// ═══════════════════════════════════════════════════════
// mpv.rs — libmpv 播放引擎（**只用它的音频**）
//   动态加载 mpv-2.dll（缺失时优雅降级，不影响主程序）
//   视频：vo=null + vid=no，完全不碰视频轨、不建任何原生窗口
//   音频：万能格式（ts/mkv/avi/rmvb…）的解码与播放
//   控制：命令字符串（loadfile/seek/set_property），进度轮询 observe_property
//
// 为什么画面不交给 mpv：mpv 只能靠 `wid` 往原生子窗口里画，而 WebView2 走
// DirectComposition，DWM 合成永远把 DComp 内容叠在 GDI 子窗口层之上，
// 子窗口在架构上就不可能可见。已用纯 GDI 红色 WS_CHILD 探针实测证实。
// 画面改由 ffmpeg 解码成裸 RGBA 字节送给前端 canvas，见 video.rs。
// ═══════════════════════════════════════════════════════
#![cfg(windows)]

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Emitter;

/// Send 包装：HWND/handle 原始指针跨线程传递（mpv 客户端 API 线程安全）
#[derive(Clone, Copy)]
struct SendPtr(*mut c_void);
unsafe impl Send for SendPtr {}

// ─── libmpv C API 符号 ───
type MpvHandle = *mut c_void;
type MpvFormat = c_int;
const MPV_FORMAT_STRING: MpvFormat = 1;
const MPV_FORMAT_FLAG: MpvFormat = 3;
const MPV_FORMAT_DOUBLE: MpvFormat = 5;
const MPV_EVENT_END_FILE: c_int = 7;

/// 视频输出后端。
///
/// 固定 `null`：mpv 在本项目里**只负责音频**，视频画面由 ffmpeg 解码后
/// 以裸 RGBA 字节送到前端 canvas（见 video.rs）。
///
/// 这里曾长期排查「有声无画」，结论是两条路都走不通，已全部放弃：
///   1) vo_gpu 整条链路吐不出帧。本机（NVIDIA GTX 1060 / 驱动 32.0.15.8266）
///      上 examples/mpv_embed_smoke.rs 用 GDI BitBlt 抓子窗口像素统计「非黑
///      像素占比」做地面真值（而不是只看 time-pos 是否递增）：
///        vo=direct3d              → pos 0.37→3.74，nonblack=4096/4096 (100%)  ✅
///        vo=gpu;gpu-context=win   → pos=0.00 停滞，nonblack=0/4096 (0%)          ❌
///        vo=gpu;gpu-context=d3d11 → pos=0.00 停滞，0%，且 VO 初始化 0xc0000005 崩溃  ❌
///        vo=gpu-next;gpu-context=win → 0%                                          ❌
///        vo=gpu;gpu-context=angle    → 0%                                          ❌
///   2) 就算 mpv 成功画出像素（vo=direct3d 那档），画面依然看不见。根因是
///      WebView2 走 DirectComposition（窗口树里有 `Intermediate D3D Window`），
///      DWM 把 DComp 内容合成在 GDI 子窗口层「之上」，WS_CHILD 无论怎么
///      SetWindowPos(HWND_TOP) 都抬不上去。已用纯 GDI 红色 WS_CHILD 探针窗口
///      实测：探针覆盖整个客户区、Z 序第一、vis=true，屏幕采样 R-G=0。
///
/// 换机器后若想重测第 1 条，改这个常量并重跑 examples/mpv_embed_smoke.rs
/// 的像素采样对比即可；第 2 条与显卡无关，换机器同样成立。
const VIDEO_OUT: &str = "null";

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

