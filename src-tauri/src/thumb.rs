// ═══════════════════════════════════════════════════════
// thumb.rs — 缩略图生成与缓存
//   图片: image crate + EXIF 自动旋转; blake3 哈希做缓存 key
//   视频: ffmpeg 抓首帧; Semaphore 限制并发（可在设置中调整）
//   缓存目录: 默认 %APPDATA，可在设置中更改；支持统计/清理/LRU 淘汰
// ═══════════════════════════════════════════════════════
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use std::io::Read;
use serde::Serialize;
use tauri::Emitter;
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

// ─── 本地文件 HTTP 服务器 ───
/// web-demuxer 的 worker（data URL，origin=null）无法通过 Tauri asset 协议访问文件，
/// 因此启动一个本地 HTTP 服务器提供文件访问（支持 Range）。
static FILE_SERVER_PORT: OnceLock<u16> = OnceLock::new();

#[tauri::command]
pub fn get_file_server_port() -> u16 {
    *FILE_SERVER_PORT.get_or_init(|| start_file_server())
}

fn start_file_server() -> u16 {
    // 尝试绑定 14300~14399 端口
    for port in 14300u16..14400 {
        if let Ok(server) = tiny_http::Server::http(format!("127.0.0.1:{port}")) {
            std::thread::spawn(move || run_file_server(server));
            return port;
        }
    }
    0
}

fn run_file_server(server: tiny_http::Server) {
    for request in server.incoming_requests() {
        // 每个请求独立线程：流式转码响应会长时间阻塞，不能卡住其他文件请求
        std::thread::spawn(move || {
            handle_file_request(request);
        });
    }
}

fn handle_file_request(request: tiny_http::Request) {
        let url = request.url().to_string();

        // 流式转码端点: /stream/<id>
        if let Some(id_str) = url.strip_prefix("/stream/") {
            let id: u64 = id_str.parse().unwrap_or(0);
            let entry = transcode_streams()
                .lock()
                .unwrap()
                .get_mut(&id)
                .and_then(|e| e.receiver.take());

            match entry {
                Some(rx) => {
                    let reader = ChannelReader {
                        receiver: rx,
                        current: std::io::Cursor::new(Vec::new()),
                    };
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        vec![
                            tiny_http::Header::from_bytes(&b"Content-Type"[..], b"video/mp4").unwrap(),
                            tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], b"none").unwrap(),
                            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap(),
                            tiny_http::Header::from_bytes(&b"Cache-Control"[..], b"no-store").unwrap(),
                        ],
                        reader,
                        None,
                        None,
                    );
                    let _ = request.respond(response);
                }
                None => {
                    let _ = request.respond(tiny_http::Response::empty(404));
                }
            }
            return;
        }

        // URL 格式: /<base64-encoded-path>
        let path_b64 = url.trim_start_matches('/');
        use base64::Engine;
        let path_bytes = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(path_b64) {
            Ok(b) => b,
            Err(_) => {
                let _ = request.respond(tiny_http::Response::empty(400));
                return;
            }
        };
        let path = match String::from_utf8(path_bytes) {
            Ok(s) => s,
            Err(_) => {
                let _ = request.respond(tiny_http::Response::empty(400));
                return;
            }
        };
        let file_path = Path::new(&path);
        if !file_path.is_file() {
            let _ = request.respond(tiny_http::Response::empty(404));
            return;
        }
        match std::fs::File::open(file_path) {
            Ok(file) => {
                let metadata = match file.metadata() {
                    Ok(m) => m,
                    Err(_) => {
                        let _ = request.respond(tiny_http::Response::empty(500));
                        return;
                    }
                };
                let file_size = metadata.len();
                let content_type = match file_path.extension().and_then(|e| e.to_str()) {
                    Some("mp4") | Some("m4v") => "video/mp4",
                    Some("webm") => "video/webm",
                    Some("ts") | Some("m2ts") | Some("mts") => "video/mp2t",
                    Some("mkv") => "video/x-matroska",
                    Some("avi") => "video/x-msvideo",
                    Some("flv") => "video/x-flv",
                    Some("mov") => "video/quicktime",
                    Some("m4a") | Some("aac") => "audio/mp4",
                    Some("mp3") => "audio/mpeg",
                    Some("ogg") | Some("opus") => "audio/ogg",
                    Some("wav") => "audio/wav",
                    Some("flac") => "audio/flac",
                    _ => "application/octet-stream",
                };

                // 解析 Range 头
                let range_header = request.headers().iter()
                    .find(|h| h.field.equiv("Range"))
                    .and_then(|h| h.value.as_str().strip_prefix("bytes="));

                if let Some(range) = range_header {
                    let (start, end) = if let Some((s, e)) = range.split_once('-') {
                        let s: u64 = s.parse().unwrap_or(0);
                        let e: u64 = if e.is_empty() { file_size - 1 } else { e.parse().unwrap_or(file_size - 1) };
                        (s, e.min(file_size - 1))
                    } else {
                        (0, file_size - 1)
                    };
                    if start > end {
                        let _ = request.respond(tiny_http::Response::empty(416));
                        return;
                    }
                    let length = end - start + 1;
                    let mut file = file;
                    use std::io::Seek;
                    let _ = file.seek(std::io::SeekFrom::Start(start));
                    let limited = file.take(length);
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(206),
                        vec![
                            tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap(),
                            tiny_http::Header::from_bytes(&b"Content-Length"[..], length.to_string().as_bytes()).unwrap(),
                            tiny_http::Header::from_bytes(&b"Content-Range"[..], format!("bytes {start}-{end}/{file_size}").as_bytes()).unwrap(),
                            tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], b"bytes").unwrap(),
                            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap(),
                        ],
                        limited,
                        Some(length as usize),
                        None,
                    );
                    let _ = request.respond(response);
                } else {
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        vec![
                            tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap(),
                            tiny_http::Header::from_bytes(&b"Content-Length"[..], file_size.to_string().as_bytes()).unwrap(),
                            tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], b"bytes").unwrap(),
                            tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap(),
                        ],
                        file,
                        Some(file_size as usize),
                        None,
                    );
                    let _ = request.respond(response);
                }
            }
            Err(_) => {
                let _ = request.respond(tiny_http::Response::empty(500));
            }
        }
}

