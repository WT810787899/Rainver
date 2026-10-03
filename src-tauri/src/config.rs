// ═══════════════════════════════════════════════════════
// config.rs — 持久化配置（tauri-plugin-store）
//   覆盖：外观 / 行为 / 快捷键 / 收藏 / 视图状态 全部字段
//   保存时自动应用副作用（全局热键重注册、ffmpeg 并发数）
// ═══════════════════════════════════════════════════════
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::Arc;

const STORE_FILE: &str = "config.json";
const KEY: &str = "app-config";

/// 本地快捷键表：动作名 -> 组合键字符串（如 "Ctrl+f" / "Escape"）
pub type LocalShortcuts = HashMap<String, String>;

/// 应用配置 — 与前端共享（camelCase）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    // ─── 视图状态 ───
    pub last_dir: String,
    pub view_mode: String,          // grid | list | gallery
    pub theme: String,              // dark | light | system
    pub thumb_size: f64,
    pub info_panel_width: f64,
    pub info_panel_visible: bool,
    pub sidebar_width: f64,
    pub sort_mode: String,          // nameAsc | nameDesc | sizeAsc | sizeDesc | modifiedAsc | modifiedDesc | type
    pub filter_kind: String,        // all | image | video | audio
    pub sidebar_visible: bool,      // 左侧栏显示开关
    #[serde(default)]
    pub tabs: Vec<String>,          // 文件区标签页（每个标签 = 一个目录路径）
    #[serde(default)]
    pub active_tab: usize,          // 当前标签页索引
    /// 播放进度：文件路径 -> 已播放秒数（退出/刷新后从记录位置续播）
    #[serde(default)]
    pub playback_progress: HashMap<String, f64>,


    // ─── 外观 ───
    pub window_opacity: f64,        // 窗口全局不透明度 0.3 ~ 1.0
    pub wallpaper_enabled: bool,    // 自定义本地背景壁纸开关
    pub wallpaper_path: String,
    pub wallpaper_opacity: f64,     // 壁纸透明度
    pub background_blur: f64,      // 背景模糊度 px
    pub mask_color: String,         // 遮罩颜色 hex
    pub mask_opacity: f64,          // 遮罩透明度
    pub mica_enabled: bool,         // Mica 材质开关（Win11）
    pub accent_color: String,       // 强调色 hex

    // ─── 行为 ───
    pub cache_dir: String,          // 空字符串 = 默认 %APPDATA%
    pub cache_limit_mb: f64,        // 缓存大小上限（0 = 不限）
    pub lru_enabled: bool,          // LRU 缓存淘汰开关
    pub ffmpeg_concurrency: u32,    // ffmpeg 缩略并发任务数
    pub ffmpeg_path: String,        // ffmpeg 手动指定路径（空 = 自动检测）
    pub overscan: u32,              // 虚拟滚动上下多渲染行数
    pub double_click_action: String,// viewer | open | none
    pub video_autoplay: bool,       // 画廊预览打开时视频是否自动播放
    pub video_autoplay_limit: u32,  // 画廊预览同时自动播放数量上限（0 = 不限）
    pub video_wheel_switch: bool,   // 预览器内滚轮切换文件（含视频）
    /// 预览器 Q/E 的跳转步长（秒）。10 是播放器惯例；给到 300 是为了长纪录片。
    pub video_seek_step: f64,
    pub immersive_fullscreen: bool, // 进入沉浸模式时自动全屏
    pub tree_folder_count: bool,    // 目录树名称后显示子文件夹数量

    // ─── 播放器状态（音量/静音持久化） ───
    pub video_volume: f64,          // 视频/预览音量 0~100
    pub video_muted: bool,
    pub audio_volume: f64,          // 独立音频模块音量 0~100
    pub audio_muted: bool,
    /// 音频播放队列（路径列表）与当前索引 —— 支持后台播放与重启恢复
    #[serde(default)]
    pub audio_queue: Vec<String>,
    #[serde(default)]
    pub audio_queue_index: usize,


    // ─── 快捷键 ───
    pub global_hotkey: String,      // 全局唤起/隐藏热键，默认 Shift+S
    pub local_shortcuts: LocalShortcuts,

    // ─── 收藏夹 ───
    #[serde(default)]
    pub favorites: Vec<String>,
    // ─── 集锦箱（旧版存储；L88 起迁移到本地文件 box{1..5}.json，此字段仅用于一次性迁移） ───
    #[serde(default)]
    pub collection: Vec<String>,

    // ─── L93：深/浅主题独立外观覆盖（None = 跟随上方全局基础值；壁纸路径共享不进结构） ───
    pub appearance_dark: ThemeAppearance,
    pub appearance_light: ThemeAppearance,

    // ─── 画廊表演（F1 进入/退出，F2 设置面板） ───
    #[serde(default)]
    pub gallery_perf: GalleryPerfConfig,
}

