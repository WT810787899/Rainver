// ═══════════════════════════════════════════════════════
// files.rs — 文件操作：复制 / 剪切（移动）/ 删除
//   · 路径一律经防穿越校验
//   · 重名自动加序号（name (2).ext），与资源管理器一致
//   · 删除：permanent=false → 系统回收站（可撤销）
//           permanent=true  → 直接删除（不可恢复）
//   · 剪贴板：CF_HDROP + Preferred DropEffect，与资源管理器互通
//   · 目录递归处理；禁止把目录复制/移动进它自己的子目录
// ═══════════════════════════════════════════════════════
use std::path::{Path, PathBuf};

/// 复制到目标目录，返回实际落盘的新路径
#[tauri::command]
pub async fn copy_items(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || transfer(&paths, &dest_dir, false))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 剪切（移动）到目标目录，返回实际落盘的新路径
#[tauri::command]
pub async fn move_items(paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || transfer(&paths, &dest_dir, true))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

/// 删除：permanent=false → 移入回收站（无提示，可还原）
///       permanent=true  → 直接删除（调用方负责二次确认）
#[tauri::command]
pub async fn delete_items(paths: Vec<String>, permanent: bool) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut list: Vec<PathBuf> = Vec::new();
        for p in &paths {
            let src = crate::utils::canonicalize_checked(p)?;
            // 拒绝删除盘根（防手滑清盘）
            if src.parent().is_none() || src.to_string_lossy().ends_with(":\\") {
                return Err(format!("拒绝删除根目录：{}", src.display()));
            }
            if src.exists() {
                list.push(src);
            }
        }
        if list.is_empty() {
            return Ok(0);
        }
        let n = list.len();
        if permanent {
            for p in &list {
                remove_recursive(p)?;
            }
        } else {
            recycle(&list)?;
        }
        Ok(n)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

// ─── 内部实现 ───

fn transfer(paths: &[String], dest_dir: &str, cut: bool) -> Result<Vec<String>, String> {
    let dest = crate::utils::canonicalize_checked(dest_dir)?;
    if !dest.is_dir() {
        return Err("目标不是文件夹".into());
    }
    let mut out = Vec::new();
    for p in paths {
        let src = crate::utils::canonicalize_checked(p)?;
        if !src.exists() {
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| format!("路径无效: {}", src.display()))?;
        // 目标落在源目录内部 → 会无限递归
        if dest.starts_with(&src) {
            return Err(format!("不能把「{name}」放进它自己内部"));
        }
        // 剪切到原目录：无需动作
        if cut && src.parent() == Some(dest.as_path()) {
            continue;
        }
        let target = unique_path(&dest.join(&name));
        if cut {
            // 同盘直接改名；跨盘先复制再删源
            if std::fs::rename(&src, &target).is_err() {
                copy_recursive(&src, &target)?;
                remove_recursive(&src)?;
            }
        } else {
            copy_recursive(&src, &target)?;
        }
        out.push(target.to_string_lossy().into_owned());
    }
    Ok(out)
}

/// 重名时自动加序号：a.txt → a (2).txt
fn unique_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let dir = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..10_000 {
        let cand = dir.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    p.to_path_buf()
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
        let rd = std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))?;
        for entry in rd.flatten() {
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst)
            .map(|_| ())
            .map_err(|e| format!("复制失败: {e}"))
    }
}

fn remove_recursive(p: &Path) -> Result<(), String> {
    let r = if p.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    };
    r.map_err(|e| format!("删除失败: {e}"))
}

// ─── 回收站（SHFileOperation + FOF_ALLOWUNDO） ───
#[cfg(windows)]
fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, SHFILEOPSTRUCTW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FO_DELETE,
    };

    // pFrom 需要「以 \0 分隔、双 \0 结尾」的宽字符串
    let mut buf: Vec<u16> = Vec::new();
    for p in paths {
        buf.extend(p.as_os_str().encode_wide());
        buf.push(0);
    }
    buf.push(0);

    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: windows::core::PCWSTR(buf.as_ptr()),
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0) as u16,
        ..Default::default()
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("移入回收站失败（代码 {code}）"));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("删除被中止".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn recycle(paths: &[PathBuf]) -> Result<(), String> {
    for p in paths {
        remove_recursive(p)?;
    }
    Ok(())
}

// ═══════════════ 剪贴板：CF_HDROP 与资源管理器互通 ═══════════════

/// 系统剪贴板中的文件列表（mode: "copy" | "cut"）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFiles {
    pub paths: Vec<String>,
    pub mode: String,
}