// ─── 流式转码（边转边播）───
/// 转码流条目：ffmpeg stdout 通过 channel 推给 HTTP 响应
struct StreamEntry {
    receiver: Option<PeekableReceiver>,
    child: Option<Arc<Mutex<std::process::Child>>>,
}

static TRANSCODE_STREAMS: OnceLock<Mutex<HashMap<u64, StreamEntry>>> = OnceLock::new();
fn transcode_streams() -> &'static Mutex<HashMap<u64, StreamEntry>> {
    TRANSCODE_STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前活跃的流式转码 ID（用于快速停止）
static ACTIVE_STREAM_ID: OnceLock<Mutex<Option<u64>>> = OnceLock::new();
fn active_stream_id() -> &'static Mutex<Option<u64>> {
    ACTIVE_STREAM_ID.get_or_init(|| Mutex::new(None))
}

/// 带预读缓冲的 Receiver：第一个数据块可被 peek 后放回
struct PeekableReceiver {
    first: Option<Vec<u8>>,
    inner: mpsc::Receiver<Vec<u8>>,
}

impl PeekableReceiver {
    fn recv(&mut self) -> Result<Vec<u8>, mpsc::RecvError> {
        if let Some(data) = self.first.take() {
            return Ok(data);
        }
        self.inner.recv()
    }
}

/// 从 PeekableReceiver 读取数据的 Reader，用于 tiny_http 流式响应
struct ChannelReader {
    receiver: PeekableReceiver,
    current: std::io::Cursor<Vec<u8>>,
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if (self.current.position() as usize) < self.current.get_ref().len() {
            return self.current.read(buf);
        }
        match self.receiver.recv() {
            Ok(data) => {
                self.current = std::io::Cursor::new(data);
                self.current.read(buf)
            }
            Err(_) => Ok(0), // 流结束
        }
    }
}

/// 硬件加速方案（解码器 + 编码器配对）
#[derive(Clone, Copy)]
enum Accel {
    /// NVIDIA：CUDA 解码显存帧直通 NVENC
    Nvenc,
    /// Intel：QSV 解码帧直通 QSV 编码器
    Qsv,
    /// AMD：D3D11VA 解码纹理直通 AMF 编码器
    Amf,
}

impl Accel {
    /// 零拷贝参数：(hwaccel, hwaccel_output_format, encoder, preset)
    /// 解码帧留在显存/显卡内存，直接喂给同族硬件编码器，不经过系统内存
    fn zero_copy_args(self) -> (&'static str, &'static str, &'static str, &'static [&'static str]) {
        let (enc, preset) = self.encoder_args();
        match self {
            Accel::Nvenc => ("cuda", "cuda", enc, preset),
            Accel::Qsv => ("qsv", "qsv", enc, preset),
            Accel::Amf => ("d3d11va", "d3d11", enc, preset),
        }
    }
    /// 编码器及参数（预设 + 质量控制），零拷贝与内存中转两档共用。
    /// 不设质量控制时 NVENC 落到 SDK 默认码率（4K 源实测仅 ~1.5Mbps，画面严重模糊），
    /// 统一用恒定质量 VBR：cq26 对 4K 实测 ~20Mbps、166fps（1.38x 实时，4K120 源可跟上）
    fn encoder_args(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Accel::Nvenc => ("h264_nvenc", &["-preset", "p2", "-rc", "vbr", "-cq", "26", "-b:v", "0"]),
            Accel::Qsv => ("h264_qsv", &["-preset", "veryfast", "-global_quality", "26"]),
            Accel::Amf => ("h264_amf", &["-quality", "speed"]),
        }
    }
    /// GPU 端位深转换滤镜：10bit 解码帧（p016 等）在显存内转成 nv12 再进编码器，
    /// 保持零拷贝链路不断；8bit 源为直通，开销可忽略
    fn gpu_filter(self) -> Option<&'static str> {
        match self {
            Accel::Nvenc => Some("scale_cuda=format=nv12"),
            Accel::Qsv => Some("scale_qsv=format=nv12"),
            // d3d11va 无对应位深转换滤镜，AMF 10bit 源由内存中转档兜底
            Accel::Amf => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Accel::Nvenc => "h264_nvenc · GPU 零拷贝",
            Accel::Qsv => "h264_qsv · GPU 零拷贝",
            Accel::Amf => "h264_amf · GPU 零拷贝",
        }
    }
    fn roundtrip_label(self) -> &'static str {
        match self {
            Accel::Nvenc => "h264_nvenc · GPU 转码",
            Accel::Qsv => "h264_qsv · GPU 转码",
            Accel::Amf => "h264_amf · GPU 转码",
        }
    }
    fn hwaccel(self) -> &'static str {
        match self {
            Accel::Nvenc => "cuda",
            Accel::Qsv => "qsv",
            Accel::Amf => "d3d11va",
        }
    }
}