// 函数指针表（Library 泄漏为进程级静态）
struct MpvApi {
    create: unsafe extern "C" fn() -> MpvHandle,
    initialize: unsafe extern "C" fn(MpvHandle) -> c_int,
    terminate_destroy: unsafe extern "C" fn(MpvHandle),
    // 单字符串命令版本；不可用 mpv_command——它接收 char** 参数数组，
    // 误传字符串指针会被当指针解引用（STATUS_ACCESS_VIOLATION）
    command_string: unsafe extern "C" fn(MpvHandle, *const c_char) -> c_int,
    set_property: unsafe extern "C" fn(MpvHandle, *const c_char, MpvFormat, *mut c_void) -> c_int,
    // 字符串属性便捷 API：直接传字符串。注意 mpv_set_property 的 MPV_FORMAT_STRING
    // 分支 data 参数实际是 char**（m_option 字符串按指针存储，上游 client.c 的
    // mpv_set_property_string 内部就是传 &data 调的），直接传 char* 会闪退
    set_property_string: unsafe extern "C" fn(MpvHandle, *const c_char, *const c_char) -> c_int,
    get_property: unsafe extern "C" fn(MpvHandle, *const c_char, MpvFormat, *mut c_void) -> c_int,
    #[allow(dead_code)]
    observe_property: unsafe extern "C" fn(MpvHandle, u64, *const c_char, MpvFormat) -> c_int,
    wait_event: unsafe extern "C" fn(MpvHandle, f64) -> *mut MpvEvent,
    free: unsafe extern "C" fn(*mut c_void), // mpv_free：归还 mpv 分配的字符串
    #[allow(dead_code)]
    client_api_version: unsafe extern "C" fn() -> u64,
}

static API: Mutex<Option<&'static MpvApi>> = Mutex::new(None);
static MPV: Mutex<Option<SendPtr>> = Mutex::new(None);

fn dll_path() -> std::path::PathBuf {
    // 优先：exe 同目录（安装版）；其次开发期 target/debug
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("mpv-2.dll");
            if p.is_file() {
                return p;
            }
        }
    }
    std::path::PathBuf::from("mpv-2.dll")
}

/// 加载 mpv-2.dll 并解析符号（只做一次）
unsafe fn api() -> Result<&'static MpvApi, String> {
    let mut g = API.lock().unwrap();
    if let Some(a) = *g {
        return Ok(a);
    }
    let path = dll_path();
    if !path.is_file() {
        return Err("未找到 mpv-2.dll".into());
    }
    unsafe {
        let lib = libloading::Library::new(&path).map_err(|e| format!("加载 mpv-2.dll 失败: {e}"))?;
        let api: MpvApi = MpvApi {
            create: *lib.get(b"mpv_create").map_err(|e| format!("符号 mpv_create: {e}"))?,
            initialize: *lib.get(b"mpv_initialize").map_err(|e| format!("符号 mpv_initialize: {e}"))?,
            terminate_destroy: *lib.get(b"mpv_terminate_destroy").map_err(|e| format!("符号 mpv_terminate_destroy: {e}"))?,
            command_string: *lib.get(b"mpv_command_string").map_err(|e| format!("符号 mpv_command_string: {e}"))?,
            set_property: *lib.get(b"mpv_set_property").map_err(|e| format!("符号 mpv_set_property: {e}"))?,
            set_property_string: *lib.get(b"mpv_set_property_string").map_err(|e| format!("符号 mpv_set_property_string: {e}"))?,
            get_property: *lib.get(b"mpv_get_property").map_err(|e| format!("符号 mpv_get_property: {e}"))?,
            observe_property: *lib.get(b"mpv_observe_property").map_err(|e| format!("符号 mpv_observe_property: {e}"))?,
            wait_event: *lib.get(b"mpv_wait_event").map_err(|e| format!("符号 mpv_wait_event: {e}"))?,
            free: *lib.get(b"mpv_free").map_err(|e| format!("符号 mpv_free: {e}"))?,
            client_api_version: *lib.get(b"mpv_client_api_version").map_err(|e| format!("符号 mpv_client_api_version: {e}"))?,
        };
        // 泄漏为静态引用（进程生命周期）
        let leaked: &'static MpvApi = Box::leak(Box::new(api));
        // Library 不能 drop（符号表在用），泄漏之
        std::mem::forget(lib);
        *g = Some(leaked);
        Ok(leaked)
    }
}