/// 画廊表演配置：三个模式各自独立子设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GalleryPerfConfig {
    pub mode: String,               // waterfall | cards | array
    // 模式1 瀑布流
    pub waterfall_speed: f64,       // 滚动速度 px/s
    pub waterfall_direction: String,// down | up
    pub waterfall_bottom: String,   // bounce 回弹 | restart 从头
    pub waterfall_dwell: f64,       // 触底停留秒
    // 模式2 卡片动画
    pub cards_count: u32,           // 同时显示卡片数量（0 = 跟随缩放默认数量）
    pub cards_interval: f64,        // 切换速度 秒
    pub cards_no_repeat: bool,      // 轮次内排除重复
    pub cards_fade: f64,            // 过渡时长 ms（0 = 无动画纯快切）
    pub cards_anim: String,         // 动画类型 fade | zoomIn | zoomOut | slideUp | blur
    pub cards_sync: bool,           // 同步开关：关闭=同时出现；开启=各卡片错峰随机出现
    pub cards_sync_min: f64,        // 错峰随机延迟下限 ms
    pub cards_sync_max: f64,        // 错峰随机延迟上限 ms
    // 模式3 随机阵列
    pub array_interval: f64,        // 视口跳动间隔 秒
    // 模式4 幻灯片（1-2 张大图/视频，Ken Burns / 翻转等动画）
    pub slide_count: u32,           // 同屏张数 0=自动 | 1 | 2
    pub slide_interval: f64,        // 每张停留秒
    pub slide_duration: f64,        // 过渡时长 秒
    pub slide_effect: String,       // kenburns | panL | panR | fade | blur | flip | slideL | circle | blackout
    pub slide_random_fx: bool,      // 每张幻灯片随机一种动画
    pub slide_include_video: bool,  // （已废弃：视频始终直接播放）保留字段兼容旧配置
    // 模式5 封面流（3D Cover Flow 自动推进）
    pub cover_interval: f64,        // 推进间隔 秒
    pub cover_effect: String,      // 中央卡切换效果 zoom | flip | slide | fade | rotate
    // 配置迁移版本（JS 端一次性迁移用，缺失按 0）
    pub perf_ver: u32,
    // 通用
    pub mute: bool,                 // 表演时静音卡片视频
}

impl Default for GalleryPerfConfig {
    fn default() -> Self {
        Self {
            mode: "waterfall".into(),
            waterfall_speed: 120.0,
            waterfall_direction: "down".into(),
            waterfall_bottom: "bounce".into(),
            waterfall_dwell: 1.0,
            cards_count: 0,
            cards_interval: 2.0,
            cards_no_repeat: true,
            cards_fade: 450.0,
            cards_anim: "zoomIn".into(),
            cards_sync: true,
            cards_sync_min: 0.0,
            cards_sync_max: 2000.0,
            array_interval: 2.0,
            slide_count: 0,
            slide_interval: 5.0,
            slide_duration: 0.9,
            slide_effect: "kenburns".into(),
            slide_random_fx: true,
            slide_include_video: false,
            cover_interval: 2.5,
            cover_effect: "zoom".into(),
            perf_ver: 0,
            mute: true,
        }
    }
}

/// 单个主题的外观覆盖参数：字段均为可选，未设置时回退到 AppConfig 的全局外观字段
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeAppearance {
    pub accent_color: Option<String>,
    pub wallpaper_enabled: Option<bool>,
    pub wallpaper_opacity: Option<f64>,
    pub background_blur: Option<f64>,
    pub mask_color: Option<String>,
    pub mask_opacity: Option<f64>,
    pub mica_enabled: Option<bool>,
    pub window_opacity: Option<f64>,
}

