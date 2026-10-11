// ═══════════════════════════════════════════════════════
// settings.rs — 窗口效果（Mica / 全局不透明度）与系统打开
//   Windows: Mica 用 tauri set_effects；不透明度用 Win32 分层窗口
// ═══════════════════════════════════════════════════════
use crate::utils::canonicalize_checked;
use tauri::Manager;

/// 用系统默认程序打开媒体文件（只读操作，不修改文件）
#[tauri::command]
pub fn open_media(path: String) -> Result<(), String> {
    let p = canonicalize_checked(&path)?;
    tauri_plugin_opener::open_path(p.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("打开失败: {e}"))
}

/// Mica 材质开关（Win11 云母背景；非 Windows 平台忽略）
#[tauri::command]
pub fn set_mica(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    apply_mica(&app, enabled)
}

pub fn apply_mica(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    #[cfg(windows)]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        if enabled {
            let effects = EffectsBuilder::new()
                .effects([Effect::Mica])
                .state(EffectState::Active)
                .build();
            win.set_effects(Some(effects))
                .map_err(|e| format!("Mica 应用失败: {e}"))?;
        } else {
            // None = 清除材质
            win.set_effects(None).map_err(|e| format!("Mica 清除失败: {e}"))?;
        }
    }
    #[cfg(not(windows))]
    let _ = (win, enabled);
    Ok(())
}

/// 窗口全局不透明度（0.3 ~ 1.0）
/// alpha < 1 时挂 WS_EX_LAYERED + LWA_ALPHA；恢复 1.0 时摘除分层样式，让 Mica 正常显示
#[tauri::command]
pub fn set_window_opacity(app: tauri::AppHandle, alpha: f64) -> Result<(), String> {
    apply_opacity(&app, alpha)
}

pub fn apply_opacity(app: &tauri::AppHandle, alpha: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let alpha = alpha.clamp(0.3, 1.0);
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
            LWA_ALPHA, WS_EX_LAYERED,
        };
        let hwnd = win.hwnd().map_err(|e| format!("获取窗口句柄失败: {e}"))?;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if alpha < 1.0 {
                // 挂分层样式 + 设置整体 alpha
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize);
                SetLayeredWindowAttributes(hwnd, Default::default(), (alpha * 255.0) as u8, LWA_ALPHA)
                    .map_err(|e| format!("设置透明度失败: {e}"))?;
            } else {
                // 摘除分层样式（Mica 与 WS_EX_LAYERED 不兼容）
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !(WS_EX_LAYERED.0 as isize));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (win, alpha);
    Ok(())
}

/// 启动时按配置应用窗口效果（Mica + 不透明度），供 main.rs setup 调用
pub fn apply_window_effects(app: &tauri::AppHandle, cfg: &crate::config::AppConfig) {
    if let Err(e) = apply_mica(app, cfg.mica_enabled) {
        eprintln!("Mica: {e}");
    }
    if let Err(e) = apply_opacity(app, cfg.window_opacity) {
        eprintln!("窗口透明度: {e}");
    }
}

// ─── 窗口全屏切换 ───
// 必须在主线程上原子完成（run_on_main_thread 同步等待）。
// 历史问题：最大化窗口直接走 tao set_fullscreen(true) 会残留最大化内部状态，
// tao 按保存的 maximized placement 恢复时窗口卡在伪全屏（setFullscreen(false) 失效）。
// 旧绕法是先 ShowWindow(SW_RESTORE) 再进全屏，但那会产生一帧 normal 几何，
// 前端会看到背景画廊缩小一闪。
//
// 现方案：最大化态走自实现的「无边框全屏」——保存 WINDOWPLACEMENT（含 SW_SHOWMAXIMIZED）
// 与窗口样式，去边框后 SetWindowPos 直接扩到显示器矩形，全程不经过 normal；
// 退出时先恢复样式再 SetWindowPlacement 原子还原 maximized，同样无 normal 中间帧。
// 普通（normal）窗口才走 tao 原路径（该路径无最大化残留问题）。
static FULLSCREEN_WAS_MAX: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

#[cfg(windows)]
struct BorderlessFsState {
    placement: windows::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT,
    style: u32,
    ex_style: u32,
}
#[cfg(windows)]
static BORDERLESS_FS: std::sync::Mutex<Option<BorderlessFsState>> = std::sync::Mutex::new(None);

