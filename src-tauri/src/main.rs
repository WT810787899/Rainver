// ═══════════════════════════════════════════════════════
// Rainver 落雨影音 — 入口：IPC 注册、托盘、全局热键、启动配置应用

// ═══════════════════════════════════════════════════════
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // 发布版隐藏控制台

mod config;
mod files;
mod fs;
mod media_info;
mod settings;
mod thumb;
mod utils;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

fn main() {
    // WebView2 自动播放策略：环境变量由 WebView2 Loader 在创建环境时直接读取，
    // 比 tauri.conf.json 的 additionalBrowserArgs 更可靠（不依赖 wry 参数管道）。
    // 注意：仅在 WebView2 环境首次创建（无同数据目录存活进程）时生效。
    #[cfg(windows)]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // 仅在按下（非释放）时触发：唤起 / 隐藏主窗口
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            fs::list_directory,             // 扫描目录 → MediaItem 列表
            fs::list_directory_deep,        // L230：穿透递归扫描
            fs::list_directory_stream,      // 流式扫描：每 500 条 emit dir-chunk，前端增量渲染
            fs::list_subfolders,            // 侧边树：子文件夹
            fs::pick_and_list,              // 选择根目录并扫描
            fs::list_drives,                // 磁盘根列表
            fs::list_quick_dirs,            // 常用目录（音乐/图片/视频/文档/下载）
            fs::stat_items,                 // 集锦箱：按路径批量取元数据
            thumb::get_thumbnail,           // 图片/视频缩略图（带缓存）
            thumb::get_cache_stats,         // 缓存统计
            thumb::clear_thumbnail_cache,   // 一键清理缓存
            thumb::detect_ffmpeg,           // ffmpeg 自动检测（路径+版本）
            thumb::pick_ffmpeg,             // 手动选择 ffmpeg 可执行文件
            thumb::get_playable_path,       // 播放兼容：不支持的容器无损重封装为 mp4
            thumb::extract_audio_track,     // 提取指定音轨并转码为 AAC（web-demuxer 不支持的音轨）
            thumb::extract_video_only,      // 提取纯视频流（丢弃音轨），供 web-demuxer 播放
            thumb::stream_audio,            // 实时转码音频为 fMP4，通过事件推送前端 MSE 播放
            thumb::stop_audio_stream,       // 停止实时音频流
            thumb::get_file_server_port,    // 获取本地文件 HTTP 服务器端口
            thumb::transcode_stream,        // 硬件转码并流式输出（边转边播）
            thumb::stop_transcode_stream,   // 停止流式转码（关闭查看器时）
            thumb::transform_image,         // 旋转/翻转写回原图
            thumb::cancel_all_previews,     // 取消所有预览重封装（全屏播放时释放资源）
            thumb::transcode_to_playable,   // 视频编码不支持时转码为 H.264 mp4
            thumb::get_preview_path,        // 卡片预览专用：只重封装开头 N 秒
            thumb::cancel_preview,          // 卡片滚走时掐掉正在跑的重封装
            thumb::frame_at,                // L131：进度条悬浮帧预览
            thumb::build_seek_frames,        // L131c：进度缩略图关键帧序列（后台实时落盘）
            thumb::list_seek_frames,        // L131c：轮询已落盘关键帧清单
            thumb::cancel_sprite,           // L131c：杀正在跑的逐帧生成 ffmpeg
            media_info::get_media_info,     // 单项元信息（含音频封面）
            media_info::get_media_props,    // 属性面板：帧率/分辨率/编码等
            config::load_config,            // 读取持久化配置
            config::save_config,            // 保存配置（含热键/并发副作用）
            config::reset_config,           // 重置全部设置
            config::pick_cache_dir,         // 选择缓存目录
            config::pick_wallpaper,         // 选择壁纸文件
            config::save_window_geometry,   // 保存窗口大小/位置
            config::load_window_geometry,   // 读取窗口大小/位置
            settings::open_media,           // 系统默认程序打开
            settings::set_mica,             // Mica 开关
            settings::set_window_opacity,   // 窗口全局不透明度
            settings::toggle_fullscreen,    // 窗口全屏原子切换（最大化态安全）
            utils::check_path,              // 路径防穿越校验
            files::copy_items,              // 复制到目录（重名自动加序号）
            files::move_items,              // 剪切（移动）到目录
            files::delete_items,            // 删除（回收站 / 永久删除）
            files::set_clipboard_files,     // 写入系统剪贴板（与资源管理器互通）
            files::get_clipboard_files,     // 读取系统剪贴板文件
            files::start_file_drag,         // L87：原生拖出文件到资源管理器（drag crate）
            files::copy_files_into,         // L78：拖入文件区以复制方式放入
            files::read_collection_box,     // L88：读取编号集锦箱
            files::write_collection_box,    // L88：写入编号集锦箱
            files::rename_item,             // 重命名文件/文件夹
            files::save_screenshot,         // 保存截图
            files::capture_window,          // L240：截取窗口画面（非视频截图）
        ])

        .setup(|app| {
            // ─── 读取配置 ───
            let cfg = config::read_config(app.handle());

            // ─── 托盘 ───
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let perf = MenuItem::with_id(app, "perf", "表演模式", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &perf, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Rainver 落雨影音")

                .menu(&menu)
                // 左键只切换显示/隐藏，不弹菜单；菜单由右键打开
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "perf" => {
                        // 先呼出窗口再通知前端切换表演模式（隐藏时启动表演无意义）
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = app.emit("tray-perf", ());
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击切换窗口显示
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                                release_background_ffmpeg(app); // 托盘隐藏：回收 ffmpeg 视频类工作
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // ─── 启动时应用窗口效果（Mica + 不透明度） ───
            settings::apply_window_effects(app.handle(), &cfg);

            // ─── 全局热键（配置值；失败仅告警不崩溃） ───
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            if let Err(e) = app.global_shortcut().register(cfg.global_hotkey.as_str()) {
                eprintln!("全局热键 {} 注册失败（可能被占用）: {e}", cfg.global_hotkey);
            }

            // ─── ffmpeg 并发 & 手动路径 & 缓存目录 ───
            thumb::set_concurrency(cfg.ffmpeg_concurrency);
            // 上次异常退出留下的 `.part` 半成品是纯垃圾（每个几 GB），
            // 它们会被算进缓存体积，不清的话每次崩溃都再攒一批。
            thumb::sweep_partials(app.handle());
            if !cfg.ffmpeg_path.is_empty() {
                if let Ok(p) = utils::canonicalize_checked(&cfg.ffmpeg_path) {
                    if p.is_file() {
                        thumb::set_ffmpeg_path(Some(p));
                    }
                }
            }
            if !cfg.cache_dir.is_empty() {
                if let Ok(p) = utils::canonicalize_checked(&cfg.cache_dir) {
                    thumb::set_cache_dir(p);
                }
            }

            // ─── LRU 缓存淘汰（异步后台执行，不阻塞启动） ───
            let handle = app.handle().clone();
            let (limit, lru) = (cfg.cache_limit_mb, cfg.lru_enabled);
            tauri::async_runtime::spawn_blocking(move || {
                thumb::enforce_cache_limit(handle, limit, lru);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 最小化进后台：回收 ffmpeg 视频类工作，避免后台空耗 CPU/GPU。
            // （Tauri 2 无 Minimized 事件：Resized 时查 is_minimized，最小化仅触发一次）
            if let tauri::WindowEvent::Resized(_) = event {
                if window.is_minimized().unwrap_or(false) {
                    release_background_ffmpeg(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Rainver 启动失败")
        .run(move |_app_handle, event| {
            // 进程退出前必须收掉外部进程。Windows 上父进程退出**不会**带走子进程：
            // 开了单文件循环的解码管线是 `-stream_loop -1`，应用一关，ffmpeg 就成了
            // 孤儿，还在后台满速解码 + 编码，吃满一个核，只能去任务管理器手动结束。
            // 所以在 Exit 上主动 kill + wait（wait 顺带回收进程句柄，
            // 否则每次启停都漏一个句柄，跑久了句柄表会耗尽）。
            if let tauri::RunEvent::Exit = event {
                thumb::kill_all_remuxes();
            }
        });

}

/// 唤起/隐藏主窗口（全局热键与托盘共用）
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
            release_background_ffmpeg(app);
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// 隐藏/最小化进后台：回收全部 ffmpeg 视频类工作（转码流 + 预览 remux），
/// 避免后台空耗 CPU/GPU/IO。音频播放独立于这些进程，不受影响。
/// emit 通知前端暂停视频层（转码流已被杀，video 会僵等死流）。
fn release_background_ffmpeg(app: &tauri::AppHandle) {
    thumb::stop_transcode_stream();
    thumb::cancel_all_previews();
    let _ = app.emit("ffmpeg-released", ());
}
