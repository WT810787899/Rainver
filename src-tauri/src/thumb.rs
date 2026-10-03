// ═══════════════════════════════════════════════════════
// thumb.rs — 缩略图生成与缓存
//   图片: image crate + EXIF 自动旋转; blake3 哈希做缓存 key
//   视频: ffmpeg 抓首帧; Semaphore 限制并发（可在设置中调整）
//   缓存目录: 默认 %APPDATA，可在设置中更改；支持统计/清理/LRU 淘汰
// ═══════════════════════════════════════════════════════
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use serde::Serialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 缩略图尺寸（长边像素）
const THUMB_SIZE: u32 = 512;
/// L133/L146：画廊模式大尺寸缩略图上限（长边）。
/// 2400 覆盖单列放大（~1920 CSS px）与 HiDPI（dpr 1.25/1.5）的清晰显示
const MAX_LARGE_SIZE: u32 = 2400;
/// 默认并发（按 CPU 核数，2~8）：ffmpeg 缩略/图片解码共用
fn default_concurrency() -> usize {
    num_cpus::get().clamp(2, 8)
}
/// 缩略图 IPC 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbResult {
    pub thumb_path: String,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}
/// 缓存统计 IPC 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub file_count: u64,
    pub total_bytes: u64,
}
// ─── ffmpeg 并发队列（可运行时调整） ───
fn slots_mutex() -> &'static Mutex<Arc<tokio::sync::Semaphore>> {
    static S: OnceLock<Mutex<Arc<tokio::sync::Semaphore>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Arc::new(tokio::sync::Semaphore::new(default_concurrency()))))
}
/// 当前并发信号量
fn slots_current() -> Arc<tokio::sync::Semaphore> {
    slots_mutex().lock().unwrap().clone()
}
// ─── 图片解码并发信号量（按核数，防止同时解码几十张大图） ───
fn image_slots() -> &'static tokio::sync::Semaphore {
    static S: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(default_concurrency()))
}
/// 设置 ffmpeg 并发任务数（设置-行为页调用；1~16 钳制）
pub fn set_concurrency(n: u32) {
    let n = n.clamp(1, 16) as usize;
    let mut g = slots_mutex().lock().unwrap();
    // 重建信号量（旧 Arc 持有者继续用旧实例收尾，新任务用新并发上限）
    *g = Arc::new(tokio::sync::Semaphore::new(n));
}
// ─── 缓存目录（可配置覆盖） ───
fn cache_override() -> &'static Mutex<Option<PathBuf>> {
    static O: Mutex<Option<PathBuf>> = Mutex::new(None);
    &O
}
/// 热更新缓存目录（设置-行为页「选择缓存目录」时调用）
pub fn set_cache_dir(p: PathBuf) {
    *cache_override().lock().unwrap() = Some(p);
}
/// 获取指定类型的缓存子目录；不存在则创建
/// kind: "image" | "video" | "audio" — 对应 thumbnails/images|videos|audio
fn cache_dir(_app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let base = if let Some(o) = cache_override().lock().unwrap().clone() {
        o
    } else {
        crate::utils::ensure_project_cache_dir()
            .map_err(|e| format!("无法获取 cache 目录: {e}"))?
            .join("thumbnails")
    };
    let sub = match kind {
        "image" => "images",
        "video" => "videos",
        "audio" => "audio",
        _ => "other",
    };
    let dir = base.join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    Ok(dir)
}