/// 转码编码模式（按此顺序回退尝试）
#[derive(Clone, Copy)]
enum EncodeMode {
    /// 硬解显存帧直通硬件编码器（GPU 零拷贝，位深转换也在显存内完成）
    ZeroCopy(Accel),
    /// 硬解后帧下载到内存、CPU 仅做位深转换，再交由 GPU 编码（零拷贝失败时兜底）
    HwRoundTrip(Accel),
    /// 纯软解软编
    Software,
}

impl EncodeMode {
    fn label(self) -> &'static str {
        match self {
            EncodeMode::ZeroCopy(a) => a.label(),
            EncodeMode::HwRoundTrip(a) => a.roundtrip_label(),
            EncodeMode::Software => "libx264 · CPU 软编",
        }
    }
}

/// 探测 ffmpeg 编译产物中可用的硬件编码器。
/// 注意：`-encoders` 列表只代表编译进了哪些编码器，与本机实际硬件无关，
/// 因此仅作候选提示，真实可用性由运行时快速失败探测决定。
fn detect_hw_encoder(ffmpeg: &Path) -> Option<Accel> {
    let output = std::process::Command::new(ffmpeg)
        .arg("-hide_banner")
        .arg("-encoders")
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    if s.contains("h264_nvenc") {
        Some(Accel::Nvenc)
    } else if s.contains("h264_qsv") {
        Some(Accel::Qsv)
    } else if s.contains("h264_amf") {
        Some(Accel::Amf)
    } else {
        None
    }
}

/// 构建 ffmpeg 转码命令
fn build_transcode_cmd(
    ffmpeg: &Path,
    src: &Path,
    mode: EncodeMode,
    seek: Option<f64>,
) -> std::process::Command {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-nostdin");
    // 进度跳转：demuxer 级 -ss 置于 -i 之前（快速定位关键帧），
    // 输出时间轴从 0 重新计起，浏览器侧由前端叠加偏移换算绝对时间
    if let Some(t) = seek {
        cmd.arg("-ss").arg(format!("{t:.3}"));
    }
    match mode {
        EncodeMode::ZeroCopy(a) => {
            let (hw, fmt, enc, preset) = a.zero_copy_args();
            cmd.arg("-hwaccel").arg(hw)
                .arg("-hwaccel_output_format").arg(fmt);
            cmd.arg("-i").arg(src)
                .arg("-map").arg("0:v:0")
                .arg("-map").arg("0:a:0?");
            // GPU 滤镜在显存内把 10bit 解码帧转成 nv12，编码器只吃 8bit；
            // 不设 -pix_fmt，强制软件像素格式会引入显存↔内存往返，破坏零拷贝
            if let Some(f) = a.gpu_filter() {
                cmd.arg("-vf").arg(f);
            }
            cmd.arg("-c:v").arg(enc);
            for p in preset {
                cmd.arg(p);
            }
        }
        EncodeMode::HwRoundTrip(a) => {
            let (enc, preset) = a.encoder_args();
            cmd.arg("-hwaccel").arg(a.hwaccel());
            cmd.arg("-i").arg(src)
                .arg("-map").arg("0:v:0")
                .arg("-map").arg("0:a:0?")
                // 硬解帧下载到内存后统一转 nv12（10bit→8bit 在 CPU 完成，仅此一步），
                // 编码仍走 GPU：nvenc/qsv/amf 均接受系统内存 nv12 并自行上传
                .arg("-vf").arg("format=nv12")
                .arg("-c:v").arg(enc);
            for p in preset {
                cmd.arg(p);
            }
        }
        EncodeMode::Software => {
            cmd.arg("-i").arg(src)
                .arg("-map").arg("0:v:0")
                .arg("-map").arg("0:a:0?")
                .arg("-c:v").arg("libx264")
                .arg("-preset").arg("veryfast")
                .arg("-pix_fmt").arg("yuv420p");
        }
    }
    cmd.arg("-c:a").arg("aac")
        .arg("-b:a").arg("128k")
        .arg("-f").arg("mp4")
        .arg("-movflags").arg("+frag_keyframe+empty_moov+default_base_moof")
        .arg("pipe:1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW (0x08000000) | BELOW_NORMAL_PRIORITY_CLASS (0x00004000)
        // 降优先级避免转码抢占 UI/浏览器渲染线程的 CPU 时间片
        const FLAGS: u32 = 0x08000000 | 0x00004000;
        cmd.creation_flags(FLAGS);
    }
    cmd
}