/// config.json 持久化结构 —— 只含非大列表字段（大列表走 data/*.json）
/// 从 AppConfig 转换而来，写入 store 时自动排除 tabs/progress/queue/favs/collection
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigCore<'a> {
    last_dir: &'a str,
    view_mode: &'a str,
    theme: &'a str,
    thumb_size: f64,
    info_panel_width: f64,
    info_panel_visible: bool,
    sidebar_width: f64,
    sort_mode: &'a str,
    filter_kind: &'a str,
    sidebar_visible: bool,
    // 外观
    window_opacity: f64,
    wallpaper_enabled: bool,
    wallpaper_path: &'a str,
    wallpaper_opacity: f64,
    background_blur: f64,
    mask_color: &'a str,
    mask_opacity: f64,
    mica_enabled: bool,
    accent_color: &'a str,
    // 行为
    cache_dir: &'a str,
    cache_limit_mb: f64,
    lru_enabled: bool,
    ffmpeg_concurrency: u32,
    ffmpeg_path: &'a str,
    overscan: u32,
    double_click_action: &'a str,
    video_autoplay: bool,
    video_autoplay_limit: u32,
    video_wheel_switch: bool,
    video_seek_step: f64,
    immersive_fullscreen: bool,
    tree_folder_count: bool,
    // 播放器状态
    video_volume: f64,
    video_muted: bool,
    audio_volume: f64,
    audio_muted: bool,
    // 快捷键
    global_hotkey: &'a str,
    local_shortcuts: &'a LocalShortcuts,
    // 主题外观
    appearance_dark: &'a ThemeAppearance,
    appearance_light: &'a ThemeAppearance,
    // 画廊表演
    gallery_perf: &'a GalleryPerfConfig,
}

impl<'a> From<&'a AppConfig> for AppConfigCore<'a> {
    fn from(c: &'a AppConfig) -> Self {
        Self {
            last_dir: &c.last_dir,
            view_mode: &c.view_mode,
            theme: &c.theme,
            thumb_size: c.thumb_size,
            info_panel_width: c.info_panel_width,
            info_panel_visible: c.info_panel_visible,
            sidebar_width: c.sidebar_width,
            sort_mode: &c.sort_mode,
            filter_kind: &c.filter_kind,
            sidebar_visible: c.sidebar_visible,
            window_opacity: c.window_opacity,
            wallpaper_enabled: c.wallpaper_enabled,
            wallpaper_path: &c.wallpaper_path,
            wallpaper_opacity: c.wallpaper_opacity,
            background_blur: c.background_blur,
            mask_color: &c.mask_color,
            mask_opacity: c.mask_opacity,
            mica_enabled: c.mica_enabled,
            accent_color: &c.accent_color,
            cache_dir: &c.cache_dir,
            cache_limit_mb: c.cache_limit_mb,
            lru_enabled: c.lru_enabled,
            ffmpeg_concurrency: c.ffmpeg_concurrency,
            ffmpeg_path: &c.ffmpeg_path,
            overscan: c.overscan,
            double_click_action: &c.double_click_action,
            video_autoplay: c.video_autoplay,
            video_autoplay_limit: c.video_autoplay_limit,
            video_wheel_switch: c.video_wheel_switch,
            video_seek_step: c.video_seek_step,
            immersive_fullscreen: c.immersive_fullscreen,
            tree_folder_count: c.tree_folder_count,
            video_volume: c.video_volume,
            video_muted: c.video_muted,
            audio_volume: c.audio_volume,
            audio_muted: c.audio_muted,
            global_hotkey: &c.global_hotkey,
            local_shortcuts: &c.local_shortcuts,
            appearance_dark: &c.appearance_dark,
            appearance_light: &c.appearance_light,
            gallery_perf: &c.gallery_perf,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            last_dir: String::new(),
            view_mode: "grid".into(),
            theme: "dark".into(),
            thumb_size: 160.0,
            info_panel_width: 280.0,
            info_panel_visible: true,
            sidebar_width: 240.0,
            sort_mode: "type".into(),
            filter_kind: "all".into(),
            sidebar_visible: true,
            tabs: Vec::new(),
            active_tab: 0,
            playback_progress: HashMap::new(),

            // 外观默认
            window_opacity: 1.0,
            wallpaper_enabled: false,
            wallpaper_path: String::new(),
            wallpaper_opacity: 1.0,
            background_blur: 0.0,
            mask_color: "#0f172a".into(),
            mask_opacity: 0.0,
            mica_enabled: true,
            accent_color: "#0ea5e9".into(),
            // 行为默认
            cache_dir: String::new(),
            cache_limit_mb: 512.0,
            lru_enabled: true,
            ffmpeg_concurrency: 4,
            ffmpeg_path: String::new(),
            overscan: 2,
            double_click_action: "viewer".into(),
            video_autoplay: true,
            video_autoplay_limit: 0,
            video_wheel_switch: true,
            video_seek_step: 10.0,
            immersive_fullscreen: true,
            tree_folder_count: true,
            // 播放器状态默认
            video_volume: 100.0,
            video_muted: false,
            audio_volume: 100.0,
            audio_muted: false,
            audio_queue: Vec::new(),
            audio_queue_index: 0,

            // 快捷键默认：上一文件 A / 下一文件 D / 全局唤起 Shift+E
            global_hotkey: "Shift+E".into(),
            local_shortcuts: HashMap::from([
                ("openViewer".to_string(), "Enter".to_string()),
                ("viewerClose".to_string(), "Escape".to_string()),
                ("viewerPrev".to_string(), "a".to_string()),
                ("viewerNext".to_string(), "d".to_string()),
                ("goUp".to_string(), "Backspace".to_string()),
                ("focusSearch".to_string(), "Ctrl+f".to_string()),
                ("toggleTheme".to_string(), "Ctrl+t".to_string()),
                ("togglePanel".to_string(), "Ctrl+i".to_string()),
            ]),

            favorites: Vec::new(),
            collection: Vec::new(),
            appearance_dark: ThemeAppearance::default(),
            appearance_light: ThemeAppearance::default(),
            gallery_perf: GalleryPerfConfig::default(),
        }
    }
}

