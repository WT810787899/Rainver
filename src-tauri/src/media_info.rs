// ═══════════════════════════════════════════════════════
// media_info.rs — 元信息懒加载
//   图片: 尺寸
//   视频: 时长/分辨率（ffmpeg 探测）
//   音频: 标题/艺术家/专辑/时长 + 封面提取 → 缓存；无封面生成纯色占位图
// ═══════════════════════════════════════════════════════
use std::path::Path;
use serde::Serialize;
use tauri::Manager;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 单项元信息 IPC 返回
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub kind: String,
    /// 时长（秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// 音频标签
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    /// 封面/占位图绝对路径（音频与视频首帧共用缩略图缓存机制）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
}
/// 获取单个媒体文件的元信息（spawn_blocking，防止 IO 阻塞）
#[tauri::command]
pub async fn get_media_info(
    app: tauri::AppHandle,
    path: String,
    kind: String,
) -> Result<MediaInfo, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取 AppData: {e}"))?
        .join("thumbnails");
    std::fs::create_dir_all(&cache).map_err(|e| format!("缓存目录创建失败: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || match kind.as_str() {
        "image" => image_info(&src),
        "video" => video_info(&src),
        "audio" => audio_info(&src, &ext, &cache),
        _ => Err(format!("未知类型: {kind}")),
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}
// ─── 属性面板：完整媒体属性（帧率/编码/码率等，ffmpeg stderr 解析） ───
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProps {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<String>,
}
#[tauri::command]
pub async fn get_media_props(path: String, kind: String) -> Result<MediaProps, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.is_file() {
        return Err("文件不存在".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&src).map_err(|e| format!("读取文件信息失败: {e}"))?;
        let mut p = MediaProps {
            path: src.to_string_lossy().into_owned(),
            name: src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            kind: kind.clone(),
            duration: None,
            width: None,
            height: None,
            frame_rate: None,
            video_codec: None,
            audio_codec: None,
            bitrate: None,
        };

        use std::process::Command;
        if let Some(ffmpeg) = crate::thumb::find_ffmpeg() {
            let mut cmd = Command::new(&ffmpeg);
            cmd
                .arg("-hide_banner")
                .arg("-nostdin") // 关键：禁止ffmpeg读取stdin，防止意外唤起控制台
                .arg("-i")
                .arg(&src);
            // Windows平台：添加创建标志，不弹出控制台窗口
            #[cfg(windows)]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            if let Ok(out) = cmd.output() {
                let err = String::from_utf8_lossy(&out.stderr).to_string();
                p.duration = crate::thumb::parse_ffmpeg_duration(&err);
                let (w, h) = crate::thumb::parse_ffmpeg_dims(&err);
                p.width = w;
                p.height = h;
                p.frame_rate = parse_fps(&err);
                p.video_codec = parse_stream_codec(&err, "Video:");
                p.audio_codec = parse_stream_codec(&err, "Audio:");
                p.bitrate = parse_bitrate(&err);
            }
        }
        Ok(p)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}