/// 启动 ffmpeg 转码，返回 (child, receiver)
/// 使用有界 channel（32 块 ≈ 2MB），浏览器缓冲足够时 ffmpeg 自动背压等待
fn spawn_transcode(
    cmd: &mut std::process::Command,
) -> Result<(Arc<Mutex<std::process::Child>>, mpsc::Receiver<Vec<u8>>), String> {
    let (tx, rx) = mpsc::sync_channel(32);
    let child = Arc::new(Mutex::new(cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败: {e}"))?));
    let mut stdout = child.lock().unwrap().stdout.take().ok_or("无法获取 stdout")?;

    let child_clone = child.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut buf = [0u8; 65536];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // 接收端已关闭
                    }
                }
                Err(_) => break,
            }
        }
        drop(tx);
        let _ = child_clone.lock().unwrap().wait();
    });

    Ok((child, rx))
}

/// fMP4 的 moov 头在首帧编码之前就会写出，不能作为转码成功的依据；
/// 出现首个媒体分片标记 moof 才说明第一帧真正编码成功。
/// 某些失败（如 10bit 源直通编码器）恰好死在「头已出、帧全无」，按头判定会交付死流。
fn contains_moof(buf: &[u8]) -> bool {
    buf.windows(4).any(|w| w == b"moof")
}

/// 等待转码管线的首个有效输出（累积到出现 moof 为止）。
/// ffmpeg 提前退出（硬件不可用/格式组合不支持）时立即判定失败，
/// 不干等整个超时；仅在"进程活着但迟迟无有效输出"时等满 timeout。
/// 返回值是已累积的输出数据，调用方需将其送入 PeekableReceiver。
fn wait_first_output(
    child: &Arc<Mutex<std::process::Child>>,
    rx: &mut mpsc::Receiver<Vec<u8>>,
    timeout: std::time::Duration,
) -> Option<Vec<u8>> {
    let start = std::time::Instant::now();
    let mut acc: Vec<u8> = Vec::new();
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(data) => {
                acc.extend_from_slice(&data);
                if contains_moof(&acc) {
                    return Some(acc); // 首帧编码成功，进程健康
                }
                // 仅为防累积失控：moov 头加空转错误输出不会超过几十 KB
                if acc.len() > 4 * 1024 * 1024 {
                    return None;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // 进程已退出：若已产出媒体分片（文件极短转完即退）仍算成功
                return if contains_moof(&acc) { Some(acc) } else { None };
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let exited = child.lock().unwrap().try_wait().ok().flatten().is_some();
                if exited || start.elapsed() >= timeout {
                    return if contains_moof(&acc) { Some(acc) } else { None };
                }
            }
        }
    }
}

/// 转码流 IPC 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeInfo {
    pub id: u64,
    pub engine: String,
}

/// 转码请求代际：每次新管线/停止请求自增，过期管线注册前自行作废，
/// 避免「上一个转码尚未完成时用户又触发跳转/切换」导致旧流覆盖新流
static TRANSCODE_GEN: AtomicU64 = AtomicU64::new(0);
/// 流 ID 发号器：小整数即可（HTTP URL / IPC 往返），
/// 不能用时间戳纳秒——超过 JS 安全整数范围，经 JSON 序列化会精度丢失导致 404
static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

/// 启动流式转码管线，输出 fMP4 到 HTTP 流。
/// 前端用 <video src="http://127.0.0.1:port/stream/<id>"> 边转边播。
/// 候选链：GPU 零拷贝（显存内转 8bit）→ GPU 解码 + GPU 编码（内存中转）→ 纯软编，
/// 每级快速失败探测后自动降级。
/// seek 为目标秒数（进度跳转/续播），重启转码从该位置起播。
fn start_transcode_pipeline(path: &str, seek: Option<f64>) -> Result<TranscodeInfo, String> {
    // 先停掉上一个流（切换视频/进度跳转时），再捕获本管线代际：
    // 之后任何新的管线/停止请求都会让代际前移，使本管线注册前作废
    stop_transcode_stream_inner();
    let gen = TRANSCODE_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let src = crate::utils::canonicalize_checked(path)?;

    let accel = detect_hw_encoder(&ffmpeg);

    let mut modes: Vec<EncodeMode> = Vec::new();
    if let Some(a) = accel {
        modes.push(EncodeMode::ZeroCopy(a));
        modes.push(EncodeMode::HwRoundTrip(a));
    }
    modes.push(EncodeMode::Software);

    let mut started: Option<(Arc<Mutex<std::process::Child>>, PeekableReceiver, &'static str)> = None;
    for (i, mode) in modes.iter().enumerate() {
        // 非末级 6s：进程提前退出仍会秒级快速判失败（主导失败模式），
        // 上限只兜底「活着却无输出」的病态情况。4s 会误杀即将成功的候选：
        // 4K/高帧率 10bit 源首个媒体分片可达 4~5s（实测一个文件 moof 在 4.2s）
        let timeout = if i + 1 == modes.len() { 15 } else { 6 };
        let mut cmd = build_transcode_cmd(&ffmpeg, &src, *mode, seek);
        let Ok((child, rx)) = spawn_transcode(&mut cmd) else { continue };
        let mut rx = rx;
        match wait_first_output(&child, &mut rx, std::time::Duration::from_secs(timeout)) {
            Some(chunk) => {
                let peekable = PeekableReceiver { first: Some(chunk), inner: rx };
                started = Some((child, peekable, mode.label()));
                break;
            }
            None => {
                let _ = child.lock().unwrap().kill();
                let _ = child.lock().unwrap().wait();
            }
        }
    }

    let (child, peekable, engine) =
        started.ok_or_else(|| "转码启动失败：所有编码模式均无输出".to_string())?;

    // 注册前校验代际：期间若有新管线/停止请求介入，本管线直接作废
    if TRANSCODE_GEN.load(Ordering::SeqCst) != gen {
        let _ = child.lock().unwrap().kill();
        let _ = child.lock().unwrap().wait();
        return Err("转码请求已被更新操作取代".to_string());
    }

    let id = NEXT_STREAM_ID.fetch_add(1, Ordering::SeqCst);

    transcode_streams().lock().unwrap().insert(id, StreamEntry {
        receiver: Some(peekable),
        child: Some(child),
    });
    *active_stream_id().lock().unwrap() = Some(id);

    Ok(TranscodeInfo { id, engine: engine.to_string() })
}

/// 启动 ffmpeg 硬件转码，输出 fMP4 到 HTTP 流。
/// seekSecs：跳转目标秒数（进度条拖动/续播），重启转码从该位置起播。
#[tauri::command]
pub async fn transcode_stream(path: String, seek_secs: Option<f64>) -> Result<TranscodeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_transcode_pipeline(&path, seek_secs))
        .await
        .map_err(|e| format!("转码任务异常退出: {e}"))?
}