/// 把文件写入系统剪贴板（CF_HDROP），可在资源管理器里粘贴；
/// cut=true 时追加 Preferred DropEffect = MOVE
#[tauri::command]
pub fn set_clipboard_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        clipboard_win::set_files(paths, cut)
    }
    #[cfg(not(windows))]
    {
        let _ = (paths, cut);
        Err("剪贴板互通仅支持 Windows".into())
    }
}

/// 读取系统剪贴板中的文件（资源管理器复制 / 剪切，或本应用写入的）
#[tauri::command]
pub fn get_clipboard_files() -> Result<Option<ClipboardFiles>, String> {
    #[cfg(windows)]
    {
        clipboard_win::get_files()
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[cfg(windows)]
mod clipboard_win {
    use super::ClipboardFiles;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use windows::core::{w, BOOL};
    use windows::Win32::Foundation::{HANDLE, HGLOBAL, POINT, TRUE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
        RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    // windows 0.61：CF_HDROP 位于 System::Ole，类型 CLIPBOARD_FORMAT(u16)
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};

    // DROPEFFECT_COPY = 1，DROPEFFECT_MOVE = 2
    const DROP_EFFECT_COPY: u32 = 1;
    const DROP_EFFECT_MOVE: u32 = 2;

    pub fn set_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
        // 解析并校验路径
        let mut resolved: Vec<PathBuf> = Vec::new();
        for p in &paths {
            let src = crate::utils::canonicalize_checked(p)?;
            if src.exists() {
                resolved.push(src);
            }
        }
        if resolved.is_empty() {
            return Err("没有可复制的有效文件".into());
        }

        // 路径块：\0 分隔、双 \0 结尾的宽字符
        let mut block: Vec<u16> = Vec::new();
        for p in &resolved {
            block.extend(p.as_os_str().encode_wide());
            block.push(0);
        }
        block.push(0);

        unsafe {
            OpenClipboard(None).map_err(|e| format!("打开剪贴板失败: {e}"))?;
            // EmptyClipboard 后必须保持剪贴板打开直到 SetClipboardData 完成
            EmptyClipboard().map_err(|e| format!("清空剪贴板失败: {e}"))?;

            let run = || -> windows::core::Result<()> {
                // ─── CF_HDROP：DROPFILES 头 + 路径块 ───
                let header = std::mem::size_of::<DROPFILES>();
                let bytes = block.len() * 2;
                let hglob = GlobalAlloc(
                    GMEM_MOVEABLE | GMEM_ZEROINIT,
                    header + bytes,
                )?;
                let ptr = GlobalLock(hglob);
                if ptr.is_null() {
                    return Err(windows::core::Error::from_win32());
                }
                std::ptr::write(
                    ptr as *mut DROPFILES,
                    DROPFILES {
                        pFiles: header as u32,
                        pt: POINT { x: 0, y: 0 },
                        fNC: BOOL(0),
                        fWide: TRUE,
                    },
                );
                std::ptr::copy_nonoverlapping(
                    block.as_ptr() as *const u8,
                    (ptr as *mut u8).add(header),
                    bytes,
                );
                let _ = GlobalUnlock(hglob);

                // ─── Preferred DropEffect：COPY / MOVE（DWORD） ───
                let hglob_eff = GlobalAlloc(
                    GMEM_MOVEABLE | GMEM_ZEROINIT,
                    std::mem::size_of::<u32>(),
                )?;
                let p_eff = GlobalLock(hglob_eff);
                if p_eff.is_null() {
                    return Err(windows::core::Error::from_win32());
                }
                std::ptr::write(
                    p_eff as *mut u32,
                    if cut { DROP_EFFECT_MOVE } else { DROP_EFFECT_COPY },
                );
                let _ = GlobalUnlock(hglob_eff);

                // SetClipboardData 成功后内存所有权移交系统，不可再释放
                SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hglob.0)))?;
                let fmt_effect = RegisterClipboardFormatW(w!("Preferred DropEffect"));
                SetClipboardData(fmt_effect, Some(HANDLE(hglob_eff.0)))?;
                Ok(())
            };

            let res = run();
            let _ = CloseClipboard();
            res.map_err(|e| format!("写入文件剪贴板失败: {e}"))?;
        }
        Ok(())
    }

    pub fn get_files() -> Result<Option<ClipboardFiles>, String> {
        unsafe {
            OpenClipboard(None).map_err(|e| format!("打开剪贴板失败: {e}"))?;
            let result = read_files();
            let _ = CloseClipboard();
            result
        }
    }

    unsafe fn read_files() -> Result<Option<ClipboardFiles>, String> {
        let hdata = match GetClipboardData(CF_HDROP.0 as u32) {
            Ok(h) => h,
            Err(_) => return Ok(None), // 剪贴板里没有文件
        };
        let hdrop = HDROP(hdata.0);
        // windows 0.61：DragQueryFileW 接收 Option<&mut [u16]>，空切片=仅查询长度
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        if count == 0 {
            return Ok(None);
        }
        let mut paths: Vec<String> = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, Some(&mut []));
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let got = DragQueryFileW(hdrop, i, Some(&mut buf));
            if got == 0 {
                continue;
            }
            paths.push(String::from_utf16_lossy(&buf[..got as usize]));
        }
        if paths.is_empty() {
            return Ok(None);
        }

        // 读取 Preferred DropEffect：2 = 剪切（移动），其余按复制
        let mut mode = "copy".to_string();
        let fmt_effect = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if let Ok(heff) = GetClipboardData(fmt_effect) {
            let hg = HGLOBAL(heff.0);
            let ptr = GlobalLock(hg);
            if !ptr.is_null() {
                let effect = std::ptr::read(ptr as *const u32);
                if effect == DROP_EFFECT_MOVE {
                    mode = "cut".to_string();
                }
                let _ = GlobalUnlock(hg);
            }
        }
        Ok(Some(ClipboardFiles { paths, mode }))
    }
}