/// 获取 thumbnails 根目录（用于遍历所有类型子目录）
fn cache_root_dir(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(o) = cache_override().lock().unwrap().clone() {
        return Ok(o);
    }
    let dir = crate::utils::ensure_project_cache_dir()
        .map_err(|e| format!("无法获取 cache 目录: {e}"))?
        .join("thumbnails");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    Ok(dir)
}
/// 生成缩略图（若缓存命中则直接返回）
/// 失败时返回 Err → 前端显示占位图，不影响整体
#[tauri::command]
pub async fn get_thumbnail(
    app: tauri::AppHandle,
    path: String,
    kind: String,
    // L133：请求长边尺寸（仅画廊模式传 >512 的值，生成独立缓存文件；缺省=512）
    size: Option<u32>,
) -> Result<ThumbResult, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let dir = cache_dir(&app, &kind)?;
    // 请求尺寸归一：[512, 1600]，非默认尺寸缓存文件名带 .s{req} 后缀
    let req = size.unwrap_or(THUMB_SIZE).clamp(THUMB_SIZE, MAX_LARGE_SIZE);
    let tag = if req == THUMB_SIZE { String::new() } else { format!(".s{req}") };
    match kind.as_str() {
        "image" => {
            let key = hash_key(&src);
            let out = dir.join(format!("{key}{tag}.jpg"));
            if !out.exists() {
                // 并发上限：同时解码的大图数量受限，避免 CPU/内存争抢导致整体变慢
                let _permit = image_slots()
                    .acquire()
                    .await
                    .map_err(|e| format!("队列异常: {e}"))?;
                let src2 = src.clone();
                let out2 = out.clone();
                let req2 = req;
                tauri::async_runtime::spawn_blocking(move || make_image_thumb(&src2, &out2, req2))
                    .await
                    .map_err(|e| format!("任务失败: {e}"))??;
            }
            let (w, h) = read_dims_meta(&dir, &key);
            // 大尺寸文件伴随元数据按 out 名存放：默认键没有时回退读它
            let (w, h) = if w.is_some() {
                (w, h)
            } else {
                read_dims_meta(&dir, &format!("{key}{tag}"))
            };
            Ok(ThumbResult {
                thumb_path: out.to_string_lossy().into_owned(),
                duration: None,
                width: w,
                height: h,
            })
        }
        "video" => {
            let key = hash_key(&src);
            let out = dir.join(format!("{key}{tag}.jpg"));
            let dur_cache = read_duration_meta(&dir, &key);
            // 默认尺寸：元数据（时长）缺失也要补；大尺寸：文件不存在才生成
            if !out.exists() || (req == THUMB_SIZE && dur_cache.is_none()) {
                // 任务队列：受设置的并发上限约束
                let slots = slots_current();
                let _permit = slots
                    .acquire()
                    .await
                    .map_err(|e| format!("队列异常: {e}"))?;
                let src2 = src.clone();
                let out2 = out.clone();
                let req2 = req;
                let (dur, wh) = tauri::async_runtime::spawn_blocking(move || {
                    make_video_thumb(&src2, &out2, req2)
                })
                .await
                .map_err(|e| format!("任务失败: {e}"))??;
                // 默认尺寸写共享时长元数据；大尺寸写 tag 元数据（互不覆盖）
                if let Some(d) = dur {
                    let meta_key = if req2 == THUMB_SIZE {
                        key.clone()
                    } else {
                        format!("{key}.s{req2}")
                    };
                    write_duration_meta(&dir, &meta_key, d, wh.0, wh.1);
                }
                Ok(ThumbResult {
                    thumb_path: out.to_string_lossy().into_owned(),
                    duration: dur,
                    width: wh.0,
                    height: wh.1,
                })
            } else {
                // 缓存命中：宽高同样从伴随元数据读回（画廊按媒体宽高比排版需要）
                let (w, h) = read_dims_meta(&dir, &key);
                let (w, h) = if w.is_some() {
                    (w, h)
                } else {
                    read_dims_meta(&dir, &format!("{key}{tag}"))
                };
                Ok(ThumbResult {
                    thumb_path: out.to_string_lossy().into_owned(),
                    duration: dur_cache,
                    width: w,
                    height: h,
                })
            }
        }
        "audio" => {
            // 音频：抽出内嵌封面当缩略图；没有封面就返回 Err（前端显示音频图标）
            let key = hash_key(&src);
            let out = dir.join(format!("{key}.cover.jpg"));
            if !out.exists() {
                let ext = src
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                let (_, _, _, cover) = crate::media_info::read_tags(&src, &ext);
                let data = cover.ok_or_else(|| "该音频没有内嵌封面".to_string())?;
                match image::load_from_memory(&data) {
                    Ok(img) => {
                        let thumb = if img.width().max(img.height()) > THUMB_SIZE {
                            img.thumbnail(THUMB_SIZE, THUMB_SIZE)
                        } else {
                            img
                        };
                        thumb
                            .save_with_format(&out, image::ImageFormat::Jpeg)
                            .map_err(|e| format!("保存封面失败: {e}"))?;
                    }
                    // image crate 解不了（avif 封面等）：已是 jpg/png 就原样写
                    Err(_) if data.starts_with(&[0xFF, 0xD8]) || data.starts_with(&[0x89, 0x50]) => {
                        std::fs::write(&out, &data).map_err(|e| format!("写入封面失败: {e}"))?;
                    }
                    Err(_) => return Err("封面格式不受支持".into()),
                }
            }
            Ok(ThumbResult {
                thumb_path: out.to_string_lossy().into_owned(),
                duration: None,
                width: None,
                height: None,
            })
        }
        _ => Err(format!("未知类型: {kind}")),
    }
}
// ─── L131：进度条悬浮帧预览（ffmpeg 按秒提取，宽 320，缓存复用） ───
#[tauri::command]
pub async fn frame_at(
    app: tauri::AppHandle,
    path: String,
    time: f64,
) -> Result<String, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let dir = cache_dir(&app, "video")?;
    let sec = time.max(0.0).round() as i64;
    let key = hash_key(&src);
    let out = dir.join(format!("{key}.f{sec}.jpg"));
    if !out.exists() {
        // 必须限流，但**只抢不排**：悬浮帧是可有可无的装饰，抢不到就直接放弃
        // （前端 catch 会保留旧帧）。原来这里刻意不占信号量，理由是「前端已防抖」，
        // 但防抖只挡住了「还没发出去」的请求 —— 已经 spawn 的 ffmpeg 照跑不误，
        // 而缓存键是按秒分档的（{key}.f{sec}.jpg），鼠标扫过进度条等于每个秒数
        // 起一个新进程且无上限。4K mkv 上并发几十个抽帧（每个 ~600MB 显存），
        // 足以把正在播放的解码管线挤到卡死。
        // sem 必须绑到局部变量：try_acquire 借的是它，直接对临时值调用会让
        // 临时 Arc 在语句结束就被丢掉，而 permit 还活着（E0716）
        let sem = slots_current();
        let Ok(_permit) = sem.try_acquire() else {
            return Err("抽帧繁忙".into());
        };
        let src2 = src.clone();
        let out2 = out.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg".to_string())?;
            let mut cmd = std::process::Command::new(ffmpeg);
            cmd
                .arg("-hide_banner")
                .arg("-nostdin")
                .arg("-ss")
                .arg(sec.to_string())
                .arg("-i")
                .arg(&src2)
                .arg("-frames:v")
                .arg("1")
                .arg("-vf")
                .arg("scale=320:-2")
                .arg("-q:v")
                .arg("4")
                .arg("-y")
                .arg(&out2);

            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let output = cmd.output()
                .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
            if !output.status.success() {
                let _ = std::fs::remove_file(&out2);
                return Err("提取帧失败".into());
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("任务失败: {e}"))??;
    }
    Ok(out.to_string_lossy().into_owned())
}
// ─── 播放兼容：WebView2 不支持的容器 → ffmpeg 无损重封装为 mp4 ───
/// 需要重封装的容器后缀（Chromium/WebView2 原生不支持，但内部编码多为 H.264/AAC 可直接拷贝）
const REMUX_EXTS: &[&str] = &["ts", "mts", "m2ts", "mkv", "avi", "flv", "wmv", "rm", "rmvb", "vob"];