/// 停止当前流式转码（关闭查看器/切换视频时调用）
#[tauri::command]
pub fn stop_transcode_stream() {
    stop_transcode_stream_inner();
}

fn stop_transcode_stream_inner() {
    // 代际自增：作废仍在启动中的转码管线
    TRANSCODE_GEN.fetch_add(1, Ordering::SeqCst);
    let id = active_stream_id().lock().unwrap().take();
    if let Some(id) = id {
        if let Some(entry) = transcode_streams().lock().unwrap().remove(&id) {
            // kill ffmpeg 子进程
            if let Some(child) = entry.child {
                let _ = child.lock().unwrap().kill();
            }
            // receiver drop 后，读取线程的 tx.send 会失败，线程自动退出
        }
    }
}

/// 取消所有正在运行的预览重封装（全屏播放开始时调用，释放 CPU/IO）
#[tauri::command]
pub fn cancel_all_previews() {
    // 标记所有 tag=="prev" 的任务为取消
    let mut running_paths: Vec<PathBuf> = Vec::new();
    {
        let running = REMUX_RUNNING.lock().unwrap();
        for job in running.iter() {
            if job.tag == "prev" {
                running_paths.push(job.src.clone());
            }
        }
    }
    let mut cancels = REMUX_CANCEL.lock().unwrap();
    for p in &running_paths {
        cancels.push((p.clone(), "prev"));
    }
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

/// 提取指定音轨并转码为 AAC（m4a），供 web-demuxer 不支持的音轨使用。
/// `audio_index` 为音轨在源文件中的索引（从 0 开始）。
#[tauri::command]
pub async fn extract_audio_track(
    app: tauri::AppHandle,
    path: String,
    audio_index: u32,
) -> Result<String, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let dir = cache_dir(&app, "video")?;
    let key = hash_key(&src);
    let out = dir.join(format!("{key}.a{audio_index}.m4a"));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let slots = slots_current();
    let _permit = slots.acquire().await.map_err(|e| format!("队列异常: {e}"))?;
    let (src2, out2) = (src.clone(), out.clone());
    tauri::async_runtime::spawn_blocking(move || {
        transcode_audio_to_aac(&src2, &out2, audio_index)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    Ok(out.to_string_lossy().into_owned())
}

/// 用 ffmpeg 把指定音轨转码为 AAC-LC m4a。
fn transcode_audio_to_aac(src: &Path, out: &Path, audio_index: u32) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg（音轨转码需要）".to_string())?;
    let tmp = part_path(out);
    let _ = std::fs::remove_file(&tmp);
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(src)
        .arg("-map")
        .arg(format!("0:a:{audio_index}"))
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
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

    let status = cmd
        .status()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "音轨转码失败: ffmpeg 退出码 {}",
            status.code().unwrap_or(-1)
        ));
    }
    std::fs::rename(&tmp, out).map_err(|e| format!("写入缓存失败: {e}"))?;
    Ok(())
}