/// "23.98 fps" / "25 fps" → "23.98 fps"
fn parse_fps(s: &str) -> Option<String> {
    let idx = s.find(" fps")?;
    let head = s[..idx].rsplit(|c: char| c == ',' || c == ' ').next()?;
    let v: f64 = head.trim().parse().ok()?;
    Some(format!("{} fps", if v.fract() == 0.0 { format!("{v:.0}") } else { format!("{v:.2}") }))
}
/// "Stream #0:0: Video: h264 (High), ..." → "h264"
fn parse_stream_codec(s: &str, tag: &str) -> Option<String> {
    let idx = s.find(tag)?;
    let rest = &s[idx + tag.len()..];
    let codec = rest.trim_start().split(|c: char| c == ' ' || c == ',').next()?;
    let codec = codec.trim();
    if codec.is_empty() { None } else { Some(codec.to_string()) }
}
/// "bitrate: 1536 kb/s" → "1536 kb/s"
fn parse_bitrate(s: &str) -> Option<String> {
    let idx = s.find("bitrate:")?;
    let rest = &s[idx + 8..];
    rest.lines().next().map(|l| l.trim().to_string()).filter(|x| !x.is_empty())
}
// ─── 图片：读尺寸（只读文件头，不做完整解码） ───
fn image_info(src: &Path) -> Result<MediaInfo, String> {
    let (w, h) = match image::image_dimensions(src) {
        Ok(d) => d,
        // avif / heic 等：image crate 无解码器 → 交给 ffmpeg 探测
        Err(e) => image_dimensions_ffmpeg(src)
            .ok_or_else(|| format!("解析图片尺寸失败: {e}"))?,
    };
    Ok(MediaInfo {
        kind: "image".into(),
        duration: None,
        width: Some(w),
        height: Some(h),
        title: None,
        artist: None,
        album: None,
        cover_path: Some(src.to_string_lossy().into_owned()),
    })
}
/// ffmpeg 探测图片尺寸（stderr 里的 "Video: … 1920x1080"）
fn image_dimensions_ffmpeg(src: &Path) -> Option<(u32, u32)> {
    let ffmpeg = crate::thumb::find_ffmpeg()?;
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(src);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    let err = String::from_utf8_lossy(&out.stderr);
    let (w, h) = crate::thumb::parse_ffmpeg_dims(&err);
    match (w, h) {
        (Some(w), Some(h)) => Some((w, h)),
        _ => None,
    }
}
// ─── 视频：ffmpeg 探测时长/分辨率（无写入，只读） ───
fn video_info(src: &Path) -> Result<MediaInfo, String> {
    let ffmpeg = crate::thumb::find_ffmpeg().ok_or_else(|| "未找到 ffmpeg".to_string())?;
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(src);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output()
        .map_err(|e| format!("调用 ffmpeg 失败: {e}"))?;
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    let duration = crate::thumb::parse_ffmpeg_duration(&err);
    let (w, h) = crate::thumb::parse_ffmpeg_dims(&err);
    Ok(MediaInfo {
        kind: "video".into(),
        duration,
        width: w,
        height: h,
        title: None,
        artist: None,
        album: None,
        cover_path: None,
    })
}
// ─── 音频：标签 + 时长 + 封面 ───
fn audio_info(src: &Path, ext: &str, cache: &Path) -> Result<MediaInfo, String> {
    // 1) 时长：symphonia 探测音频时长
    let duration = probe_duration(src);
    // 2) 标签与封面：按格式分派
    let (title, artist, album, cover_bytes) = read_tags(src, ext);
    // 3) 有内嵌封面才落盘缓存；没有则返回 None（前端显示音频图标）
    let cover_path = match cover_bytes {
        Some(data) => {
            let key = crate::thumb::hash_key(src);
            let p = cache.join(format!("{key}.cover.jpg"));
            if !p.exists() {
                match image::load_from_memory(&data) {
                    Ok(img) => {
                        let _ = img.save_with_format(&p, image::ImageFormat::Jpeg);
                    }
                    // 已是 jpg/png 的原样写入；其它格式放弃
                    Err(_) if data.starts_with(&[0xFF, 0xD8]) || data.starts_with(&[0x89, 0x50]) => {
                        let _ = std::fs::write(&p, &data);
                    }
                    Err(_) => {}
                }
            }
            p.exists().then(|| p.to_string_lossy().into_owned())
        }
        None => None,
    };
    Ok(MediaInfo {
        kind: "audio".into(),
        duration,
        width: None,
        height: None,
        title,
        artist,
        album,
        cover_path,
    })
}
/// symphonia 探测音频时长
fn probe_duration(src: &Path) -> Option<f64> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    let file = std::fs::File::open(src).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = src.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let track = probed.format.default_track()?.clone();
    let cp = &track.codec_params;
    cp.time_base.and_then(|tb| {
        // 优先：容器记录的总帧数 × 时间基
        if let Some(n) = cp.n_frames {
            let t = tb.calc_time(n);
            return Some(t.seconds as f64 + t.frac);
        }
        // 回退：容器未记录总帧数时无法精确计算，交给 ffmpeg/前端兜底
        None
    })
}
/// 各格式读取标签与内嵌封面（thumb 模块抽音频封面时复用）
pub(crate) fn read_tags(src: &Path, ext: &str) -> (Option<String>, Option<String>, Option<String>, Option<Vec<u8>>) {
    use id3::TagLike;
    match ext {
        // ── MP3 (ID3v2) ──
        "mp3" => match id3::Tag::read_from_path(src) {
            Ok(tag) => {
                let cover = tag
                    .pictures()
                    .next()
                    .map(|p| p.data.to_vec());
                (
                    tag.title().map(|s| s.to_string()),
                    tag.artist().map(|s| s.to_string()),
                    tag.album().map(|s| s.to_string()),
                    cover,
                )
            }
            Err(_) => (None, None, None, None),
        },
        // ── FLAC ──
        "flac" => match metaflac::Tag::read_from_path(src) {
            Ok(tag) => {
                let cover = tag
                    .pictures()
                    .next()
                    .map(|p| p.data.clone());
                (
                    tag.get_vorbis("title").and_then(|mut v| v.next().map(|s| s.to_string())),
                    tag.get_vorbis("artist").and_then(|mut v| v.next().map(|s| s.to_string())),
                    tag.get_vorbis("album").and_then(|mut v| v.next().map(|s| s.to_string())),
                    cover,
                )
            }
            Err(_) => (None, None, None, None),
        },
        // ── MP4 / M4A ──
        "m4a" | "mp4" => match mp4ameta::Tag::read_from_path(src) {
            Ok(tag) => {
                let cover = tag.artwork().map(|a| a.data.to_vec());
                (
                    tag.title().map(|s| s.to_string()),
                    tag.artist().map(|s| s.to_string()),
                    tag.album().map(|s| s.to_string()),
                    cover,
                )
            }
            Err(_) => (None, None, None, None),
        },
        // ogg / wav / aac：标签读取暂不支持（前端显示音频图标）
        _ => (None, None, None, None),
    }
}