/// 正在跑的重封装任务。
///
/// 为什么必须记 pid：重封装是**整个文件**的 `-c copy`，一个 GB 级 .ts 要拷几十秒。
/// 以前用 `cmd.output()` 一口气阻塞等到底，句柄锁在 spawn_blocking 线程里，
/// 外面既杀不掉、也查不到——卡片滚走了它还在拷，进程退出后还会变成孤儿。
/// 记下 pid 才有两个能力：(1) 卡片取消预览时立刻 kill；(2) 退出时兜底全杀。
///
/// key 用 (源文件, 用途) 而不是输出路径：调用方要取消时手上只有源路径，
/// 复现不了输出文件名里那串 `-ss` 起始时间。
struct RemuxJob {
    src: PathBuf,
    /// "play" = 整片（正式播放）；"prev" = 开头一小段（卡片预览）
    tag: &'static str,
    part: PathBuf,
    pid: u32,
}
static REMUX_RUNNING: Mutex<Vec<RemuxJob>> = Mutex::new(Vec::new());

/// 被请求取消的任务，key 同上。工作线程每 30ms 查一次，见 remux_to_mp4。
static REMUX_CANCEL: Mutex<Vec<(PathBuf, &'static str)>> = Mutex::new(Vec::new());

fn remux_begin(src: &Path, tag: &'static str, part: &Path, pid: u32) {
    REMUX_RUNNING.lock().unwrap().push(RemuxJob {
        src: src.to_path_buf(),
        tag,
        part: part.to_path_buf(),
        pid,
    });
}
fn remux_end(src: &Path, tag: &str) {
    REMUX_RUNNING
        .lock()
        .unwrap()
        .retain(|j| !(j.src == src && j.tag == tag));
    REMUX_CANCEL
        .lock()
        .unwrap()
        .retain(|(s, t)| !(s == src && *t == tag));
}
fn remux_wants_cancel(src: &Path, tag: &str) -> bool {
    REMUX_CANCEL
        .lock()
        .unwrap()
        .iter()
        .any(|(s, t)| s == src && *t == tag)
}
/// 请求取消某个源文件的某类重封装。正在跑的话 30ms 内自杀。
pub fn cancel_remux(src: &Path, tag: &'static str) {
    REMUX_CANCEL.lock().unwrap().push((src.to_path_buf(), tag));
}

/// 退出兜底：杀掉所有还在跑的重封装。
///
/// Windows 上父进程退出不会带走子进程。`spawn_blocking` 的工作线程在进程
/// 结束时会被直接抛弃，它手里 `wait()` 的那个 ffmpeg 就成了孤儿，会继续
/// 把整个 .ts 拷完（用户会看到缓存目录还在涨、CPU 还在跑）。
pub fn kill_all_remuxes() {
    let running = std::mem::take(&mut *REMUX_RUNNING.lock().unwrap());
    for j in running {
        kill_pid(j.pid);
        // 半成品没用了，顺手删掉，别占着缓存目录几个 GB
        let _ = std::fs::remove_file(&j.part);
    }
    REMUX_CANCEL.lock().unwrap().clear();
}

/// 按 pid 强杀（不建进程、不闪窗口）。
///
/// 不用 `taskkill` 是因为它自己也是个要 spawn 的进程；这里直接开句柄
/// TerminateProcess。`PROCESS_TERMINATE` 对自己起的子进程总是拿得到。
fn kill_pid(pid: u32) {
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(h, 1);
            let _ = windows::Win32::Foundation::CloseHandle(h);
        }
    }
}

/// 临时文件名：与最终产物同目录同 stem，只是后缀换成 `.part`，
/// 成功后原子改名，失败/被杀就删掉——绝不留半成品在缓存里。
fn part_path(out: &Path) -> PathBuf {
    out.with_extension("part")
}

/// 启动时清掉上次异常退出留下的 `.part`。
///
/// 它们是「重封装被杀到一半」的产物，纯垃圾：每个都是几 GB 的
/// `-movflags +faststart` 中间文件（faststart 还要做一次完整的二次拷贝），
/// 而且 `get_cache_stats` 会把它们算进缓存体积，用户点「一键清理」之前
/// 缓存永远下不来。不清的话每次崩溃退出都会再攒一批。
pub fn sweep_partials(app: &tauri::AppHandle) {
    let Ok(dir) = cache_dir(app, "video") else { return };
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut freed = 0u64;
    let mut n = 0u32;
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.extension().map(|x| x.eq_ignore_ascii_case("part")).unwrap_or(false) {
            if let Ok(md) = e.metadata() { freed += md.len(); }
            if std::fs::remove_file(&p).is_ok() { n += 1; }
        }
    }
    if n > 0 {
        log::info!("清理残留重封装临时文件 {n} 个，释放 {:.1} MB", freed as f64 / 1048576.0);
    }
}

/// 获取可播放路径：WebView2 直接支持的格式原样返回；
/// 否则用 ffmpeg `-c copy` 重封装为 mp4（按内容哈希缓存，与缩略图共用缓存目录）
#[tauri::command]
pub async fn get_playable_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    remux_path(app, path, None, 0.0).await
}