unsafe fn cstr(s: &str) -> CString {
    CString::new(s.replace('\\', "/")).unwrap_or_default()
}

fn mpv() -> Result<MpvHandle, String> {
    let mut g = MPV.lock().unwrap();
    if let Some(h) = *g {
        return Ok(h.0);
    }
    unsafe {
        let api = api()?;
        let h = (api.create)();
        if h.is_null() {
            return Err("mpv_create 失败".into());
        }
        // 基础属性：无 OSD；视频轨整个关掉，只当音频引擎用
        set_prop_str(h, "keep-open", "yes"); // 播完不退出
        set_prop_str(h, "osc", "no"); // 关闭 mpv 自带控制条
        set_prop_str(h, "osd-level", "0"); // 无 OSD 文字
        set_prop_str(h, "cursor-autohide", "no"); // 鼠标管理交给前端
        set_prop_str(h, "input-default-bindings", "no"); // 快捷键交给前端
        set_prop_str(h, "input-vo-keyboard", "no");
        set_prop_str(h, "hr-seek", "absolute");
        // vid=no：不解码视频轨。画面由 ffmpeg 负责（video.rs），
        // 这里再解一遍纯属白烧 CPU，而且会碰到 mpv 那条坏掉的 VO 链路。
        set_prop_str(h, "vid", "no");
        // 必须在 mpv_initialize 之前设：VO 链路只在 initialize 时按选项固化
        set_prop_str(h, "vo", VIDEO_OUT); // "null"：不建任何视频输出窗口
        if (api.initialize)(h) < 0 {
            (api.terminate_destroy)(h);
            return Err("mpv_initialize 失败".into());
        }
        *g = Some(SendPtr(h));
        Ok(h)
    }
}

unsafe fn set_prop_str(h: MpvHandle, name: &str, v: &str) {
    let api = api().unwrap();
    let n = cstr(name);
    let val = cstr(v);
    let _ = (api.set_property_string)(h, n.as_ptr(), val.as_ptr());
}

unsafe fn set_prop_flag(h: MpvHandle, name: &str, v: bool) {
    let api = api().unwrap();
    let n = cstr(name);
    let mut flag: c_int = if v { 1 } else { 0 };
    let _ = (api.set_property)(h, n.as_ptr(), MPV_FORMAT_FLAG, &mut flag as *mut c_int as *mut c_void);
}

unsafe fn set_prop_double(h: MpvHandle, name: &str, v: f64) {
    let api = api().unwrap();
    let n = cstr(name);
    let mut d = v;
    let _ = (api.set_property)(h, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut d as *mut f64 as *mut c_void);
}

/// 执行 mpv 命令字符串（同步）；不可用 mpv_command——它接收 char** 数组
fn mpv_cmd(h: MpvHandle, cmd: &str) -> Result<(), String> {
    unsafe {
        let api = api()?;
        let c = cstr(cmd);
        let r = (api.command_string)(h, c.as_ptr());
        if r < 0 {
            Err(format!("mpv 命令失败({r}): {cmd}"))
        } else {
            Ok(())
        }
    }
}

// ─── 播放状态快照（前端轮询） ───
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MpvState {
    pub loaded: bool,
    pub paused: bool,
    pub position: f64,
    pub duration: f64,
    /// mpv 的音频/视频时间戳差（正 = 音频超前视频，单位秒）。
    ///
    /// 我们只让 mpv 出声音（vo=null），而 vo=null 的呈现延迟是 0，
    /// 所以这个差值就等于「音频输出缓冲里压着多少秒」—— 也就是
    /// `time-pos` 比耳朵真正听到的位置超前多少。画面是照 time-pos 摆的，
    /// 不减掉这段就是画面超前音频一个常数（不漂移，但永远自己修不好）。
    pub av_sync: f64,
    pub seekable: bool,
    pub ended: bool,
    pub media_title: String,
}

