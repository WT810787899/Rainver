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
// 必须在主线程上原子完成（run_on_main_thread 同步等待）：
// 1. 最大化窗口直接 set_fullscreen(true) 会残留 WS_MAXIMIZE 样式，退出全屏时
//    tao 按保存的最大化 placement 恢复，窗口卡在伪全屏（实测 setFullscreen(false) 完全失效）；
// 2. 前端 isMaximized() 读 tao 内部标志，与真实窗口状态存在不同步窗口，
//    可能在最大化时跳过还原直接进全屏触发上述损坏。
// 因此这里用 Win32 真实状态 IsZoomed 判断，最大化则先 ShowWindow(SW_RESTORE)
// 同步清除 WS_MAXIMIZE，再进全屏；退出后按需恢复最大化。
static FULLSCREEN_WAS_MAX: std::sync::Mutex<bool> = std::sync::Mutex::new(false);

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
    let full = win.is_fullscreen().map_err(|e| e.to_string())?;
    if full {
        // 退出全屏；进入前是最大化则恢复
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
        let hwnd = win.hwnd().map_err(|e| format!("获取窗口句柄失败: {e}"))?;
        unsafe {
            let zoomed = windows::Win32::UI::WindowsAndMessaging::IsZoomed(hwnd).as_bool();
            *FULLSCREEN_WAS_MAX.lock().unwrap() = zoomed;
            if zoomed {
                // 同步还原：清除 WS_MAXIMIZE，保证进全屏时保存的 placement 是 normal 态
                let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::SW_RESTORE,
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        *FULLSCREEN_WAS_MAX.lock().unwrap() = win.is_maximized().unwrap_or(false);
    }
    win.set_fullscreen(true).map_err(|e| e.to_string())?;
    Ok(true)
}
