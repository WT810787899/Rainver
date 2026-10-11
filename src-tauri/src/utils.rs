// ═══════════════════════════════════════════════════════
// utils.rs — 媒体类型判定、路径防穿越校验、通用辅助
// ═══════════════════════════════════════════════════════
use std::path::{Component, Path, PathBuf};

/// 媒体大类（声明顺序即排序顺序：文件夹 → 图 → 影 → 音 → 其他）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    /// 子文件夹（文件区同样列出，双击进入）
    Folder,
    Image,
    Video,
    Audio,
    /// 非媒体文件（「仅显示媒体文件」关闭时按资源管理器方式列出）
    Other,
}


/// 图片后缀
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff", "tif", "heic"];
/// 视频后缀
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "webm", "avi","ts","rm","rmvb"];
/// 音频后缀
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "flac", "aac", "ogg", "m4a"];

/// 根据扩展名判断媒体类型；非媒体返回 None
pub fn kind_by_ext(ext: &str) -> Option<MediaKind> {
    let e = ext.to_ascii_lowercase();
    if IMAGE_EXTS.contains(&e.as_str()) {
        Some(MediaKind::Image)
    } else if VIDEO_EXTS.contains(&e.as_str()) {
        Some(MediaKind::Video)
    } else if AUDIO_EXTS.contains(&e.as_str()) {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

/// 规范化路径并做防穿越校验：
/// - 去除 `..`、`.`、盘符外的非常规组件
/// - 返回标准化的绝对路径；非法输入返回 Err
pub fn canonicalize_checked(input: &str) -> Result<PathBuf, String> {
    if input.is_empty() {
        return Err("路径为空".into());
    }
    let p = Path::new(input);
    // 逐组件检查，拒绝 ParentDir 组件穿越
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out.push(comp.as_os_str()),
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                // 只允许向上回退一层到根以内
                if !out.pop() {
                    return Err("路径穿越被拒绝".into());
                }
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("路径穿越被拒绝".into());
    }
    Ok(out)
}

/// 文件大小人类可读格式（如 1.4 MB；保留给后续 IPC 使用）
#[allow(dead_code)]
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < 4 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

/// 时长（秒）→ mm:ss / hh:mm:ss（保留给后续 IPC 使用）
#[allow(dead_code)]
pub fn fmt_duration(secs: f64) -> String {
    if !secs.is_finite() || secs <= 0.0 {
        return "0:00".into();
    }
    let s = secs as u64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    if h > 0 {
        format!("{h}:{m:02}:{sec:02}")
    } else {
        format!("{m}:{sec:02}")
    }
}

// ═══════════════ 项目 cache 目录 ═══════════════
// 所有运行时数据（配置、缓存、集锦箱）统一存放到项目 cache 文件夹下。
// 定位策略：从 exe 路径向上查找包含 Cargo.toml 的目录（即项目根目录），
// 在其下创建 cache 子目录。打包后若找不到则回退到 exe 所在目录。

/// 获取项目 cache 目录路径（不创建）
pub fn project_cache_dir() -> PathBuf {
    // 1) 从 exe 路径向上查找项目根目录（含 Cargo.toml）
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        while let Some(d) = dir {
            if d.join("Cargo.toml").is_file() {
                return d.join("cache");
            }
            dir = d.parent();
        }
        // 2) 回退：exe 所在目录下的 cache
        if let Some(exe_dir) = exe.parent() {
            return exe_dir.join("cache");
        }
    }
    // 3) 最终回退：当前工作目录下的 cache
    std::env::current_dir()
        .map(|d| d.join("cache"))
        .unwrap_or_else(|_| PathBuf::from("cache"))
}

/// 获取项目 cache 目录并确保存在
pub fn ensure_project_cache_dir() -> Result<PathBuf, String> {
    let dir = project_cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 cache 目录失败: {e}"))?;
    Ok(dir)
}

// ═══════════════ IPC 命令 ═══════════════

/// 路径校验命令：前端可用于预检查
#[tauri::command]
pub fn check_path(path: String) -> Result<String, String> {
    let p = canonicalize_checked(&path)?;
    if p.exists() {
        Ok(p.to_string_lossy().into_owned())
    } else {
        Err(format!("路径不存在: {}", p.display()))
    }
}