/// 卡片预览的默认重封装时长（秒），用于「拿不到时长元信息」时的兜底。
///
/// 固定 30 秒是早期定的：循环播一小段，30 秒足够看出内容，又不至于把大文件
/// 整份拷一遍。现在默认走 `preview_window_secs` 按字节预算反推，这里只是兜底值。
pub const PREVIEW_SECS: f64 = 60.0;

/// 预览片段的**字节预算**（`-c copy` 的输出大小 ≈ 码率 × 时长，与分辨率无关）。
///
/// 24 MiB 不是随手取的：默认缓存上限 512 MiB，一屏新卡片最多 `NEW_PREVIEWS_PER_TICK`
/// (6) 张，预算 × 6 必须明显小于上限，否则刚写完的预览立刻被 LRU 挤掉，
/// 用户看到的是「预览一直转圈」——比 30 秒循环更糟。
const PREVIEW_BUDGET_BYTES: f64 = 24.0 * 1024.0 * 1024.0;
/// 窗口下限：短于此连「是不是同一段」都看不出来。高码率文件会突破预算
/// （30 秒 × 20 MB/s = 600 MiB），但那正是**改之前**的行为，不算回退。
const PREVIEW_MIN_SECS: f64 = 30.0;
/// 窗口上限：再长收益递减（用户早就划走了），缓存占用却线性涨。
const PREVIEW_MAX_SECS: f64 = 120.0;

/// 由「文件总长 + 文件大小」反推平均码率，再按字节预算算出该截多长的预览窗口。
///
/// 为什么不能写死秒数：`-c copy` 拷的字节数只跟码率×时长有关，同一个 30 秒，
/// SD 的 .ts 约 3 MB，4K 高码率的能到 75 MB。写死 30 秒对前者是「刚睁眼就循环」，
/// 对后者是「一个预览占 75 MB」。按预算反推之后，低码率文件能拿到 2~4 分钟，
/// 高码率自动退回 30 秒底线 —— 用户真正在意的是**看不看得出重复**，
/// 不是这个数字本身。
///
/// 纯算术，不额外起 ffmpeg/ffprobe：文件大小取 `metadata`，时长读缩略图那趟
/// 顺带写下的 `{key}.json`（画廊是先出缩略图再挂预览的，那份元信息基本总在）。
pub fn preview_window_secs(size_bytes: u64, duration: f64, start: f64) -> f64 {
    let dur = if duration.is_finite() && duration > 1.0 {
        duration
    } else {
        0.0
    };
    let bps = if dur > 0.0 && size_bytes > 0 {
        size_bytes as f64 * 8.0 / dur
    } else {
        0.0
    };
    let mut s = if bps > 0.0 {
        PREVIEW_BUDGET_BYTES * 8.0 / bps
    } else {
        PREVIEW_SECS
    };
    // 对齐到 5 秒栅格：同一文件两次算出来的秒数必须**逐位相同**，否则缓存键
    // （文件名里带 {:.0}s）会分裂成两个文件，同一段白白拷两遍。
    s = (s / 5.0).round() * 5.0;
    s = s.clamp(PREVIEW_MIN_SECS, PREVIEW_MAX_SECS);
    if dur > 0.0 {
        let remain = dur - start.max(0.0);
        // 越过片尾没意义；但起播点贴着片尾时也别截出 3 秒短片，至少给回下限
        s = if remain >= PREVIEW_MIN_SECS {
            s.min(remain)
        } else {
            PREVIEW_MIN_SECS
        };
    }
    s
}

/// **卡片预览专用**：只重封装从 `start` 开始的 `seconds` 秒。
///
/// 为什么要单独一条路：预览只是循环播一小段，但 `get_playable_path` 是
/// `-c copy` **整文件**重封装 —— 一个 GB 级 .ts 要把全片拷一遍才能看到第一帧。
/// 实测在一个放满 .ts 的目录里滚动，每个可见卡片都起一个全量重封装，
/// 并发 4~8 个，CPU 和磁盘一起被吃满，缓存目录还多出几 GB 垃圾，
/// 用户看起来就是「ffmpeg 卡住不回收」。限时限量后单次只要几百毫秒。
///
/// `seconds` 传 `None` = 让后端按字节预算自己定（`preview_window_secs`），
/// 这才是常规用法：前端并不知道文件码率，硬编一个数字只会「要么太短要么太肥」。
///
/// `start` 必须锚在**上次进度**上而不是 0：窗口是围绕续播点截的，
/// 用户从卡片预览看到的内容正好就是打开后会看到的开场。
#[tauri::command]
pub async fn get_preview_path(
    app: tauri::AppHandle,
    path: String,
    start: Option<f64>,
    seconds: Option<f64>,
) -> Result<String, String> {
    let start = start.unwrap_or(0.0).max(0.0);
    let secs = match seconds {
        Some(s) if s.is_finite() => s.clamp(1.0, 600.0),
        _ => {
            // 只读文件系统元数据 + 缩略图顺带写下的时长，不起任何子进程
            let src = crate::utils::canonicalize_checked(&path)?;
            let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
            let dur = cache_dir(&app, "video")
                .ok()
                .and_then(|d| read_duration_meta(&d, &hash_key(&src)))
                .unwrap_or(0.0);
            preview_window_secs(size, dur, start)
        }
    };
    remux_path(app, path, Some(secs), start).await
}