// ═══════════════════════════════════════════════════════
// L87/L78：文件拖拽 —— 原生拖出（drag crate，DoDragDrop + CF_HDROP）+ 拖入复制
// 注：tauri 2.11.6 尚无 start_drag API，故用 drag crate 实现；
// 拖回本窗口时系统照常派发 tauri://drag-drop，由前端按落点分发
// ═══════════════════════════════════════════════════════

/// 以原生方式发起文件拖拽：可拖到资源管理器（复制/移动由系统决定）
#[tauri::command]
pub async fn start_file_drag(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    use std::path::PathBuf;
    use tauri::Manager;
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let mut files: Vec<PathBuf> = Vec::with_capacity(paths.len());
    for p in &paths {
        files.push(crate::utils::canonicalize_checked(p)?);
    }
    if files.is_empty() {
        return Err("没有可拖拽的文件".into());
    }
    // 1×1 透明 PNG（WIC 解码为拖拽预览位图，失败也无妨）
    const PIXEL_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8,
        6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 100, 96, 248, 95,
        15, 0, 2, 135, 1, 128, 235, 71, 186, 146, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    // DoDragDrop 须在 OLE 初始化的主线程执行；调用会阻塞至拖放结束（模态循环）
    let (tx, rx) = std::sync::mpsc::channel();
    let win2 = win.clone(); // 方法接收者会借用 win，克隆一个供闭包移动捕获
    win2.run_on_main_thread(move || {
        let r = drag::start_drag(
            &win,
            drag::DragItem::Files(files),
            drag::Image::Raw(PIXEL_PNG.to_vec()),
            |_result, _pos| {},
            drag::Options::default(),
        );
        let _ = tx.send(r.map_err(|e| format!("发起拖拽失败: {e:?}")));
    })
    .map_err(|e| format!("派发到主线程失败: {e}"))?;
    rx.recv().map_err(|_| "拖拽线程通道关闭".to_string())?
}