/// 同步读取配置（IPC 命令与启动逻辑共用）；任何异常回退默认值，绝不崩溃
pub fn read_config(app: &tauri::AppHandle) -> AppConfig {
    let Ok(store) = config_store(app) else {
        return AppConfig::default();
    };
    store
        .get(KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// 构建指向项目 cache 目录的 store
fn config_store(app: &tauri::AppHandle) -> Result<Arc<tauri_plugin_store::Store<tauri::Wry>>, tauri_plugin_store::Error> {
    let dir = crate::utils::ensure_project_cache_dir().map_err(|e| {
        tauri_plugin_store::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, e))
    })?;
    let path = dir.join(STORE_FILE);
    tauri_plugin_store::StoreBuilder::new(app, path).build()
}

/// 已应用副作用快照 (热键, ffmpeg 并发)，避免每次保存重复注册
fn applied_state() -> &'static Mutex<Option<(String, u32)>> {
    static S: Mutex<Option<(String, u32)>> = Mutex::new(None);
    &S
}

// ─── 大列表分文件存储 ───
// 避免 config.json 因 audio_queue / playback_progress / favorites / tabs 过大而读写慢
fn data_dir() -> Result<std::path::PathBuf, String> {
    let dir = crate::utils::ensure_project_cache_dir()?.join("data");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 data 目录失败: {e}"))?;
    Ok(dir)
}

fn read_json<T: serde::de::DeserializeOwned>(name: &str) -> Option<T> {
    let p = data_dir().ok()?.join(name);
    let s = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_json<T: Serialize>(name: &str, val: &T) -> Result<(), String> {
    let p = data_dir()?.join(name);
    let s = serde_json::to_string(val).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&p, s).map_err(|e| format!("写入 {} 失败: {e}", name))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
struct TabsData { tabs: Vec<String>, active: usize }
#[derive(Serialize, Deserialize, Default)]
struct AudioQueueData { queue: Vec<String>, index: usize }

/// 从分离文件加载大列表到 cfg（若文件不存在则保持 cfg 中的默认/旧值）
fn load_lists(cfg: &mut AppConfig) {
    if let Some(d) = read_json::<TabsData>("tabs.json") {
        cfg.tabs = d.tabs;
        cfg.active_tab = d.active;
    }
    if let Some(p) = read_json::<HashMap<String, f64>>("playback_progress.json") {
        cfg.playback_progress = p;
    }
    if let Some(d) = read_json::<AudioQueueData>("audio_queue.json") {
        cfg.audio_queue = d.queue;
        cfg.audio_queue_index = d.index;
    }
    if let Some(f) = read_json::<Vec<String>>("favorites.json") {
        cfg.favorites = f;
    }
}

/// 把大列表保存到分离文件
fn save_lists(cfg: &AppConfig) -> Result<(), String> {
    write_json("tabs.json", &TabsData { tabs: cfg.tabs.clone(), active: cfg.active_tab })?;
    write_json("playback_progress.json", &cfg.playback_progress)?;
    write_json("audio_queue.json", &AudioQueueData { queue: cfg.audio_queue.clone(), index: cfg.audio_queue_index })?;
    write_json("favorites.json", &cfg.favorites)?;
    Ok(())
}

/// 读取配置 IPC
#[tauri::command]
pub async fn load_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    let mut cfg = read_config(&app);
    load_lists(&mut cfg);
    Ok(cfg)
}