/// 取消某个源文件正在跑的**预览**重封装。
///
/// 卡片滚出可视区（或整个滚动容器被重建）时调用：如果这个预览片段
/// 还在重封装中，就地掐掉。已经跑完的（缓存里已有文件）是
/// 瞬间返回的，掐不掉也无所谓——反正下次直接命中缓存。
#[tauri::command]
pub async fn cancel_preview(path: String) -> Result<(), String> {
    // 解析失败就算了：拿不到路径说明文件已经没了，没有正在跑的任务
    if let Ok(src) = crate::utils::canonicalize_checked(&path) {
        cancel_remux(&src, "prev");
    }
    Ok(())
}

/// 重封装的公共实现。`limit_secs` 为 `None` 表示整文件（正式播放）；
/// `Some(s)` 表示只要从 `start` 起的 s 秒（卡片预览）。
///
/// 预览产物按 `{key}.prev{s:.0}s@{start:.0}.mp4` 命名：`s` 由
/// `preview_window_secs` 量化到 5 秒栅格，保证同一个文件每次算出同一个
/// `s`，否则这里会分裂出多个内容相同、文件名不同的片段。
async fn remux_path(
    app: tauri::AppHandle,
    path: String,
    limit_secs: Option<f64>,
    start: f64,
) -> Result<String, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !REMUX_EXTS.contains(&ext.as_str()) {
        return Ok(src.to_string_lossy().into_owned());
    }
    let dir = cache_dir(&app, "video")?;
    let key = hash_key(&src);
    // 缓存键要带上起点与时长，否则不同位置的预览会互相覆盖
    let (tag, name) = match limit_secs {
        Some(s) => (
            "prev",
            format!("{key}.prev{:.0}s@{:.0}.mp4", s, start.max(0.0)),
        ),
        None => ("play", format!("{key}.play.mp4")),
    };
    let out = dir.join(name);
    if !out.exists() {
        // 任务队列：与缩略图共享并发上限
        let slots = slots_current();
        let _permit = slots.acquire().await.map_err(|e| format!("队列异常: {e}"))?;
        let (src2, out2) = (src.clone(), out.clone());
        tauri::async_runtime::spawn_blocking(move || {
            remux_to_mp4(&src2, &out2, limit_secs, start, tag)
        })
        .await
        .map_err(|e| format!("任务失败: {e}"))??;
    }
    Ok(out.to_string_lossy().into_owned())
}

