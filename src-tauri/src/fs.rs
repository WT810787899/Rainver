// ═══════════════════════════════════════════════════════
// fs.rs — 目录扫描（walkdir + 后缀过滤），返回 MediaItem 列表
// 所有 IO 在 spawn_blocking 中执行，避免阻塞主线程
// ═══════════════════════════════════════════════════════
use serde::Serialize;
use std::time::UNIX_EPOCH;

use crate::utils::{canonicalize_checked, kind_by_ext, MediaKind};

/// 媒体条目 — IPC 返回给前端的序列化结构
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    /// 绝对路径
    pub path: String,
    /// 文件名（含后缀）
    pub name: String,
    /// 后缀（小写）
    pub ext: String,
    /// 媒体大类：image / video / audio
    pub kind: MediaKind,
    /// 文件大小（字节）
    pub size: u64,
    /// 修改时间（Unix 秒）
    pub modified: u64,
    /// 时长（秒，视频/音频；图片为 None，由懒加载填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// 宽（像素，懒加载）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// 高（像素，懒加载）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// 标题（音频懒加载）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 艺术家
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    /// 专辑
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
}

/// 侧边树节点
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub path: String,
    pub name: String,
    /// 是否包含子文件夹（用于显示展开箭头）
    pub has_children: bool,
    /// 直接子文件夹数量（目录树名称后括号追加显示）
    pub subfolder_count: u32,
    /// L336：隐藏属性（Windows FILE_ATTRIBUTE_HIDDEN；其他平台按点号开头判定）
    pub hidden: bool,
    /// L336：系统属性（Windows FILE_ATTRIBUTE_SYSTEM）
    pub system: bool,
}

/// L336：读取条目的隐藏/系统属性
#[cfg(windows)]
fn hidden_system_attrs(path: &std::path::Path) -> (bool, bool) {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    match std::fs::symlink_metadata(path) {
        Ok(m) => {
            let a = m.file_attributes();
            (a & FILE_ATTRIBUTE_HIDDEN != 0, a & FILE_ATTRIBUTE_SYSTEM != 0)
        }
        Err(_) => (false, false),
    }
}
#[cfg(not(windows))]
fn hidden_system_attrs(path: &std::path::Path) -> (bool, bool) {
    let hidden = path
        .file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false);
    (hidden, false)
}

/// 扫描单个目录（非递归）；include_all=false 时过滤出媒体文件（默认），true 时非媒体归为 Other 一并列出
/// 阻塞 IO 全部放到 spawn_blocking 任务，防止卡顿
#[tauri::command]
pub async fn list_directory(path: String, include_all: Option<bool>) -> Result<Vec<MediaItem>, String> {
    let dir = canonicalize_checked(&path)?;
    if !dir.is_dir() {
        return Err(format!("不是有效目录: {}", dir.display()));
    }

    let all = include_all.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || scan_dir(&dir, all))
        .await
        .map_err(|e| format!("扫描任务失败: {e}"))?
}

/// L230「穿透」：递归扫描目录及其所有子目录，只返回媒体文件（不含文件夹）
/// 上限 10 万条，防止误选磁盘根目录时结果爆炸
#[tauri::command]
pub async fn list_directory_deep(path: String) -> Result<Vec<MediaItem>, String> {
    let dir = canonicalize_checked(&path)?;
    if !dir.is_dir() {
        return Err(format!("不是有效目录: {}", dir.display()));
    }
    tauri::async_runtime::spawn_blocking(move || scan_dir_deep(&dir))
        .await
        .map_err(|e| format!("扫描任务失败: {e}"))?
}

/// 选择根目录并扫描（原生文件夹选择对话框）
#[tauri::command]
pub async fn pick_and_list(
    app: tauri::AppHandle,
) -> Result<(String, Vec<MediaItem>), String> {
    use tauri_plugin_dialog::DialogExt;
    // 打开系统「选择文件夹」对话框
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .ok_or_else(|| "未选择目录".to_string())?;

    let dir = canonicalize_checked(&picked.to_string())?;
    if !dir.is_dir() {
        return Err("所选路径不是目录".into());
    }
    let display = dir.to_string_lossy().into_owned();
    let items = tauri::async_runtime::spawn_blocking(move || scan_dir(&dir, false))
        .await
        .map_err(|e| format!("扫描任务失败: {e}"))??;
    Ok((display, items))
}

/// 磁盘根列表（Windows 盘符 A..Z 探测）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub path: String,  // 如 "C:\"
    pub name: String,  // L141：卷标名称（无卷标回退"本地磁盘"）
    pub total: u64,    // L149：总容量（字节）
    pub free: u64,     // L149：可用容量（字节）
}