/// 重命名文件/文件夹
#[tauri::command]
pub async fn rename_item(path: String, new_name: String) -> Result<String, String> {
    let src = crate::utils::canonicalize_checked(&path)?;
    if !src.exists() {
        return Err("源文件不存在".into());
    }
    if new_name.is_empty() {
        return Err("文件名不能为空".into());
    }
    // 校验新文件名不含非法字符
    if new_name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("文件名包含非法字符".into());
    }
    let parent = src.parent().ok_or("无法获取父目录")?;
    let dest = unique_path(&parent.join(&new_name));
    std::fs::rename(&src, &dest).map_err(|e| format!("重命名失败: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 保存截图（二进制 PNG 数据）到指定路径
#[tauri::command]
pub async fn save_screenshot(path: String, data: Vec<u8>) -> Result<String, String> {
    use std::path::PathBuf;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, &data).map_err(|e| format!("写入截图失败: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

/// L240：截取主窗口客户区画面（非视频场景的「其他截图」），返回 PNG 字节
/// Windows：PrintWindow(PW_RENDERFULLCONTENT) 优先（兼容 DWM/合成窗口），
/// 全黑时回退到窗口 DC BitBlt；其他平台暂不支持
#[tauri::command]
pub fn capture_window(app: tauri::AppHandle) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        capture_window_win(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("窗口截图仅支持 Windows".into())
    }
}

#[cfg(windows)]
fn capture_window_win(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ, RGBQUAD, SRCCOPY,
    };
    // 注意：windows 0.61 元数据把 PrintWindow 放在 Storage::Xps（feature = Win32_Storage_Xps）
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口".to_string())?;
    let hwnd = win.hwnd().map_err(|e| format!("获取窗口句柄失败: {e}"))?;

    unsafe {
        let mut rc = windows::Win32::Foundation::RECT::default();
        GetClientRect(hwnd, &mut rc).map_err(|e| format!("GetClientRect 失败: {e}"))?;
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;
        if w <= 0 || h <= 0 {
            return Err("窗口客户区尺寸无效".into());
        }
        let (w32, h32) = (w as u32, h as u32);

        let hdc_win = GetDC(Some(hwnd));
        if hdc_win.is_invalid() {
            return Err("GetDC 失败".into());
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_win));
        if hdc_mem.is_invalid() {
            ReleaseDC(Some(hwnd), hdc_win);
            return Err("CreateCompatibleDC 失败".into());
        }
        let hbmp = CreateCompatibleBitmap(hdc_win, w, h);
        if hbmp.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(Some(hwnd), hdc_win);
            return Err("CreateCompatibleBitmap 失败".into());
        }
        let old_obj = SelectObject(hdc_mem, HGDIOBJ(hbmp.0));
        if old_obj.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(hbmp.0));
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(Some(hwnd), hdc_win);
            return Err("SelectObject 失败".into());
        }

        // PW_RENDERFULLCONTENT = 2：对 DirectComposition / WebView 一类窗口更有效
        let printed = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(2)).as_bool();
        if !printed
            && BitBlt(hdc_mem, 0, 0, w, h, Some(hdc_win), 0, 0, SRCCOPY).is_err()
        {
            let _ = SelectObject(hdc_mem, old_obj);
            let _ = DeleteObject(HGDIOBJ(hbmp.0));
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(Some(hwnd), hdc_win);
            return Err("BitBlt 失败".into());
        }

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: h, // 正数 = bottom-up
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD::default()],
        };
        let mut buf = vec![0u8; (w32 * h32 * 4) as usize];
        let copied = GetDIBits(
            hdc_mem,
            hbmp,
            0,
            h32,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if copied != h as i32 {
            let _ = SelectObject(hdc_mem, old_obj);
            let _ = DeleteObject(HGDIOBJ(hbmp.0));
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(Some(hwnd), hdc_win);
            return Err(format!("GetDIBits 失败：{copied}"));
        }

        // PrintWindow 偶发返回成功但画面全黑（硬件加速合成）→ 回退 BitBlt 窗口 DC
        if buf.iter().all(|&b| b == 0)
            && BitBlt(hdc_mem, 0, 0, w, h, Some(hdc_win), 0, 0, SRCCOPY).is_ok()
        {
            let copied2 = GetDIBits(
                hdc_mem,
                hbmp,
                0,
                h32,
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            if copied2 != h as i32 {
                let _ = SelectObject(hdc_mem, old_obj);
                let _ = DeleteObject(HGDIOBJ(hbmp.0));
                let _ = DeleteDC(hdc_mem);
                ReleaseDC(Some(hwnd), hdc_win);
                return Err("窗口画面抓取失败（全黑）".into());
            }
        }

        // BGRA(bottom-up) → RGBA(top-down)
        let mut rgba = vec![0u8; (w32 * h32 * 4) as usize];
        for row in 0..h32 as usize {
            let src_row = (h as usize - 1 - row) * (w as usize) * 4;
            let dst_row = row * (w as usize) * 4;
            for x in 0..w as usize {
                let s = src_row + x * 4;
                let d = dst_row + x * 4;
                rgba[d] = buf[s + 2]; // R
                rgba[d + 1] = buf[s + 1]; // G
                rgba[d + 2] = buf[s]; // B
                rgba[d + 3] = 255;
            }
        }

        let _ = SelectObject(hdc_mem, old_obj);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(Some(hwnd), hdc_win);

        let img = image::RgbaImage::from_raw(w32, h32, rgba)
            .ok_or_else(|| "组装截图图像失败".to_string())?;
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .map_err(|e| format!("PNG 编码失败: {e}"))?;
        Ok(out.into_inner())
    }
}