/// 无损重封装：`ffmpeg -i src -c copy -movflags +faststart -f mp4 out`
/// 先写临时文件，成功后原子改名，避免缓存里留下半成品。
///
/// `limit_secs` 为 `Some(s)` 时只取 `[start, start+s)` 这一段
/// （`-ss start -t s`，`-c copy` 下是包级 seek + 定长拷贝，几百毫秒就完事）。
///
/// 不用 `.output()` 而是 `spawn()` + 轮询 `try_wait()`：`.output()` 会一直阻塞到
/// 子进程结束，句柄锁死在当前线程里，外面既杀不掉也感知不到，于是
/// 「卡片滚走了」和「应用退出了」都清不掉它。改成轮询后每 30ms 看一眼取消标志，
/// 顺带把 pid 登记到 REMUX_RUNNING，退出时能兜底 kill。
fn remux_to_mp4(
    src: &Path,
    out: &Path,
    limit_secs: Option<f64>,
    start: f64,
    tag: &'static str,
) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg（重封装需要）".to_string())?;
    let tmp = part_path(out);
    let _ = std::fs::remove_file(&tmp);
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-y").arg("-hide_banner").arg("-nostdin");
    if let Some(s) = limit_secs {
        if start > 0.0 {
            cmd.arg("-ss").arg(format!("{start:.2}"));
        }
        cmd.arg("-t").arg(format!("{s:.2}"));
    }
    cmd.arg("-i")
        .arg(src)
        .arg("-c")
        .arg("copy")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-f")
        .arg("mp4")
        .arg(&tmp);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    let pid = child.id();
    remux_begin(src, tag, &tmp, pid);

    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if remux_wants_cancel(src, tag) {
                    let _ = child.kill();
                    let _ = child.wait(); // wait 回收进程句柄，否则每次取消漏一个
                    remux_end(src, tag);
                    let _ = std::fs::remove_file(&tmp);
                    return Err("已取消".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            Err(e) => {
                remux_end(src, tag);
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("等待 ffmpeg 失败: {e}"));
            }
        }
    };
    remux_end(src, tag);

    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "重封装失败（编码可能不兼容 MP4）: ffmpeg 退出码 {}",
            status.code().unwrap_or(-1)
        ));
    }
    // +faststart 收尾时 ffmpeg 还会再写一次头部，rename 前确保落盘完成
    std::fs::rename(&tmp, out).map_err(|e| format!("写入缓存失败: {e}"))?;
    Ok(())
}
// ─── 缓存管理 IPC ───
/// 缓存统计（文件数 + 总字节数）
#[tauri::command]
pub fn get_cache_stats(app: tauri::AppHandle) -> Result<CacheStats, String> {
    let dir = cache_root_dir(&app)?;
    let mut stats = CacheStats { file_count: 0, total_bytes: 0 };
    for sub in ["images", "videos", "audio", "other"] {
        let sub_dir = dir.join(sub);
        if let Ok(rd) = std::fs::read_dir(&sub_dir) {
            for e in rd.filter_map(|e| e.ok()) {
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        stats.file_count += 1;
                        stats.total_bytes += m.len();
                    }
                }
            }
        }
    }
    Ok(stats)
}
/// 一键清理缩略图缓存（删除缓存目录下全部文件，目录保留）
#[tauri::command]
pub fn clear_thumbnail_cache(app: tauri::AppHandle) -> Result<CacheStats, String> {
    let dir = cache_root_dir(&app)?;
    for sub in ["images", "videos", "audio", "other"] {
        let sub_dir = dir.join(sub);
        if let Ok(rd) = std::fs::read_dir(&sub_dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_file() {
                    let _ = std::fs::remove_file(p); // 单文件失败忽略
                }
            }
        }
    }
    get_cache_stats(app)
}
/// LRU 淘汰：超过上限时按「最后访问时间」从旧到新删除，直到回到限额内
/// 启动时由 main.rs 调用（spawn_blocking 中执行）
pub fn enforce_cache_limit(app: tauri::AppHandle, limit_mb: f64, lru_enabled: bool) {
    if limit_mb <= 0.0 || !lru_enabled {
        return;
    }
    let Ok(dir) = cache_root_dir(&app) else { return };
    let limit = (limit_mb * 1024.0 * 1024.0) as u64;
    // 收集 (路径, 大小, 最后访问时间)
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for sub in ["images", "videos", "audio", "other"] {
        let sub_dir = dir.join(sub);
        if let Ok(rd) = std::fs::read_dir(&sub_dir) {
            for e in rd.filter_map(|e| e.ok()) {
                if let Ok(m) = e.metadata() {
                    if m.is_file() {
                        // 优先 atime，失败退 mtime
                        let t = m
                            .accessed()
                            .or_else(|_| m.modified())
                            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                        total += m.len();
                        files.push((e.path(), m.len(), t));
                    }
                }
            }
        }
    }
    if total <= limit {
        return;
    }
    // 旧的先删
    files.sort_by_key(|(_, _, t)| *t);
    for (p, sz, _) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= sz;
        }
    }
}
// ─── 缓存 key ───
/// blake3(路径字节 + 修改时间) 十六进制
pub(crate) fn hash_key(p: &Path) -> String {
    let mtime = std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_le_bytes())
        .unwrap_or_default();
    let mut hasher = blake3::Hasher::new();
    hasher.update(p.to_string_lossy().as_bytes());
    hasher.update(&mtime);
    hasher.finalize().to_hex().to_string()
}
// ─── 图片缩略图 ───
/// 读取图片 → EXIF 自动旋转 → 缩放到请求尺寸 → 存 JPEG
/// image crate 未启用解码的容器（avif / heic 等）自动退回 ffmpeg
fn make_image_thumb(src: &Path, out: &Path, req: u32) -> Result<(), String> {
    let decoded = std::fs::read(src)
        .map_err(|e| format!("读取失败: {e}"))
        .and_then(|bytes| {
            let mut img = image::load_from_memory(&bytes).map_err(|e| format!("解码失败: {e}"))?;
            if let Some(orient) = exif_orientation(&bytes) {
                img = apply_orientation(img, orient);
            }
            let (w, h) = (img.width(), img.height());
            Ok((img, w, h))
        });
    match decoded {
        Ok((img, w, h)) => {
            let thumb = if w.max(h) > req {
                img.thumbnail(req, req)
            } else {
                img
            };
            // L146：显式高质量 JPEG（save_with_format 默认质量仅 75，压缩痕迹明显）
            let rgb = thumb.to_rgb8();
            let mut f = std::fs::File::create(out)
                .map_err(|e| format!("保存缩略图失败: {e}"))?;
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 88);
            enc.encode_image(&rgb)
                .map_err(|e| format!("保存缩略图失败: {e}"))?;
            write_duration_meta_raw(out.with_extension("json"), None, Some(w), Some(h));
            Ok(())
        }
        Err(e) => {
            // avif / heic 等：image crate 无解码器（avif 解码需 dav1d 系统库）→ 交给 ffmpeg
            eprintln!("image crate 解码失败，改用 ffmpeg: {src:?}（{e}）");
            make_image_thumb_ffmpeg(src, out, req)
        }
    }
}
/// ffmpeg 兜底解码图片（avif/heic…）：取一帧缩放到请求尺寸，并从 stderr 解析尺寸
fn make_image_thumb_ffmpeg(src: &Path, out: &Path, req: u32) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg（该图片格式需要 ffmpeg 解码）".to_string())?;
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(src)
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(format!("scale='min({req},iw)':-2"))
        .arg("-q:v")
        .arg("4")
        .arg("-y")
        .arg(out);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(out);
        return Err("ffmpeg 解码该图片失败".into());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let (w, h) = parse_ffmpeg_dims(&err);
    write_duration_meta_raw(out.with_extension("json"), None, w, h);
    Ok(())
}
/// 解析 EXIF Orientation（1..=8）
fn exif_orientation(bytes: &[u8]) -> Option<u32> {
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(bytes))
        .ok()?;
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
}
/// 按 EXIF orientation 应用旋转/镜像
fn apply_orientation(img: image::DynamicImage, orient: u32) -> image::DynamicImage {
    match orient {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}
// ─── 视频缩略图（ffmpeg） ───
/// ffmpeg 手动指定路径（设置中指定；None = 自动检测）
fn ffmpeg_override() -> &'static Mutex<Option<PathBuf>> {
    static O: Mutex<Option<PathBuf>> = Mutex::new(None);
    &O
}
/// 设置 ffmpeg 手动路径（配置保存时由 config.rs 调用）
pub fn set_ffmpeg_path(p: Option<PathBuf>) {
    *ffmpeg_override().lock().unwrap() = p;
}
/// ffmpeg 可执行文件名
fn ffmpeg_name() -> &'static str {
    if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }
}
/// 在 PATH 或程序目录及常见安装位置中查找 ffmpeg 可执行文件
pub(crate) fn find_ffmpeg() -> Option<PathBuf> {
    // 1) 设置中手动指定的路径优先
    if let Some(p) = ffmpeg_override().lock().unwrap().clone() {
        if p.is_file() {
            return Some(p);
        }
    }
    // 2) PATH
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let exe = dir.join(ffmpeg_name());
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    // 3) 程序目录（随应用分发的 ffmpeg）
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            let cand = dir.join(ffmpeg_name());
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    // 4) 常见包管理器安装位置（winget / scoop / choco）
    let extra: Vec<PathBuf> = {
        let mut v = Vec::new();
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(&local).join(r"Microsoft\WinGet\Links").join(ffmpeg_name()));
            v.push(PathBuf::from(&local).join(r"Microsoft\WinGet\Packages").join(ffmpeg_name()));
            if let Ok(home) = std::env::var("USERPROFILE") {
                // scoop: %USERPROFILE%\scoop\shims 与 apps\ffmpeg\current\bin
                v.push(PathBuf::from(&home).join(r"scoop\shims").join(ffmpeg_name()));
                v.push(PathBuf::from(&home).join(r"scoop\apps\ffmpeg\current\bin").join(ffmpeg_name()));
            }
        }
        v.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin").join(ffmpeg_name()));
        v.push(PathBuf::from(r"C:\ffmpeg\bin").join(ffmpeg_name()));
        v
    };
    extra.into_iter().find(|p| p.is_file())
}
/// ffmpeg 检测结果（设置-行为页显示）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}
/// 检测 ffmpeg：查找可执行文件并尝试获取版本号
#[tauri::command]
pub async fn detect_ffmpeg() -> FfmpegInfo {
    let Some(exe) = find_ffmpeg() else {
        return FfmpegInfo { found: false, path: None, version: None };
    };
    // 取版本号（ffmpeg -version 首行）；失败不影响 found
    let version = {
        let mut cmd = std::process::Command::new(&exe);
        cmd.arg("-version");
        cmd.arg("-nostdin");
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .map(|l| l.trim().to_string())
            })
    };
    FfmpegInfo {
        found: true,
        path: Some(exe.to_string_lossy().into_owned()),
        version,
    }
}
/// 手动选择 ffmpeg 可执行文件（设置-行为页）
#[tauri::command]
pub async fn pick_ffmpeg(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("ffmpeg 可执行文件", if cfg!(windows) { &["exe"] } else { &["*"] })
        .blocking_pick_file()
        .ok_or_else(|| "未选择文件".to_string())?;
    let p = crate::utils::canonicalize_checked(&picked.to_string())?;
    if !p.is_file() {
        return Err("所选文件无效".into());
    }
    // 立即生效
    set_ffmpeg_path(Some(p.clone()));
    Ok(p.to_string_lossy().into_owned())
}
/// ffmpeg 抓取首帧（1s 处，避免黑帧）生成缩略图，并从 stderr 解析时长
/// -an/-sn/-dn 跳过音频/字幕/数据流解码，只处理视频流，显著加快首帧提取
fn make_video_thumb(src: &Path, out: &Path, req: u32) -> Result<(Option<f64>, (Option<u32>, Option<u32>)), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| {
        "未找到 ffmpeg，请安装并将其加入 PATH，或放置于程序目录".to_string()
    })?;
    let run = |seek: bool| {
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.arg("-hide_banner");
        cmd.arg("-nostdin");
        if seek {
            // -ss 放在 -i 之前：输入定位（关键帧级 seek），远快于精确 seek
            cmd.arg("-ss").arg("1");
        }
        cmd.arg("-i").arg(src)
            .arg("-an").arg("-sn").arg("-dn")
            .arg("-vf").arg(format!("scale='min({req},iw)':-2"))
            .arg("-frames:v").arg("1")
            .arg("-q:v").arg("4")
            .arg("-y")
            .arg(out);

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        cmd.output()
    };
    let mut output = run(true).map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    if !output.status.success() {
        // 起始 1s 超出视频长度等失败时回退到第 0 秒（同时仍解析时长）
        output = run(false).map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
        if !output.status.success() {
            return Err("ffmpeg 生成视频缩略图失败".into());
        }
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let duration = parse_ffmpeg_duration(&err);
    let (w, h) = parse_ffmpeg_dims(&err);
    Ok((duration, (w, h)))
}
/// 解析 ffmpeg stderr 中的 Duration 行 → 秒
pub(crate) fn parse_ffmpeg_duration(s: &str) -> Option<f64> {
    let idx = s.find("Duration:")?;
    let line = &s[idx + 9..];
    let rest = line.trim_start().split(',').next()?;
    let mut it = rest.split(':');
    let h: f64 = it.next()?.trim().parse().ok()?;
    let m: f64 = it.next()?.trim().parse().ok()?;
    let sec: f64 = it.next()?.trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}