/// 提取纯视频流（丢弃所有音轨）为 mp4，供 web-demuxer 播放。
/// 适用于源文件音轨参数损坏导致 web-demuxer 连带视频流也读不出的情况。
/// 视频直接 copy，速度极快。
#[tauri::command]
pub async fn extract_video_only(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let dir = cache_dir(&app, "video")?;
    let key = hash_key(&src);
    let out = dir.join(format!("{key}.vonly.mp4"));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let slots = slots_current();
    let _permit = slots.acquire().await.map_err(|e| format!("队列异常: {e}"))?;
    let (src2, out2) = (src.clone(), out.clone());
    tauri::async_runtime::spawn_blocking(move || {
        extract_video_only_inner(&src2, &out2)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    Ok(out.to_string_lossy().into_owned())
}

fn extract_video_only_inner(src: &Path, out: &Path) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let tmp = part_path(out);
    let _ = std::fs::remove_file(&tmp);
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-y")
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(src)
        .arg("-map").arg("0:v:0")
        .arg("-c:v").arg("copy")
        .arg("-an")
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
    let status = cmd
        .status()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    if !status.success() {
        return Err(format!(
            "提取视频失败: ffmpeg 退出码 {}",
            status.code().unwrap_or(-1)
        ));
    }
    std::fs::rename(&tmp, out).map_err(|e| format!("写入缓存失败: {e}"))?;
    Ok(())
}

// ─── 实时音频流 ───
/// 全局音频流取消标志
static AUDIO_STREAM_CANCEL: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
fn audio_cancel_flag() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    AUDIO_STREAM_CANCEL.get_or_init(|| Mutex::new(None))
}

/// 实时转码音频为 fMP4 并通过 Tauri 事件推送给前端（MSE 播放）。
/// ffmpeg 输出 fragmented mp4 到 stdout，Rust 分块 emit "audio-chunk"。
#[tauri::command]
pub async fn stream_audio(app: tauri::AppHandle, path: String, audio_index: u32) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let src = crate::utils::canonicalize_checked(&path)?;

    // 先停掉上一个流
    stop_audio_stream_inner();

    let cancel = Arc::new(AtomicBool::new(false));
    *audio_cancel_flag().lock().unwrap() = Some(cancel.clone());

    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i").arg(&src)
        .arg("-map").arg(format!("0:a:{}", audio_index))
        .arg("-c:a").arg("aac")
        .arg("-b:a").arg("128k")
        .arg("-f").arg("mp4")
        .arg("-movflags").arg("+frag_keyframe+empty_moov+default_base_moof")
        .arg("pipe:1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("无法获取 stdout")?;

    let app2 = app.clone();
    let cancel2 = cancel.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut buf = [0u8; 65536];
        loop {
            if cancel2.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("audio-chunk", b64);
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit("audio-end", ());
    });

    Ok(())
}

/// 停止实时音频流。
#[tauri::command]
pub fn stop_audio_stream() {
    stop_audio_stream_inner();
}

fn stop_audio_stream_inner() {
    if let Some(cancel) = audio_cancel_flag().lock().unwrap().take() {
        cancel.store(true, Ordering::Relaxed);
    }
}