/// L141：读取盘符卷标（GetVolumeInformationW）；失败或无卷标返回 None
#[cfg(windows)]
fn volume_label(letter: char) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetVolumeInformationW;
    let root = HSTRING::from(format!("{letter}:\\"));
    let mut buf = [0u16; 64];
    unsafe {
        let ok = GetVolumeInformationW(
            &root,
            Some(&mut buf),
            None,
            None,
            None,
            None,
        );
        if ok.is_err() {
            return None;
        }
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let s = String::from_utf16_lossy(&buf[..len]);
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(not(windows))]
fn volume_label(_letter: char) -> Option<String> {
    None
}

/// L149：磁盘容量（总字节 / 可用字节）
#[cfg(windows)]
fn disk_space(letter: char) -> (u64, u64) {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root = HSTRING::from(format!("{letter}:\\"));
    let mut free: u64 = 0;
    let mut total: u64 = 0;
    unsafe {
        if GetDiskFreeSpaceExW(&root, Some(&mut free), Some(&mut total), None).is_ok() {
            return (total, free);
        }
    }
    (0, 0)
}

#[cfg(not(windows))]
fn disk_space(_letter: char) -> (u64, u64) {
    (0, 0)
}

#[tauri::command]
pub fn list_drives() -> Vec<DriveInfo> {
    ('A'..='Z')
        .filter(|l| std::path::Path::new(&format!("{l}:\\")).exists())
        .map(|l| {
            let (total, free) = disk_space(l);
            DriveInfo {
                path: format!("{l}:\\"),
                // L141：优先卷标名称；无卷标回退「本地磁盘」
                name: volume_label(l).unwrap_or_else(|| "本地磁盘".to_string()),
                total,
                free,
            }
        })
        .collect()
}