/// 检查 mpv 是否可用（前端启动时探测，决定是否启用 mpv 引擎）
#[tauri::command]
pub async fn mpv_available() -> bool {
    unsafe { api().is_ok() }
}

/// 打开/替换播放文件。**只起音频**，画面由 video::video_start 单独拉起。
/// 不再有任何窗口/HWND 参数。
#[tauri::command]
pub async fn mpv_load(app: tauri::AppHandle, path: String, autoplay: bool) -> Result<(), String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let h_mpv = mpv()?;
    unsafe {
        set_prop_flag(h_mpv, "pause", !autoplay);
        let cmd = format!("loadfile \"{}\"", src.to_string_lossy().replace('\\', "/").replace('"', ""));
        mpv_cmd(h_mpv, &cmd)?;
    }
    // 事件线程：消费事件队列防止堆积；播放结束时通知前端（首次 load 时启动）
    start_event_thread(app);
    Ok(())
}

/// 播放控制（pause/play/seek/volume/speed/mute/loop）
#[tauri::command]
pub async fn mpv_control(action: String, value: Option<f64>) -> Result<(), String> {
    let h = mpv()?;
    unsafe {
        match action.as_str() {
            "toggle" => {
                let paused = get_prop_flag(h, "pause").unwrap_or(false);
                set_prop_flag(h, "pause", !paused);
            }
            "pause" => set_prop_flag(h, "pause", true),
            "play" => set_prop_flag(h, "pause", false),
            "seek" => {
                let v = value.ok_or("seek 需要秒数")?;
                mpv_cmd(h, &format!("seek {v} absolute"))?;
            }
            "seekPercent" => {
                let v = value.ok_or("seekPercent 需要 0~100")?;
                let dur = get_prop_double(h, "duration").unwrap_or(0.0);
                if dur > 0.0 {
                    mpv_cmd(h, &format!("seek {} absolute", dur * v / 100.0))?;
                }
            }
            "volume" => {
                let v = value.ok_or("volume 需要 0~100")?;
                set_prop_double(h, "volume", v);
                if v > 0.0 { set_prop_flag(h, "mute", false); }
            }
            "mute" => set_prop_flag(h, "mute", value.map(|v| v > 0.5).unwrap_or(true)),
            "speed" => {
                let v = value.ok_or("speed 需要倍率")?;
                set_prop_double(h, "speed", v);
            }
            "loop" => {
                let on = value.map(|v| v > 0.5).unwrap_or(false);
                set_prop_str(h, "loop-file", if on { "inf" } else { "no" });
            }
            _ => return Err(format!("未知操作: {action}")),
        }
    }
    Ok(())
}

/// 读取播放状态（前端 ~10Hz 轮询）
#[tauri::command]
pub async fn mpv_state() -> MpvState {
    let Ok(h) = mpv() else { return MpvState::default(); };
    unsafe {
        MpvState {
            // loaded 改由 mpv 自己的 idle-active 判定：
            // 原先靠「子窗口是否已创建」，那条路已经随原生窗口一起删掉了
            loaded: !get_prop_flag(h, "idle-active").unwrap_or(true),
            paused: get_prop_flag(h, "pause").unwrap_or(true),
            position: get_prop_double(h, "time-pos").unwrap_or(0.0),
            duration: get_prop_double(h, "duration").unwrap_or(0.0),
            // 属性缺失/不支持时返回 0（= 不补偿），前端还有手动微调兜底
            av_sync: get_prop_double(h, "av-sync").unwrap_or(0.0).clamp(-1.0, 1.0),
            seekable: get_prop_flag(h, "seekable").unwrap_or(false),
            ended: get_prop_flag(h, "idle-active").unwrap_or(false),
            media_title: get_prop_string(h, "media-title").unwrap_or_default(),
        }
    }
}