/// 视频编码不被浏览器/MSE 支持时（如 hevc/vp9/av1），转码为 H.264 + AAC 的 mp4。
/// 优先尝试硬件编码器（h264_qsv / h264_nvenc / h264_amf），失败回退 libx264。
#[tauri::command]
pub async fn transcode_to_playable(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let dir = cache_dir(&app, "video")?;
    let key = hash_key(&src);
    let out = dir.join(format!("{key}.x264.mp4"));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let slots = slots_current();
    let _permit = slots.acquire().await.map_err(|e| format!("队列异常: {e}"))?;
    let (src2, out2) = (src.clone(), out.clone());
    tauri::async_runtime::spawn_blocking(move || {
        transcode_to_h264(&src2, &out2)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    Ok(out.to_string_lossy().into_owned())
}

/// 转码为 H.264 + AAC mp4，优先硬件编码。
fn transcode_to_h264(src: &Path, out: &Path) -> Result<(), String> {
    let ffmpeg = find_ffmpeg().ok_or_else(|| "未找到 ffmpeg（视频转码需要）".to_string())?;
    let tmp = part_path(out);
    let _ = std::fs::remove_file(&tmp);

    // 探测第一个 aac 音轨：有则直接 -c:a copy，跳过音频转码
    let aac_idx = find_first_aac_audio(src);
    // 探测视频是否已经是 h264：是则 -c:v copy，无需重编码
    let video_is_h264 = probe_video_codec(src).map_or(false, |c| c == "h264");

    if video_is_h264 {
        // 视频已是 h264：直接 copy，只处理音频
        if try_direct_copy(&ffmpeg, src, &tmp, aac_idx).is_ok() {
            std::fs::rename(&tmp, out).map_err(|e| format!("写入缓存失败: {e}"))?;
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
    }

    // 需要重编码视频：尝试硬件编码器，失败则用 libx264
    let hw_encoders = ["h264_qsv", "h264_nvenc", "h264_amf"];
    for enc in hw_encoders {
        if try_transcode(&ffmpeg, src, &tmp, enc, aac_idx).is_ok() {
            std::fs::rename(&tmp, out).map_err(|e| format!("写入缓存失败: {e}"))?;
            return Ok(());
        }
        let _ = std::fs::remove_file(&tmp);
    }
    // 回退 libx264
    try_transcode(&ffmpeg, src, &tmp, "libx264", aac_idx)?;
    std::fs::rename(&tmp, out).map_err(|e| format!("写入缓存失败: {e}"))?;
    Ok(())
}

/// 探测视频编码名称。
fn probe_video_codec(src: &Path) -> Option<String> {
    let ff = find_ffmpeg()?;
    let probe = ff.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if !probe.is_file() {
        return None;
    }
    let mut cmd = std::process::Command::new(probe);
    cmd.arg("-v").arg("error")
        .arg("-select_streams").arg("v:0")
        .arg("-show_entries").arg("stream=codec_name")
        .arg("-of").arg("csv=p=0")
        .arg(src);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let codec = s.lines().next()?.trim().to_string();
    if codec.is_empty() { None } else { Some(codec) }
}

/// 视频直接 copy（源已是 h264），只处理音频。
/// 带音频失败时自动回退到不带音频（-an）。
fn try_direct_copy(ffmpeg: &Path, src: &Path, tmp: &Path, aac_idx: Option<usize>) -> Result<(), String> {
    let args = build_ffmpeg_args(src, tmp, "copy", aac_idx, false);
    if run_ffmpeg(ffmpeg, &args).is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(tmp);
    // 回退：不带音频
    let args_noaudio = build_ffmpeg_args(src, tmp, "copy", None, true);
    run_ffmpeg(ffmpeg, &args_noaudio)
}

/// 用 ffprobe 找第一个 aac 音轨的索引；找不到返回 None。
fn find_first_aac_audio(src: &Path) -> Option<usize> {
    let ff = find_ffmpeg()?;
    let probe = ff.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
    if !probe.is_file() {
        return None;
    }
    let mut cmd = std::process::Command::new(probe);
    cmd.arg("-v").arg("error")
        .arg("-select_streams").arg("a")
        .arg("-show_entries").arg("stream=index,codec_name")
        .arg("-of").arg("csv=p=0")
        .arg(src);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() >= 2 && parts[1].trim() == "aac" {
            if let Ok(idx) = parts[0].trim().parse::<usize>() {
                return Some(idx);
            }
        }
    }
    None
}

fn try_transcode(ffmpeg: &Path, src: &Path, tmp: &Path, vcodec: &str, aac_idx: Option<usize>) -> Result<(), String> {
    let args = build_ffmpeg_args(src, tmp, vcodec, aac_idx, false);
    if run_ffmpeg(ffmpeg, &args).is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(tmp);
    // 回退：不带音频
    let args_noaudio = build_ffmpeg_args(src, tmp, vcodec, None, true);
    run_ffmpeg(ffmpeg, &args_noaudio)
}

/// 构建 ffmpeg 参数。`no_audio` 为 true 时忽略所有音轨。
fn build_ffmpeg_args(src: &Path, tmp: &Path, vcodec: &str, aac_idx: Option<usize>, no_audio: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(), "-hide_banner".into(), "-nostdin".into(),
        "-i".into(), src.to_string_lossy().into_owned(),
        "-map".into(), "0:v:0".into(),
        "-c:v".into(), vcodec.into(),
    ];
    if vcodec != "copy" {
        // 10bit 输入硬件编码器不支持，统一转 8bit
        args.push("-pix_fmt".into());
        args.push("yuv420p".into());
        if vcodec == "libx264" {
            args.push("-preset".into());
            args.push("veryfast".into());
            args.push("-crf".into());
            args.push("23".into());
        }
    }
    if no_audio {
        args.push("-an".into());
    } else if let Some(idx) = aac_idx {
        args.push("-map".into());
        args.push(format!("0:a:{}", idx));
        args.push("-c:a".into());
        args.push("copy".into());
    } else {
        args.push("-map".into());
        args.push("0:a:0".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("128k".into());
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-f".into());
    args.push("mp4".into());
    args.push(tmp.to_string_lossy().into_owned());
    args
}

/// 运行 ffmpeg，失败时打印 stderr 末尾便于诊断。
fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(args);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        eprintln!("[ffmpeg] failed: {}", tail);
        return Err(format!("ffmpeg 退出码 {}: {}", out.status.code().unwrap_or(-1), tail.lines().last().unwrap_or("")));
    }
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

// ═══════════════ 图片变换写回原图（旋转/翻转实装） ═══════════════

/// 变换写回 IPC 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformedImage {
    pub width: u32,
    pub height: u32,
}

/// 旋转/翻转后写回原图。ops 按序应用（像素坐标系）：
/// rotate_cw（顺时针 90°）/ rotate_180 / rotate_ccw（逆时针 90°）/ flip_h / flip_v。
/// 支持 jpg/png/bmp/tiff：png/bmp/tiff 无损重编码，JPEG 质量 92 重编码并保留 EXIF
/// （像素转正后剔除 Orientation 标签）。gif/webp/avif/heic 等不支持（动图/未启用编码器）。
#[tauri::command]
pub async fn transform_image(
    app: tauri::AppHandle,
    path: String,
    ops: Vec<String>,
) -> Result<TransformedImage, String> {
    tauri::async_runtime::spawn_blocking(move || transform_image_inner(&app, &path, &ops))
        .await
        .map_err(|e| format!("变换任务异常退出: {e}"))?
}

fn transform_image_inner(app: &tauri::AppHandle, path: &str, ops: &[String]) -> Result<TransformedImage, String> {
    if ops.is_empty() {
        return Err("没有要应用的变换".into());
    }
    let src = crate::utils::canonicalize_checked(path)?;
    if !src.is_file() {
        return Err(format!("文件不存在: {}", src.display()));
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let fmt = match ext.as_str() {
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "png" => image::ImageFormat::Png,
        "bmp" => image::ImageFormat::Bmp,
        "tif" | "tiff" => image::ImageFormat::Tiff,
        _ => return Err(format!(".{ext} 暂不支持旋转/翻转保存（仅 jpg/png/bmp/tiff）")),
    };

    // 写回前的缓存 key（含旧 mtime）：mtime 变化后新缩略图走新 key，旧缓存文件需清理
    let old_hash = hash_key(&src);
    let bytes = std::fs::read(&src).map_err(|e| format!("读取失败: {e}"))?;

    // 解码 + EXIF 方向转正（转正后 Orientation 标签失效，JPEG 写回时剔除）
    let mut img = image::load_from_memory(&bytes).map_err(|e| format!("解码失败: {e}"))?;
    let mut exif_out: Option<Vec<u8>> = None;
    if fmt == image::ImageFormat::Jpeg {
        if let Some(o) = exif_orientation(&bytes) {
            img = apply_orientation(img, o);
        }
        exif_out = exif_without_orientation(&bytes);
    }

    for op in ops {
        img = match op.as_str() {
            "rotate_cw" => img.rotate90(),
            "rotate_180" => img.rotate180(),
            "rotate_ccw" => img.rotate270(),
            "flip_h" => img.fliph(),
            "flip_v" => img.flipv(),
            other => return Err(format!("未知变换: {other}")),
        };
    }
    let (w, h) = (img.width(), img.height());

    // 编码：JPEG 带 EXIF 插入；其余格式直接按原格式重编码
    let mut buf: Vec<u8> = Vec::with_capacity(bytes.len() + 64 * 1024);
    if fmt == image::ImageFormat::Jpeg {
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92);
        img.write_with_encoder(enc).map_err(|e| format!("JPEG 编码失败: {e}"))?;
        if let Some(ex) = &exif_out {
            jpeg_insert_exif(&mut buf, ex);
        }
    } else {
        img.write_to(&mut std::io::Cursor::new(&mut buf), fmt)
            .map_err(|e| format!("编码失败: {e}"))?;
    }

    // 原子写回：写同目录临时文件 → rename 覆盖（Windows 上 rename 不覆盖已存在目标，先删再试）
    let name = src.file_name().ok_or("无效文件名")?.to_string_lossy().into_owned();
    let tmp = src.with_file_name(format!("{name}.rvtmp"));
    std::fs::write(&tmp, &buf).map_err(|e| format!("写入临时文件失败: {e}"))?;
    if std::fs::rename(&tmp, &src).is_err() {
        let removed = std::fs::remove_file(&src).is_ok();
        let ok = removed && std::fs::rename(&tmp, &src).is_ok();
        if !ok {
            let _ = std::fs::remove_file(&tmp);
            return Err("写回失败：文件可能被占用".into());
        }
    }

    purge_orphan_thumbs(app, &old_hash);
    Ok(TransformedImage { width: w, height: h })
}

/// 读取 EXIF 并剔除 Orientation（像素已转正），返回 TIFF 容器字节；无 EXIF/失败返回 None。
/// 只保留 IFD0 字段：IFD1 内嵌缩略图像素未随旋转更新，保留会错位，直接丢弃。
fn exif_without_orientation(bytes: &[u8]) -> Option<Vec<u8>> {
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(bytes))
        .ok()?;
    let fields: Vec<exif::Field> = exif
        .fields()
        .filter(|f| f.ifd_num == exif::In::PRIMARY && f.tag != exif::Tag::Orientation)
        .cloned()
        .collect();
    let mut writer = exif::experimental::Writer::new();
    for f in &fields {
        writer.push_field(f);
    }
    let mut out = std::io::Cursor::new(Vec::new());
    writer.write(&mut out, true).ok()?; // 小端 TIFF（主流）
    let data = out.into_inner();
    if data.len() > 8 { Some(data) } else { None }
}