/// 列出某目录的直接子文件夹（侧边树懒加载）
#[tauri::command]
pub async fn list_subfolders(path: String) -> Result<Vec<FolderNode>, String> {
    let dir = canonicalize_checked(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .map_err(|e| format!("读取目录失败: {e}"))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();
        // 按名称排序，文件夹树更稳定
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            // 一次扫描同时得到 数量 与 是否含子文件夹
            let subfolder_count = std::fs::read_dir(&p)
                .map(|rd| rd.filter_map(|x| x.ok()).filter(|x| x.path().is_dir()).count() as u32)
                .unwrap_or(0);
            let (hidden, system) = hidden_system_attrs(&p);
            out.push(FolderNode {
                path: p.to_string_lossy().into_owned(),
                name: e.file_name().to_string_lossy().into_owned(),
                has_children: subfolder_count > 0,
                subfolder_count,
                hidden,
                system,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

// ─── 内部：实际扫描逻辑（运行在阻塞线程池） ───
const SCAN_CHUNK: usize = 500;

fn scan_dir(dir: &std::path::Path, include_all: bool) -> Result<Vec<MediaItem>, String> {
    scan_dir_batched(dir, false, include_all, &mut |_| Ok(()))
}

/// L230：递归扫描（穿透）——遍历全部层级，仅收集媒体文件
fn scan_dir_deep(dir: &std::path::Path) -> Result<Vec<MediaItem>, String> {
    scan_dir_batched(dir, true, false, &mut |_| Ok(()))
}

/// 统一扫描：deep=false 非递归（含文件夹）；deep=true 递归仅媒体文件（上限 10 万条）。
/// include_all=true 时非媒体文件归为 MediaKind::Other 一并列出（对应「仅显示媒体文件」关闭）。
/// 每积累 SCAN_CHUNK 条通过 on_batch 推给调用方（流式场景增量 emit 到前端），
/// 结束后整体排序并返回全量列表。
fn scan_dir_batched(
    dir: &std::path::Path,
    deep: bool,
    include_all: bool,
    on_batch: &mut dyn FnMut(Vec<MediaItem>) -> Result<(), String>,
) -> Result<Vec<MediaItem>, String> {
    const MAX_ITEMS: usize = 100_000;
    let mut items: Vec<MediaItem> = Vec::new();
    let mut batch: Vec<MediaItem> = Vec::with_capacity(SCAN_CHUNK);
    let mut walk = walkdir::WalkDir::new(dir);
    if !deep {
        walk = walk.max_depth(1); // 非递归；deep 走默认递归，follow_links(false) 避免环
    }
    for entry in walk.into_iter().filter_map(|e| e.ok()) {
        if deep && items.len() >= MAX_ITEMS {
            break;
        }
        let p = entry.path();
        if p == dir {
            continue;
        }
        let ft = entry.file_type();
        let (kind, ext, size) = if ft.is_dir() {
            if deep {
                continue; // 穿透结果里不放文件夹，文件区双击/操作都针对文件
            }
            // 目录同样列出（文件区不过滤文件夹），双击进入；不跟随符号链接
            (MediaKind::Folder, String::new(), 0u64)
        } else if ft.is_file() {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            // 非媒体后缀：默认跳过；include_all 时归为 Other（资源管理器式列出）
            let kind = match kind_by_ext(&ext) {
                Some(k) => k,
                None if include_all => MediaKind::Other,
                None => continue,
            };
            let size = match entry.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue, // 无权限或已删除 → 跳过，避免崩溃
            };
            (kind, ext, size)
        } else {
            continue; // 符号链接 / 设备等
        };

        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let item = MediaItem {
            path: p.to_string_lossy().into_owned(),
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ext,
            kind,
            size,
            modified,
            // 以下字段懒加载（get_media_info）
            duration: None,
            width: None,
            height: None,
            title: None,
            artist: None,
            album: None,
        };
        items.push(item.clone());
        batch.push(item);
        if batch.len() >= SCAN_CHUNK {
            on_batch(std::mem::take(&mut batch))?;
        }
    }
    if !batch.is_empty() {
        on_batch(batch)?;
    }
    // 按类型（夹→图→影→音）+ 名称排序（流式场景前端 applyFilter 会再统一排序）
    items.sort_by(|a, b| {
        a.kind
            .partial_cmp(&b.kind)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

/// 流式目录扫描的批次事件载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChunk {
    /// 前端传入的代际号：换目录/刷新自增，过期批次由前端丢弃
    seq: u32,
    items: Vec<MediaItem>,
}

/// 流式目录扫描：每 500 条通过 `dir-chunk` 事件推送一批，
/// 前端增量渲染，大目录不再等全量 JSON 一次序列化/解析完才显示。
/// 完成后返回总数（最终排序由前端 applyFilter 统一处理）。
#[tauri::command]
pub async fn list_directory_stream(
    app: tauri::AppHandle,
    path: String,
    deep: bool,
    seq: u32,
    include_all: Option<bool>,
) -> Result<u32, String> {
    use tauri::Emitter;
    let dir = canonicalize_checked(&path)?;
    if !dir.is_dir() {
        return Err(format!("不是有效目录: {}", dir.display()));
    }
    let all = include_all.unwrap_or(false) && !deep; // 穿透扫描保持仅媒体，避免 10 万上限被杂项占满
    tauri::async_runtime::spawn_blocking(move || {
        let mut total: u32 = 0;
        scan_dir_batched(&dir, deep, all, &mut |batch| {
            total += batch.len() as u32;
            app.emit("dir-chunk", DirChunk { seq, items: batch })
                .map_err(|e| format!("批次事件发送失败: {e}"))?;
            Ok(())
        })?;
        Ok(total)
    })
    .await
    .map_err(|e| format!("扫描任务失败: {e}"))?
}

/// 按路径列表批量取文件元数据（集锦箱：跨目录文件，不做目录扫描）
#[tauri::command]
pub async fn stat_items(paths: Vec<String>) -> Result<Vec<MediaItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for raw in paths {
            let p = std::path::PathBuf::from(&raw);
            if !p.is_file() {
                continue; // 已删除/移动的文件跳过
            }
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let Some(kind) = kind_by_ext(&ext) else { continue };
            let meta = std::fs::metadata(&p).ok();
            out.push(MediaItem {
                path: raw,
                name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                ext,
                kind,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                duration: None,
                width: None,
                height: None,
                title: None,
                artist: None,
                album: None,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

// ═══════════════ 常用目录（音乐 / 图片 / 视频 / 文档 / 下载） ═══════════════

/// 侧边栏顶部的常用目录快捷入口
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickDir {
    pub key: String,
    pub name: String,
    pub path: String,
}

/// 读取系统已知目录（SHGetKnownFolderPath），只返回实际存在的
#[tauri::command]
pub fn list_quick_dirs() -> Vec<QuickDir> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        use windows::core::GUID;
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{
            SHGetKnownFolderPath, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music,
            FOLDERID_Pictures, FOLDERID_Videos, KNOWN_FOLDER_FLAG,
        };
        // windows 0.61：FOLDERID_* 为 GUID 常量（无独立 KNOWNFOLDERID 类型）
        let folders: &[(&GUID, &str, &str)] = &[
            (&FOLDERID_Music, "music", "音乐"),
            (&FOLDERID_Pictures, "pictures", "图片"),
            (&FOLDERID_Videos, "videos", "视频"),
            (&FOLDERID_Documents, "documents", "文档"),
            (&FOLDERID_Downloads, "downloads", "下载"),
        ];
        unsafe {
            for (id, key, name) in folders {
                if let Ok(pwstr) = SHGetKnownFolderPath(*id, KNOWN_FOLDER_FLAG(0), None) {
                    let path = pwstr.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void));
                    if !path.is_empty() && std::path::Path::new(&path).exists() {
                        out.push(QuickDir {
                            key: key.to_string(),
                            name: name.to_string(),
                            path,
                        });
                    }
                }
            }
        }
    }
    out
}