/// 解析 ffmpeg stderr 中首个视频流的分辨率 "1920x1080"
pub(crate) fn parse_ffmpeg_dims(s: &str) -> (Option<u32>, Option<u32>) {
    for line in s.lines() {
        if line.contains("Video:") {
            for tok in line.split_whitespace() {
                let tok = tok.trim_matches(|c: char| !c.is_ascii_digit() && c != 'x');
                if let Some((a, b)) = tok.split_once('x') {
                    if let (Ok(w), Ok(h)) = (a.parse::<u32>(), b.parse::<u32>()) {
                        if w > 0 && h > 0 && w < 20000 && h < 20000 {
                            return (Some(w), Some(h));
                        }
                    }
                }
            }
            break;
        }
    }
    (None, None)
}
// ─── 伴随元数据（.json，与缩略图同名） ───
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ThumbMeta {
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
}
fn meta_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.json"))
}
fn write_duration_meta_raw(path: PathBuf, duration: Option<f64>, w: Option<u32>, h: Option<u32>) {
    let meta = ThumbMeta { duration, width: w, height: h };
    if let Ok(json) = serde_json::to_string(&meta) {
        let _ = std::fs::write(path, json);
    }
}
fn write_duration_meta(dir: &Path, key: &str, duration: f64, w: Option<u32>, h: Option<u32>) {
    write_duration_meta_raw(meta_path(dir, key), Some(duration), w, h);
}
fn read_duration_meta(dir: &Path, key: &str) -> Option<f64> {
    read_meta(dir, key).and_then(|m| m.duration)
}
fn read_dims_meta(dir: &Path, key: &str) -> (Option<u32>, Option<u32>) {
    match read_meta(dir, key) {
        Some(m) => (m.width, m.height),
        None => (None, None),
    }
}
fn read_meta(dir: &Path, key: &str) -> Option<ThumbMeta> {
    let json = std::fs::read_to_string(meta_path(dir, key)).ok()?;
    serde_json::from_str(&json).ok()
}