/// 保存配置 IPC — 写入 store 后自动应用热键/并发副作用
#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, cfg: AppConfig) -> Result<(), String> {
    let store = config_store(&app).map_err(|e| format!("打开配置存储失败: {e}"))?;
    // 分流写入：非大列表 → config.json；大列表 → data/*.json
    let core = AppConfigCore::from(&cfg);
    let value = serde_json::to_value(core).map_err(|e| format!("配置序列化失败: {e}"))?;
    store.set(KEY, value);
    store.save().map_err(|e| format!("配置写入失败: {e}"))?;

    // 大列表直接写入各自的 data 文件
    save_lists(&cfg)?;

    // ─── 副作用：仅当热键/并发与上次不同才动作 ───
    let mut last = applied_state().lock().unwrap();
    let need_hotkey = last.as_ref().map(|(h, _)| h != &cfg.global_hotkey).unwrap_or(true);
    let need_ffmpeg = last
        .as_ref()
        .map(|(_, c)| *c != cfg.ffmpeg_concurrency)
        .unwrap_or(true);

    if need_hotkey {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let gs = app.global_shortcut();
        let _ = gs.unregister_all(); // 卸载旧热键（失败忽略）
        if let Err(e) = gs.register(cfg.global_hotkey.as_str()) {
            eprintln!("全局热键 {} 注册失败（可能被占用）: {e}", cfg.global_hotkey);
        }
    }
    if need_ffmpeg {
        crate::thumb::set_concurrency(cfg.ffmpeg_concurrency);
    }
    // ffmpeg 手动路径热更新（空 = 回到自动检测）
    let ffmpeg_override = if cfg.ffmpeg_path.is_empty() {
        None
    } else {
        std::path::PathBuf::from(&cfg.ffmpeg_path).canonicalize().ok()
    };
    crate::thumb::set_ffmpeg_path(ffmpeg_override);
    *last = Some((cfg.global_hotkey.clone(), cfg.ffmpeg_concurrency));
    Ok(())
}

/// 重置全部设置（保留窗口几何键，便于重启后重新保存）
#[tauri::command]
pub async fn reset_config(app: tauri::AppHandle) -> Result<(), String> {
    let store = config_store(&app).map_err(|e| format!("打开配置存储失败: {e}"))?;
    store.delete(KEY);
    store.save().map_err(|e| format!("配置写入失败: {e}"))?;
    *applied_state().lock().unwrap() = None;
    Ok(())
}

/// 选择缓存目录（原生对话框），同时热更新后端缓存路径
#[tauri::command]
pub async fn pick_cache_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .ok_or_else(|| "未选择目录".to_string())?;
    let p = crate::utils::canonicalize_checked(&picked.to_string())?;
    crate::thumb::set_cache_dir(p.clone()); // 立即生效
    Ok(p.to_string_lossy().into_owned())
}

/// 选择本地壁纸文件
#[tauri::command]
pub async fn pick_wallpaper(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .add_filter("图片", &["jpg", "jpeg", "png", "webp", "bmp", "avif"])
        .blocking_pick_file()
        .ok_or_else(|| "未选择文件".to_string())?;
    let p = crate::utils::canonicalize_checked(&picked.to_string())?;
    if !p.is_file() {
        return Err("所选文件无效".into());
    }
    Ok(p.to_string_lossy().into_owned())
}

// ─── 窗口几何持久化 ───

/// 保存窗口位置/大小（关闭时由前端调用）
#[tauri::command]
pub async fn save_window_geometry(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximized: bool,
) -> Result<(), String> {
    let store = config_store(&app).map_err(|e| format!("打开配置存储失败: {e}"))?;
    store.set(
        "window-geometry",
        serde_json::json!({ "x": x, "y": y, "width": width, "height": height, "maximized": maximized }),
    );
    store.save().map_err(|e| format!("配置写入失败: {e}"))?;
    Ok(())
}

/// 读取窗口几何信息（返回 None 表示首次启动）
#[tauri::command]
pub async fn load_window_geometry(
    app: tauri::AppHandle,
) -> Result<Option<serde_json::Value>, String> {
    let store = config_store(&app).map_err(|e| format!("打开配置存储失败: {e}"))?;
    Ok(store.get("window-geometry"))
}