/// 把 TIFF 容器字节作为 APP1(Exif) 段插入 JPEG（SOI 之后）
fn jpeg_insert_exif(jpeg: &mut Vec<u8>, tiff: &[u8]) {
    if jpeg.len() < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return;
    }
    let seg_len = (tiff.len() + 2) as u16;
    if seg_len > 0xFFFF {
        return; // 单段超长（罕见），放弃保留
    }
    let mut app1 = vec![0xFF, 0xE1, (seg_len >> 8) as u8, (seg_len & 0xFF) as u8];
    app1.extend_from_slice(b"Exif\0\0");
    app1.extend_from_slice(tiff);
    jpeg.splice(2..2, app1);
}

/// 删除 thumbnails 各子目录中以旧 hash 开头的缓存文件（写回原图后成为孤儿）
fn purge_orphan_thumbs(app: &tauri::AppHandle, hash: &str) {
    let Ok(root) = cache_root_dir(app) else { return };
    for sub in std::fs::read_dir(root).into_iter().flatten() {
        let Ok(sub) = sub else { continue };
        if !sub.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(sub.path()).into_iter().flatten().filter_map(|e| e.ok()) {
            let fp = f.path();
            if let Some(n) = fp.file_name().and_then(|n| n.to_str()) {
                if n.starts_with(hash) {
                    let _ = std::fs::remove_file(&fp);
                }
            }
        }
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