// ─── 测试 ───

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: f64 = 1024.0 * 1024.0;

    /// 按目标码率造出「大小 × 时长」自洽的一组参数。
    ///
    /// 必须这样造：`preview_window_secs` 是用 `size*8/dur` 反推码率的，
    /// 直接把「每秒字节数」当文件大小传进去，得到的码率会被时长再除一遍
    /// （第一版就是这么错的：8MB/s 传 size=8MiB 却配 dur=600，
    /// 实际码率算成 0.11MB/s，于是窗口顶到上限，看起来像「预算没生效」）。
    fn sized_for(bps_mib_s: f64, dur: f64) -> u64 {
        (bps_mib_s * MIB * dur) as u64
    }

    /// 低码率长片（1.6 Mbps 的压制版 .mkv/.ts，很常见）应该拿到窗口上限。
    /// 这是本次改动的**主要收益**：以前一律 30 秒，看两轮就循环。
    #[test]
    fn low_bitrate_gets_long_window() {
        let s = preview_window_secs(sized_for(0.2, 7200.0), 7200.0, 0.0);
        assert_eq!(s, PREVIEW_MAX_SECS, "0.2MB/s 按 24MiB 预算能装 120 秒，应取上限");
    }

    /// 高码率（320 Mbps 的 4K）必须退回下限，否则一个卡片预览就是 1.2 GB。
    #[test]
    fn high_bitrate_falls_back_to_floor() {
        let s = preview_window_secs(sized_for(40.0, 3600.0), 3600.0, 0.0);
        assert_eq!(s, PREVIEW_MIN_SECS, "40MB/s 连 30 秒都超预算，应取下限");
    }

    /// 中间值落点正确，且对预算线性敏感（不是写死的档位）。
    /// 0.5 MB/s → 24MiB/0.5MB = 50.3 秒 → 5 秒栅格取 50。
    #[test]
    fn mid_bitrate_scales_with_budget() {
        let s = preview_window_secs(sized_for(0.5, 600.0), 600.0, 0.0);
        assert_eq!(s, 50.0, "0.5MB/s 应落在预算算出的 50 秒的 5 秒栅格上");
    }

    /// **5 秒栅格**：同一文件必须每次算出逐位相同的秒数，否则
    /// `remux_path` 的缓存键（`{key}.prev{s}s@{start}.mp4`）会分裂成多个文件，
    /// 同一段内容被反复拷贝 —— 这是缓存正确性的前提，不是格式洁癖。
    #[test]
    fn window_is_quantized_to_5s_grid() {
        for bps_mb in [0.13, 0.37, 0.59, 0.71, 1.13, 1.97, 3.33] {
            let size = sized_for(bps_mb, 480.0);
            let a = preview_window_secs(size, 480.0, 0.0);
            let b = preview_window_secs(size, 480.0, 0.0);
            assert_eq!(a, b, "同一输入必须算出同一窗口（{bps_mb}MB/s）");
            assert_eq!(a % 5.0, 0.0, "{bps_mb}MB/s 算出的 {a} 未对齐到 5 秒栅格");
        }
    }

    /// 起播点贴近片尾时不能截出空片段，但也不能因此归零。
    #[test]
    fn never_runs_past_end_of_file() {
        // 100 秒的片子，从 95 秒起播 → 剩 5 秒，不足下限，给回下限 30
        assert_eq!(preview_window_secs(sized_for(0.5, 100.0), 100.0, 95.0), PREVIEW_MIN_SECS);
        // 从 10 秒起播、预算够 120 秒 → 只能到片尾，剩 90 秒
        assert_eq!(preview_window_secs(sized_for(0.2, 100.0), 100.0, 10.0), 90.0);
    }

    /// 时长/大小缺失（缩略图还没生成、文件正被占用）必须给兜底值而不是 0。
    /// 0 会让 `-t 0` 产出空 mp4，`<video>` 永远黑屏。
    #[test]
    fn missing_metadata_falls_back() {
        for (size, dur) in [(0u64, 0.0f64), (12345, 0.0), (0, 99.0), (0, f64::NAN), (0, -5.0)] {
            let s = preview_window_secs(size, dur, 0.0);
            assert!(s >= PREVIEW_MIN_SECS && s <= PREVIEW_MAX_SECS, "兜底越界: {s}");
        }
    }

    /// 负的 start（脏数据 / 进度被外部改坏）不能让窗口算成负数或 NaN。
    #[test]
    fn negative_start_is_clamped() {
        let s = preview_window_secs(sized_for(0.5, 600.0), 600.0, -100.0);
        assert!(s.is_finite() && s >= PREVIEW_MIN_SECS, "负 start 得出 {s}");
    }
}