/// 最大化窗口 → 自实现无边框全屏（无 normal 中间帧）
#[cfg(windows)]
fn enter_borderless_fullscreen(
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        ClientToScreen, GetMonitorInfoW, MonitorFromWindow, MONITOR_DEFAULTTONEAREST,
        MONITORINFO,
    };
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowLongW, GetWindowPlacement, GetWindowRect, SetWindowLongW,
        SetWindowPos, GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, WINDOWPLACEMENT, WS_MAXIMIZE,
    };
    unsafe {
        // 1) 保存 maximized placement（退出时 SetWindowPlacement 原子还原，不闪 normal）
        let mut plc = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        GetWindowPlacement(hwnd, &mut plc).map_err(|e| format!("GetWindowPlacement: {e}"))?;
        let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;

        // 2) 取窗口所在显示器的整屏矩形（含任务栏区）
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return Err("GetMonitorInfoW 失败".into());
        }
        let r = mi.rcMonitor;

        *BORDERLESS_FS.lock().unwrap() = Some(BorderlessFsState {
            placement: plc,
            style,
            ex_style,
        });

        // 3) 样式不动（decorations:false + 透明分层窗口），只清 WS_MAXIMIZE 状态位解除工作区钳制。
        //    该窗口在非最大化态仍带非对称非客户区内嵌（实测 左8/上1/右8/下8，随 DPI/系统变化），
        //    先按显示器矩形落位+FRAMECHANGED，再用同步的 GetClientRect/ClientToScreen 实测四边，
        //    非对称外扩，使客户区逐像素等于显示器矩形（顶部内嵌只有 1px，不能对称扩 8px）。
        SetWindowLongW(hwnd, GWL_STYLE, (style & !WS_MAXIMIZE.0) as i32);
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            r.left,
            r.top,
            r.right - r.left,
            r.bottom - r.top,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|e| format!("SetWindowPos(enter1): {e}"))?;

        // USER32 几何查询是同步的（不同于异步合成的 DWM 边界），FRAMECHANGED 后即可信
        let mut wr1 = RECT::default();
        GetWindowRect(hwnd, &mut wr1).map_err(|e| format!("GetWindowRect: {e}"))?;
        let mut cr1 = RECT::default();
        GetClientRect(hwnd, &mut cr1).map_err(|e| format!("GetClientRect: {e}"))?;
        let mut org1 = POINT::default();
        if !ClientToScreen(hwnd, &mut org1).as_bool() {
            return Err("ClientToScreen 失败".into());
        }
        let il = org1.x - wr1.left;
        let it = org1.y - wr1.top;
        let ir = wr1.right - (org1.x + (cr1.right - cr1.left));
        let ib = wr1.bottom - (org1.y + (cr1.bottom - cr1.top));
        if il != 0 || it != 0 || ir != 0 || ib != 0 {
            // 二次定位：不带 FRAMECHANGED（内嵌只取决于样式/DPI，不再变化）
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                r.left - il,
                r.top - it,
                r.right - r.left + il + ir,
                r.bottom - r.top + it + ib,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
            .map_err(|e| format!("SetWindowPos(enter2): {e}"))?;
        }
    }
    Ok(())
}

/// 无边框全屏 → 恢复原样式并原子还原 maximized placement（无 normal 中间帧）
#[cfg(windows)]
fn exit_borderless_fullscreen(
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowLongW, SetWindowPlacement, SetWindowPos, GWL_EXSTYLE, GWL_STYLE,
        HWND_NOTOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Some(st) = BORDERLESS_FS.lock().unwrap().take() else {
        return Ok(());
    };
    unsafe {
        SetWindowLongW(hwnd, GWL_STYLE, st.style as i32);
        SetWindowLongW(hwnd, GWL_EXSTYLE, st.ex_style as i32);
        // SW_SHOWMAXIMIZED 的 placement 直接回最大化，Win32 不回放 normal 几何
        SetWindowPlacement(hwnd, &st.placement)
            .map_err(|e| format!("SetWindowPlacement: {e}"))?;
        SetWindowPos(
            hwnd,
            Some(HWND_NOTOPMOST),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|e| format!("SetWindowPos(exit): {e}"))?;
    }
    Ok(())
}

/// 切换主窗口全屏；only_exit=true 时仅在当前全屏时退出（关闭预览场景），不进入
#[tauri::command]
pub async fn toggle_fullscreen(app: tauri::AppHandle, only_exit: bool) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(toggle_fullscreen_impl(&handle, only_exit));
    })
    .map_err(|e| format!("派发到主线程失败: {e}"))?;
    rx.recv().map_err(|_| "主线程执行通道关闭".to_string())?
}

fn toggle_fullscreen_impl(app: &tauri::AppHandle, only_exit: bool) -> Result<bool, String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("主窗口不存在".into());
    };

    // 自实现无边框全屏（自最大化进入）：原子还原 maximized
    #[cfg(windows)]
    {
        let hwnd = win.hwnd().map_err(|e| format!("获取窗口句柄失败: {e}"))?;
        if BORDERLESS_FS.lock().unwrap().is_some() {
            exit_borderless_fullscreen(hwnd)?;
            *FULLSCREEN_WAS_MAX.lock().unwrap() = false;
            return Ok(false);
        }
    }

    let full = win.is_fullscreen().map_err(|e| e.to_string())?;
    if full {
        // 退出 tao 全屏；normal 路径进入时 was_max 恒为 false，保留判断仅作兜底
        win.set_fullscreen(false).map_err(|e| e.to_string())?;
        let was_max = {
            let mut g = FULLSCREEN_WAS_MAX.lock().unwrap();
            std::mem::replace(&mut *g, false)
        };
        if was_max {
            win.maximize().map_err(|e| e.to_string())?;
        }
        return Ok(false);
    }
    if only_exit {
        return Ok(false); // 非全屏且仅要求退出：无操作
    }

    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::IsZoomed;
        let hwnd = win.hwnd().map_err(|e| format!("获取窗口句柄失败: {e}"))?;
        if unsafe { IsZoomed(hwnd).as_bool() } {
            // 最大化：无边框全屏直切，不 SW_RESTORE、不经过 normal
            *FULLSCREEN_WAS_MAX.lock().unwrap() = true;
            enter_borderless_fullscreen(hwnd)?;
            return Ok(true);
        }
    }
    #[cfg(not(windows))]
    {
        *FULLSCREEN_WAS_MAX.lock().unwrap() = win.is_maximized().unwrap_or(false);
    }
    // normal 窗口：tao 路径（无最大化残留问题）
    win.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(true)
}