/// 停止播放（关闭预览/切换到图片/音频时调用）
#[tauri::command]
pub async fn mpv_stop() -> Result<(), String> {
    if let Some(h) = *MPV.lock().unwrap() {
        let _ = mpv_cmd(h.0, "stop");
    }
    Ok(())
}

/// 进程退出前销毁 mpv 句柄。
///
/// libmpv 是同进程加载的 DLL（没有独立的 mpv.exe），所以不存在孤儿进程问题；
/// 但退出前显式 `stop` + `terminate_destroy` 能让音频设备被正常释放，
/// 否则 WASAPI 的设备句柄要等进程被内核回收才复位，偶尔表现为退出瞬间的爆音。
pub fn shutdown() {
    let taken = { MPV.lock().unwrap().take() };
    if let Some(sp) = taken {
        unsafe {
            let _ = mpv_cmd(sp.0, "stop");
            if let Ok(api) = api() {
                (api.terminate_destroy)(sp.0);
            }
        }
    }
    // 事件线程是靠 mpv 事件队列喂醒的，句柄销毁后它会自然 EOF 退出；
    // 这里只把标志位留着——进程马上就退了，重建也来不及，不值得引入竞态。
}

unsafe fn get_prop_flag(h: MpvHandle, name: &str) -> Option<bool> {
    let api = api().ok()?;
    let n = cstr(name);
    let mut v: c_int = 0;
    let r = (api.get_property)(h, n.as_ptr(), MPV_FORMAT_FLAG, &mut v as *mut c_int as *mut c_void);
    if r < 0 { None } else { Some(v != 0) }
}

unsafe fn get_prop_double(h: MpvHandle, name: &str) -> Option<f64> {
    let api = api().ok()?;
    let n = cstr(name);
    let mut v: f64 = 0.0;
    let r = (api.get_property)(h, n.as_ptr(), MPV_FORMAT_DOUBLE, &mut v as *mut f64 as *mut c_void);
    if r < 0 { None } else { Some(v) }
}

unsafe fn get_prop_string(h: MpvHandle, name: &str) -> Option<String> {
    let api = api().ok()?;
    let n = cstr(name);
    let mut p: *mut c_char = std::ptr::null_mut();
    let r = (api.get_property)(h, n.as_ptr(), MPV_FORMAT_STRING, &mut p as *mut *mut c_char as *mut c_void);
    if r < 0 || p.is_null() { return None; }
    let s = CStr::from_ptr(p).to_string_lossy().into_owned();
    (api.free)(p as *mut c_void); // mpv 分配的字符串必须用 mpv_free 归还（轮询高频，泄漏会累积）
    Some(s)
}

/// 事件线程只启动一次
static EVENT_THREAD_STARTED: Mutex<bool> = Mutex::new(false);

/// mpv 事件线程：消费事件队列防止堆积；播放结束时通知前端
fn start_event_thread(app: tauri::AppHandle) {
    let mut started = EVENT_THREAD_STARTED.lock().unwrap();
    if *started { return; }
    *started = true;
    std::thread::spawn(move || {
        loop {
            let h = {
                let g = MPV.lock().unwrap();
                match *g {
                    Some(h) => h.0,
                    None => break,
                }
            };
            if h.is_null() { break; }
            unsafe {
                let api = match api() { Ok(a) => a, Err(_) => break };
                let ev = (api.wait_event)(h, 0.5);
                if ev.is_null() { continue; }
                let id = (*ev).event_id;
                if id == MPV_EVENT_END_FILE {
                    // 播放结束（keep-open 下停在末帧）→ 通知前端更新按钮状态
                    let _ = app.emit("mpv-end-file", ());
                }
            }
        }
    });
}