/// 拖入文件区：以「复制」方式把路径列表复制进目标目录（文件夹递归）
#[tauri::command]
pub async fn copy_files_into(srcs: Vec<String>, dest_dir: String) -> Result<u32, String> {
    use std::path::PathBuf;
    let dest = crate::utils::canonicalize_checked(&dest_dir)?;
    if !dest.is_dir() {
        return Err(format!("目标不是目录: {}", dest.display()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut count = 0u32;
        for s in &srcs {
            let src = PathBuf::from(s);
            if !src.exists() {
                continue;
            }
            // 源已在目标目录内（原地拖放）→ 跳过
            if src.parent().map(|p| p == dest).unwrap_or(false) {
                continue;
            }
            let name = src.file_name().ok_or("无效文件名")?;
            let target = unique_dest(&dest.join(name));
            if src.is_dir() {
                copy_dir_recursive(&src, &target).map_err(|e| format!("复制文件夹失败: {e}"))?;
            } else {
                std::fs::copy(&src, &target).map_err(|e| format!("复制失败: {e}"))?;
            }
            count += 1;
        }
        Ok(count)
    })
    .await
    .map_err(|e| format!("复制任务失败: {e}"))?
}

/// 目标已存在时追加「 (2)」「 (3)」…，避免覆盖
fn unique_dest(path: &std::path::Path) -> std::path::PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(std::path::Path::new(""));
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 2..1000 {
        let cand = parent.join(format!("{stem} ({i}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    path.to_path_buf() // 兜底（理论上到不了）
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════
// L88：集锦箱 —— 5 个独立列表，各自用本地 JSON 文件储存
//   存放位置：<app_data>/collections/box{1..5}.json
// ═══════════════════════════════════════════════════════

fn collection_box_path(_app: &tauri::AppHandle, idx: u8) -> Result<std::path::PathBuf, String> {
    if !(1..=5).contains(&idx) {
        return Err(format!("集锦箱编号超出范围: {idx}"));
    }
    let dir = crate::utils::ensure_project_cache_dir()
        .map_err(|e| format!("获取 cache 目录失败: {e}"))?
        .join("collections");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建集锦箱目录失败: {e}"))?;
    Ok(dir.join(format!("box{idx}.json")))
}

#[tauri::command]
pub fn read_collection_box(app: tauri::AppHandle, idx: u8) -> Result<Vec<String>, String> {
    let path = collection_box_path(&app, idx)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json_lenient(&text),
        Err(_) if idx == 1 => Ok(crate::config::read_config(&app).collection), // 旧配置一次性迁移到 1 号箱
        Err(_) => Ok(Vec::new()), // 文件不存在 = 空列表
    }
}

#[tauri::command]
pub fn write_collection_box(app: tauri::AppHandle, idx: u8, paths: Vec<String>) -> Result<(), String> {
    let path = collection_box_path(&app, idx)?;
    let text = format!("{:?}", paths); // 简单可靠的 JSON 数组（Debug 输出即 JSON 兼容字符串数组）
    std::fs::write(&path, text).map_err(|e| format!("写入集锦箱失败: {e}"))
}

/// 宽松解析 ["a","b"] 形式（与上面的 {:?} 输出互逆；手工编辑损坏时容忍失败）
fn serde_json_lenient(text: &str) -> Result<Vec<String>, String> {
    let text = text.trim();
    if text.is_empty() || text == "[]" {
        return Ok(Vec::new());
    }
    // 手写解析：逐行提取 "..." 段，处理 \" 与 \\ 转义
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '"' {
            continue;
        }
        let mut s = String::new();
        loop {
            match chars.next() {
                Some('\\') => match chars.next() {
                    Some('n') => s.push('\n'),
                    Some('r') => s.push('\r'),
                    Some('t') => s.push('\t'),
                    Some(c) => s.push(c), // \" \\ \/ 等直接取字符
                    None => break,
                },
                Some('"') => break,
                Some(c) => s.push(c),
                None => break,
            }
        }
        out.push(s);
    }
    Ok(out)
}
