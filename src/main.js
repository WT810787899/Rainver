// ═══════════════════════════════════════════════════════
// main.js — Rainver 落雨影音 前端逻辑
//   虚拟滚动三视图 / 筛选排序搜索 / 收藏与磁盘根 / 设置 TAB 弹窗
//   外观实时预览 / 自定义快捷键 / 画廊预览 / 配置持久化
// ═══════════════════════════════════════════════════════
import { invoke, convertFileSrc } from './vendor/core.js';
import { getCurrentWindow } from './vendor/window.js';
import { listen } from './vendor/event.js';
import { LogicalSize, LogicalPosition, PhysicalPosition, PhysicalSize } from './vendor/dpi.js';
import { renderAboutHtml, ABOUT } from './about.js';

const win = getCurrentWindow();
const APP_VERSION = ABOUT.version;

// 全局错误捕获：任何未处理异常显示在状态栏，避免静默失败难以排查
window.addEventListener('error', (e) => {
  try { setStatus(`JS错误: ${e.message}（${e.filename?.split('/').pop()}:${e.lineno}）`, true); } catch { /* 忽略 */ }
});

// ─────────── 全局状态 ───────────
const state = {
  cfg: null,           // 后端 AppConfig 镜像
  rootDir: '',
  currentDir: '',
  items: [],
  filtered: [],
  selected: -1,        // 主选中项（信息面板 / 打开预览 / 键盘导航锚点）
  selection: new Set(),// 多选集合（索引）；selected 始终是其中之一
  selVersion: 0,       // 选择变化版本号（渲染签名用，避免每次拼大字符串）
  viewerIndex: -1,
  tabs: [],            // 文件区标签页（每个标签 = 一个目录路径）
  activeTab: 0,
  progress: {},        // 播放进度：path -> 秒（持久化，续播用）
  thumbCache: new Map(),  // path -> {url, duration, w, h}
  thumbPromises: new Map(), // path -> Promise（并发去重）
  thumbFailed: new Set(),   // 已知取不到缩略图的路径（负缓存，避免反复请求）

  infoCache: new Map(),
  treeState: new Set(),   // 展开的树节点路径
  collectionMode: false,  // 集锦箱模式：文件区显示收藏文件而非目录
  penetrate: null,        // L230：穿透扫描中的目录路径（null = 普通单层浏览）
  galleryVer: 0,          // L236：画廊布局版本（缩略图比例回填后 +1，触发重排）
  pendingReveal: null,    // 跳目录后待选中/滚到的文件路径（集锦箱点击定位）
  systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
};



const $ = (id) => document.getElementById(id);
const scroller = $('scroller');
const content = $('content');
const viewerImg = $('viewerImg');

// 调试接口（生产无害）：暴露内部状态供诊断
window.__state = state;

// ─────────── 「关于」面板：文案全部来自 about.js ───────────
$('aboutInfo').innerHTML = renderAboutHtml();
$('aboutAuthor').addEventListener('click', () => {
  // 用系统浏览器打开作者主页（opener 插件；capabilities 已放行 open-url）
  invoke('plugin:opener|open_url', { url: ABOUT.author.url }).catch((e) => setStatus(String(e), true));
});


// ═══════════════ 启动 ═══════════════
// L239：内置壁纸（随前端分发的 src/wallpaper.jpg）。配置里存哨兵值，
// 应用时解析为相对 URL（不能走 convertFileSrc，那是给绝对本地路径用的）
const BUILTIN_WALLPAPER = '__builtin_wallpaper__';
function resolveWallpaperUrl(p) {
  return p === BUILTIN_WALLPAPER ? './wallpaper.jpg' : convertFileSrc(p);
}

async function init() {
  try {
    state.cfg = await invoke('load_config');
  } catch {
    state.cfg = {}; // 极端情况：用默认值兜底
  }
  const c = state.cfg;

  // 画廊表演配置迁移 v2：旧版本把幻灯片同屏张数持久化成了 1（旧默认），
  // 新版 0=自动（竖屏 2 张/横屏 1 张）；serde 默认值只补缺失字段、覆盖不了已存的 1
  const gp0 = c.galleryPerf;
  if (gp0 && (gp0.perfVer ?? 0) < 2) {
    if (gp0.slideCount === 1) gp0.slideCount = 0;
    gp0.perfVer = 2;
    saveCfg();
  }

  // 兜底：页面重载 / HMR 后视频解码进程可能残留，启动时停掉
  invoke('video_stop').catch(() => {});
  invoke('mpv_stop').catch(() => {});
  // 默认快捷键迁移：旧默认是左右方向键，现默认 上一文件 A / 下一文件 D。
  // 仅在"仍是旧默认"（即用户没自定义过）时改写；方向键仍作为固定别名可用。
  const lsc = c.localShortcuts ?? (c.localShortcuts = {});
  if (lsc.viewerPrev === 'ArrowLeft') lsc.viewerPrev = 'a';
  if (lsc.viewerNext === 'ArrowRight') lsc.viewerNext = 'd';
  // L122：沉浸模式默认快捷键 Shift+D（仅用户未自定义过时注入）
  if (!lsc.toggleImmersion) lsc.toggleImmersion = 'Shift+d';
  // L237/L238：M 呼出音频播放器；Ctrl+M 全局卡片静音
  if (!lsc.toggleAudioPanel) lsc.toggleAudioPanel = 'm';
  if (!lsc.toggleCardMute) lsc.toggleCardMute = 'Ctrl+m';

  // L239：首次运行把内置 wallpaper.jpg 设为默认壁纸（深浅两套均开启）
  if (!c.wallpaperDefaultInitialized) {
    c.wallpaperDefaultInitialized = true;
    if (!c.wallpaperPath) c.wallpaperPath = BUILTIN_WALLPAPER;
    c.appearanceDark = c.appearanceDark ?? {};
    c.appearanceLight = c.appearanceLight ?? {};
    if (c.appearanceDark.wallpaperEnabled === undefined) c.appearanceDark.wallpaperEnabled = true;
    if (c.appearanceLight.wallpaperEnabled === undefined) c.appearanceLight.wallpaperEnabled = true;
    saveCfg();
  }
  // 缩略并发默认值迁移：旧默认 2 → 按 CPU 核数（多线程加载优化）；同样只在未自定义过时提升
  if (c.ffmpegConcurrency === 2) {
    c.ffmpegConcurrency = Math.max(4, Math.min(8, navigator.hardwareConcurrency || 4));
  }


  // 视图状态恢复（L80：滑块显示当前视图的独立缩放值）
  $('zoomSlider').value = c.viewMode === 'gallery' ? (c.galleryThumbSize ?? 260) : (c.thumbSize ?? 160);
  $('sidebar').style.width = (c.sidebarWidth ?? 240) + 'px';
  $('infoPanel').style.width = (c.infoPanelWidth ?? 280) + 'px';
  if (c.infoPanelVisible === false) $('infoPanel').classList.add('hidden');
  if (c.filterKind) $('filterKind').value = c.filterKind;
  if (c.sortMode) $('sortMode').value = c.sortMode;

  // 主题系统模式监听（L93：主题变化后按新主题重取外观参数）
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    state.systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if ((state.cfg?.theme ?? 'dark') === 'system') applyAppearance();
  });

  applyAppearance();   // 外观实时预览（壁纸/Mica/透明度/强调色/主题）
  applyGalleryGap();   // L156：画廊卡片间隔
  applyViewMode();
  syncAutoplayBtn();   // L123：恢复自动播放按钮点亮态
  renderFavorites();
  await loadCollectionBox(); // L88：从本地文件读取当前编号集锦箱
  renderCollection();  // L71：集锦箱
  renderQuickDirs();   // L43：常用目录快捷入口
  applySidebarVisible();
  restorePlayerState(); // 音量/静音/音频队列恢复


  // 播放进度与标签页恢复（保持与 state.cfg 同一引用，变更即随 saveCfg 落盘）
  if (!Array.isArray(c.tabs)) c.tabs = [];
  state.tabs = c.tabs;
  state.progress = c.playbackProgress ?? (c.playbackProgress = {});
  state.activeTab = Math.max(0, Math.min(Number(c.activeTab) || 0, Math.max(0, state.tabs.length - 1)));
  c.activeTab = state.activeTab;


  // 目录树（磁盘作为根节点）；然后打开当前标签页目录
  await renderTree();
  const startDir = state.tabs[state.activeTab] || c.lastDir || '';
  if (startDir) {
    await openDirectory(startDir);
  } else {
    renderTabs();
    renderVirtual(); // 欢迎空态
  }


  // 窗口几何恢复由 Rust 端 setup 在窗口显示前完成（config::apply_saved_window_geometry）：
  // 旧的前端恢复既和屏外预渲染 relocate 有竞态（位置会被移回默认值覆盖），
  // 又把存储的物理像素错当 Logical 用（HiDPI 下尺寸错误）。这里不再重复设置。
}
init();

// ═══════════════ L241：鼠标静止自动隐藏指针 ═══════════════
(function initIdleCursor() {
  let timer = null;
  const IDLE_MS = 2800;
  const reveal = () => {
    document.body.classList.remove('cursor-idle');
    clearTimeout(timer);
    if (state.cfg?.autoHideCursor === false) return; // 可在设置中关闭
    timer = setTimeout(() => document.body.classList.add('cursor-idle'), IDLE_MS);
  };
  for (const ev of ['mousemove', 'mousedown', 'wheel']) {
    window.addEventListener(ev, reveal, { passive: true });
  }
  reveal();
})();

// ═══════════════ 外观实时预览 ═══════════════
/** 强调色派生变量：--accent-rgb（rgba 用）/ --accent-on（实底文字）/ --accent-text（浅色模式压暗） */
function applyAccent(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (isNaN(n)) return;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-rgb', `${r},${g},${b}`);
  // WCAG 感知亮度：亮强调色实底上用深字
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  root.setProperty('--accent-on', lum > 0.62 ? '#1a1d24' : '#ffffff');
  const isLight = !document.documentElement.classList.contains('dark');
  if (isLight && lum > 0.55) {
    // 浅色模式亮强调色作为文字看不清，等比压暗
    const f = 0.55 / lum;
    root.setProperty('--accent-text', `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`);
  } else {
    root.setProperty('--accent-text', hex);
  }
}

// ─── L93：深色/浅色模式拥有独立外观参数（壁纸路径共享，其余各自独立） ───
// 参数解析 = 当前生效主题的覆盖值 ?? 全局基础值；设置面板改动写入当前主题的覆盖对象
function themeKey() { // 当前生效主题：dark | light（system 按系统解析）
  const t = state.cfg?.theme ?? 'dark';
  return t === 'system' ? (state.systemDark ? 'dark' : 'light') : (t === 'light' ? 'light' : 'dark');
}
function themeOvKey() { return themeKey() === 'dark' ? 'appearanceDark' : 'appearanceLight'; }
function eff(key) { // 读取：当前主题覆盖 ?? 全局基础值
  const v = state.cfg?.[themeOvKey()]?.[key];
  return (v === undefined || v === null) ? state.cfg?.[key] : v;
}
function setEff(key, value) { // 写入：当前主题覆盖
  const k = themeOvKey();
  const ov = state.cfg[k] ?? (state.cfg[k] = {});
  ov[key] = value;
}

function applyAppearance() {
  const c = state.cfg ?? {};
  // 主题按钮图标：深色显示太阳（可切到浅色），浅色显示月亮（可切到深色）
  const dark = themeKey() === 'dark';
  const themeBtn = $('btnTheme');
  if (themeBtn) {
    themeBtn.innerHTML = dark
      ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  }
  // 强调色（按当前主题解析）
  applyAccent(eff('accentColor') || '#0ea5e9');
  applyTheme();
  // 壁纸层（路径共享；开关/透明度/模糊/遮罩按主题独立）
  const wall = $('bgWall'), mask = $('bgMask');
  const wallOn = eff('wallpaperEnabled') && c.wallpaperPath;
  if (wallOn) {
    wall.classList.remove('hidden');
    wall.style.backgroundImage = `url(${resolveWallpaperUrl(c.wallpaperPath)})`;
    wall.style.opacity = (eff('wallpaperOpacity') ?? 1);
    const blur = eff('backgroundBlur') ?? 0;
    // L192：壁纸饱和度 / 亮度（100 = 原图）
    const sat = eff('wallSaturation') ?? 100;
    const bri = eff('wallBrightness') ?? 100;
    // 注意：scale() 不是 filter 函数，必须拆到 transform，否则整条 filter 声明无效
    const filters = [];
    if (blur > 0) filters.push(`blur(${blur}px)`);
    if (sat !== 100) filters.push(`saturate(${sat / 100})`);
    if (bri !== 100) filters.push(`brightness(${bri / 100})`);
    wall.style.filter = filters.join(' ');
    wall.style.transform = blur > 0 ? `scale(${1 + blur / 100})` : '';
    if ((eff('maskOpacity') ?? 0) > 0) {
      mask.classList.remove('hidden');
      mask.style.background = eff('maskColor') || '#0f172a';
      mask.style.opacity = eff('maskOpacity');
    } else {
      mask.classList.add('hidden');
    }
  } else {
    wall.classList.add('hidden');
    mask.classList.add('hidden');
  }
  // Mica / 窗口透明度（后端命令，实时生效；按主题独立）
  const micaOn = eff('micaEnabled') !== false;
  invoke('set_mica', { enabled: micaOn }).catch(() => {});
  const wop = eff('windowOpacity') ?? 1;
  invoke('set_window_opacity', { alpha: wop < 1 ? wop : 1 }).catch(() => {});
  // L60：壁纸与 Mica 均关闭时挂纯色底 —— 界面透明度只由「窗口全局不透明度」控制
  document.body.classList.toggle('solid-bg', !wallOn && !micaOn);
}

// （原生壁纸/基底层同步已移除：当前版本无 DComp 渲染管线，壁纸纯 DOM 实现）

function applyTheme() {
  const t = state.cfg?.theme ?? 'dark';
  const dark = t === 'system' ? state.systemDark : t !== 'light';
  document.documentElement.classList.toggle('dark', dark);
  // --accent-text 依赖明暗模式，切换后重算（按当前主题的强调色）
  applyAccent(eff('accentColor') || '#0ea5e9');
}

// ═══════════════ 目录加载 / 筛选排序 ═══════════════
/** 切换活动标签页（同步写回 cfg，保证持久化） */
function setActiveTab(i) {
  state.activeTab = i;
  if (state.cfg) state.cfg.activeTab = i;
}

async function openDirectory(dir, opts = {}) {
  if (!dir) return;
  state.collectionMode = false; // L74：点击新目录时退出集锦箱模式，正常响应
  syncCollectionModeBtn();
  // L230：deep = 穿透扫描（递归所有子目录）；普通导航显式退出穿透
  state.penetrate = opts.deep ? dir : null;
  // 标签页：显式新开 / 首个标签 / 覆盖当前标签（浏览器式）
  // 注意用 push 而非重新赋值，保持与 state.cfg.tabs 的同一引用
  if (opts.newTab || state.tabs.length === 0) {
    state.tabs.push(dir);
    setActiveTab(state.tabs.length - 1);
  } else {
    state.tabs[state.activeTab] = dir;
  }

  state.rootDir = dir;
  state.currentDir = dir;
  if (state.cfg) state.cfg.lastDir = dir; // 此前只读不写，重启后无法恢复目录
  renderTabs();
  setStatus('加载中…');
  try {
    state.items = opts.deep
      ? await invoke('list_directory_deep', { path: dir })
      : await invoke('list_directory', { path: dir });
    resetSelection();
    state.thumbFailed.clear(); // 换目录：允许重新尝试之前失败的缩略图
    renderBreadcrumb();


    setStatus(opts.deep ? `穿透扫描：${state.items.length} 个文件（含全部子目录）` : '');
  } catch (e) {
    setStatus('加载失败: ' + e, true);
  }
  applyFilter();
  saveCfg();
  // L73：集锦箱点击定位 —— 跳到所在目录后选中并滚动到该文件
  if (state.pendingReveal) {
    const i = state.filtered.findIndex((x) => x.path === state.pendingReveal);
    if (i >= 0) {
      select(i);
      requestAnimationFrame(() => {
        content.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    }
    state.pendingReveal = null;
  }
  renderAudioQueue(); // 音频列表可能用到本目录的时长信息
  renderAudioNow();
  updateQuickDirActive(); // L43：高亮匹配的快捷入口
  revealInTree(dir).catch(() => {}); // 目录树按文件区位置自动定位选中
  updateTreeDriveHint(dir);   // L229：标题行磁盘「卷标+盘符」
  syncPenetrateButtons();     // L230：穿透按钮状态
}




/** 筛选（类型 + 搜索）+ 排序 → filtered */
function applyFilter() {
  const c = state.cfg ?? {};
  const kind = c.filterKind || 'all';
  const q = ($('searchInput').value || '').trim().toLowerCase();
  let list = state.items;
  // 类型筛选只作用于媒体：文件夹始终保留（文件区不过滤文件夹）
  if (kind !== 'all') list = list.filter((it) => it.kind === kind || it.kind === 'folder');
  if (q) list = list.filter((it) => it.name.toLowerCase().includes(q));

  const mode = c.sortMode || 'type';
  const cmp = {
    type: (a, b) => kindRank(a) - kindRank(b) || a.name.localeCompare(b.name, 'zh'),
    nameAsc: (a, b) => a.name.localeCompare(b.name, 'zh'),
    nameDesc: (a, b) => b.name.localeCompare(a.name, 'zh'),
    sizeAsc: (a, b) => a.size - b.size,
    sizeDesc: (a, b) => b.size - a.size,
    modifiedAsc: (a, b) => a.modified - b.modified,
    modifiedDesc: (a, b) => b.modified - a.modified,
  }[mode] || ((a, b) => a.name.localeCompare(b.name, 'zh'));
  state.filtered = [...list].sort(cmp);
  resetSelection();
  clearPreviewPool(); // 列表已变化：旧文件预览不再复用
  updateStats();
  renderVirtual();
}

const kindRank = (it) => ({ folder: 0, image: 1, video: 2, audio: 3 }[it.kind] ?? 4);

/** 清空选择（目录/筛选变化时调用） */
function resetSelection() {
  state.selected = -1;
  state.selection = new Set();
  state.selVersion++;
}

function updateStats() {
  const n = state.filtered.length;
  const dir = state.filtered.filter((i) => i.kind === 'folder').length;
  const img = state.filtered.filter((i) => i.kind === 'image').length;
  const vid = state.filtered.filter((i) => i.kind === 'video').length;
  const aud = state.filtered.filter((i) => i.kind === 'audio').length;
  $('statCount').textContent = `共 ${n} 项（夹 ${dir} · 图 ${img} · 视 ${vid} · 音 ${aud}）`;
  $('statPath').textContent = state.currentDir;
  updateSelStatus();
}

/** 选择状态提示（多选时显示数量） */
function updateSelStatus() {
  const sel = state.selection.size;
  const item = state.filtered[state.selected];
  $('statSel').textContent = sel > 1
    ? `已选中 ${sel} 项`
    : (item ? `已选中: ${item.name}` : '');
}


// ═══════════════ 虚拟滚动渲染 ═══════════════
const GAP = 12;
const cellH = () => (state.cfg?.thumbSize ?? 160) + GAP + 22;

function gridCols() {
  const w = content.clientWidth || 800;
  const size = state.cfg?.thumbSize ?? 160;
  return Math.max(1, Math.floor(w / (size + GAP)));
}

// 渲染签名：行范围/选中/尺寸等未变时（overscan 行内滚动、画廊纯滚动）
// 跳过 innerHTML 全量重建 —— 滚动流畅度与预览视频存活的关键
let lastRenderSig = '';
let lastFilteredRef = null;

/** 强制下次 renderVirtual 全量重建（缩略图缓存清理等签名感知不到的变化） */
function invalidateRender() {
  lastRenderSig = '';
}

/** L70/L318-7：画廊模式列宽（缩放滑块 → 行高基准）
 *  · 量化到离散区间，避免小范围滑动频繁切换每行卡片数
 *  · 最大缩放 → 仅 1 张/行；最小缩放 → 多张/行（随容器宽度动态）
 */
const GALLERY_SIZE_STEPS = [60, 80, 100, 120, 145, 170, 200, 230, 265, 300];
function quantizeGallerySize(size) {
  return GALLERY_SIZE_STEPS.reduce((p, c) =>
    Math.abs(c - size) < Math.abs(p - size) ? c : p);
}
function galleryColW(size) {
  const innerW = (content.clientWidth || 800) - GALLERY_PAD * 2;
  const qs = quantizeGallerySize(size);
  const t = (qs - 60) / (300 - 60); // 0..1
  const minH = 100;                 // 最小行高 → 多列
  const maxH = innerW * 0.82;       // 最大行高 → 1 张/行（竖屏也撑满宽度）
  return Math.max(minH, minH + (maxH - minH) * t);
}

/** L80：缩放状态按视图独立（图标/列表用 thumbSize，画廊用 galleryThumbSize），共享同一滑块 */
function activeThumbSize() {
  return state.cfg?.viewMode === 'gallery'
    ? (state.cfg.galleryThumbSize ?? 260)
    : (state.cfg?.thumbSize ?? 160);
}
function setActiveThumbSize(v) {
  if (state.cfg.viewMode === 'gallery') state.cfg.galleryThumbSize = v;
  else state.cfg.thumbSize = v;
}

function renderVirtual() {
  const scrollTop = scroller.scrollTop;
  const viewH = scroller.clientHeight;
  const total = state.filtered.length;
  const size = activeThumbSize(); // L80：缩放状态按视图独立
  const overscan = state.cfg?.overscan ?? 2;

  if (total === 0) {
    // 未选择根目录：欢迎空态；已选目录：无匹配提示
    recycleAutoPreviews();
    content.style.height = '100%'; // 撑满可视区，让欢迎内容垂直居中
    content.innerHTML = !state.currentDir
      ? `<div class="welcome-wrap">
           <!-- L132：文件区顶部磁盘栏（图标与文件夹一样大，显示磁盘名称，点击打开） -->
           <div id="welcomeDrives" class="welcome-drivebar"></div>
           <div class="welcome-hero">
             <svg class="w-16 h-16 accent-icon opacity-80" viewBox="0 0 24 24" fill="currentColor">
               <path d="M12 2C8 7 4 10.5 4 15a8 8 0 1 0 16 0c0-4.5-4-8-8-13z"/></svg>
             <p class="text-base font-semibold">欢迎使用 Rainver 落雨影音</p>
             <p class="text-sm opacity-60 max-w-md leading-relaxed">
               从左侧目录树选择磁盘或文件夹（会自动定位到当前位置），或
               <button id="welcomePick" class="underline hover:opacity-100 opacity-80" style="color:var(--accent)">选择一个文件夹</button>
               开始浏览你的图片 / 视频 / 音频收藏<br/>
               顶部「+」可新建标签页；也可将目录树节点拖入「收藏」区
             </p>
           </div>
         </div>`
      : `<div class="welcome-hero"><p class="text-sm opacity-50">没有匹配的项目</p></div>`;

    const wp = $('welcomePick');
    if (wp) wp.addEventListener('click', pickRoot);
    // L149：磁盘卡片 = 图标+容量进度条横卡，下方显示卷标和盘符
    const wdNode = $('welcomeDrives');
    if (wdNode) {
      invoke('list_drives').then((drives) => {
        wdNode.innerHTML = drives.map((d) => {
          const used = d.total > 0 ? d.total - d.free : 0;
          const pct = d.total > 0 ? Math.max(2, Math.round((used / d.total) * 100)) : 0;
          const letter = d.path.replace(/[\\/]/g, '');
          const capTxt = d.total > 0 ? `${fmtSize(used)} / ${fmtSize(d.total)}` : '';
          return `
          <button class="drive-card" data-drive="${escapeAttr(d.path)}" title="${escapeAttr(d.name)}">
            <div class="drive-card-inner">
              <img class="drive-card-icon" src="./disk.ico" alt="" draggable="false" />
              <div class="drive-card-info">
                <span class="drive-card-cap">${capTxt}</span>
                <div class="drive-card-bar"><div style="width:${pct}%"></div></div>
              </div>
            </div>
            <span class="drive-card-bottom">${escapeHtml(d.name)} (${letter})</span>
          </button>`;
        }).join('');
        wdNode.querySelectorAll('button[data-drive]').forEach((b) => {
          b.addEventListener('click', () => openDirectory(b.dataset.drive));
        });
      }).catch(() => {});
    }
    lastRenderSig = 'empty';
    return;
  }

  let html = '';
  let sig;
  let vlog = '';
  if ((state.cfg?.viewMode ?? 'grid') === 'grid') {
    // L41：文件夹与媒体分离 —— 文件夹只渲染顶部紧凑小图标条，
    // 不再与媒体卡片共享网格尺寸
    const folderIdxs = [];
    const mediaIdxs = [];
    for (let i = 0; i < total; i++) {
      (state.filtered[i].kind === 'folder' ? folderIdxs : mediaIdxs).push(i);
    }
    const cols = Math.max(1, gridCols());
    const mediaRows = Math.ceil(mediaIdxs.length / cols);
    const h = cellH();

    // 图标条排版（与 CSS 对齐）：item 宽 76 / 高 73，间距 6，条内左右 padding 10
    const W = content.clientWidth || 800;
    const perRow = Math.max(1, Math.floor((W - 14) / 82));
    const fRows = Math.ceil(folderIdxs.length / perRow);
    // F = strip padding 16 + 行*73 + (行-1)*6 = 行*79 + 10
    const folderH = fRows ? fRows * 79 + 10 : 0;

    content.style.height = (folderH + mediaRows * h) + 'px';

    // 文件夹条：始终位于顶部（数量少，随签名重建）
    let stripHtml = '';
    if (folderIdxs.length) {
      stripHtml = `<div class="folder-strip">${folderIdxs.map(folderChip).join('')}</div>`;
    }

    // 媒体可视窗口：整体下移 folderH
    const startRow = Math.max(0, Math.floor((scrollTop - folderH) / h) - overscan);
    const endRow = Math.min(
      mediaRows,
      Math.ceil((scrollTop + viewH - folderH) / h) + overscan,
    );
    sig = `g|${total}|${cols}|${startRow}|${endRow}|${state.selVersion}|${size}|${overscan}|${folderIdxs.length}|${perRow}`;
    let cards = '';
    for (let r = startRow; r < endRow; r++) {
      for (let c2 = 0; c2 < cols; c2++) {
        const mi = r * cols + c2;
        if (mi >= mediaIdxs.length) break;
        const i = mediaIdxs[mi];
        cards += gridCard(state.filtered[i], i, c2 * (size + GAP), r * h);
      }
    }
    html = stripHtml
      + `<div id="gridLayer" style="transform:translateY(${folderH}px)">${cards}</div>`;
    vlog = `grid rebuild scroll=${scrollTop} viewH=${viewH} W=${W} h=${h} folderH=${folderH} rows[${startRow},${endRow})/${mediaRows} cols=${cols}`;
  } else if (state.cfg?.viewMode === 'list') {
    const rowH = 48;
    content.style.height = total * rowH + 'px';
    const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan * 2);
    const end = Math.min(total, Math.ceil((scrollTop + viewH) / rowH) + overscan * 2);
    sig = `l|${total}|${start}|${end}|${state.selVersion}|${overscan}|${state.cfg?.listViewMeta !== false ? 1 : 0}`;
    for (let i = start; i < end; i++) html += listRow(state.filtered[i], i, i * rowH);
  } else {
    // 画廊模式（L236）：行优先排列——先从左到右填满一行，再换行向下。
    // 卡片绝对定位（位置由 layoutGalleryNow 计算），无虚拟化。
    // L318 bug 修复：重建 innerHTML 前锁定 content 高度，避免 .gallery-rows 高度为 0
    // 的瞬间导致 scroller.scrollTop 被浏览器钳制回 0。
    if (!content.style.height) content.style.height = (scroller.scrollHeight || content.clientHeight) + 'px';
    // L36：扩大缩放范围；size>320 后斜率加大，最大(800)→列宽 1920，
    // 常见 1080p~4K 窗口均只显示 1 张
    const colW = galleryColW(size);
    // 画廊视图过滤文件夹（只展示可预览的媒体）
    const tiles = [];
    state.filtered.forEach((it, i) => { if (it.kind !== 'folder') tiles.push(galleryTile(it, i, colW)); });
    sig = `y|${total}|${state.selVersion}|${size}|${Math.round(content.clientWidth)}|${state.galleryVer || 0}`;
    html = `<div class="gallery-rows">` + tiles.join('') + `</div>`;

  }

  // 签名未变：内容一致，跳过 DOM 重建（滚动零成本，预览视频原地存活）
  if (sig === lastRenderSig && state.filtered === lastFilteredRef) {
    scheduleAutoPreviews();
    return;
  }
  recycleAutoPreviews(); // innerHTML 替换会销毁 video：先回收入池供重挂复用
  // L318：保存滚动位置，画廊模式重建后恢复（防止偶发回到顶部）
  const savedScrollTop = scroller.scrollTop;
  content.innerHTML = html;
  if (state.cfg?.viewMode === 'gallery') {
    layoutGalleryNow(); // L236：行优先定位
    // 锁定高度已由 .gallery-rows 接管，清掉内联 height 让其随内容自适应
    content.style.height = '';
    scroller.scrollTop = savedScrollTop;
  }
  requestThumbs();
  requestFullImgs(); // L155：画廊图片视口内原质量加载
  scheduleAutoPreviews();
  lastRenderSig = sig;
  lastFilteredRef = state.filtered;
  if (vlog) jsDiag(vlog);
}

/// [临时取证] 前端诊断日志（写控制台）
function jsDiag(msg) {
  console.log('[diag]', msg);
}

/** 文件夹占位图标（不走缩略图管线）—— L69：文件区实心淡蓝色 */
const FOLDER_ICO = '<svg viewBox="0 0 24 24"><path fill="#7dd3fc" stroke="#38bdf8" stroke-width="0.6" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

// L133：缩略图缓存按请求尺寸分键（默认尺寸键为原 path；大尺寸带 \u0000s{size} 后缀）
function thumbKey(path, size = 512) { return size === 512 ? path : `${path}\u0000s${size}`; }
function thumbGet(path, size = 512) { return state.thumbCache.get(thumbKey(path, size)); }
/** 取该路径任意尺寸的已缓存条目（元数据用：默认缺失时找大尺寸条目） */
function thumbAny(path) {
  const d = state.thumbCache.get(path);
  if (d) return d;
  const pfx = `${path}\u0000s`;
  for (const [k, v] of state.thumbCache) {
    if (k.startsWith(pfx)) return v;
  }
  return undefined;
}
/** L133/L146：画廊缩略图请求尺寸：列宽×dpr，钳制 [512,2400] */
function galleryReq() {
  const colW = galleryColW(state.cfg?.galleryThumbSize ?? 260);
  return Math.max(512, Math.min(2400, Math.round(colW * (window.devicePixelRatio || 1))));
}

// 已有缓存 → 直接内联 <img>（滚动重渲染不再闪烁，也不必再走 IPC/替换流程）
// reqSize：画廊模式传大尺寸（L133），缺省 512
function thumbHtml(item, cls, style = '', reqSize = 512) {
  // 文件夹：直接画图标（不产生 data-thumb 骨架，避免被缩略图队列当媒体处理）
  if (item.kind === 'folder') {
    return `<div class="folder-thumb ${cls}"${style ? ` style="${style}"` : ''}>${FOLDER_ICO}</div>`;
  }
  // L146：必须先查「精确尺寸」缓存；只有精确命中才能不带 data-thumb 直接出图。
  // 否则即便已有 512 小图，也要带着 data-thumb/data-size 渲染，
  // 让懒加载继续把大尺寸请求回来（修复"小图拉伸→永远模糊"）。
  const exact = thumbGet(item.path, reqSize);
  const t = exact || thumbAny(item.path);
  if (t) {
    const needLarge = reqSize !== 512 && !exact;
    const lazyAttr = needLarge
      ? ` data-thumb="${escapeAttr(item.path)}" data-kind="${item.kind}" data-size="${reqSize}"`
      : '';
    return `<img class="${cls}" src="${t.url}" alt="" loading="lazy" decoding="async" draggable="false"${lazyAttr}${style ? ` style="${style}"` : ''}>`;
  }
  // 音频：先用音频图标占位；有内嵌封面时由缩略图回调替换成封面图
  if (item.kind === 'audio') {
    return `<div class="audio-thumb ${cls}" data-thumb="${escapeAttr(item.path)}" data-kind="audio"${style ? ` style="${style}"` : ''}>${AUDIO_ICO}</div>`;
  }
  const sizeAttr = reqSize !== 512 ? ` data-size="${reqSize}"` : '';
  return `<div class="skeleton ${cls}" data-thumb="${escapeAttr(item.path)}" data-kind="${item.kind}"${sizeAttr}${style ? ` style="${style}"` : ''}></div>`;
}

// 视频时长角标：缓存有值直接显示，否则占位并由懒加载回调回填

function durBadgeHtml(item) {
  if (item.kind !== 'video') return '';
  const t = thumbAny(item.path);
  const txt = t?.duration ? fmtDur(t.duration) : '…';
  return `<span class="badge-duration" data-dur="${escapeAttr(item.path)}">${txt}</span>`;
}

/** 卡片占位宽高比：优先缩略图元数据（含后端读回的媒体宽高），未知用默认 */
function ratioCss(item) {
  if (item.kind === 'video' || item.kind === 'image') {
    const t = thumbAny(item.path);
    const w = t?.w || item.width;
    const h = t?.h || item.height;
    if (w > 0 && h > 0) return `${w} / ${h}`;
  }
  return item.kind === 'video' ? '16 / 9' : '1 / 1';
}

/** 角标（时长/类型）贴在缩略图内，避免压住卡片下方的文件名
 *  gallery: 画廊视图下图片不显示类型图标（L64） */
function badgesHtml(item, gallery = false) {
  const typeIco = (gallery && item.kind === 'image') ? '' : `<span class="badge-type">${kindIcon(item.kind)}</span>`;
  return `${durBadgeHtml(item)}${typeIco}`;
}

// L41：网格视图文件夹紧凑小图标（顶部图标条内使用）
function folderChip(idx) {
  const item = state.filtered[idx];
  const sel = state.selection.has(idx) ? ' selected' : '';
  return `
  <div class="folder-item${sel}" data-idx="${idx}" title="${escapeAttr(item.name)}">
    <span class="fi-icon">${FOLDER_ICO}</span>
    <span class="fi-name">${escapeHtml(item.name)}</span>
  </div>`;
}

function gridCard(item, idx, x, y) {
  const size = state.cfg?.thumbSize ?? 160;
  const sel = state.selection.has(idx) ? ' selected' : '';
  const name = escapeHtml(item.name);
  const sub = item.kind === 'audio'
    ? `<div class="px-1.5 pb-1 text-[11px] opacity-60 truncate">${escapeHtml(item.artist || '未知艺术家')} · ${escapeHtml(item.album || '未知专辑')}</div>`
    : '';
  return `
  <div class="media-card${sel}" data-idx="${idx}" style="position:absolute;left:${x}px;top:${y}px;width:${size}px">
    <div class="thumb-box">${thumbHtml(item, 'thumb')}${badgesHtml(item)}</div>
    <div class="px-1.5 py-1 text-xs truncate" title="${name}">${name}</div>
    ${sub}
  </div>`;
}

function listRow(item, idx, y) {
  const sel = state.selection.has(idx) ? ' selected' : '';
  const name = escapeHtml(item.name);
  // L341：列表视图信息列（修改时间 / 分辨率 / 时长），设置项可整体关闭
  const meta = state.cfg?.listViewMeta !== false;
  let metaHtml = '';
  if (meta) {
    const t = (item.kind === 'video' || item.kind === 'image') ? thumbAny(item.path) : null;
    const w = t?.w || item.width, h = t?.h || item.height;
    const res = (w > 0 && h > 0) ? `${w}×${h}` : '';
    const dur = (item.kind === 'audio' || item.kind === 'video') ? fmtDur(item.duration) : '';
    metaHtml =
      `<span class="opacity-40 text-xs w-[7.5rem] text-right">${item.kind === 'folder' ? '' : fmtDate(item.modified)}</span>` +
      `<span class="opacity-40 text-xs w-20 text-right">${res}</span>` +
      `<span class="opacity-50 text-xs w-14 text-right">${dur}</span>`;
  }
  return `
  <div class="media-row${sel}" data-idx="${idx}" style="position:absolute;left:0;right:0;top:${y}px">
    ${thumbHtml(item, 'rounded-md', 'width:36px;height:36px;flex-shrink:0')}
    <span class="flex-1 truncate" title="${name}">${name}</span>
    ${metaHtml}
    <span class="opacity-50 text-xs w-16 text-right">${item.kind === 'folder' ? '' : fmtSize(item.size)}</span>
    <span class="opacity-40 text-xs w-14 text-right">${kindLabel(item.kind)}</span>
  </div>`;
}

// 画廊卡片：占位框按媒体宽高比（完整显示不裁剪）；文件名默认隐藏，悬浮显示在卡片顶部
// L236：colW 给定时直接内联宽高/位置初值，避免首帧跳动（位置随后由 layoutGalleryNow 校正）
function galleryTile(item, idx, colW = 0) {
  const name = escapeHtml(item.name);
  const sel = state.selection.has(idx) ? ' selected' : '';
  const wStyle = colW ? ` width:${colW}px;` : '';
  return `
  <div class="media-card gallery-card${sel}" data-idx="${idx}" style="position:absolute;${wStyle}">
    <div class="thumb-box" style="aspect-ratio:${ratioCss(item)}"${item.kind === 'image' ? ` data-fullimg="${escapeAttr(item.path)}"` : ''}>${thumbHtml(item, 'gallery-thumb', '', galleryReq())}${badgesHtml(item, true)}</div>
    <div class="gallery-name" title="${name}">${name}</div>
  </div>`;
}

// ─── L236/L250：画廊行优先布局（对齐行：每行卡片等高、宽度按比例填满整行，上下相连无大片背景） ───
const GALLERY_PAD = 14;
function galleryGapPx() { return state.cfg?.galleryGap ?? 14; }
/** 卡片媒体区宽高比（数值 w/h），与 ratioCss 的默认值保持一致 */
function itemRatioNum(item) {
  if (item.kind === 'video' || item.kind === 'image') {
    const t = thumbAny(item.path);
    const w = t?.w || item.width;
    const h = t?.h || item.height;
    if (w > 0 && h > 0) return w / h;
  }
  return item.kind === 'video' ? 16 / 9 : 1;
}
/** 就地重排画廊卡片（对齐行布局，不重建 DOM，正在自动预览的视频不受影响） */
function layoutGalleryNow() {
  const m = content.querySelector('.gallery-rows');
  if (!m) return;
  const gap = galleryGapPx();
  // 基准行高由缩放滑块决定（与原列宽一致的尺寸感）
  const targetH = galleryColW(state.cfg?.galleryThumbSize ?? 260);
  const innerW = (content.clientWidth || m.clientWidth || scroller.clientWidth) - GALLERY_PAD * 2;

  const cards = [...m.children];
  const items = cards.map((card) => {
    const item = state.filtered[Number(card.dataset.idx)];
    const ratio = item ? itemRatioNum(item) : 1;
    return { card, ratio, natW: targetH * ratio }; // 基准行高下卡片的自然宽度
  });

  let y = GALLERY_PAD;
  let row = [];
  let rowNatW = 0;

  const flushRow = (isLast) => {
    if (!row.length) return;
    const n = row.length;
    const totalGap = (n - 1) * gap;
    const available = innerW - totalGap;
    // 按比例缩放使整行正好填满容器宽度；最后一行限制最大放大，避免单卡被拉得过大
    let scale = available / rowNatW;
    if (isLast) scale = Math.min(scale, 1.4);
    scale = Math.min(scale, 1.4);
    const h = targetH * scale;
    let x = GALLERY_PAD;
    for (const it of row) {
      const w = it.natW * scale;
      it.card.style.width = w + 'px';
      it.card.style.height = h + 'px';
      it.card.style.left = x + 'px';
      it.card.style.top = y + 'px';
      // thumb-box 填满卡片（覆盖原 aspect-ratio，由 object-fit:contain 保证媒体不变形）
      const box = it.card.querySelector('.thumb-box');
      if (box) { box.style.aspectRatio = 'auto'; box.style.height = '100%'; box.style.width = '100%'; }
      x += w + gap;
    }
    y += h + gap;
    row = []; rowNatW = 0;
  };

  for (const it of items) {
    const projectedW = rowNatW + it.natW + (row.length ? gap : 0);
    if (row.length && projectedW > innerW) flushRow(false);
    row.push(it);
    rowNatW += it.natW;
  }
  flushRow(true);

  m.style.height = (y - gap + GALLERY_PAD) + 'px';
}
let galleryLayoutRaf = 0;
function scheduleGalleryLayout() {
  if (galleryLayoutRaf) return;
  galleryLayoutRaf = requestAnimationFrame(() => { galleryLayoutRaf = 0; layoutGalleryNow(); });
}



// ═══════════════ 播放进度（续播 / 跨模式同步） ═══════════════
// 卡片预览、单一播放（<video> 与 mpv）共用同一份 path -> 秒 记录：
//   · 播放中持续写回（卡片 timeupdate / 播放器 timeupdate / mpv 状态轮询）
//   · 打开时按记录位置 seek（卡片 loadedmetadata / 播放器 loadedmetadata / mpv 加载就绪后）
// 因此"返回上级 / 刷新 / 切视图 / 切换单一播放"都不会重头播放，
// 且同一文件在任何模式下的进度条读数都一致。
let progressDirty = false;
const PROGRESS_MAX_ENTRIES = 800;

function progressGet(path) {
  const v = state.progress?.[path];
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

function progressSet(path, sec) {
  if (!path || !isFinite(sec) || sec <= 0) return;
  const rounded = Math.round(sec * 10) / 10;
  if (state.progress[path] === rounded) return;
  state.progress[path] = rounded;
  progressDirty = true;
}

/** 立即落盘（隐藏/失焦/关闭预览/切目录等关键节点调用；平时由定时器节流） */
function flushProgress() {
  if (!progressDirty) return;
  progressDirty = false;
  pruneProgress();
  saveCfg();
}

function pruneProgress() {
  const keys = Object.keys(state.progress);
  if (keys.length <= PROGRESS_MAX_ENTRIES) return;
  for (const k of keys.slice(0, keys.length - PROGRESS_MAX_ENTRIES)) delete state.progress[k];
}

setInterval(flushProgress, 5000); // 播放中每 5s 落盘，避免 timeupdate 频率写盘

// ─── 视频卡片自动预览：进入视口即静音循环播放；悬浮显示进度条与音量 ───

// 受设置-行为「视频自动播放」开关控制；同时播放数量受上限约束（0 = 不限，
// 默认视野内全部播放）。性能设计（滚动不卡顿的关键）：
// 1. video 元素按 path 池化：虚拟滚动重建 DOM 前回收入池，重挂时直接复用
//    （src 已加载，appendChild 即续播，不重新调取/seek/起播）；
// 2. 滚动过程中暂停全部预览（保留当前帧），停止 250ms 后恢复；
// 3. 新建挂载每轮渐进进行，避免几十个解码器同一时刻启动的尖峰。
function autoPreviewLimit() {
  const n = Number(state.cfg?.videoAutoplayLimit) || 0;
  return n > 0 ? n : Infinity;
}

// 预览池：path -> { v, ctrl }；池内元素已从 DOM 摘下、暂停、src 保留
const PREVIEW_POOL_MAX = 32;
const previewPool = new Map();
let autoPreviewTimer = null;

// ─── 预览挂起：单一播放打开 / 窗口失焦 / 最小化 → 暂停列表预览（保留当前帧） ───
// 记录「状态」而不是「事件配对」：任一信号都能算出正确结果，并带 1.5s 兜底轮询，
// 因此不会因为某个 focus/visibility 事件丢失而永久停在暂停态
// （此前用原因集合配对，出现过"从最小化/后台返回后不恢复播放"）。
const previewSuspend = { viewer: false, window: false, perf: false };
const previewsSuspended = () => previewSuspend.viewer || previewSuspend.window || previewSuspend.perf;

function pauseAllCardPreviews() {
  content.querySelectorAll('video.auto-preview').forEach((v) => v.pause());
}

/** L37：仅暂停已完全离开视野（带 80px 余量）的预览，视野内播放不受影响 */
function pauseOffscreenPreviews() {
  if (previewsSuspended()) return;
  const view = scroller.getBoundingClientRect();
  // 表演自动滚动时与挂载/起播外扩带保持一致，视频刚离屏不急停（默认仅 80px）
  const m = 80 + perfPlayMargin();
  for (const v of content.querySelectorAll('video.auto-preview')) {
    if (v.paused) continue;
    const r = v.getBoundingClientRect();
    if (r.bottom < view.top - m || r.top > view.bottom + m) v.pause();
  }
}

/** 重算挂起态并应用：挂起 → 暂停 + 掐掉待恢复定时器；解除 → 对齐进度后恢复 */
function applyPreviewSuspension() {
  if (previewsSuspended()) {
    clearTimeout(autoPreviewTimer); // 掐掉"滚动停止后恢复"的待触发回调
    pauseAllCardPreviews();
  } else {
    alignVisiblePreviews();  // 单一播放/后台期间进度可能已走远：先对齐再恢复
    scheduleAutoPreviews();  // 统一走"滚动停止"通道恢复视野内播放
  }
}

function setViewerSuspension(on) {
  if (previewSuspend.viewer === on) return;
  previewSuspend.viewer = on;
  applyPreviewSuspension();
}

function setWindowSuspension(on) {
  if (previewSuspend.window === on) return;
  previewSuspend.window = on;
  applyPreviewSuspension();
}

// 窗口是否活跃：最小化/被遮挡 → 否；Tauri 聚焦事件权威；未收到事件时退化为 DOM 判定
let winFocused = null; // null = 尚未收到 Tauri 事件
function windowActive() {
  if (document.hidden) return false;
  if (winFocused !== null) return winFocused;
  return document.hasFocus();
}

function syncWindowSuspension() {
  setWindowSuspension(!windowActive());
}

// 兜底轮询：任何事件丢失都能在 1.5s 内纠正（含最小化后从任务栏恢复）
setInterval(syncWindowSuspension, 1500);


/** 把视野内预览对齐到记录进度（退出单一播放、回到前台时调用，保证各模式进度一致） */
function alignVisiblePreviews() {
  const view = scroller.getBoundingClientRect();
  for (const v of content.querySelectorAll('video.auto-preview')) {
    const saved = progressGet(v.dataset.src);
    if (!(saved > 0) || !(v.duration > 0)) continue;
    const r = v.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom) continue;
    if (Math.abs(v.currentTime - saved) < 2) continue; // 本来就同步，别动（避免打断循环）
    try {
      v.currentTime = saved;
      // 立即更新卡片进度条 UI（不等 timeupdate）
      const box = v.closest('.thumb-box');
      const fill = box?.querySelector('.player-seek-fill');
      const knob = box?.querySelector('.player-seek-knob');
      if (fill && knob) {
        const p = Math.max(0, Math.min(1, saved / v.duration));
        fill.style.width = p * 100 + '%';
        knob.style.left = p * 100 + '%';
      }
    } catch { /* 忽略 */ }
  }
}



/** video + 控制条入池（同路径去重 + LRU 淘汰，逐出时释放解码资源） */
function poolPutPreview(path, v, ctrl) {
  const stale = previewPool.get(path);
  if (stale) {
    stale.v.removeAttribute('src');
    stale.v.load();
  }
  previewPool.delete(path);
  previewPool.set(path, { v, ctrl: ctrl || null });
  while (previewPool.size > PREVIEW_POOL_MAX) {
    const oldest = previewPool.keys().next().value;
    const e = previewPool.get(oldest);
    e.v.removeAttribute('src');
    e.v.load(); // 显式丢弃媒体资源，防止内存无限增长
    previewPool.delete(oldest);
  }
}

/** 清空预览池（目录/筛选变化后旧文件不再复用） */
function clearPreviewPool() {
  for (const { v } of previewPool.values()) {
    v.removeAttribute('src');
    v.load();
  }
  previewPool.clear();
}

/** 从卡片上摘下预览（detach 不销毁）并暂停入池 */
function detachPreview(v) {
  const box = v.closest('.thumb-box');
  const ctrl = box?.querySelector('.card-ctrl') ?? null;
  const path = v.dataset.src;
  v.pause();
  v.remove();
  ctrl?.remove();
  if (path) poolPutPreview(path, v, ctrl);
}

/** renderVirtual 替换 innerHTML 前调用：回收 DOM 内全部预览视频供后续复用 */
function recycleAutoPreviews() {
  content.querySelectorAll('video.auto-preview').forEach(detachPreview);
}

/** 限制收紧时按可视顺序保留靠前的预览，超出入池（不销毁，放宽后可复用） */
function enforceAutoPreviewLimit() {
  // 表演滚动模式（瀑布流/随机阵列）不受全局自动播放数量上限约束，保证流畅
  if (perf.active && !previewSuspend.perf) return;
  const limit = autoPreviewLimit();
  const vids = [...content.querySelectorAll('video.auto-preview')];
  if (vids.length <= limit) return;
  const sorted = vids
    .map((v) => ({ v, top: v.closest('.thumb-box')?.getBoundingClientRect().top ?? Infinity }))
    .sort((a, b) => a.top - b.top);
  for (let i = sorted.length - 1; i >= limit; i--) {
    const box = sorted[i].v.closest('.thumb-box');
    detachPreview(sorted[i].v);
    if (box) delete box.dataset.previewPending;
  }
}

// WebView2 无法直接播放的容器（ts/mkv/avi…）→ Rust 端 ffmpeg 无损重封装为 mp4（带缓存）
const REMUX_EXTS = new Set(['ts', 'mts', 'm2ts', 'mkv', 'avi', 'flv', 'wmv', 'rm', 'rmvb', 'vob']);
async function playableVideoSrc(path) {
  const ext = (path.match(/\.([^.\\/]+)$/) || [])[1]?.toLowerCase() || '';
  if (!REMUX_EXTS.has(ext)) return path;
  try { return await invoke('get_playable_path', { path }); }
  catch { return path; } // ffmpeg 缺失/失败 → 回退原文件
}

const CARD_VOL_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
const CARD_VOL_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>';

function makeCardCtrl(v) {
  const ctrl = document.createElement('div');
  ctrl.className = 'card-ctrl';
  ctrl.innerHTML = `
    <div class="player-seek">
      <div class="player-seek-fill"></div>
      <div class="player-seek-knob"></div>
    </div>
    <div class="card-ctl-row">
      <button class="card-ctl-btn" title="静音"></button>
      <input type="range" min="0" max="100" value="0" class="player-vol card-vol" title="音量" />
    </div>`;

  const seek = ctrl.querySelector('.player-seek');
  const fill = ctrl.querySelector('.player-seek-fill');
  const knob = ctrl.querySelector('.player-seek-knob');
  const muteBtn = ctrl.querySelector('.card-ctl-btn');
  const vol = ctrl.querySelector('.card-vol');

  const VOL_ON = CARD_VOL_ON;
  const VOL_OFF = CARD_VOL_OFF;
  const syncMuteIcon = () => { muteBtn.innerHTML = (v.muted || v.volume === 0) ? VOL_OFF : VOL_ON; };

  // 进度：点击 / 拖拽跳转
  const setFromPointer = (e) => {
    const r = seek.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (v.duration) { try { v.currentTime = p * v.duration; } catch { /* 忽略 */ } }
    fill.style.width = p * 100 + '%';
    knob.style.left = p * 100 + '%';
  };
  let dragging = false;
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); setFromPointer(e); });
  seek.addEventListener('pointermove', (e) => { if (dragging) setFromPointer(e); });
  seek.addEventListener('pointerup', () => { dragging = false; });
  seek.addEventListener('pointercancel', () => { dragging = false; });
  v.addEventListener('timeupdate', () => {
    if (dragging || !v.duration) return;
    const p = v.currentTime / v.duration;
    fill.style.width = p * 100 + '%';
    knob.style.left = p * 100 + '%';
  });

  // 音量：拖动即取消静音；静音按钮双向同步
  vol.addEventListener('input', () => {
    v.volume = Number(vol.value) / 100;
    v.muted = vol.value === '0';
    syncMuteIcon();
  });
  muteBtn.addEventListener('click', () => {
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) { v.volume = 0.5; vol.value = 50; }
    vol.value = v.muted ? 0 : Math.round(v.volume * 100);
    syncMuteIcon();
  });
  vol.value = v.muted ? 0 : Math.round(v.volume * 100); // L238：初值跟随全局卡片音量
  syncMuteIcon();

  // 控件操作不触发卡片选中 / 双击打开
  for (const ev of ['pointerdown', 'click', 'dblclick']) ctrl.addEventListener(ev, (e) => e.stopPropagation());
  return ctrl;
}

async function attachCardPreview(box, path) {
  const playPath = await playableVideoSrc(path);
  if (!box.isConnected) return; // 等待重封装期间卡片已被虚拟滚动重建
  // 等待期间限制可能已收紧：超出上限则放弃本次挂载
  if (content.querySelectorAll('video.auto-preview').length >= autoPreviewLimit()) return;
  const v = document.createElement('video');
  v.className = 'auto-preview';
  v.dataset.src = path; // 池化复用 key（remux 后的 src 可能与源路径不同）
  // L238：卡片默认静音、默认音量 20%（均可在设置中配置）
  v.volume = Math.min(1, Math.max(0, (state.cfg?.cardVolume ?? 20) / 100));
  v.muted = state.cfg?.cardMuted !== false;
  v.loop = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.src = convertFileSrc(playPath);
  // 起播位置：优先上次记录进度（与单一播放共享同一进度），否则跳过黑屏片头取约 10%
  v.addEventListener('loadedmetadata', () => {
    try {
      if (!(v.duration > 0)) return;
      const saved = progressGet(path);
      v.currentTime = saved > 0 && saved < v.duration - 0.5 ? saved : Math.min(3, v.duration * 0.1);
    } catch { /* 忽略 */ }
  }, { once: true });
  // 进度记录：卡片预览播放中持续写回，单一播放/刷新后据此续播
  v.addEventListener('timeupdate', () => { progressSet(path, v.currentTime); });
  if (!previewsSuspended()) v.play().catch(() => { /* 静音播放失败则保留缩略图 */ });
  box.appendChild(v);
  box.appendChild(makeCardCtrl(v));
}


// 滚动停止 250ms 后再挂载/恢复，避免虚拟滚动逐帧重建视频
function scheduleAutoPreviews() {
  clearTimeout(autoPreviewTimer);
  autoPreviewTimer = setTimeout(() => {
    setupAutoPreviews();
  }, 250);
}

// 每轮最多新建挂载数（池命中不受限）；超出部分排到下一轮渐进完成
const NEW_PREVIEWS_PER_TICK = 6;

/**
 * 表演中（瀑布流/随机阵列）的播放外扩带：视口上下各外扩 70% 屏高。
 * 自动滚动时视频在进入视口前就已起播、离开后也不急停，避免边界反复暂停/起播造成卡顿。
 */
function perfPlayMargin() {
  return (perf.active && !previewSuspend.perf) ? scroller.clientHeight * 0.7 : 0;
}

function setupAutoPreviews() {
  if (state.cfg?.videoAutoplay === false) return;
  if ((state.cfg?.viewMode ?? 'grid') !== 'gallery') return; // 网格模式不自动播放
  if (previewsSuspended()) return; // 挂起期间不新建挂载，也不起播
  enforceAutoPreviewLimit(); // 上限可能在设置/重置后收紧


  // 表演滚动模式外扩带内不限挂载数量；其余遵循用户设置的自动播放上限
  const cap = (perf.active && !previewSuspend.perf) ? Infinity : autoPreviewLimit();
  let budget = cap - content.querySelectorAll('video.auto-preview').length;
  if (budget <= 0) { resumeVisiblePreviews(); return; }
  const view = scroller.getBoundingClientRect();
  const m = perfPlayMargin();
  // 收集可见视频卡片，按可视顺序（自上而下）挂载
  const cards = [...content.querySelectorAll('.media-card[data-idx]')]
    .map((card) => {
      const item = state.filtered[Number(card.dataset.idx)];
      const box = item && item.kind === 'video' ? card.querySelector('.thumb-box') : null;
      if (!box || box.dataset.previewPending === '1' || box.querySelector('video.auto-preview')) return null;
      const r = box.getBoundingClientRect();
      if (r.bottom < view.top - m || r.top > view.bottom + m) return null;
      return { box, path: item.path, top: r.top };
    })
    .filter(Boolean)
    .sort((a, b) => a.top - b.top);
  let created = 0;
  let deferred = false;
  for (const c of cards) {
    if (budget-- <= 0) break;
    const pooled = previewPool.get(c.path);
    if (pooled) {
      // 池命中：直接复用（src 已加载，无需重新调取），起播统一由 resumeVisiblePreviews
      previewPool.delete(c.path);
      c.box.appendChild(pooled.v);
      if (pooled.ctrl) c.box.appendChild(pooled.ctrl);
      continue;
    }
    if (created >= NEW_PREVIEWS_PER_TICK) { deferred = true; break; }
    created++;
    c.box.dataset.previewPending = '1';
    attachCardPreview(c.box, c.path).finally(() => { delete c.box.dataset.previewPending; });
  }
  if (deferred) scheduleAutoPreviews(); // 渐进：剩余视野内卡片下一轮继续
  resumeVisiblePreviews();
}

/** L37：按可见性对齐预览 —— 视野内播放、视野外暂停（滚动停止/挂载后统一调用） */
function resumeVisiblePreviews() {
  if (previewsSuspended()) return;

  const view = scroller.getBoundingClientRect();
  const m = perfPlayMargin();
  for (const v of content.querySelectorAll('video.auto-preview')) {
    const r = v.getBoundingClientRect();
    const visible = r.bottom >= view.top - m && r.top <= view.bottom + m;
    if (visible) {
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }
}

// ─── 缩略图懒加载（IntersectionObserver 单例复用，观察未加载的占位节点） ───
// 占位节点可能是骨架（图片/视频）或图标（音频），两者都带 data-thumb
let thumbObserver = null;

function requestThumbs() {
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbObserver.unobserve(en.target);
        loadThumbForNode(en.target);
      }
    }, { root: scroller, rootMargin: '400px' });
  }
  // 重绘后旧节点已不在 DOM：先断开避免观察器持有引用
  thumbObserver.disconnect();
  content.querySelectorAll('[data-thumb]').forEach((n) => thumbObserver.observe(n));
}

// ─── L155/L198：画廊图片「视口内原质量渲染」───
// 缩略图秒开占位；图片卡片进入视口（含下方 300px 预载带）立即加载原图——
// 原图经 new Image() 后台预载，解码完成后再替换 src，避免加载闪烁。
let fullImgObserver = null;

function upgradeFullImg(box, attempt = 0) {
  if (!box.isConnected) return;
  const img = box.querySelector('img.gallery-thumb');
  if (!img) {
    // 缩略图尚未就位：稍后重试（最多约 3s）预载
    if (attempt < 10) setTimeout(() => upgradeFullImg(box, attempt + 1), 500);
    return;
  }
  if (img.dataset.fullDone) return;
  img.dataset.fullDone = '1';
  const orig = convertFileSrc(box.dataset.fullimg);
  if (img.src === orig) return;
  // 防闪烁：先后台加载完成再替换（旧缩略图一直保持显示）
  const pre = new Image();
  pre.onload = () => { if (img.isConnected) img.src = orig; };
  pre.src = orig;
}

function requestFullImgs() {
  if (!fullImgObserver) {
    fullImgObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) upgradeFullImg(en.target); // L198：立即加载，无防抖
      }
    }, { root: scroller, rootMargin: '300px 0px' }); // 视口下方 300px 内的后续卡片跟着预载
  }
  fullImgObserver.disconnect();
  content.querySelectorAll('[data-fullimg]').forEach((n) => fullImgObserver.observe(n));
}

/** 单个占位节点取缩略图并就地替换（失败/无封面则保留占位，如音频图标） */
function loadThumbForNode(node) {
  const path = node.dataset.thumb;
  const kind = node.dataset.kind;
  const req = node.dataset.size ? parseInt(node.dataset.size, 10) || 512 : 512; // L133
  loadThumb(path, kind, req).then((t) => {
    if (!t) return;
    content.querySelectorAll(`[data-thumb="${cssEscape(path)}"], [data-dur="${cssEscape(path)}"]`).forEach((n) => {
      if (n.hasAttribute('data-dur')) {
        if (t.duration) n.textContent = fmtDur(t.duration);
        return;
      }
      // 缩略图尺寸就绪 → 校正画廊占位比例（L236：行布局需按真实比例重排）
      const box = n.closest('.thumb-box');
      if (box && t.w > 0 && t.h > 0) {
        const prev = box.style.aspectRatio;
        box.style.aspectRatio = `${t.w} / ${t.h}`;
        if (state.cfg?.viewMode === 'gallery' && box.closest('.gallery-rows') && prev !== box.style.aspectRatio) {
          state.galleryVer++;
          scheduleGalleryLayout();
        }
      }
      if (n.tagName === 'IMG') {
        n.src = t.url;
        // 大尺寸已就位 → 去掉懒加载标记，避免重渲染时重复请求
        n.removeAttribute('data-thumb');
        n.removeAttribute('data-kind');
        n.removeAttribute('data-size');
        return;
      }
      const img = new Image();
      img.src = t.url;
      img.draggable = false;
      // 保留尺寸类，去掉占位类
      img.className = n.className.split(/\s+/)
        .filter((c) => c && !['skeleton', 'audio-thumb', 'folder-thumb'].includes(c))
        .join(' ') || 'thumb';
      if (n.dataset.idx !== undefined) img.dataset.idx = n.dataset.idx;
      n.replaceWith(img);
    });
    const it = state.items.find((m) => m.path === path);
    if (it && t.duration) it.duration = t.duration;
  });
}

// ─── 缩略图并发队列：限制同时在飞的 IPC 数，避免几十个解码任务同时打满 CPU ───
// 并发上限按 CPU 核数（多线程优化：核多则同时解码更多缩略图）
const MAX_ACTIVE_THUMBS = Math.max(4, Math.min(12, navigator.hardwareConcurrency || 6));

let activeThumbs = 0;
const thumbQueue = [];

function pumpThumbQueue() {
  while (activeThumbs < MAX_ACTIVE_THUMBS && thumbQueue.length > 0) {
    const job = thumbQueue.shift();
    activeThumbs++;
    job().finally(() => { activeThumbs--; pumpThumbQueue(); });
  }
}

async function loadThumb(path, kind, req = 512) {
  const ck = thumbKey(path, req); // L133：缓存键按尺寸区分
  // 1) 已有缓存：直接返回
  if (state.thumbCache.has(ck)) return state.thumbCache.get(ck);
  // 2) 已知失败（如无内嵌封面的音频）：不再重复请求（负缓存，省 IO 与解码）
  if (state.thumbFailed.has(path)) return null;
  // 3) 加载中：共享同一个 Promise（而非返回 null，避免调用方拿到空结果后不再重试）
  if (state.thumbPromises.has(ck)) return state.thumbPromises.get(ck);
  const p = new Promise((resolve) => {
    thumbQueue.push(async () => {
      try {
        const r = await invoke('get_thumbnail', { path, kind, size: req === 512 ? null : req });
        const t = { url: convertFileSrc(r.thumbPath), duration: r.duration ?? null, w: r.width, h: r.height };
        state.thumbCache.set(ck, t);
        resolve(t);
      } catch {
        state.thumbFailed.add(path); // 负缓存
        resolve(null);
      }
    });
  }).finally(() => state.thumbPromises.delete(ck));
  state.thumbPromises.set(ck, p);
  pumpThumbQueue();
  return p;
}


// ═══════════════ 元信息面板 ═══════════════
async function showInfo(idx) {
  const item = state.filtered[idx];
  const body = $('infoBody');
  if (!item) { body.innerHTML = ''; return; }
  const rows = [
    ['文件名', item.name],
    ['类型', kindLabel(item.kind)],
  ];
  if (item.kind !== 'folder') {
    rows.push(['大小', fmtSize(item.size)]);
  }
  rows.push(['修改时间', new Date(item.modified * 1000).toLocaleString()]);
  if (item.duration) rows.push(['时长', fmtDur(item.duration)]);
  if (item.width) rows.push(['尺寸', `${item.width} × ${item.height}`]);
  if (item.title) rows.push(['标题', item.title]);
  if (item.artist) rows.push(['艺术家', item.artist]);
  if (item.album) rows.push(['专辑', item.album]);
  // 文件夹没有缩略图/元信息可查：只显示基础信息
  const cover = item.kind === 'folder'
    ? `<div class="rounded-xl overflow-hidden mb-3 border border-white/20 dark:border-white/10">
         <div class="w-full aspect-square folder-thumb" style="border-radius:0">${FOLDER_ICO}</div>
       </div>`
    : `<div class="rounded-xl overflow-hidden mb-3 border border-white/20 dark:border-white/10">
         <div id="infoCover" class="skeleton w-full aspect-square"></div>
       </div>`;
  body.innerHTML = cover +
    rows.map(([k, v]) => `
      <div class="flex gap-2 text-sm">
        <span class="opacity-50 w-16 shrink-0">${k}</span>
        <span class="break-all">${escapeHtml(String(v))}</span>
      </div>`).join('');

  if (item.kind === 'folder') return; // 无媒体元信息
  try {

    let info = state.infoCache.get(item.path);
    if (!info) {
      info = await invoke('get_media_info', { path: item.path, kind: item.kind });
      state.infoCache.set(item.path, info);
    }
    if (info.duration) { addInfoRow('时长', fmtDur(info.duration)); item.duration = info.duration; }
    if (info.width && item.kind === 'image') addInfoRow('尺寸', `${info.width} × ${info.height}`);
    if (info.title) addInfoRow('标题', info.title);
    if (info.artist) addInfoRow('艺术家', info.artist);
    if (info.album) addInfoRow('专辑', info.album);
    if (info.coverPath) {
      setInfoCover(convertFileSrc(info.coverPath));
    } else if (item.kind === 'video') {
      const t = await loadThumb(item.path, 'video');
      if (t) setInfoCover(t.url);
    } else if (item.kind === 'audio') {
      // 音频无内嵌封面 → 显示音频图标（不生成占位图）
      const cv = body.querySelector('#infoCover');
      if (cv) {
        cv.classList.remove('skeleton');
        cv.innerHTML = `<div class="w-full h-full audio-thumb" style="border-radius:0">${AUDIO_ICO}</div>`;
      }
    }
  } catch { /* 保留基础信息 */ }
}

/** 元信息面板封面：完整显示（contain），不裁剪不拉伸 */
function setInfoCover(url) {
  const cv = $('infoBody').querySelector('#infoCover');
  if (!cv) return;
  cv.classList.remove('skeleton');
  cv.style.backgroundColor = 'rgba(125,125,125,.10)';
  cv.style.backgroundImage = `url(${url})`;
  cv.style.backgroundSize = 'contain';
  cv.style.backgroundPosition = 'center';
  cv.style.backgroundRepeat = 'no-repeat';
}


function addInfoRow(k, v) {
  $('infoBody').insertAdjacentHTML('beforeend',
    `<div class="flex gap-2 text-sm"><span class="opacity-50 w-16 shrink-0">${k}</span><span class="break-all">${escapeHtml(String(v))}</span></div>`);
}

// ═══════════════ 专业播放器控制 ═══════════════
const vVideo = $('viewerVideo');
const vAudio = $('audioPlayer');
// L124：更圆润精致的播放/暂停图标（与旁侧线性图标大小和谐）
const ICO_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 7.5v9a1 1 0 0 0 1.52.86l7.5-4.5a1 1 0 0 0 0-1.72l-7.5-4.5A1 1 0 0 0 9 7.5z"/></svg>';
const ICO_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.5A1.5 1.5 0 0 0 6.5 8v8A1.5 1.5 0 0 0 8 17.5h.5A1.5 1.5 0 0 0 10 16V8a1.5 1.5 0 0 0-1.5-1.5zM15.5 6.5A1.5 1.5 0 0 0 14 8v8a1.5 1.5 0 0 0 1.5 1.5h.5a1.5 1.5 0 0 0 1.5-1.5V8a1.5 1.5 0 0 0-1.5-1.5z"/></svg>';

/** 更新播放按钮图标 */
function syncPlayIcon(el, paused) { el.innerHTML = paused ? ICO_PLAY : ICO_PAUSE; }

/** 当前单一播放项（进度记录/同步用） */
const viewerItemPath = () => state.filtered[state.viewerIndex]?.path ?? '';



/** 视频：进度/时间同步到控制栏 */
function bindVideoBar() {
  const fill = $('videoSeekFill'), knob = $('videoSeekKnob');
  const setP = (p) => {
    p = Math.max(0, Math.min(1, p));
    fill.style.width = p * 100 + '%';
    knob.style.left = p * 100 + '%';
  };
  vVideo.addEventListener('timeupdate', () => {
    setP(vVideo.duration ? vVideo.currentTime / vVideo.duration : 0);
    $('videoCur').textContent = fmtDur(vVideo.currentTime) || '0:00';
    viewerMediaDur = vVideo.duration || 0; // L131
    progressSet(viewerItemPath(), vVideo.currentTime); // 与卡片预览共享进度
  });
  vVideo.addEventListener('durationchange', () => {
    $('videoDur').textContent = fmtDur(vVideo.duration) || '0:00';
    viewerMediaDur = vVideo.duration || 0; // L131
  });
  // 进度条点击 / 拖拽 seek
  initSeekDrag($('videoSeek'), (p) => {
    if (mpvCtl('seekPercent', p * 100)) return;       // mpv 引擎
    if (vVideo.duration) vVideo.currentTime = p * vVideo.duration;
  });
}


/** 通用进度条拖拽（返回进度 0~1） */
function initSeekDrag(seekEl, onChange) {
  const fill = seekEl.querySelector('.player-seek-fill');
  const knob = seekEl.querySelector('.player-seek-knob');
  const apply = (e) => {
    const r = seekEl.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    fill.style.width = p * 100 + '%';
    knob.style.left = p * 100 + '%';
    onChange(p);
  };
  let dragging = false;
  seekEl.addEventListener('mousedown', (e) => { dragging = true; apply(e); });
  window.addEventListener('mousemove', (e) => { if (dragging) apply(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
}

function toggleVideoPlay() {
  if (mpvCtl('toggle')) { showVideoBar(); return; }
  if (vVideo.paused) vVideo.play().catch(() => {}); else vVideo.pause();
  showVideoBar(); // 用户主动暂停/播放时亮出控制条
}


/**
 * 健壮自动播放（多通道）：
 * A. 原生 autoplay 属性（设置 src 前置位，浏览器自行调度）
 * B. play() 立即调用 + canplay/loadeddata 就绪重试（readyState 已就绪时显式补调）
 * C. NotAllowedError（WebView2 自动播放策略）→ 静音兜底（静音自动播放总是被允许）
 * D. AbortError / 其他瞬时错误 → 延迟重试
 * 失败原因写入状态栏，便于定位。
 */
function tryAutoplay(el, muteBtnId) {
  const autoplayOn = () => state.cfg?.videoAutoplay !== false;
  if (!autoplayOn()) { el.autoplay = false; return; }
  el.autoplay = true;   // 通道 A
  let tries = 0;
  const attempt = () => {
    if (el.paused && autoplayOn() && el.src) {
      el.play().then(() => setStatus('')).catch((err) => {
        const why = err?.name || String(err);
        if (!el.paused || !autoplayOn()) return;
        if (why === 'NotAllowedError') {
          if (!el.muted) {
            el.muted = true;
            if (muteBtnId) $(muteBtnId).classList.add('active');
            setStatus('自动播放策略限制，已静音播放');
            el.play().catch(() => setStatus('自动播放失败: ' + why));
          } else {
            setStatus('自动播放失败: ' + why);
          }
        } else if (why === 'AbortError' && tries < 3) {
          tries++;
          setTimeout(attempt, 300);   // 通道 D：加载打断，稍后重试
        } else {
          setStatus('自动播放失败: ' + why);
        }
      });
    }
  };
  attempt();                                            // 通道 B：立即
  el.addEventListener('canplay', attempt, { once: true });
  el.addEventListener('loadeddata', attempt, { once: true });
  if (el.readyState >= 2) attempt();                    // 已就绪补调
}

// 视频控制栏事件
$('videoPlay').addEventListener('click', toggleVideoPlay);
vVideo.addEventListener('play', () => syncPlayIcon($('videoPlay'), false));
vVideo.addEventListener('pause', () => syncPlayIcon($('videoPlay'), true));
vVideo.addEventListener('ended', handlePlaybackEnded); // L130：按播放模式决定下一项
let mpvMuted = false; // mpv 引擎独立静音态（mpv 播放时不操作 vVideo）
$('videoMute').addEventListener('click', () => {
  if (mpvPlaying) {
    mpvMuted = !mpvMuted;
    mpvCtl('mute', mpvMuted ? 1 : 0);
  } else {
    vVideo.muted = !vVideo.muted;
  }
  const muted = mpvPlaying ? mpvMuted : vVideo.muted;
  $('videoMute').classList.toggle('active', muted);
  if (state.cfg) { state.cfg.videoMuted = muted; saveCfg(); } // 音量状态持久化
});
$('videoVol').addEventListener('input', (e) => {
  const vol = Number(e.target.value);
  if (mpvCtl('volume', vol)) { mpvMuted = vol === 0; }
  vVideo.volume = vol / 100;
  vVideo.muted = vol === 0;
  $('videoMute').classList.toggle('active', vVideo.muted);
  if (state.cfg) { state.cfg.videoVolume = vol; state.cfg.videoMuted = vVideo.muted; saveCfg(); }
});

// L118：倍速持久化（播放控件设置记忆）
const videoSpeedStored = localStorage.getItem('videoSpeed');
if (videoSpeedStored) {
  $('videoSpeed').value = videoSpeedStored;
  vVideo.playbackRate = Number(videoSpeedStored);
}
$('videoSpeed').addEventListener('change', (e) => {
  mpvCtl('speed', Number(e.target.value));
  vVideo.playbackRate = Number(e.target.value);
  localStorage.setItem('videoSpeed', e.target.value);
});

// L235：视频画面缩放 0.5/1/1.5/2/4（HTML5 video 与 mpv canvas 统一用 CSS transform，
// 以画面中心为原点；不影响原始帧截图）
function applyVideoZoom() {
  const z = Number($('videoZoom')?.value) || 1;
  const tf = z === 1 ? '' : `scale(${z})`;
  vVideo.style.transform = tf;
  const vc = $('videoCanvas');
  if (vc) vc.style.transform = tf;
}
const videoZoomStored = localStorage.getItem('videoZoom');
if (videoZoomStored) $('videoZoom').value = videoZoomStored;
applyVideoZoom();
$('videoZoom').addEventListener('change', (e) => {
  applyVideoZoom();
  localStorage.setItem('videoZoom', e.target.value);
});
// L151：循环按钮已并入播放模式；旧 videoLoop 存储迁移为 loop 模式
if (localStorage.getItem('videoLoop') === '1' && !localStorage.getItem('viewerPlayMode')) {
  localStorage.setItem('viewerPlayMode', 'loop');
}
localStorage.removeItem('videoLoop');
// 全屏切换：Tauri 窗口级全屏真正隐藏任务栏（元素级全屏在无边框窗口下会露出任务栏）。
// 最大化态直接切全屏会损坏 tao 保存的 placement 导致退出全屏失效，
// 由 Rust 端在主线程原子处理（IsZoomed 真实状态 + SW_RESTORE + 按需恢复最大化）
async function toggleAppFullscreen() {
  try { await invoke('toggle_fullscreen', { onlyExit: false }); } catch { /* 忽略 */ }
}
$('videoFull').addEventListener('click', viewerFullscreenAction); // L136：播放控件全屏=播放全屏
$('btnFull').addEventListener('click', toggleAppFullscreen); // LOGO 旁：全局全屏

// L136-139：明确「全局全屏」与「播放全屏」两种模式（都是真全屏、隐藏任务栏，判断不同）。
// 打开预览时记录窗口基准状态 viewerFsPrev：
//   · 'fullscreen'（全局全屏）→ 直接是播放全屏，窗口不动；关闭预览回到全局全屏。
//   · 'maximized'（最大化）→ 进入真全屏（toggle 内部记录"曾最大化"）；
//     关闭预览退出全屏，Rust 自动恢复最大化。
//   · 'normal'（一般模式）→ 预览器普通播放；点全屏进入播放全屏时记录窗口几何，
//     退出播放全屏（仍在预览器）或关闭预览时把窗口位置/尺寸恢复到记录值。
let viewerFsPrev = 'normal';
let viewerFsActive = false;
let viewerSavedGeo = null; // { x, y, w, h }（物理像素）
let viewerSavedScroll = null; // { top, left } 进入预览前的画廊滚动位置

const ICON_FS_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const ICON_FS_COLLAPSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

/** 同步播放控件全屏按钮的状态（L139：按钮状态对应播放全屏） */
function syncVideoFullBtn() {
  const btn = $('videoFull');
  btn.innerHTML = viewerFsActive ? ICON_FS_COLLAPSE : ICON_FS_EXPAND;
  btn.classList.toggle('active', viewerFsActive);
  if (viewerFsPrev !== 'normal') {
    btn.title = '回到文件预览（关闭预览）'; // 场景1/2：已是播放全屏
  } else if (viewerFsActive) {
    btn.title = '回到预览器播放模式'; // 场景3：全屏中
  } else {
    btn.title = '播放全屏（双击 / Enter）';
  }
}

/** openViewer 首次打开时捕获窗口基准状态 */
async function captureViewerBase() {
  viewerSavedGeo = null;
  try {
    // 全屏切换统一走 tao（toggle_fullscreen 内部即 win.set_fullscreen），
    // tao 自己维护 fullscreen/maximized 标志与 placement，查询结果跨周期一致。
    const fs = await win.isFullscreen();
    const mx = await win.isMaximized();
    jsDiag(`captureBase fs=${fs} mx=${mx}`);
    if (fs) {
      viewerFsPrev = 'fullscreen';
      viewerFsActive = true;
    } else if (mx) {
      viewerFsPrev = 'maximized';
      viewerFsActive = true;
      // 最大化 → 真全屏（Win32 原生：铺满显示器含任务栏区，不靠 tao set_fullscreen）
      await invoke('toggle_fullscreen', { onlyExit: false });
    } else {
      viewerFsPrev = 'normal';
      viewerFsActive = false;
    }
  } catch {
    viewerFsPrev = 'normal';
    viewerFsActive = false;
  }
  syncVideoFullBtn();
}

/** 退出全屏并还原记录几何（仅一般模式用） */
async function restoreViewerGeo() {
  const g = viewerSavedGeo;
  viewerSavedGeo = null;
  try {
    await invoke('toggle_fullscreen', { onlyExit: true });
    if (g) {
      // 记录值为物理像素 → 用 Physical 类型，避免重复乘 dpr
      await win.setPosition(new PhysicalPosition(g.x, g.y));
      await win.setSize(new PhysicalSize(g.w, g.h));
    }
  } catch { /* 忽略 */ }
}
async function enterViewerFs() {
  if (viewerFsPrev === 'normal') {
    // 记录窗口位置/尺寸（outer* 返回物理像素，恢复时按物理值设回）
    try {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      viewerSavedGeo = { x: pos.x, y: pos.y, w: size.width, h: size.height };
      await invoke('toggle_fullscreen', { onlyExit: false });
    } catch { /* 忽略 */ }
  }
  viewerFsActive = true;
  syncVideoFullBtn();
  setStatus('全屏播放（双击 / Enter 退出）');
}
async function exitViewerFs() {
  viewerFsActive = false;
  if (viewerFsPrev === 'normal' && viewerSavedGeo) await restoreViewerGeo();
  syncVideoFullBtn();
  setStatus('已返回预览器播放模式');
}
// L98/L106：双击 / Enter 切换预览器全屏播放（一般模式进入/退出播放全屏）
async function toggleViewerFullscreen() {
  if (viewerFsActive) await exitViewerFs();
  else await enterViewerFs();
}
/** L139：播放控件全屏按钮 / 右键菜单「全屏」统一入口（按3种场景区分响应） */
function viewerFullscreenAction() {
  if (viewerFsPrev !== 'normal') {
    // 场景1全局全屏 / 场景2最大化：打开即播放全屏 → 回到文件预览
    closeViewer();
  } else {
    // 场景3一般模式：进入播放全屏 / 回到预览器播放
    toggleViewerFullscreen();
  }
}

// ═══════════════ L130：播放模式（顺序 / 循环 / 随机 / 一次） ═══════════════
const PLAY_MODES = [
  { id: 'seq', title: '顺序播放（播完列表停止）',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13M4 12h13M4 17h9"/><path d="M14 14l4 3-4 3"/></svg>' },
  { id: 'loop', title: '循环播放（列表循环）',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>' },
  { id: 'one', title: '单曲循环（当前文件循环）',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><text x="12" y="14.5" font-size="8" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle">1</text></svg>' },
  { id: 'random', title: '随机播放',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>' },
  { id: 'once', title: '一次播放（播完当前项停止）',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v14"/><path d="M12 5l7 7-7 7"/></svg>' },
];
let playMode = localStorage.getItem('viewerPlayMode') || 'seq';
if (!PLAY_MODES.some((m) => m.id === playMode)) playMode = 'seq';
function syncPlayModeBtn() {
  const m = PLAY_MODES.find((x) => x.id === playMode);
  const btn = $('videoPlayMode');
  btn.title = m.title;
  btn.innerHTML = m.icon;
  btn.classList.toggle('active', playMode !== 'seq');
}
/** L247：按当前播放模式设置播放器循环状态（单曲循环=开，其余=关） */
function applyPlayLoop() {
  const loop = playMode === 'one';
  if (mpvPlaying) mpvCtl('loop', loop ? 1 : 0);
  vVideo.loop = loop;
}
$('videoPlayMode').addEventListener('click', () => {
  const i = PLAY_MODES.findIndex((m) => m.id === playMode);
  playMode = PLAY_MODES[(i + 1) % PLAY_MODES.length].id;
  localStorage.setItem('viewerPlayMode', playMode);
  syncPlayModeBtn();
  applyPlayLoop();
});
syncPlayModeBtn();

/** L130：播放结束时按模式选下一项；无下一项返回 -1 */
function pickAfterEnded() {
  if (playMode === 'once') return -1;
  // L247：单曲循环模式下播放器自身 loop 已开启（HTML5/mpv 都不会触发 ended），
  // 这里兜底：万一 ended 被触发，重播当前项
  if (playMode === 'one') return state.viewerIndex;
  if (playMode === 'random') {
    const viewable = [];
    state.filtered.forEach((it, i) => {
      if (it.kind === 'image' || it.kind === 'video') viewable.push(i);
    });
    if (viewable.length === 1) return viewable[0] === state.viewerIndex ? -1 : viewable[0];
    let n = state.viewerIndex;
    while (n === state.viewerIndex) n = viewable[Math.floor(Math.random() * viewable.length)];
    return n;
  }
  // 从「下一项」开始环形查找（旧代码从当前项开始，会把自己当成下一项重播）
  const n = nextViewable(state.viewerIndex + 1, 1);
  if (n < 0 || n <= state.viewerIndex) {
    // 发生回绕：循环模式回开头；顺序模式停止
    return playMode === 'loop' ? n : -1;
  }
  return n;
}
/** vVideo ended / mpv EOF 统一入口 */
function handlePlaybackEnded() {
  const n = pickAfterEnded();
  if (n >= 0) openViewer(n, true);
  else syncPlayIcon($('videoPlay'), true);
}

// ═══════════════ L131/L145：悬浮进度条显示当前进度帧缩略图 ═══════════════
let viewerMediaDur = 0; // 当前预览媒体总时长（vVideo 与 mpv 统一记录）
const seekPreviewEl = $('seekPreview');
const seekPreviewImgEl = $('seekPreviewImg');
const seekPreviewTEl = $('seekPreviewT');
const frameCache = new Map(); // `${path}|${sec}` → URL/dataURL
let frameJobToken = 0;

// L145：客户端即时抽帧（独立隐藏 video + canvas，不走 IPC/ffmpeg，毫秒级出图）
const extractVideo = document.createElement('video');
extractVideo.muted = true;
extractVideo.preload = 'auto';
extractVideo.playsInline = true;
extractVideo.crossOrigin = 'anonymous'; // asset 协议带 CORS 头，保证 canvas 不被标记污染
const extractCanvas = document.createElement('canvas');
let extractSrcPath = '';

const onceOn = (el, ev, timeoutMs) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(new Error(ev)); };
  const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok);
  el.addEventListener('error', bad);
});

/** 确保抽帧 video 已加载指定文件 */
async function ensureExtractSrc(path) {
  if (extractSrcPath === path) return;
  extractSrcPath = path;
  extractVideo.src = convertFileSrc(path);
  await onceOn(extractVideo, 'loadedmetadata', 4000);
}

/** 客户端抽帧：seek → 画到 canvas → JPEG dataURL；失败/超时抛错 */
async function clientExtractFrame(path, sec) {
  await ensureExtractSrc(path);
  if (Math.abs(extractVideo.currentTime - sec) > 0.35) {
    extractVideo.currentTime = sec;
    await onceOn(extractVideo, 'seeked', 1500);
  }
  const vw = extractVideo.videoWidth;
  const vh = extractVideo.videoHeight;
  if (!vw || !vh) throw new Error('no-dim');
  const w = 320;
  const h = Math.max(2, Math.round((vh / vw) * w / 2) * 2);
  extractCanvas.width = w;
  extractCanvas.height = h;
  extractCanvas.getContext('2d').drawImage(extractVideo, 0, 0, w, h);
  return extractCanvas.toDataURL('image/jpeg', 0.82); // 跨域失败会在此抛 SecurityError
}

/** IPC 抽帧（mpv 格式主路径 / 客户端抽帧失败的后备）；带 60ms 防抖 */
let ipcDebounce = 0;
function ipcExtractFrame(path, sec, key, myToken) {
  const d = ++ipcDebounce;
  setTimeout(() => {
    if (d !== ipcDebounce) return; // 移动中：新请求取消旧的
    invoke('frame_at', { path, time: sec }).then((p) => {
      const url = convertFileSrc(p);
      frameCache.set(key, url);
      if (myToken === frameJobToken) seekPreviewImgEl.src = url;
    }).catch(() => { /* 失败保留旧帧 */ });
  }, 60);
}

/** 显示指定时间的帧（按整秒一档；vVideo 文件走客户端即时抽帧，mpv 走 IPC） */
function showSeekFrame(path, t, leftPx, barW) {
  const sec = Math.max(0, Math.round(t));
  seekPreviewTEl.textContent = fmtDur(t) || '0:00';
  // 位置：夹在 [88, width-88]，防止超出进度条两端
  seekPreviewEl.style.left = Math.max(88, Math.min(barW - 88, leftPx)) + 'px';
  seekPreviewEl.classList.remove('hidden');
  const key = `${path}|${sec}`;
  const hit = frameCache.get(key);
  if (hit) { if (seekPreviewImgEl.src !== hit) seekPreviewImgEl.src = hit; return; }
  const myToken = ++frameJobToken;
  if (!mpvPlaying) {
    // HTML5 可播文件：客户端即时抽帧（L145）；失败再退回 IPC
    clientExtractFrame(path, sec).then((url) => {
      frameCache.set(key, url);
      if (myToken === frameJobToken) seekPreviewImgEl.src = url;
    }).catch(() => ipcExtractFrame(path, sec, key, myToken));
  } else {
    ipcExtractFrame(path, sec, key, myToken);
  }
}
$('videoSeek').addEventListener('pointerenter', () => {
  // L145：提前加载抽帧 video，首次悬浮即出图
  const path = viewerItemPath();
  if (path && !mpvPlaying) ensureExtractSrc(path).catch(() => {});
});
$('videoSeek').addEventListener('pointermove', (e) => {
  const path = viewerItemPath();
  if (!path || !viewerMediaDur) return;
  const r = $('videoSeek').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  showSeekFrame(path, ratio * viewerMediaDur, ratio * r.width, r.width);
});
$('videoSeek').addEventListener('pointerleave', () => {
  seekPreviewEl.classList.add('hidden');
});


// ═══════════════ 音频播放模块（独立于预览层，支持后台播放） ═══════════════
// 队列/索引/音量都持久化到配置；收起面板或关闭预览都不会中断播放。
let audioMode = 'list'; // list | one | shuffle

const AUDIO_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

function audioQueue() { return state.cfg?.audioQueue ?? (state.cfg.audioQueue = []); }
const audioIndex = () => state.cfg?.audioQueueIndex ?? 0;
function setAudioIndex(i) {
  if (!state.cfg) return;
  state.cfg.audioQueueIndex = Math.max(0, i);
  saveCfg();
}
const audioCurrent = () => audioQueue()[audioIndex()] ?? '';

/** 面板开关（与播放状态无关，收起后继续后台播放） */
function openAudioPanel() {
  renderAudioNow();
  renderAudioQueue();
  $('audioPanel').classList.remove('hidden');
}
function closeAudioPanel() { $('audioPanel').classList.add('hidden'); }

/** 用一批路径替换队列并从 start 开始播放 */
function audioSetQueue(paths, start = 0) {
  if (!state.cfg) return;
  state.cfg.audioQueue = [...paths];
  setAudioIndex(start);
  renderAudioQueue();
  playAudioIndex(start);
}

/** 播放队列第 i 首（环形） */
async function playAudioIndex(i) {
  const q = audioQueue();
  if (!q.length) return;
  const idx = ((i % q.length) + q.length) % q.length;
  setAudioIndex(idx);
  const path = q[idx];
  vAudio.src = convertFileSrc(path);
  vAudio.volume = (state.cfg.audioVolume ?? 100) / 100;
  vAudio.muted = !!state.cfg.audioMuted;
  vAudio.playbackRate = Number($('audioSpeed').value) || 1;
  syncAudioVolumeUI();
  renderAudioNow();
  renderAudioQueue();
  try { await vAudio.play(); } catch { /* 自动播放限制等，忽略 */ }
  loadAudioMeta(path); // 标题/艺术家/封面异步补
}

/** 补齐当前曲目的元信息与封面 */
async function loadAudioMeta(path) {
  const item = state.items.find((m) => m.path === path);
  const fallback = item ? item.name.replace(/\.[^.]+$/, '') : (path.split(/[\\/]/).pop() || '');
  let info = state.infoCache.get(path);
  if (!info) {
    try {
      info = await invoke('get_media_info', { path, kind: 'audio' });
      state.infoCache.set(path, info);
    } catch { info = null; }
  }
  if (audioCurrent() !== path) return; // 期间已切歌
  $('audioTitle').textContent = info?.title || fallback || '未知曲目';
  $('audioArtist').textContent = [info?.artist, info?.album].filter(Boolean).join(' · ') || '';
  setAudioCover(info?.coverPath || null);
}

/** 封面：有内嵌封面显示图片，没有则显示音频图标 */
function setAudioCover(coverPath) {
  $('audioCover').innerHTML = coverPath
    ? `<img src="${convertFileSrc(coverPath)}" alt="" draggable="false">`
    : AUDIO_ICO;
}

function syncAudioVolumeUI() {
  const v = Math.round((vAudio.volume ?? 1) * 100);
  $('audioVol').value = String(vAudio.muted ? 0 : v);
  $('audioMute').classList.toggle('active', vAudio.muted || v === 0);
}

function audioNext(auto = false) {
  const q = audioQueue();
  if (!q.length) return;
  if (auto && audioMode === 'one') { vAudio.currentTime = 0; vAudio.play().catch(() => {}); return; }
  if (audioMode === 'shuffle' && q.length > 1) {
    let n = audioIndex();
    while (n === audioIndex()) n = Math.floor(Math.random() * q.length);
    playAudioIndex(n);
    return;
  }
  playAudioIndex(audioIndex() + 1);
}

function audioPrev() {
  if (!audioQueue().length) return;
  if (vAudio.currentTime > 3) { vAudio.currentTime = 0; return; } // 常见播放器行为
  playAudioIndex(audioIndex() - 1);
}

function audioToggle() {
  if (!audioQueue().length) return;
  if (vAudio.paused) vAudio.play().catch(() => {}); else vAudio.pause();
}

/** 下一首播放：插到当前曲目之后 */
function audioPlayNext(path) {
  const q = audioQueue();
  const at = q.indexOf(path);
  if (at >= 0) q.splice(at, 1);
  q.splice(Math.min(audioIndex() + 1, q.length), 0, path);
  renderAudioQueue();
  saveCfg();
  if (q.length === 1) playAudioIndex(0); // 队列原本为空：直接开播
}

/** 追加到队列末尾（去重） */
function audioEnqueue(paths) {
  const q = audioQueue();
  let added = 0;
  for (const p of paths) {
    if (!q.includes(p)) { q.push(p); added++; }
  }
  renderAudioQueue();
  saveCfg();
  if (added && !vAudio.src) playAudioIndex(0);
  return added;
}

function renderAudioNow() {
  const path = audioCurrent();
  const item = state.items.find((m) => m.path === path);
  $('npMini').classList.toggle('hidden', !path);
  const name = path ? (item ? item.name.replace(/\.[^.]+$/, '') : (path.split(/[\\/]/).pop() || '')) : '';
  $('npTitle').textContent = name;
  $('npTitle').title = path;
  syncPlayIcon($('audioPlay'), vAudio.paused);
  syncPlayIcon($('npPlay'), vAudio.paused);
  const n = audioQueue().length;
  $('apCount').textContent = n ? `共 ${n} 首` : '';
  if (!path) { $('audioTitle').textContent = '未在播放'; $('audioArtist').textContent = ''; setAudioCover(null); }
}

function renderAudioQueue() {
  const q = audioQueue();
  const cur = audioIndex();
  $('apList').innerHTML = q.length
    ? q.map((p, i) => {
        const item = state.items.find((m) => m.path === p);
        const nm = item ? item.name : (p.split(/[\\/]/).pop() || p);
        return `<div class="ap-item${i === cur ? ' active' : ''}" data-api="${i}" title="${escapeAttr(p)}">
          <span class="ap-idx">${i + 1}</span>
          <span class="flex-1 truncate">${escapeHtml(nm)}</span>
          <span class="ap-dur">${item?.duration ? fmtDur(item.duration) : ''}</span>
          <span class="ap-del" data-apdel="${i}" title="从列表移除">✕</span>
        </div>`;
      }).join('')
    : `<div class="px-2 py-3 text-xs opacity-40">播放列表为空 —— 双击音频文件，或用右键「添加到播放列表」</div>`;
}

/** 当前文件夹的音频列表（按显示顺序），以及指定项在其中的位置 */
function audioPathsFrom(idx) {
  const paths = state.filtered.filter((i) => i.kind === 'audio').map((i) => i.path);
  const start = paths.indexOf(state.filtered[idx]?.path);
  return { paths, start: Math.max(0, start) };
}

/** 恢复播放器状态：视频/音频音量与静音、音频队列（配置持久化） */
function restorePlayerState() {
  const c = state.cfg ?? {};
  // 视频 / 卡片预览
  const vv = Math.max(0, Math.min(100, Number(c.videoVolume ?? 100)));
  $('videoVol').value = String(vv);
  vVideo.volume = vv / 100;
  vVideo.muted = !!c.videoMuted || vv === 0;
  mpvMuted = vVideo.muted;
  $('videoMute').classList.toggle('active', vVideo.muted);
  // 独立音频模块
  const av = Math.max(0, Math.min(100, Number(c.audioVolume ?? 100)));
  vAudio.volume = av / 100;
  vAudio.muted = !!c.audioMuted || av === 0;
  $('audioVol').value = String(vAudio.muted ? 0 : av);
  $('audioMute').classList.toggle('active', vAudio.muted);
  // 音频队列：恢复上次曲目（就绪但不自动播放）
  const cur = audioCurrent();
  if (cur) { vAudio.src = convertFileSrc(cur); loadAudioMeta(cur); }
  renderAudioNow();
  renderAudioQueue();
}


// ─── 音频模块事件 ───
$('audioPlay').addEventListener('click', audioToggle);
$('npPlay').addEventListener('click', audioToggle);
$('audioPrev').addEventListener('click', audioPrev);
$('npPrev').addEventListener('click', audioPrev);
$('audioNext').addEventListener('click', () => audioNext(false));
$('npNext').addEventListener('click', () => audioNext(false));
$('btnAudio').addEventListener('click', () => {
  if ($('audioPanel').classList.contains('hidden')) openAudioPanel(); else closeAudioPanel();
});
$('audioPanelClose').addEventListener('click', closeAudioPanel);
$('audioPanelBackdrop').addEventListener('click', closeAudioPanel);
$('audioMode').addEventListener('click', () => {
  audioMode = audioMode === 'list' ? 'one' : audioMode === 'one' ? 'shuffle' : 'list';
  $('audioMode').classList.toggle('active', audioMode !== 'list');
  setStatus(audioMode === 'list' ? '列表循环' : audioMode === 'one' ? '单曲循环' : '随机播放');
});
$('apClear').addEventListener('click', () => {
  audioSetQueue([], 0);
  vAudio.pause();
  vAudio.removeAttribute('src');
  renderAudioNow();
  renderAudioQueue();
});
$('apAddDir').addEventListener('click', () => {
  const auds = state.items.filter((i) => i.kind === 'audio').map((i) => i.path);
  if (!auds.length) { setStatus('当前文件夹没有音频文件', true); return; }
  const n = audioEnqueue(auds);
  setStatus(n ? `已加入 ${n} 首` : '这些音频都已在列表中');
});
$('apList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-apdel]');
  if (del) {
    const i = Number(del.dataset.apdel);
    const q = audioQueue();
    q.splice(i, 1);
    if (i < audioIndex()) {
      setAudioIndex(audioIndex() - 1);
    } else if (i === audioIndex()) {
      if (q.length) { renderAudioQueue(); playAudioIndex(Math.min(i, q.length - 1)); return; }
      vAudio.pause();
      vAudio.removeAttribute('src');
    }
    renderAudioQueue();
    renderAudioNow();
    saveCfg();
    return;
  }
  const row = e.target.closest('[data-api]');
  if (row) playAudioIndex(Number(row.dataset.api));
});
vAudio.addEventListener('play', () => { syncPlayIcon($('audioPlay'), false); syncPlayIcon($('npPlay'), false); });
vAudio.addEventListener('pause', () => { syncPlayIcon($('audioPlay'), true); syncPlayIcon($('npPlay'), true); });
vAudio.addEventListener('timeupdate', () => {
  const p = vAudio.duration ? vAudio.currentTime / vAudio.duration : 0;
  $('audioSeekFill').style.width = p * 100 + '%';
  $('audioSeekKnob').style.left = p * 100 + '%';
  $('audioCur').textContent = fmtDur(vAudio.currentTime) || '0:00';
});
vAudio.addEventListener('durationchange', () => { $('audioDur').textContent = fmtDur(vAudio.duration) || '0:00'; });
vAudio.addEventListener('ended', () => audioNext(true));
initSeekDrag($('audioSeek'), (p) => { if (vAudio.duration) vAudio.currentTime = p * vAudio.duration; });
$('audioMute').addEventListener('click', () => {
  vAudio.muted = !vAudio.muted;
  if (state.cfg) state.cfg.audioMuted = vAudio.muted; // 音量状态持久化
  syncAudioVolumeUI();
  saveCfg();
});
$('audioVol').addEventListener('input', (e) => {
  vAudio.volume = Number(e.target.value) / 100;
  vAudio.muted = vAudio.volume === 0;
  if (state.cfg) { state.cfg.audioVolume = Number(e.target.value); state.cfg.audioMuted = vAudio.muted; }
  syncAudioVolumeUI();
  saveCfg();
});
$('audioSpeed').addEventListener('change', (e) => { vAudio.playbackRate = Number(e.target.value); });


// ═══════════════ 视频播放引擎（ffmpeg 解码 → canvas 画面 + mpv 音频） ═══════════════
// 画面：video_start 启动 ffmpeg 解码为 JPEG 帧流，经 rvframe:// 协议 fetch 到 canvas
// 音频：mpv_load 起 libmpv 纯音频（vo=null），mpv_control 控制播放/音量/倍速
// 同步：音频时钟为主，拉帧时把音频 position 作为 pts 传给后端取对应帧
let mpvEnabled = false;
const MPV_EXTS = new Set(['ts', 'mts', 'm2ts', 'mkv', 'avi', 'flv', 'wmv', 'rm', 'rmvb', 'vob', '3gp', 'ogv']);
invoke('mpv_available').then((ok) => { mpvEnabled = !!ok; }).catch(() => {});

/** 文件是否应走 mpv 音频引擎（HTML5 不支持的容器格式） */
function useMpvEngine(path) {
  if (!mpvEnabled) return false;
  const ext = (path.match(/\.([^.\\/]+)$/) || [])[1]?.toLowerCase() || '';
  return MPV_EXTS.has(ext);
}

// 播放状态
let mpvSession = -1;      // 对应 state.viewerIndex，防止异步竞态
let mpvTimer = null;
let mpvPlaying = false;   // 是否处于视频播放模式（当前预览项）
let mpvPendingSeek = 0;   // 续播：文件就绪后要跳到的秒数（只做一次）
let mpvPath = '';         // 当前播放的文件路径（进度记录用）
let mpvEndHandled = false; // EOF 事件去重
let mpvPosition = 0;      // 当前播放位置（秒，供 Q/E seek 等读取）
let videoGen = 0;         // 会话代令牌：stop 时递增，使在途 rAF/fetch 回调失效
let videoPrimed = false;  // 画面缓冲是否已攒够（primed 后才启动音频）
let videoRafId = 0;       // 拉帧 rAF 句柄
let videoRate = 1;        // 播放速率
let videoLoop = false;    // 是否循环
const videoCanvas = $('videoCanvas');
const videoCtx = videoCanvas?.getContext('2d');

// rvframe 帧头偏移（小端）
const FH_W = 0, FH_H = 4, FH_SEQ = 8, FH_PTS = 16, FH_BUF = 20, FH_FLAGS = 24;
const FLAG_PRIMED = 1;
const FRAME_HEADER = 28;

// （canvas 方案下无需预读池：每次切换直接 video_start，开销可接受）
function prefetchNeighbors() {}
function prefetchClear() {}

// （canvas 方案下视频铺满舞台由 CSS object-fit:contain 处理，无需手动几何/遮罩）
function updateViewerShade() {}
function setMainWrapHole() {}
function syncMpvGeometry() {}
function setMpvGeometryOnly() {}
function applyMpvShade() {}
function computeMpvGeometry() { return null; }
function mpvLayoutLoop() {}

/** 轮询播放状态 → 更新控制条（进度/时间/按钮） */
async function mpvPoll() {
  if (!mpvPlaying) return;
  try {
    const s = await invoke('mpv_state');
    if (!mpvPlaying || !s.loaded) return;
    mpvPosition = s.position || 0;
    // 续播：时长就绪后跳到记录位置（只做一次）
    if (mpvPendingSeek > 0 && s.duration > 0) {
      const target = mpvPendingSeek;
      mpvPendingSeek = 0;
      if (target < s.duration - 0.5) mpvCtl('seek', target);
    }
    // 进度记录
    progressSet(mpvPath, s.position);
    // 进度/时长
    if (s.duration > 0) {
      const p = Math.min(1, s.position / s.duration);
      $('videoSeekFill').style.width = p * 100 + '%';
      $('videoSeekKnob').style.left = p * 100 + '%';
    }
    $('videoCur').textContent = fmtDur(s.position) || '0:00';
    $('videoDur').textContent = fmtDur(s.duration) || '0:00';
    viewerMediaDur = s.duration || 0;
    // 播放/暂停按钮
    syncPlayIcon($('videoPlay'), s.paused);
    // 播放结束按播放模式选下一项（去重触发）
    if (s.ended) {
      if (!mpvEndHandled) { mpvEndHandled = true; handlePlaybackEnded(); }
    } else {
      mpvEndHandled = false;
    }
    // 暂停时保持控制条常显
    if (s.paused) showVideoBar();
  } catch { /* 忽略 */ }
}

// 会话代令牌：stop 时递增，使在途的 rAF/fetch 回调失效
let mpvGen = 0;

/** 从 rvframe 协议取一帧并画到 canvas；返回 { primed, bufferedMs } */
async function fetchVideoFrame(gen, ptsMs) {
  if (gen !== mpvGen || !videoCtx) return null;
  try {
    const url = ptsMs != null
      ? `http://rvframe.localhost/f?pts=${Math.round(ptsMs)}`
      : 'http://rvframe.localhost/f';
    const res = await fetch(url, { cache: 'no-store' });
    if (gen !== mpvGen) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < FRAME_HEADER) return null;
    const dv = new DataView(buf);
    const w = dv.getUint32(FH_W, true);
    const h = dv.getUint32(FH_H, true);
    const bufferedMs = dv.getUint32(FH_BUF, true);
    const flags = dv.getUint32(FH_FLAGS, true);
    const primed = (flags & FLAG_PRIMED) !== 0;
    if (w > 0 && h > 0 && buf.byteLength > FRAME_HEADER) {
      const jpeg = buf.slice(FRAME_HEADER);
      const blob = new Blob([jpeg], { type: 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      if (gen !== mpvGen) { bmp.close(); return { primed, bufferedMs }; }
      if (videoCanvas.width !== w || videoCanvas.height !== h) {
        videoCanvas.width = w;
        videoCanvas.height = h;
      }
      videoCtx.drawImage(bmp, 0, 0);
      bmp.close();
    }
    return { primed, bufferedMs };
  } catch { return null; }
}

/** 拉帧循环：rAF 驱动，按音频时钟取帧（primed 前不启动音频） */
function videoFrameLoop(gen) {
  if (gen !== mpvGen || !mpvPlaying) return;
  (async () => {
    // 用音频 position 作为 pts 取对应帧（音画同步）；音频未起时 pts=null 严格 FIFO
    let pts = null;
    if (videoPrimed) {
      try {
        const st = await invoke('mpv_state');
        if (st && st.loaded && !st.paused) pts = st.position * 1000;
      } catch { /* 忽略 */ }
    }
    const r = await fetchVideoFrame(gen, pts);
    if (gen !== mpvGen || !mpvPlaying) return;
    if (r) {
      if (r.primed && !videoPrimed) {
        // 缓冲攒够：启动音频
        videoPrimed = true;
        $('videoBufOverlay').classList.add('hidden');
        try {
          await invoke('mpv_load', { path: mpvPath, autoplay: true });
          mpvCtl('volume', state.cfg?.videoVolume ?? 100);
          if (state.cfg?.videoMuted) mpvCtl('mute', 1);
          mpvCtl('speed', videoRate);
          mpvCtl('loop', videoLoop ? 1 : 0);
        } catch (e) { setStatus('音频启动失败: ' + e, true); }
      }
      // 缓冲进度条
      const bar = $('videoBufBar');
      if (bar && r.bufferedMs > 0) bar.style.width = Math.min(100, r.bufferedMs / 30) + '%';
    }
    if (gen === mpvGen && mpvPlaying) {
      videoRafId = requestAnimationFrame(() => videoFrameLoop(gen));
    }
  })();
}

function startMpvSession(item, autoplay) {
  const path = item.path;
  mpvPlaying = true;
  mpvEndHandled = false;
  mpvPath = path;
  mpvPendingSeek = progressGet(path);
  const gen = ++mpvGen;
  videoPrimed = false;
  videoRate = Number($('videoSpeed')?.value) || 1;
  // L247：按播放模式设置循环（单曲循环=开，其余=关）
  videoLoop = playMode === 'one';
  applyPlayLoop();

  // 显示 canvas，隐藏 HTML5 video
  videoCanvas.classList.remove('hidden');
  $('viewerVideo').classList.add('hidden');

  // 显示缓冲提示
  const bufOverlay = $('videoBufOverlay');
  if (bufOverlay) {
    bufOverlay.classList.remove('hidden');
    $('videoBufBar').style.width = '0%';
  }

  const dpr = window.devicePixelRatio || 1;
  const stage = $('viewerStage');
  const maxW = Math.max(2, Math.round((stage?.clientWidth || 1280) * dpr));
  const maxH = Math.max(2, Math.round((stage?.clientHeight || 720) * dpr));

  (async () => {
    try {
      const dims = await invoke('video_start', {
        path,
        startAt: mpvPendingSeek > 0 ? mpvPendingSeek : 0,
        rate: videoRate,
        loopFile: videoLoop,
        maxW,
        maxH,
        bufferMs: 3000,
      });
      if (gen !== mpvGen) return;
      // 回写元数据（供下次切换使用）
      if (dims && dims.srcW > 0) {
        item.width = dims.srcW;
        item.height = dims.srcH;
      }
      jsDiag(`videoStart ok ${dims?.w}x${dims?.h} fps=${dims?.fps} hw=${dims?.hwaccel}`);
      // 启动拉帧循环
      videoFrameLoop(gen);
    } catch (err) {
      if (gen === mpvGen) {
        jsDiag(`videoStart FAIL: ${err}`);
        setStatus('视频播放失败: ' + err, true);
      }
    }
  })();

  clearInterval(mpvTimer);
  mpvTimer = setInterval(mpvPoll, 200);
}

let mpvStopPromise = Promise.resolve();

async function stopMpvSession() {
  const wasPlaying = mpvPlaying;
  mpvPlaying = false;
  mpvGen++;
  mpvPendingSeek = 0;
  videoPrimed = false;
  if (videoRafId) { cancelAnimationFrame(videoRafId); videoRafId = 0; }
  clearInterval(mpvTimer);
  videoCanvas.classList.add('hidden');
  $('videoBufOverlay')?.classList.add('hidden');
  if (!wasPlaying) return mpvStopPromise;
  flushProgress();
  mpvStopPromise = mpvStopPromise.then(async () => {
    try { await invoke('video_stop'); } catch { /* 忽略 */ }
    try { await invoke('mpv_stop'); } catch { /* 忽略 */ }
  });
  return mpvStopPromise;
}

// 控制条适配：mpv 播放时转发到 mpv_control（音频）+ 必要时 video_pause（画面）
function mpvCtl(action, value) {
  if (!mpvPlaying) return false;
  switch (action) {
    case 'toggle':
    case 'pause':
    case 'play':
      invoke('mpv_control', { action, value: value ?? null }).catch(() => {});
      // 画面同步暂停/播放：pause 时保留最后一帧，play 时重启解码
      if (action === 'pause' || action === 'toggle') {
        invoke('video_pause').catch(() => {});
      }
      break;
    case 'seek':
    case 'seekPercent':
    case 'volume':
    case 'mute':
    case 'speed':
      invoke('mpv_control', { action, value: value ?? null }).catch(() => {});
      if (action === 'speed') videoRate = Number(value) || 1;
      if (action === 'loop') videoLoop = value > 0.5;
      break;
    case 'loop':
      invoke('mpv_control', { action, value: value ?? null }).catch(() => {});
      videoLoop = value > 0.5;
      break;
  }
  return true;
}

// ═══════════════ 画廊预览 ═══════════════
async function openViewer(idx, quiet = false) {
  if (idx < 0 || idx >= state.filtered.length) return;
  if (perf.active) return; // 表演中不打开预览器
  // 音频走独立播放模块（不进预览层；面板可收起，继续后台播放）
  if (state.filtered[idx]?.kind === 'audio') {
    const { paths, start } = audioPathsFrom(idx);
    openAudioPanel();
    audioSetQueue(paths, start);
    return;
  }
  // 文件夹 / 音频不可预览：从该位置向后找第一个可预览项
  const target = nextViewable(idx, 1);
  if (target < 0) return;
  idx = target;
  const prevViewerIdx = state.viewerIndex;
  state.viewerIndex = idx;
  const item = state.filtered[idx];
  // L90：仅首次打开（预览层之前是隐藏的）才短暂亮出悬浮控件；切换文件不唤醒
  const wasHidden = $('viewer').classList.contains('hidden');
  if (wasHidden) {
    await captureViewerBase(); // L129：首次打开捕获窗口基准状态
    // 保存画廊视口滚动位置，关闭预览时恢复
    viewerSavedScroll = { top: scroller.scrollTop, left: scroller.scrollLeft };
  }
  viewerWakePending = !quiet && wasHidden;
  $('viewer').classList.remove('hidden');
  if (viewerWakePending) wakeViewerUI();
  $('viewerTitle').textContent = item.name;
  // L62：控制条左侧显示缩略文件名
  const vfn = $('videoFileName');
  if (vfn) { vfn.textContent = item.name; vfn.title = item.name; }
  $('viewerIndex').textContent = `${idx + 1} / ${state.filtered.length}`;
  vpMarkActive(); // L99：同步播放列表高亮
  updateVideoInfoPanel(); // L152：解码信息悬浮层随文件切换刷新（未开启时内部自动隐藏）
  $('viewerImg').classList.add('hidden');
  $('viewerVideo').classList.add('hidden');
  videoCanvas.classList.add('hidden');
  $('videoBar').classList.add('hidden');
  $('imgDock').classList.add('hidden'); // L233：停靠区仅图片模式显示
  resetImageTransform(); // 翻转/旋转/缩放/平移为视图级状态，切换项即复位
  stopMpvSession(); // 停止上一个视频会话
  // L34：侧切换箭头仅图片显示（视频不显示）；光标复位
  setViewerSideArrows(item.kind === 'image');
  viewerImg.style.cursor = item.kind === 'image' ? 'grab' : '';

  vVideo.pause();
  // L249：打开视频预览时不暂停音频后台播放（音频播放器独立于视频）
  setViewerSuspension(true); // 单一播放期间暂停文件区列表预览

  const src = convertFileSrc(item.path);
  if (item.kind === 'image') {
    $('imgDock').classList.remove('hidden'); // L233：竖排缩放条停靠区
    // 渐进加载：先显示已缓存的缩略图（瞬时），全尺寸原图解码完成后再无缝替换
    const t = thumbAny(item.path);
    if (t) {
      $('viewerImg').src = t.url;
      $('viewerImg').classList.remove('hidden');
      const full = new Image();
      full.onload = () => {
        // 仍在预览同一项时才替换，避免竞态闪烁
        if (state.viewerIndex === idx) $('viewerImg').src = src;
      };
      full.src = src;
    } else {
      $('viewerImg').src = src;
      $('viewerImg').classList.remove('hidden');
    }
  } else if (item.kind === 'video') {
    jsDiag(`openViewer video idx=${idx} name=${item.name} meta=${item.width}x${item.height}`);
    syncPlayIcon($('videoPlay'), true);
    const autoplay = state.cfg?.videoAutoplay !== false;
    if (useMpvEngine(item.path)) {
      // HTML5 不支持的容器（ts/mkv/avi…）→ ffmpeg 解码 + canvas 画面 + mpv 音频
      stopMpvSession().then(() => {
        if (state.viewerIndex !== idx) return;
        mpvSession = idx;
        startMpvSession(item, autoplay);
        revealVideoBar();
      });
    } else {
      // HTML5 可播格式（mp4/webm/ogg…）→ 直接用 <video> 标签
      stopMpvSession();
      videoCanvas.classList.add('hidden');
      $('viewerVideo').classList.remove('hidden');
      (async () => {
        const playPath = await playableVideoSrc(item.path);
        if (state.viewerIndex !== idx) return;
        const resume = progressGet(item.path);
        vVideo.src = convertFileSrc(playPath);
        vVideo.playbackRate = Number($('videoSpeed')?.value) || 1;
        applyPlayLoop(); // L247：单曲循环模式下开启 loop
        const onMeta = () => {
          if (resume > 0 && vVideo.duration) {
            vVideo.currentTime = Math.min(resume, vVideo.duration - 0.5);
          }
          vVideo.removeEventListener('loadedmetadata', onMeta);
        };
        vVideo.addEventListener('loadedmetadata', onMeta);
        if (autoplay) vVideo.play().catch(() => {});
        revealVideoBar();
      })();
    }
  }
  showInfo(idx);
}

function closeViewer() {
  jsDiag('closeViewer');
  prefetchClear();
  $('viewer').classList.add('hidden');
  $('viewerPlaylist').classList.remove('viewer-show'); // L99：关预览时收起播放列表
  stopMpvSession();
  vVideo.pause();
  vVideo.autoplay = false;
  vVideo.removeAttribute('src');
  // 注意：不碰音频模块 —— 音频独立播放，关闭预览后继续后台播放
  flushProgress();            // 关闭前落盘，保证下次续播
  setViewerSuspension(false); // 退出单一播放 → 文件区列表恢复播放

  // L136-139：按基准状态分别处理
  //  · 一般模式：退出播放全屏并恢复记录几何
  //  · 最大化：退出真全屏，Rust 自动恢复最大化
  //  · 全局全屏：不动窗口
  if (viewerFsPrev === 'normal') {
    if (viewerFsActive && viewerSavedGeo) {
      viewerFsActive = false;
      restoreViewerGeo();
    } else {
      viewerFsActive = false;
    }
  } else if (viewerFsPrev === 'maximized') {
    viewerFsActive = false;
    invoke('toggle_fullscreen', { onlyExit: true }).catch(() => {});
  } else {
    viewerFsActive = false;
  }
  state.viewerIndex = -1;
  // 恢复进入预览前的画廊视口滚动位置
  if (viewerSavedScroll) {
    scroller.scrollTop = viewerSavedScroll.top;
    scroller.scrollLeft = viewerSavedScroll.left;
    viewerSavedScroll = null;
  }
}


/** 从 from 起沿 dir 找第一个可预览项（跳过文件夹与音频），环形查找；无则 -1 */
function nextViewable(from, dir) {

  const n = state.filtered.length;
  if (!n) return -1;
  for (let k = 0; k < n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (state.filtered[i]?.kind === 'image' || state.filtered[i]?.kind === 'video') return i;

  }
  return -1;
}

/** 显示视频控制条（宽度由 CSS 固定为"最佳范围内最大尺寸"，不随媒体尺寸变化） */
function revealVideoBar() {
  $('videoBar').classList.remove('hidden');
  // L90：切换文件不唤醒悬浮控件；仅首次打开时补闪控制条（openViewer 时 bar 尚未就绪）
  if (viewerWakePending) {
    viewerWakePending = false;
    showVideoBar();
    hideVideoBarSoon(1600);
  }
}

/** L240：截屏——视频=原始帧；图片=原图；其他=当前窗口客户区截图。保存为 PNG */
async function takeScreenshot() {
  const viewerOpen = !$('viewer').classList.contains('hidden');
  const item = viewerOpen ? state.filtered[state.viewerIndex] : null;
  let data = null;   // PNG 字节数组（save_screenshot 入参）
  let kind = '';

  // 1) 视频预览：提取原始分辨率帧（mpv 解码 canvas / HTML5 video 内禀尺寸）
  if (item?.kind === 'video') {
    let srcCanvas = null;
    if (mpvPlaying && videoCanvas && videoCanvas.width > 0) {
      srcCanvas = videoCanvas;
    } else if (vVideo && vVideo.videoWidth > 0) {
      const c = document.createElement('canvas');
      c.width = vVideo.videoWidth;
      c.height = vVideo.videoHeight;
      c.getContext('2d').drawImage(vVideo, 0, 0);
      srcCanvas = c;
    }
    if (srcCanvas) {
      try {
        const blob = await new Promise((res, rej) => srcCanvas.toBlob(res, 'image/png'));
        if (!blob) throw new Error('视频帧编码失败');
        data = Array.from(new Uint8Array(await blob.arrayBuffer()));
        kind = '视频原始帧';
      } catch (e) { setStatus(`截图失败：${e}`, true); return; }
    }
  }

  // 2) 图片预览：绘制原图（naturalWidth/Height，不受视图缩放影响）
  if (!data && item?.kind === 'image' && viewerImg.naturalWidth > 0) {
    try {
      const c = document.createElement('canvas');
      c.width = viewerImg.naturalWidth;
      c.height = viewerImg.naturalHeight;
      c.getContext('2d').drawImage(viewerImg, 0, 0);
      const blob = await new Promise((res, rej) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('图片编码失败');
      data = Array.from(new Uint8Array(await blob.arrayBuffer()));
      kind = '原图';
    } catch (e) { setStatus(`截图失败：${e}`, true); return; }
  }

  // 3) 其他情况（无预览 / 音频 / 文件区…）：后端抓窗口客户区
  if (!data) {
    try {
      data = await invoke('capture_window');
      kind = '窗口截图';
    } catch (e) { setStatus(`窗口截图失败：${e}`, true); return; }
    if (!data || !data.length) { setStatus('窗口截图失败：未获取到画面', true); return; }
  }

  try {
    // 默认路径：项目目录/screenshots/，可在设置中修改
    const dir = state.cfg?.screenshotDir || '';
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `screenshot_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.png`;
    const path = dir ? `${dir.replace(/[\\/]+$/, '')}/${name}` : name;
    const saved = await invoke('save_screenshot', { path, data });
    showTopToast(`${kind}已保存：${name}`);
    setStatus(`${kind}已保存：${saved}`);
  } catch (e) {
    setStatus(`截图保存失败：${e}`, true);
  }
}

function viewerStep(d) {
  if (!state.filtered.length) return;
  const cur = state.viewerIndex < 0 ? 0 : state.viewerIndex;
  const next = nextViewable(cur + d, d);
  if (next >= 0) openViewer(next, true); // true = quiet（不唤醒隐藏的悬浮控件）
}

// ─── L255：预览器内删除当前文件（Del=回收站，Shift+Del=永久删除） ───
async function deleteViewerItem(permanent = false) {
  const item = state.filtered[state.viewerIndex];
  if (!item || deleteBusy) return;
  if (permanent) {
    const ok = await askConfirm(
      `将永久删除「${item.name}」，\n不进入回收站，删除后无法恢复。确定继续吗？`,
      '永久删除',
    );
    if (!ok) return;
  }
  deleteBusy = true;
  try {
    await invoke('delete_items', { paths: [item.path], permanent });
    setStatus(permanent ? '已永久删除' : '已删除（移入回收站，可还原）');
    // 本地列表同步移除（避免重扫丢失穿透态），文件区卡片即时消失
    const rm = (arr) => {
      const i = arr.findIndex((x) => x && x.path === item.path);
      if (i >= 0) arr.splice(i, 1);
    };
    rm(state.items);
    rm(state.filtered);
    // 集锦箱中若有该文件的失效引用一并清理
    if (collectionPaths.includes(item.path)) {
      collectionPaths.splice(collectionPaths.indexOf(item.path), 1);
      renderCollection();
      saveCollectionBox();
    }
    resetSelection();
    renderVirtual();
    const idx = state.viewerIndex;
    if (idx >= state.filtered.length || !state.filtered.length) {
      closeViewer(); // 后面没有文件了
    } else {
      openViewer(idx, true); // 原位显示下一项
    }
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    deleteBusy = false;
  }
}

/** L255：当前预览文件加入 / 移出集锦箱（与文件区右键同一逻辑，作用于当前编号） */
function toggleCollectViewerItem() {
  const item = state.filtered[state.viewerIndex];
  if (!item) return;
  const i = collectionPaths.indexOf(item.path);
  if (i >= 0) {
    collectionPaths.splice(i, 1);
    setStatus('已移出集锦箱');
  } else {
    collectionPaths.push(item.path);
    setStatus(`已加入集锦箱 ${collectionIdx} 号`);
  }
  renderCollection();
  saveCollectionBox();
}

// 预览器（关闭；左右切换箭头已移除，改用快捷键 / 控制条上下文件按钮）
$('viewerClose').addEventListener('click', closeViewer);

// 视频控制条：上一 / 下一文件
$('videoPrev').addEventListener('click', () => viewerStep(-1));
$('videoNext').addEventListener('click', () => viewerStep(1));

// ─── L34：图片两侧文件切换箭头（视频不显示） ───
const viewerPrevSide = $('viewerPrevSide');
const viewerNextSide = $('viewerNextSide');
function setViewerSideArrows(show) {
  viewerPrevSide.classList.toggle('hidden', !show);
  viewerNextSide.classList.toggle('hidden', !show);
}
viewerPrevSide.addEventListener('click', () => viewerStep(-1));
viewerNextSide.addEventListener('click', () => viewerStep(1));
// L100：箭头仅鼠标悬浮在按钮（含扩区）上才显示，离开 1 秒缓动消失
viewerPrevSide.addEventListener('mouseenter', showSideArrows);
viewerPrevSide.addEventListener('mouseleave', () => hideSideArrowsSoon());
viewerNextSide.addEventListener('mouseenter', showSideArrows);
viewerNextSide.addEventListener('mouseleave', () => hideSideArrowsSoon());

// L98/L106：双击视频或图片 → 全屏；再次双击退出返回预览器（控件/面板区域不触发）
$('viewerStage').addEventListener('dblclick', (e) => {
  if ($('viewer').classList.contains('hidden')) return;
  if (e.target.closest('button, input, select, a, #videoBar, #viewerPlaylist, #viewerTopFloat, #imgDock')) return;
  const item = state.filtered[state.viewerIndex];
  if (item?.kind !== 'video' && item?.kind !== 'image') return;
  e.preventDefault();
  // L139：与全屏按钮/右键菜单同入口（场景1/2：回到文件预览；场景3：切换播放全屏）
  viewerFullscreenAction();
});

// L110/L112：点击舞台空白处、上部 1/4 或视频画面 → 拖动窗口。
// 移动超过阈值才发起（不干扰双击全屏）；视频模式下 viewerVideo 铺满舞台，
// 画面上的按住拖动即窗口拖动（mpv 原生子窗口区域事件不经过 webview，无法覆盖）。
let viewerWinDrag = null;
$('viewerStage').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('button, input, select, a, #videoBar, #viewerPlaylist, #viewerTopFloat, #imgDock')) return;
  const onVideo = e.target === $('viewerVideo') || e.target === $('videoCanvas');
  if (!(e.target === $('viewerStage') || onVideo || inViewerUpper(e))) return;
  viewerWinDrag = { x: e.clientX, y: e.clientY };
});
window.addEventListener('pointermove', (e) => {
  if (!viewerWinDrag) return;
  if (Math.abs(e.clientX - viewerWinDrag.x) < 6 && Math.abs(e.clientY - viewerWinDrag.y) < 6) return;
  viewerWinDrag = null;
  win.startDragging().catch(() => {});
});
window.addEventListener('pointerup', () => { viewerWinDrag = null; });
window.addEventListener('pointercancel', () => { viewerWinDrag = null; });

// ─── 滚轮 —— 图片：Ctrl+缩放 / 普通切换文件；视频：按设置切换文件 ───
$('viewerStage').addEventListener('wheel', (e) => {
  if ($('viewer').classList.contains('hidden')) return;
  const item = state.filtered[state.viewerIndex];
  if (!item) return;
  if (item.kind === 'image') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomImageAt(e, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    else viewerStep(e.deltaY > 0 ? 1 : -1);
  } else if (item.kind === 'video' && state.cfg?.videoWheelSwitch !== false) {
    e.preventDefault();
    viewerStep(e.deltaY > 0 ? 1 : -1);
  }
}, { passive: false });

/** 以光标位置为锚点缩放（fit 后尺寸为 1；范围 20%–1200%） */
function zoomImageAt(e, factor) {
  const rect = $('viewerStage').getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const mx = e.clientX - cx, my = e.clientY - cy; // 光标距舞台中心
  const z = imgTransform.zoom;
  // 光标对应的图片内坐标（相对中心，忽略旋转）
  const px = (mx - imgTransform.tx) / z, py = (my - imgTransform.ty) / z;
  const nz = Math.min(12, Math.max(0.2, z * factor));
  imgTransform.zoom = nz;
  imgTransform.tx += (z - nz) * px;
  imgTransform.ty += (z - nz) * py;
  applyImageTransform();
}

// ─── L35：鼠标按住拖动平移图片 ───
let imgPanning = false;
let panStartX = 0, panStartY = 0, panOrigTx = 0, panOrigTy = 0;
/** L112：指针是否在舞台上部 1/4 区域（含顶部、从顶部算起；该区域交给窗口拖动，不平移图片） */
function inViewerUpper(e) {
  const r = $('viewerStage').getBoundingClientRect();
  return e.clientY - r.top <= r.height / 4;
}
viewerImg.addEventListener('pointerdown', (e) => {
  if ($('viewer').classList.contains('hidden') || e.button !== 0) return;
  hideCtxMenu(); // L100：图片模式下点击图像，已弹出的右键菜单随之消失（指针捕获会拦截全局 mousedown）
  if (inViewerUpper(e)) {
    // L118：上部区域不做图片平移；但必须阻止浏览器原生图片拖动手势
    // （否则指针变拖拽形状、窗口拖动被手势吞掉），随后冒泡给舞台处理器拖窗口
    e.preventDefault();
    return;
  }
  imgPanning = true;
  panStartX = e.clientX; panStartY = e.clientY;
  panOrigTx = imgTransform.tx; panOrigTy = imgTransform.ty;
  viewerImg.setPointerCapture(e.pointerId);
  viewerImg.style.cursor = 'grabbing';
  e.preventDefault();
});
viewerImg.addEventListener('pointermove', (e) => {
  if (!imgPanning) return;
  imgTransform.tx = panOrigTx + (e.clientX - panStartX);
  imgTransform.ty = panOrigTy + (e.clientY - panStartY);
  applyImageTransform();
});
const endImgPan = (e) => {
  if (!imgPanning) return;
  imgPanning = false;
  viewerImg.style.cursor = 'grab';
  try { viewerImg.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
};
viewerImg.addEventListener('pointerup', endImgPan);
viewerImg.addEventListener('pointercancel', endImgPan);

// ─── L35：右下角总览图（zoom>1 时显示；点击/拖动可定位） ───
const imgMinimap = $('imgMinimap');
const minimapImgEl = $('minimapImg');
const minimapView = $('minimapView');
const MM_MAX_W = 190, MM_MAX_H = 150;

/** 图片打开/换源后：按宽高比定尺寸、同步图源 */
function setupMinimap() {
  const iw = viewerImg.naturalWidth, ih = viewerImg.naturalHeight;
  if (!iw || !ih) { imgMinimap.classList.add('hidden'); return; }
  const s = Math.min(MM_MAX_W / iw, MM_MAX_H / ih, 1);
  minimapImgEl.style.width = Math.round(iw * s) + 'px';
  minimapImgEl.style.height = Math.round(ih * s) + 'px';
  if (minimapImgEl.src !== viewerImg.currentSrc) minimapImgEl.src = viewerImg.currentSrc;
  updateMinimap();
}

/** 依据当前缩放/平移刷新视口指示框（未缩放时隐藏总览图） */
function updateMinimap() {
  const iw = viewerImg.naturalWidth, ih = viewerImg.naturalHeight;
  if (!iw || !ih || imgTransform.zoom <= 1.01) {
    imgMinimap.classList.add('hidden');
    return;
  }
  const stage = $('viewerStage');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const s0 = Math.min(sw / iw, sh / ih); // fit 基准（与 object-contain 一致）
  const k = s0 * imgTransform.zoom;
  if (!k) return;
  // 舞台四条边对应的图片坐标（图片中心为原点）
  const pl0 = (-sw / 2 - imgTransform.tx) / k, pr0 = (sw / 2 - imgTransform.tx) / k;
  const pt0 = (-sh / 2 - imgTransform.ty) / k, pb0 = (sh / 2 - imgTransform.ty) / k;
  const pl = Math.max(-iw / 2, pl0), pr = Math.min(iw / 2, pr0);
  const pt = Math.max(-ih / 2, pt0), pb = Math.min(ih / 2, pb0);
  const mmW = parseFloat(minimapImgEl.style.width) || MM_MAX_W;
  const mmS = mmW / iw;
  minimapView.style.left = Math.round((pl + iw / 2) * mmS) + 'px';
  minimapView.style.top = Math.round((pt + ih / 2) * mmS) + 'px';
  minimapView.style.width = Math.max(8, Math.round((pr - pl) * mmS)) + 'px';
  minimapView.style.height = Math.max(8, Math.round((pb - pt) * mmS)) + 'px';
  imgMinimap.classList.remove('hidden');
}

/** 总览图定位：把图片内 (px,py) 点移至舞台中心 → t = -s0*z*p */
function mmCenterTo(e) {
  const iw = viewerImg.naturalWidth, ih = viewerImg.naturalHeight;
  if (!iw || !ih) return;
  const r = minimapImgEl.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width - 0.5) * iw;
  const py = ((e.clientY - r.top) / r.height - 0.5) * ih;
  const stage = $('viewerStage');
  const s0 = Math.min(stage.clientWidth / iw, stage.clientHeight / ih);
  imgTransform.tx = -s0 * imgTransform.zoom * px;
  imgTransform.ty = -s0 * imgTransform.zoom * py;
  applyImageTransform();
}
let mmDrag = false;
minimapView.addEventListener('pointerdown', (e) => {
  mmDrag = true;
  minimapView.setPointerCapture(e.pointerId);
  mmCenterTo(e);
  e.preventDefault();
});
minimapView.addEventListener('pointermove', (e) => { if (mmDrag) mmCenterTo(e); });
minimapView.addEventListener('pointerup', () => { mmDrag = false; });
minimapView.addEventListener('pointercancel', () => { mmDrag = false; });
// 点击总览图空白处也可跳转
minimapImgEl.addEventListener('pointerdown', (e) => { mmCenterTo(e); e.preventDefault(); });

// 图源加载完成（缩略图→全尺寸会触发两次）：重新按真实尺寸初始化
viewerImg.addEventListener('load', () => {
  if (!$('viewer').classList.contains('hidden')) setupMinimap();
});

// ─── L233：竖排缩放控制条（停靠在总览区旁，悬浮显示） ───
const IMG_ZOOM_MIN = 0.2, IMG_ZOOM_MAX = 12;
const zoomToRange = (z) => Math.round(Math.log(z / IMG_ZOOM_MIN) / Math.log(IMG_ZOOM_MAX / IMG_ZOOM_MIN) * 100);
const rangeToZoom = (v) => IMG_ZOOM_MIN * Math.pow(IMG_ZOOM_MAX / IMG_ZOOM_MIN, v / 100);
/** 以舞台中心为锚点缩放（按钮用） */
function zoomImageCenter(factor) {
  const r = $('viewerStage').getBoundingClientRect();
  zoomImageAt({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, factor);
}
/** 直接设定缩放（以舞台中心为锚，保留旋转/翻转） */
function setImageZoom(nz) {
  nz = Math.min(IMG_ZOOM_MAX, Math.max(IMG_ZOOM_MIN, nz));
  const z = imgTransform.zoom || 1;
  imgTransform.tx *= nz / z;
  imgTransform.ty *= nz / z;
  imgTransform.zoom = nz;
  applyImageTransform();
}
$('imgZoomIn').addEventListener('click', () => zoomImageCenter(1.2));
$('imgZoomOut').addEventListener('click', () => zoomImageCenter(1 / 1.2));
$('imgZoomReset').addEventListener('click', () => {
  // 仅复位缩放/平移，保留旋转与翻转
  imgTransform.zoom = 1; imgTransform.tx = 0; imgTransform.ty = 0;
  applyImageTransform();
});
$('imgZoomRange').addEventListener('input', (e) => setImageZoom(rangeToZoom(Number(e.target.value))));

// ─── L234：图片模式按住右键，上滑放大、下滑缩小（单击右键仍弹菜单） ───
let rzActive = false;   // 右键按下中
let rzMoved = false;    // 已产生纵向缩放位移（用于抑制本次右键菜单）
let rzX = 0, rzY = 0, rzAcc = 0;
viewerImg.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || $('viewer').classList.contains('hidden')) return;
  rzActive = true; rzMoved = false;
  rzX = e.clientX; rzY = e.clientY; rzAcc = 0;
  try { viewerImg.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  e.preventDefault();
});
viewerImg.addEventListener('pointermove', (e) => {
  if (!rzActive) return;
  rzAcc += rzY - e.clientY; // 向上滑累积为正
  rzX = e.clientX; rzY = e.clientY;
  let steps = 0;
  while (Math.abs(rzAcc) >= 10 && steps < 20) {
    const up = rzAcc > 0;
    rzAcc += up ? -10 : 10;
    rzMoved = true;
    zoomImageAt({ clientX: rzX, clientY: rzY }, up ? 1.07 : 1 / 1.07);
    steps++;
  }
});
const endRz = (e) => {
  if (!rzActive) return;
  rzActive = false;
  try { viewerImg.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  // contextmenu 在 pointerup 之后、本轮宏任务结束前派发：延迟清标志让菜单判定先跑完
  if (rzMoved) setTimeout(() => { rzMoved = false; }, 0);
};
viewerImg.addEventListener('pointerup', endRz);
viewerImg.addEventListener('pointercancel', endRz);


// L84：预览器悬浮 UI 分区控制——控制条 / 图片箭头 / 顶部关闭按钮均为「悬浮出现，离开消失」
// L90：鼠标离开热区后 1 秒消失（带缓动）；切换文件不唤醒（openViewer quiet 参数）
let videoBarTimer = null;
let sideArrowTimer = null;
let topFloatTimer = null;
let viewerWakePending = false; // 首次打开时为 true：videoBar 结构未就绪，待 revealVideoBar 补闪

function showVideoBar() {
  const bar = $('videoBar');
  if (bar.classList.contains('hidden')) return;
  bar.classList.add('viewer-show');
  clearTimeout(videoBarTimer);
}
function hideVideoBarSoon(ms = 1000) {
  clearTimeout(videoBarTimer);
  videoBarTimer = setTimeout(() => {
    const bar = $('videoBar');
    const videoMode = !$('viewerVideo').classList.contains('hidden') || mpvPlaying;
    const paused = mpvPlaying ? $('videoPlay').innerHTML === ICO_PLAY : vVideo.paused;
    if (bar.matches(':hover')) return;   // 悬浮在控制条上保持显示
    if (videoMode && paused) return;     // 暂停时常显
    bar.classList.remove('viewer-show');
  }, ms);
}
function showViewerTop() {
  $('viewerTopFloat').classList.add('viewer-show');
  clearTimeout(topFloatTimer);
}
function hideViewerTopSoon(ms = 1000) {   // L90：离开热区 1 秒消失
  clearTimeout(topFloatTimer);
  topFloatTimer = setTimeout(() => {
    if (!$('viewerTopFloat').matches(':hover')) $('viewerTopFloat').classList.remove('viewer-show');
  }, ms);
}
function showSideArrows() {
  document.querySelectorAll('#viewer .viewer-side-arrow').forEach((el) => el.classList.add('viewer-show'));
  clearTimeout(sideArrowTimer);
}
function hideSideArrowsSoon(ms = 1000) {   // L90：图片切换箭头离开 1 秒消失（缓动由 CSS transition 提供）
  clearTimeout(sideArrowTimer);
  sideArrowTimer = setTimeout(() => {
    document.querySelectorAll('#viewer .viewer-side-arrow').forEach((el) => {
      if (!el.matches(':hover')) el.classList.remove('viewer-show');
    });
  }, ms);
}

// ─── L99：预览器右侧悬浮播放列表（鼠标靠近右边缘显示，移出 1 秒缓动消失） ───
let vpFilter = localStorage.getItem('viewerPlaylistFilter') || 'all'; // all | video | image（记录状态）
let vpTimer = null;
let vpSig = ''; // 渲染签名：结构变化才重建列表，避免 mousemove 高频重绘
const VP_ICO = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="14" height="16" rx="2"/><path d="M16 10l6-3v10l-6-3"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
};
function vpItems() {
  return state.filtered
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => (it.kind === 'video' || it.kind === 'image') && (vpFilter === 'all' || it.kind === vpFilter));
}
function renderViewerPlaylist() {
  document.querySelectorAll('#vpTabs .vp-tab').forEach((b) => b.classList.toggle('on', b.dataset.vp === vpFilter));
  const list = $('vpList');
  list.innerHTML = vpItems().map(({ it, idx }) =>
    `<div class="vp-item${idx === state.viewerIndex ? ' active' : ''}" data-idx="${idx}" title="${escapeHtml(it.name)}">` +
    `<span class="vp-ico">${VP_ICO[it.kind]}</span><span class="vp-name">${escapeHtml(it.name)}</span></div>`
  ).join('');
  list.querySelector('.vp-item.active')?.scrollIntoView({ block: 'nearest' });
}
function showViewerPlaylist() {
  const sig = `${vpFilter}|${state.viewerIndex}|${state.filtered.length}`;
  if (sig !== vpSig) { vpSig = sig; renderViewerPlaylist(); }
  $('viewerPlaylist').classList.add('viewer-show');
  clearTimeout(vpTimer);
}
function hideViewerPlaylistSoon(ms = 300) { // L109：离开后 300ms 内消失
  clearTimeout(vpTimer);
  vpTimer = setTimeout(() => {
    if (!$('viewerPlaylist').matches(':hover')) $('viewerPlaylist').classList.remove('viewer-show');
  }, ms);
}
/** 切换文件时同步高亮当前项（面板可见才重渲染） */
function vpMarkActive() {
  vpSig = ''; // 下次显示时强制重建
  const pl = $('viewerPlaylist');
  if (pl.classList.contains('viewer-show')) renderViewerPlaylist();
}
$('vpTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.vp-tab');
  if (!b) return;
  vpFilter = b.dataset.vp;
  localStorage.setItem('viewerPlaylistFilter', vpFilter);
  vpSig = '';
  renderViewerPlaylist();
});
$('vpList').addEventListener('click', (e) => {
  const row = e.target.closest('.vp-item');
  if (!row) return;
  openViewer(Number(row.dataset.idx), true);
});

/** 打开预览 / 暂停等时机：短暂亮出悬浮控件，随后各自按节奏消失 */
function wakeViewerUI() {
  showViewerTop(); hideViewerTopSoon(1200);
  showVideoBar(); hideVideoBarSoon(1600);
}

$('viewer').addEventListener('mousemove', (e) => {
  const h = window.innerHeight, w = window.innerWidth;
  // 顶部 56px 热区：关闭按钮
  if (e.clientY <= 56) showViewerTop(); else hideViewerTopSoon();
  // 底部 160px 热区：播放控制条
  const videoMode = !$('viewerVideo').classList.contains('hidden') || mpvPlaying;
  if (videoMode) { if (e.clientY >= h - 160) showVideoBar(); else hideVideoBarSoon(); }
  // L99：右侧边缘 40px 热区 → 播放列表
  if (e.clientX >= w - 40) showViewerPlaylist(); else hideViewerPlaylistSoon();
});

// L232：不再监听 pause/play 事件弹控制条——openViewer 切文件时的 pause()/autoplay
// 会误触发，导致切换文件控制条自动弹出。用户主动暂停/播放改由 toggleVideoPlay 显式亮条，
// 暂停时常显由 hideVideoBarSoon（videoMode && paused）保证。
bindVideoBar();

// L62：控制条按钮开关顶部文件名显示（默认不显示）；L153：状态记忆
let viewerShowTitle = localStorage.getItem('viewerShowTitle') === '1';
$('videoTitleToggle').classList.toggle('active', viewerShowTitle);
$('viewerTitle').classList.toggle('hidden', !viewerShowTitle);
$('videoTitleToggle').addEventListener('click', () => {
  viewerShowTitle = !viewerShowTitle;
  localStorage.setItem('viewerShowTitle', viewerShowTitle ? '1' : '0'); // L153
  $('viewerTitle').classList.toggle('hidden', !viewerShowTitle);
  $('videoTitleToggle').classList.toggle('active', viewerShowTitle);
  if (viewerShowTitle) showViewerTop();
});

// ─── L152：解码信息悬浮层（帧率/编码/码率等）；L153：状态记忆 ───
let viewerShowInfo = localStorage.getItem('viewerShowInfo') === '1';
$('videoInfo').classList.toggle('active', viewerShowInfo);
$('videoInfo').addEventListener('click', () => {
  viewerShowInfo = !viewerShowInfo;
  localStorage.setItem('viewerShowInfo', viewerShowInfo ? '1' : '0'); // L153
  $('videoInfo').classList.toggle('active', viewerShowInfo);
  if (viewerShowInfo) updateVideoInfoPanel();
  else $('videoInfoPanel').classList.add('hidden');
});

/** 读取当前预览项的解码信息并渲染悬浮层 */
async function updateVideoInfoPanel() {
  const panel = $('videoInfoPanel');
  if (!viewerShowInfo) { panel.classList.add('hidden'); return; }
  const path = viewerItemPath();
  const item = state.filtered[state.viewerIndex];
  if (!path || !item || (item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'image')) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="opacity-60">读取中…</div>';
  const myPath = path;
  try {
    const p = await invoke('get_media_props', { path, kind: item.kind });
    if (viewerItemPath() !== myPath || !viewerShowInfo) return; // 已切换文件
    const rows = [];
    rows.push(['引擎', mpvPlaying ? 'mpv（原生渲染）' : 'HTML5 video']);
    if (p.videoCodec) rows.push(['视频编码', p.videoCodec]);
    if (p.audioCodec) rows.push(['音频编码', p.audioCodec]);
    if (p.width && p.height) rows.push(['分辨率', `${p.width} × ${p.height}`]);
    if (p.frameRate) rows.push(['帧率', p.frameRate]);
    const br = p.bitrate ? parseFloat(p.bitrate) : 0;
    if (br) rows.push(['码率', `${Math.round(br)} kbps`]);
    if (p.duration != null) rows.push(['时长', fmtDur(p.duration)]);
    rows.push(['大小', fmtSize(p.size)]);
    panel.innerHTML = rows.map(([k, v]) =>
      `<div class="vi-row"><span class="vi-k">${k}</span><span class="vi-v">${escapeHtml(String(v))}</span></div>`
    ).join('');
    // L199：实时数据（实测帧率/丢帧，HTML5 播放时每秒刷新）
    if (!mpvPlaying && item.kind === 'video') startInfoLiveTicker();
    else stopInfoLiveTicker();
  } catch (e) {
    panel.innerHTML = `<div class="opacity-60">${escapeHtml(String(e))}</div>`;
  }
}

// L199：实时解码数据刷新器（totalVideoFrames 差值 = 实测帧率）
let infoLiveTimer = 0;
function startInfoLiveTicker() {
  stopInfoLiveTicker();
  const panel = $('videoInfoPanel');
  const v = $('viewerVideo');
  if (!v || typeof v.getVideoPlaybackQuality !== 'function') return;
  let lastFrames = v.getVideoPlaybackQuality().totalVideoFrames;
  infoLiveTimer = setInterval(() => {
    if (!viewerShowInfo || !panel.isConnected || panel.classList.contains('hidden')) {
      stopInfoLiveTicker();
      return;
    }
    const q = v.getVideoPlaybackQuality();
    const fps = q.totalVideoFrames - lastFrames;
    lastFrames = q.totalVideoFrames;
    if (!panel.querySelector('[data-live-fps]')) {
      panel.insertAdjacentHTML('beforeend',
        '<div class="vi-row"><span class="vi-k">实测帧率</span><span class="vi-v" data-live-fps></span></div>' +
        '<div class="vi-row"><span class="vi-k">累计丢帧</span><span class="vi-v" data-live-drop></span></div>');
    }
    panel.querySelector('[data-live-fps]').textContent = fps + ' fps';
    panel.querySelector('[data-live-drop]').textContent = String(q.droppedVideoFrames);
  }, 1000);
}
function stopInfoLiveTicker() {
  if (infoLiveTimer) { clearInterval(infoLiveTimer); infoLiveTimer = 0; }
}

// ═══════════════ 目录树（磁盘即树根） / 收藏 ═══════════════

// ═══════════════ L43：常用目录快捷入口（音乐/图片/视频/文档/下载） ═══════════════
const QUICK_ICONS = {
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  pictures: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  videos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
  documents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></svg>',
  downloads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 21h16"/></svg>',
};

let quickDirsData = [];

async function renderQuickDirs() {
  const box = $('quickDirs');
  try {
    quickDirsData = await invoke('list_quick_dirs');
  } catch {
    quickDirsData = [];
  }
  if (!quickDirsData.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = quickDirsData.map((d) => `
    <button class="quick-dir" data-qd="${escapeAttr(d.path)}"
            title="${escapeAttr(d.name)} · ${escapeAttr(d.path)}">
      ${QUICK_ICONS[d.key] || QUICK_ICONS.documents}
    </button>`).join('');
  updateQuickDirActive();
}

$('quickDirs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-qd]');
  if (btn) openDirectory(btn.dataset.qd);
});

/** 高亮当前目录对应的快捷入口 */
function updateQuickDirActive() {
  document.querySelectorAll('#quickDirs [data-qd]').forEach((b) => {
    b.classList.toggle('active', b.dataset.qd === state.currentDir);
  });
}

// L318-10/L337：收藏夹单列/双列切换 + 收起/展开
let favColsMode = localStorage.getItem('favColsMode') || '1';
let favCollapsed = localStorage.getItem('favCollapsed') === '1';
function renderFavorites() {
  const favs = state.cfg?.favorites ?? [];
  // L69：侧栏收藏用实心黄色文件夹图标
  const FOLDER_ICO = `<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24"><path fill="#facc15" stroke="#eab308" stroke-width="0.6" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  const list = $('favList');
  if (list) {
    list.classList.toggle('cols-2', favColsMode === '2');
    list.classList.toggle('collapsed', favCollapsed);
  }
  const arrow = $('favArrow');
  if (arrow) arrow.textContent = favCollapsed ? '▸' : '▾';
  $('favList').innerHTML = favs.length
    ? favs.map((p) => {
        const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
        return `<div class="tree-node group" data-fav="${escapeAttr(p)}">
          <span class="arrow">${FOLDER_ICO}</span>
          <span class="truncate flex-1" title="${escapeHtml(p)}">${escapeHtml(name)}</span>
          <button data-favdel="${escapeAttr(p)}" title="移除收藏"
            class="hidden group-hover:inline text-xs opacity-60 hover:opacity-100 hover:text-red-400">✕</button>
        </div>`;
      }).join('')
    : `<div class="px-2 py-1 text-xs opacity-40">（暂无收藏，点击上方「♥ 收藏」）</div>`;
}

$('favColsBtn')?.addEventListener('click', () => {
  favColsMode = favColsMode === '1' ? '2' : '1';
  localStorage.setItem('favColsMode', favColsMode);
  renderFavorites();
});
// L337：点击「收藏文件夹」标题收起/展开
$('favToggle')?.addEventListener('click', () => {
  favCollapsed = !favCollapsed;
  localStorage.setItem('favCollapsed', favCollapsed ? '1' : '0');
  renderFavorites();
});

// ═══════════════ L71-74/L88：集锦箱（收藏的文件） ═══════════════
// L88：5 个独立集锦箱列表，编号 1-5 按钮切换；每个列表存本地文件 box{idx}.json
let collectionCollapsed = localStorage.getItem('collectionCollapsed') === '1';
let collectionView = localStorage.getItem('collectionView') || 'list'; // list | icons
let collectionIdx = Math.min(5, Math.max(1, Number(localStorage.getItem('collectionIdx')) || 1));
let collectionPaths = []; // 当前编号集锦箱的路径列表（内存镜像）

/** 从本地文件读取当前编号集锦箱 */
async function loadCollectionBox() {
  try {
    const list = await invoke('read_collection_box', { idx: collectionIdx });
    collectionPaths = Array.isArray(list) ? list : [];
  } catch (e) {
    collectionPaths = [];
    setStatus(String(e), true);
  }
}

/** 把当前编号集锦箱写回本地文件 */
function saveCollectionBox() {
  invoke('write_collection_box', { idx: collectionIdx, paths: [...collectionPaths] })
    .catch((e) => setStatus(String(e), true));
}

/** 切换集锦箱编号：重读该编号列表；集锦箱模式下同步刷新文件区 */
async function setCollectionIdx(i) {
  if (i === collectionIdx) return;
  collectionIdx = i;
  localStorage.setItem('collectionIdx', String(i));
  await loadCollectionBox();
  renderCollection();
  if (state.collectionMode) enterCollectionMode(); // 视图跟随新编号
}

// L318-4/5：读取 / 写入指定编号集锦箱（不切换当前编号）
async function readBox(idx) {
  try { const list = await invoke('read_collection_box', { idx }); return Array.isArray(list) ? list : []; }
  catch { return []; }
}
function writeBox(idx, paths) {
  return invoke('write_collection_box', { idx, paths: [...paths] }).catch((e) => setStatus(String(e), true));
}

/** L318-4：把选中文件复制到目标编号集锦箱（保留在当前箱） */
async function copyToBox(paths, targetIdx) {
  if (!paths.length) return;
  const target = await readBox(targetIdx);
  let added = 0;
  paths.forEach((p) => { if (!target.includes(p)) { target.push(p); added++; } });
  await writeBox(targetIdx, target);
  if (targetIdx === collectionIdx) { collectionPaths = target; renderCollection(); if (state.collectionMode) refreshCollectionMode(); }
  setStatus(added ? `已复制 ${added} 项到 ${targetIdx} 号集锦箱` : `${targetIdx} 号集锦箱已包含这些项`);
}

/** L318-4：把选中文件移动到目标编号集锦箱（从当前箱移除） */
async function moveToBox(paths, targetIdx) {
  if (!paths.length) return;
  // 加入目标箱
  const target = await readBox(targetIdx);
  paths.forEach((p) => { if (!target.includes(p)) target.push(p); });
  await writeBox(targetIdx, target);
  // 从当前箱移除
  paths.forEach((p) => {
    const i = collectionPaths.indexOf(p);
    if (i >= 0) collectionPaths.splice(i, 1);
  });
  saveCollectionBox();
  renderCollection();
  if (targetIdx === collectionIdx) collectionPaths = target;
  if (state.collectionMode) refreshCollectionMode();
  setStatus(`已移动 ${paths.length} 项到 ${targetIdx} 号集锦箱`);
}

function renderCollection() {
  const list = $('collectionList');
  if (!list) return;
  const paths = collectionPaths;
  list.classList.toggle('collapsed', collectionCollapsed);
  list.classList.toggle('icon-mode', collectionView === 'icons');
  const arrow = $('collectionArrow');
  if (arrow) arrow.textContent = collectionCollapsed ? '▸' : '▾';
  // L88：编号按钮选中态
  const tabs = $('collectionTabs');
  if (tabs) [...tabs.children].forEach((b, i) => b.classList.toggle('on', i + 1 === collectionIdx));
  if (!paths.length) {
    list.innerHTML = '<div class="px-2 py-1 text-xs opacity-40">（右键媒体「加入集锦箱」）</div>';
    return;
  }
  list.innerHTML = paths.map((p) => {
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    return `<div class="collection-item" data-col="${escapeAttr(p)}" title="${escapeAttr(p)}">
      ${kindIcon(kindOf(p))}<span class="ci-name">${escapeHtml(name)}</span>
    </div>`;
  }).join('');
}

/** 集锦箱模式下刷新文件区（不移出模式）：按当前编号列表重新取元数据 */
async function refreshCollectionMode() {
  try {
    state.items = await invoke('stat_items', { paths: [...collectionPaths] });
  } catch (e) {
    setStatus(String(e), true);
  }
  resetSelection();
  renderBreadcrumb();
  applyFilter();
}

function toggleCollect(path) {
  const i = collectionPaths.indexOf(path);
  if (i >= 0) {
    collectionPaths.splice(i, 1);
    setStatus('已移出集锦箱');
    if (state.collectionMode) refreshCollectionMode(); // L88：移出后刷新但不退出模式
  } else {
    collectionPaths.push(path);
    setStatus(`已加入集锦箱 ${collectionIdx} 号`);
  }
  renderCollection();
  saveCollectionBox();
}

/** 进入/退出集锦箱模式：文件区显示当前编号收藏的文件 */
async function enterCollectionMode() {
  if (!collectionPaths.length) { setStatus(`集锦箱 ${collectionIdx} 号为空（右键媒体加入）`, true); return; }
  state.collectionMode = true;
  syncCollectionModeBtn();
  setStatus(`集锦箱模式 · ${collectionIdx} 号箱`);
  await refreshCollectionMode();
}

/** L318-3：集锦箱进入按钮的点亮/线框态同步 */
function syncCollectionModeBtn() {
  $('collectionModeBtn')?.classList.toggle('on', state.collectionMode);
}

$('collectionToggle')?.addEventListener('click', () => {
  collectionCollapsed = !collectionCollapsed;
  localStorage.setItem('collectionCollapsed', collectionCollapsed ? '1' : '0');
  renderCollection();
});
$('collectionViewBtn')?.addEventListener('click', () => {
  collectionView = collectionView === 'list' ? 'icons' : 'list';
  localStorage.setItem('collectionView', collectionView);
  renderCollection();
});
$('collectionModeBtn')?.addEventListener('click', () => {
  if (state.collectionMode && state.currentDir) openDirectory(state.currentDir); // 再点退出
  else enterCollectionMode();
});
// L88：集锦箱编号按钮 1-5
$('collectionTabs')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-box]');
  if (b) setCollectionIdx(Number(b.dataset.box));
});

/** 目录树：顶层 = 所有磁盘（不再单独占一个「磁盘」分区），逐级懒加载子目录 */
async function renderTree() {
  const tree = $('folderTree');
  tree.innerHTML = '';
  let drives = [];
  try { drives = await invoke('list_drives'); } catch { /* 忽略 */ }
  for (const d of drives) {
    const node = makeTreeNode(d.name, d.path, 0, 0, true);
    tree.appendChild(node);
    if (state.treeState.has(d.path)) await expandTreeNode(node, 1);
  }
}

/** 建一个树节点元素（子层容器由 expandTreeNode 作为兄弟节点插入）
 *  isDrive: 磁盘根节点，显示磁盘图标
 *  子文件夹数量不在此处显示 —— L68：仅展开的节点才显示，由 loadChildren 回填 */
function makeTreeNode(name, path, depth, count = 0, isDrive = false) {
  const el = document.createElement('div');
  el.className = 'tree-node' + (path === state.currentDir ? ' active' : '');
  el.dataset.path = path;
  el.draggable = true; // 支持拖到收藏区
  const driveIco = isDrive
    ? `<svg class="w-3.5 h-3.5 shrink-0 opacity-70 mr-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="17" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M5 12h6"/></svg>` : '';
  // L229/L253：磁盘根节点名称后追加盘符（统一关键色，样式在 CSS）
  const driveLetter = isDrive
    ? `<span class="tree-drive-letter">${path.slice(0, 2)}</span>` : '';
  // L230/L254：非磁盘节点提供「穿透」按钮（雷达扫描图标，表示搜索全部子目录）
  const penetrateBtn = isDrive ? '' : `
    <button class="tree-penetrate" data-penetrate="1" title="穿透扫描（递归该目录及全部子目录的文件）">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8.5"/>
        <circle cx="11" cy="11" r="5"/>
        <path d="M11 11l6-6"/>
        <circle cx="11" cy="11" r="1.3" fill="currentColor" stroke="none"/>
        <circle cx="14.7" cy="7.3" r="1" fill="currentColor" stroke="none"/>
      </svg>
    </button>`;
  el.innerHTML = `
    <span class="arrow">${state.treeState.has(path) ? '▾' : '▸'}</span>${driveIco}
    <span class="truncate">${escapeHtml(name)}</span>${driveLetter}<span class="tree-count opacity-50 text-xs ml-1 shrink-0"></span>${penetrateBtn}`;
  el.style.paddingLeft = depth * 14 + 6 + 'px';
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-folder', path);
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'copy';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

/** L53/L68：展开的节点名称后括号追加子文件夹数量（仅展开时） */
function setTreeNodeCount(path, n) {
  if (state.cfg?.treeFolderCount === false) return;
  const node = document.querySelector(`#folderTree .tree-node[data-path="${cssEscape(path)}"]`);
  const span = node?.querySelector('.tree-count');
  if (span) span.textContent = n > 0 ? `(${n})` : '';
}

/** 节点对应的子层容器（结构约定：紧跟其后的兄弟节点） */
function kidsOf(node) {
  const next = node.nextElementSibling;
  return next && next.dataset.children === node.dataset.path ? next : null;
}

/** 展开节点：插入子层容器并加载子目录（必须是兄弟节点，作为子节点会被 flex 排成一行） */
async function expandTreeNode(node, depth) {
  const path = node.dataset.path;
  state.treeState.add(path);
  const arrow = node.querySelector('.arrow');
  if (arrow) arrow.textContent = '▾';
  let kids = kidsOf(node);
  if (!kids) {
    kids = document.createElement('div');
    kids.dataset.children = path;
    node.after(kids);
  }
  await loadChildren(path, kids, depth);
  return kids;
}

/** 收起节点 */
function collapseTreeNode(node) {
  const path = node.dataset.path;
  state.treeState.delete(path);
  const arrow = node.querySelector('.arrow');
  if (arrow) arrow.textContent = '▸';
  const cnt = node.querySelector('.tree-count');
  if (cnt) cnt.textContent = ''; // L68：收起后不再显示数量
  kidsOf(node)?.remove();
}

function treeSetActive(node) {
  document.querySelectorAll('#folderTree .tree-node.active').forEach((n) => n.classList.remove('active'));
  node.classList.add('active');
  // L229/L230：标题行磁盘提示 + 穿透按钮点亮态随选中节点刷新
  updateTreeDriveHint(node.dataset.path);
  syncPenetrateButtons();
}

// ─── L229/L253：目录树标题行显示选中目录所属磁盘「卷标 + 盘符」 ───
function updateTreeDriveHint(dir) {
  const el = $('treeDriveHint');
  if (!el) return;
  if (!dir || !/^[A-Za-z]:/.test(dir)) { el.innerHTML = ''; return; }
  const letter = dir.slice(0, 1).toUpperCase();
  const label = driveLabels[letter] || '';
  el.innerHTML = (label ? `<span class="tdh-label">${escapeHtml(label)}</span>` : '')
    + `<span class="tdh-letter">${letter}:</span>`;
}

// ─── L230：穿透按钮点亮态 ───
function syncPenetrateButtons() {
  document.querySelectorAll('#folderTree .tree-penetrate').forEach((b) => {
    const nodePath = b.closest('.tree-node')?.dataset.path;
    b.classList.toggle('on', !!state.penetrate && nodePath === state.penetrate);
  });
}

/** 切换某目录的穿透扫描：同目录再点一次退出；不同目录则直接穿透打开 */
function togglePenetrate(path) {
  if (state.penetrate === path && state.currentDir === path) {
    openDirectory(path); // 退出穿透，回到单层
  } else {
    openDirectory(path, { deep: true });
  }
}

/** 目录树按文件区当前位置自动定位：逐级展开、选中并滚动到可见 */
async function revealInTree(dir) {
  if (!dir) return;
  const tree = $('folderTree');
  const drive = dir.slice(0, 3); // 形如 "D:\"
  let node = tree.querySelector(`.tree-node[data-path="${cssEscape(drive)}"]`);
  if (!node) {
    state.treeState.add(drive);
    await renderTree();
    node = tree.querySelector(`.tree-node[data-path="${cssEscape(drive)}"]`);
    if (!node) return;
  }
  const parts = dir.split(/[\\/]/).filter(Boolean).slice(1); // 去掉盘符
  let cur = drive;
  let depth = 1;
  for (const part of parts) {
    cur = cur.endsWith('\\') ? cur + part : `${cur}\\${part}`;
    const kids = kidsOf(node) ?? (await expandTreeNode(node, depth));
    const next = kids.querySelector(`.tree-node[data-path="${cssEscape(cur)}"]`);
    if (!next) return; // 该层未列出（无权限等）
    node = next;
    depth++;
  }
  treeSetActive(node);
  node.scrollIntoView({ block: 'nearest' });
  // L42：选中目录自动展开其下级目录树（一层；已展开则保留不重复加载）
  // L333：用户刚主动收起的目录不自动再展开
  const justCollapsed = treeCollapsedByUser === dir;
  treeCollapsedByUser = null;
  if (!kidsOf(node) && !justCollapsed) {
    await expandTreeNode(node, depth);
  }
}

// ─── 收藏区：接收拖入的目录 ───
(() => {
  const fav = $('favList');
  fav.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-folder')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      fav.classList.add('drag-over');
    }
  });
  fav.addEventListener('dragleave', () => fav.classList.remove('drag-over'));
  fav.addEventListener('drop', (e) => {
    e.preventDefault();
    fav.classList.remove('drag-over');
    const dir = e.dataTransfer.getData('application/x-folder') || e.dataTransfer.getData('text/plain');
    if (dir && addFavorite(dir)) setStatus(`已收藏：${dir}`);
  });
})();

/** L336：目录树文件夹过滤——默认隐藏系统文件夹；隐藏文件夹需手动开启显示 */
function treeVisibleSubs(subs) {
  const hideSystem = state.cfg?.treeHideSystem !== false; // 默认 true
  const showHidden = state.cfg?.treeShowHidden === true;   // 默认 false
  return subs.filter((s) => {
    if (s.system && hideSystem) return false;
    if (s.hidden && !showHidden) return false;
    return true;
  });
}

async function loadChildren(path, container, depth) {
  try {
    const subsAll = await invoke('list_subfolders', { path });
    const subs = treeVisibleSubs(subsAll);
    setTreeNodeCount(path, subs.length); // L68：数量只对已展开节点显示
    if (subs.length === 0) {
      container.innerHTML = `<div class="text-xs opacity-40" style="padding-left:${depth * 14 + 24}px">（空）</div>`;
      return;
    }
    container.replaceChildren(...subs.map((s) => makeTreeNode(s.name, s.path, depth)));
  } catch {
    container.innerHTML = `<div class="text-xs opacity-40">加载失败</div>`;
  }
}


// 侧边栏事件委托：收藏 / 目录树（磁盘已并入树根）
/** L333：用户刚在树中主动收起的目录路径（阻止 revealInTree 立刻再展开） */
let treeCollapsedByUser = null;
$('sidebar').addEventListener('click', async (e) => {
  // 移除收藏
  const del = e.target.closest('[data-favdel]');
  if (del) {
    state.cfg.favorites = (state.cfg.favorites ?? []).filter((p) => p !== del.dataset.favdel);
    renderFavorites();
    saveCfg();
    return;
  }
  // 收藏夹切换
  const fav = e.target.closest('[data-fav]');
  if (fav) { openDirectory(fav.dataset.fav); return; }
  // 集锦箱：点击定位到文件所在目录并选中（L73）
  const col = e.target.closest('[data-col]');
  if (col) {
    const p = col.dataset.col;
    const dir = p.replace(/[\\/][^\\/]+$/, '');
    state.pendingReveal = p;
    if (dir === state.currentDir) { // 已在该目录：直接选中
      const i = state.filtered.findIndex((x) => x.path === p);
      if (i >= 0) { select(i); state.pendingReveal = null; }
    } else {
      openDirectory(dir);
    }
    return;
  }
  // 目录树
  const node = e.target.closest('#folderTree .tree-node[data-path]');
  if (!node) return;
  const path = node.dataset.path;
  // L230：穿透按钮（不触发展开/打开目录）
  if (e.target.closest('[data-penetrate]')) {
    e.stopPropagation();
    togglePenetrate(path);
    return;
  }
  // L318-1/L333：单击目录节点（箭头或名称）在展开/收起之间切换，同时打开该目录
  const isExpanded = state.treeState.has(path);
  if (isExpanded) {
    // 标记为用户主动收起：openDirectory→revealInTree 的自动展开（L42）跳过该节点，
    // 否则收起后立刻被重新展开，表现为"只会展开"
    treeCollapsedByUser = path;
    collapseTreeNode(node);
  } else {
    treeCollapsedByUser = null;
    const depth = Math.max(0, Math.round((parseInt(node.style.paddingLeft) - 6) / 14)) + 1;
    await expandTreeNode(node, depth);
  }
  treeSetActive(node);
  openDirectory(path);
});

// L318-1：点击「目录树」标题直接收起整个目录树
$('treeTitle')?.addEventListener('click', () => {
  document.querySelectorAll('#folderTree .tree-node[data-path]').forEach((n) => collapseTreeNode(n));
});


// ═══════════════ 面包屑 / 地址栏 ═══════════════
// L148：盘符 → 卷标 缓存（面包屑首段显示卷标；输入时输入框内只显示原始路径）
let driveLabels = {};
invoke('list_drives').then((ds) => {
  ds.forEach((d) => { driveLabels[d.path.replace(/[\\/]+$/, '').toUpperCase()] = d.name; });
  renderBreadcrumb(); // 卷标到达后刷新一次首段显示
  updateTreeDriveHint(state.currentDir); // L229：标题行磁盘提示同步
}).catch(() => {});

function renderBreadcrumb() {
  // 编辑中不被重渲染打断（L148：失焦不取消，回车才跳转）
  if (addrEditing) return;
  // L194：地址栏首页段改为图标按钮（可点击跳转回首页）
  const HOME_ICO = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>';
  const homeBtn = `<button data-home="1" title="首页" class="crumb-home">${HOME_ICO}</button>`;
  if (!state.currentDir) {
    $('breadcrumb').innerHTML = homeBtn +
      '<span class="opacity-30 text-[11px] pl-1">点击空白处输入地址，回车跳转</span>';
    return;
  }
  const parts = state.currentDir.split(/[\\/]/).filter(Boolean);
  let acc = '';
  $('breadcrumb').innerHTML = homeBtn + '<span class="opacity-30">›</span>' + parts
    .map((p, i) => {
      acc = acc ? `${acc}\\${p}` : `${p}\\`;
      // L148：首段盘符显示卷标（如"本地磁盘 (C:)"）
      let label = p;
      if (i === 0 && /^[A-Za-z]:$/.test(p)) {
        const vol = driveLabels[p.toUpperCase()];
        if (vol) label = `${vol} (${p})`;
      }
      return `<button data-crumb="${escapeAttr(acc)}" class="px-1.5 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 whitespace-nowrap">${escapeHtml(label)}</button>${i < parts.length - 1 ? '<span class="opacity-30">›</span>' : ''}`;
    })
    .join('');
}

$('breadcrumb').addEventListener('click', (e) => {
  // L194：首页图标点击跳转
  if (e.target.closest('[data-home]')) { showHomeTab(); return; }
  const b = e.target.closest('[data-crumb]');
  if (b) { openDirectory(b.dataset.crumb); return; }
  // L143：点击地址栏空白处 → 可输入地址
  startAddrEdit();
});

let addrEditing = false;
// L195：点击地址栏以外的任何区域 → 失焦并退出编辑，回到可点击的面包屑状态
document.addEventListener('mousedown', (e) => {
  if (!addrEditing) return;
  if (e.target.closest('#breadcrumb')) return;
  addrEditing = false;
  renderBreadcrumb();
}, true);
/** L143/L148：面包屑就地变成输入框；回车跳转，Esc 取消；失焦不取消（仍可回车跳转） */
function startAddrEdit() {
  if (addrEditing) return;
  addrEditing = true;
  const bar = $('breadcrumb');
  bar.innerHTML = '';
  const input = document.createElement('input');
  input.id = 'addrInput';
  input.value = state.currentDir ?? ''; // 输入时隐藏卷标，只给原始路径
  input.placeholder = '输入地址，回车跳转';
  input.spellcheck = false;
  bar.appendChild(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 不触发全局快捷键
    if (e.key === 'Enter') {
      const v = input.value.trim();
      addrEditing = false;
      if (v) openDirectory(v); // openDirectory 成功后 renderBreadcrumb 刷新
      else renderBreadcrumb();
    } else if (e.key === 'Escape') {
      addrEditing = false;
      renderBreadcrumb();
    }
  });
}

// ═══════════════ 文件区标签页（每个标签 = 一个目录） ═══════════════
const tabName = (p) => p == null ? '首页' : (p.split(/[\\/]/).filter(Boolean).pop() || p);

function renderTabs() {
  const list = $('tabList');
  list.innerHTML = state.tabs.map((p, i) => `
    <div class="tab-item${i === state.activeTab ? ' active' : ''}" data-tab="${i}" title="${escapeAttr(p ?? '空白首页')}">
      <span class="tab-name">${escapeHtml(tabName(p))}</span>
      <span class="tab-close" data-tabclose="${i}" title="关闭标签页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:10px;height:10px"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </span>
    </div>`).join('');
  list.querySelector('.tab-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

$('tabList').addEventListener('click', (e) => {
  const close = e.target.closest('[data-tabclose]');
  if (close) { closeTab(Number(close.dataset.tabclose)); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) activateTab(Number(tab.dataset.tab));
});

$('btnNewTab').addEventListener('click', newTab);

/** L79：新建标签页 —— 直接创建空白首页（欢迎空态），不再弹目录选择框 */
function newTab() {
  state.tabs.push(null);
  setActiveTab(state.tabs.length - 1);
  showHomeTab();
}

/** 空白首页：清空当前目录并显示欢迎空态 */
function showHomeTab() {
  state.collectionMode = false;
  syncCollectionModeBtn();
  state.currentDir = '';
  state.items = [];
  resetSelection();
  renderTabs();
  renderBreadcrumb();
  applyFilter();
  saveCfg();
}

async function activateTab(i) {
  if (i < 0 || i >= state.tabs.length || i === state.activeTab) return;
  setActiveTab(i);
  const dir = state.tabs[i];
  if (dir == null) { showHomeTab(); return; }
  await openDirectory(dir);
}

async function closeTab(i) {
  if (i < 0 || i >= state.tabs.length) return;
  state.tabs.splice(i, 1);
  if (state.tabs.length === 0) {
    // 关完最后一个：回到欢迎空态
    setActiveTab(0);
    state.currentDir = '';
    state.items = [];
    resetSelection();
    renderTabs();

    renderBreadcrumb();
    applyFilter();
    saveCfg();
    return;
  }
  if (i < state.activeTab) setActiveTab(state.activeTab - 1);
  else if (i === state.activeTab) setActiveTab(Math.min(i, state.tabs.length - 1));
  const dir = state.tabs[state.activeTab];
  if (dir == null) { showHomeTab(); return; }
  await openDirectory(dir);
}

// ═══════════════ 交互：多选 / 框选 / 双击行为 ═══════════════
// 选择语义与资源管理器一致：
//   单击=单选   Ctrl/Cmd+单击=加选切换   Shift+单击=范围选择
//   空白或卡片上按下拖动=框选（Ctrl 保持已选）   Ctrl+A=全选   Esc=清空
// L150：空白双击检测用「点击对」计时（DOM 重渲染会吞掉原生 dblclick，导致总是失效）
let lastBlankClickT = 0;
content.addEventListener('click', (e) => {
  if (marqueeJustDragged) { marqueeJustDragged = false; return; } // 框选结束那一次 click 忽略
  const card = e.target.closest('[data-idx]');
  if (!card) {
    // L196：双击文件区任何空白处返回上一级（最多回到首页）；
    // 卡片外的区域都算空白（按钮/控件本身有 data-idx 或自身 handler，不会冒泡到这里误判）
    const now = performance.now();
    if (now - lastBlankClickT < 400) { lastBlankClickT = 0; goUp(); }
    else lastBlankClickT = now;
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) selectNone();
    return;
  }
  const idx = Number(card.dataset.idx);
  if (e.ctrlKey || e.metaKey) select(idx, 'toggle');
  else if (e.shiftKey && state.selected >= 0) select(idx, 'range');
  else select(idx, 'set');
});

content.addEventListener('dblclick', (e) => {
  const card = e.target.closest('[data-idx]');
  if (!card) return; // 空白双击由 click 双击对检测处理（L150，避免重渲染吞掉 dblclick）
  const idx = Number(card.dataset.idx);
  const item = state.filtered[idx];
  if (!item) return;
  // 文件夹：双击进入（不受"双击媒体项行为"设置影响）
  if (item.kind === 'folder') { openDirectory(item.path); return; }
  const action = state.cfg?.doubleClickAction ?? 'viewer';
  if (action === 'viewer') openViewer(idx);
  else if (action === 'open') {
    invoke('open_media', { path: item.path }).catch((err) => setStatus(String(err), true));
  }
});

/** 选中：mode = set | toggle | range */
function select(idx, mode = 'set') {
  if (idx < 0 || idx >= state.filtered.length) return;
  if (mode === 'toggle') {
    if (state.selection.has(idx)) state.selection.delete(idx);
    else state.selection.add(idx);
    const first = state.selection.values().next().value;
    state.selected = state.selection.has(idx) ? idx : (first ?? -1);
  } else if (mode === 'range' && state.selected >= 0) {
    const a = Math.min(state.selected, idx);
    const b = Math.max(state.selected, idx);
    state.selection = new Set();
    for (let i = a; i <= b; i++) state.selection.add(i);
    state.selected = idx;
  } else {
    state.selection = new Set([idx]);
    state.selected = idx;
  }
  state.selVersion++;
  applySelectionClasses();
  updateSelStatus();
  showInfo(state.selected);
}

function selectNone() {
  if (!state.selection.size && state.selected < 0) return;
  resetSelection();
  applySelectionClasses();
  updateSelStatus();
  showInfo(-1);
}

function selectAll() {
  if (!state.filtered.length) return;
  state.selection = new Set(state.filtered.map((_, i) => i));
  state.selected = 0;
  state.selVersion++;
  applySelectionClasses();
  updateSelStatus();
  showInfo(state.selected);
}

/** 只更新已渲染节点的选中样式（不整表重建，滚动/框选时不卡） */
function applySelectionClasses() {
  content.querySelectorAll('[data-idx]').forEach((n) => {
    n.classList.toggle('selected', state.selection.has(Number(n.dataset.idx)));
  });
}

// ─── 框选（橡皮筋） ───
let marqueeEl = null;
let marqueeStartV = null;    // 起点（视口坐标）
let marqueeBase = null;      // Ctrl 框选时保留的原选中集合
let marqueeAdditive = false;
let marqueeMoved = false;
let marqueeJustDragged = false;

scroller.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !state.filtered.length) return;
  // L318-2：点击文件区时让搜索框失焦（框选的 preventDefault 会阻止默认失焦）
  if (document.activeElement === $('searchInput')) $('searchInput').blur();
  if (e.target.closest('.card-ctrl')) return; // 卡片悬浮控件（进度/音量）不参与框选
  if (e.target.closest('[data-idx]')) return; // L78：卡片上按住 = 拖动文件，不进入框选
  marqueeStartV = { x: e.clientX, y: e.clientY };
  marqueeAdditive = e.ctrlKey || e.metaKey;
  marqueeMoved = false;
  e.preventDefault(); // 阻止原生图片拖拽
});

window.addEventListener('mousemove', (e) => {
  if (!marqueeStartV) return;
  if (!marqueeMoved) {
    // 超过阈值才算框选，否则让正常 click 走单选/加选/范围选
    if (Math.abs(e.clientX - marqueeStartV.x) < 4 && Math.abs(e.clientY - marqueeStartV.y) < 4) return;
    marqueeMoved = true;
    marqueeBase = marqueeAdditive ? new Set(state.selection) : new Set();
    if (!marqueeAdditive) {
      state.selection = new Set();
      state.selected = -1;
      applySelectionClasses();
      updateSelStatus();
    }
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    scroller.appendChild(marqueeEl);
  }
  const r = scroller.getBoundingClientRect();
  const x1 = Math.min(e.clientX, marqueeStartV.x);
  const x2 = Math.max(e.clientX, marqueeStartV.x);
  const y1 = Math.min(e.clientY, marqueeStartV.y);
  const y2 = Math.max(e.clientY, marqueeStartV.y);
  // 视口坐标 → 滚动容器内容坐标
  Object.assign(marqueeEl.style, {
    left: (x1 - r.left + scroller.scrollLeft) + 'px',
    top: (y1 - r.top + scroller.scrollTop) + 'px',
    width: (x2 - x1) + 'px',
    height: (y2 - y1) + 'px',
  });
  // 命中检测：与已渲染卡片矩形求交（虚拟滚动下只框到已渲染项）
  const sel = marqueeBase ? new Set(marqueeBase) : new Set();
  content.querySelectorAll('[data-idx]').forEach((n) => {
    const b = n.getBoundingClientRect();
    if (b.right >= x1 && b.left <= x2 && b.bottom >= y1 && b.top <= y2) sel.add(Number(n.dataset.idx));
  });
  state.selection = sel;
  state.selected = sel.size ? sel.values().next().value : -1;
  state.selVersion++;
  applySelectionClasses();
  updateSelStatus();
});

window.addEventListener('mouseup', endMarquee);

/** 结束框选（鼠标移出窗口松开 / 失焦时也要清理） */
function endMarquee() {
  if (!marqueeStartV) return;
  if (marqueeMoved) {
    marqueeJustDragged = true;
    if (state.selected >= 0) showInfo(state.selected);
  }
  marqueeStartV = null;
  marqueeMoved = false;
  marqueeBase = null;
  if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
}

// ─── L78/L87/L115：文件拖拽（手动发起原生 DoDragDrop） ───
// 卡片不再使用 HTML5 draggable —— 其拖拽手势会吞掉音量滑块等控件的操作，
// 且 dragstart 阶段取消也无法把本次手势还给控件。
// 改为：pointerdown 落在卡片本体（排除按钮/滑块/下拉/播放控制条等控件）后，
// 移动超过阈值才调用 start_file_drag 发起原生拖拽。
let cardDragArm = null; // { x, y, idx }
content.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // L115：控件永远不触发文件拖拽
  if (e.target.closest('button, input, select, a, .card-ctrl')) return;
  const card = e.target.closest('[data-idx]');
  if (!card) return;
  cardDragArm = { x: e.clientX, y: e.clientY, idx: Number(card.dataset.idx) };
});
window.addEventListener('pointermove', (e) => {
  if (!cardDragArm) return;
  if (Math.abs(e.clientX - cardDragArm.x) < 6 && Math.abs(e.clientY - cardDragArm.y) < 6) return;
  const { idx } = cardDragArm;
  cardDragArm = null;
  if (!state.selection.has(idx)) select(idx); // 拖动未选中项 → 先单选它
  const paths = selectedPaths();
  if (!paths.length) return;
  invoke('start_file_drag', { paths }).catch((err) => setStatus(String(err), true));
});
window.addEventListener('pointerup', () => { cardDragArm = null; });
window.addEventListener('pointercancel', () => { cardDragArm = null; });

/** 路径列表加入当前编号的集锦箱（仅文件，去重） */
function collectPaths(paths) {
  let n = 0;
  for (const p of paths) {
    if (kindOf(p) === 'folder') continue;
    if (!collectionPaths.includes(p)) { collectionPaths.push(p); n++; }
  }
  if (n) { renderCollection(); saveCollectionBox(); setStatus(`已加入集锦箱 ${collectionIdx} 号 ${n} 项`); }
  else setStatus('文件已在集锦箱中');
}

/** 路径列表加入收藏夹（仅文件夹） */
function favoritePaths(paths) {
  let n = 0;
  for (const p of paths) if (kindOf(p) === 'folder' && addFavorite(p)) n++;
  if (n) setStatus(`已收藏 ${n} 个文件夹`);
}

// 拖放（外部资源管理器拖入 / 本窗口原生拖拽落回）：Tauri 拖放事件按落点统一分发
listen('tauri://drag-drop', async (e) => {
  const paths = e.payload?.paths;
  // L119 诊断日志：控制台可确认事件是否触发、坐标与路径（重启 tauri dev 后生效）
  console.log('[drag-drop]', JSON.stringify(paths), e.payload?.position);
  if (!paths?.length) return;
  const sc = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(e.payload.position.x / sc, e.payload.position.y / sc);
  if (el?.closest('#collectionList')) { collectPaths(paths); return; }
  if (el?.closest('#favList')) { favoritePaths(paths); return; }
  if (el?.closest('#scroller') && state.currentDir) {
    try {
      const n = await invoke('copy_files_into', { srcs: paths, destDir: state.currentDir });
      if (n > 0) { setStatus(`已复制 ${n} 项到当前目录`); openDirectory(state.currentDir); }
      else setStatus('没有需要复制的项');
    } catch (err) { setStatus(String(err), true); }
  }
}).catch(() => {});

// L114：已去掉拖入时的绿边框/遮罩高亮反馈（drag-over 样式与监听一并移除）



// ═══════════════ 图片视图变换（缩放/平移/翻转/旋转，非破坏性） ═══════════════
// 只作用于预览层显示，不修改原文件；切换预览项时复位
let imgTransform = { rotate: 0, flipH: false, flipV: false, zoom: 1, tx: 0, ty: 0 };

function applyImageTransform() {
  const { rotate, flipH, flipV, zoom, tx, ty } = imgTransform;
  // translate → scale → rotate → flip：平移以像素计，缩放以 fit 后尺寸为 1
  const parts = [`translate(${Math.round(tx)}px,${Math.round(ty)}px)`];
  if (zoom !== 1) parts.push(`scale(${zoom})`);
  if (rotate) parts.push(`rotate(${rotate}deg)`);
  if (flipH) parts.push('scaleX(-1)');
  if (flipV) parts.push('scaleY(-1)');
  viewerImg.style.transform = parts.join(' ');
  const badge = $('viewerZoomBadge');
  const label = transformLabel();
  badge.textContent = label;
  badge.classList.toggle('hidden', !label);
  // L233：同步竖排缩放条位置与停靠区「已缩放」态（拖动滑块时不回写，避免打架）
  const dock = $('imgDock');
  if (dock) dock.dataset.zoom = zoom > 1.01 ? '1' : '';
  const zr = $('imgZoomRange');
  if (zr && document.activeElement !== zr) zr.value = zoomToRange(zoom);
  updateMinimap();
}

function resetImageTransform() {
  imgTransform = { rotate: 0, flipH: false, flipV: false, zoom: 1, tx: 0, ty: 0 };
  applyImageTransform();
}

function transformLabel() {
  const { rotate, flipH, flipV, zoom } = imgTransform;
  const parts = [];
  // L318-8：缩放百分比 = 当前显示尺寸 / 图片真实尺寸（而非相对 fit 的倍数）
  const iw = viewerImg.naturalWidth, ih = viewerImg.naturalHeight;
  const stage = $('viewerStage');
  if (iw && ih && stage) {
    const s0 = Math.min(stage.clientWidth / iw, stage.clientHeight / ih); // fit 基准缩放
    const realRatio = s0 * zoom; // 实际显示相对真实尺寸的比例
    parts.push(`${Math.round(realRatio * 100)}%`);
  } else if (zoom !== 1) {
    parts.push(`${Math.round(zoom * 100)}%`);
  }
  if (rotate) parts.push(`${rotate}°`);
  if (flipH) parts.push('水平翻转');
  if (flipV) parts.push('垂直翻转');
  return parts.join(' · ');
}

/** 图片右键的二级菜单项 */
function imageTransformItems() {
  const mutate = (fn) => () => { fn(); applyImageTransform(); };
  return [
    { label: '向左旋转 90°', fn: mutate(() => { imgTransform.rotate = (imgTransform.rotate + 270) % 360; }) },
    { label: '向右旋转 90°', fn: mutate(() => { imgTransform.rotate = (imgTransform.rotate + 90) % 360; }) },
    { label: '旋转 180°', fn: mutate(() => { imgTransform.rotate = (imgTransform.rotate + 180) % 360; }) },
    { label: '水平翻转', fn: mutate(() => { imgTransform.flipH = !imgTransform.flipH; }) },
    { label: '垂直翻转', fn: mutate(() => { imgTransform.flipV = !imgTransform.flipV; }) },
    { label: '重置变换', fn: mutate(() => { imgTransform = { rotate: 0, flipH: false, flipV: false, zoom: 1, tx: 0, ty: 0 }; }) },
  ];
}

// ═══════════════ 自定义右键菜单（按实际区域） ═══════════════

const ctxMenu = $('ctxMenu');
const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>',
  starYellow: '<svg viewBox="0 0 24 24" fill="#facc15" stroke="#eab308" stroke-width="1"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="#f472b6" stroke="#ec4899" stroke-width="1"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  starOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/><path d="M2 2l20 20"/></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

/** 弹出右键菜单；items: [{label, icon, sub, danger, fn} | {label, submenu:[...]} | 'sep'] */
function showCtxMenu(x, y, items) {
  hideSubmenu();
  ctxMenu.innerHTML = items.map((it, i) => it === 'sep'
    ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item${it.danger ? ' danger' : ''}" data-ctx="${i}">${ICONS[it.icon] || ''}<span>${escapeHtml(it.label)}</span>${
        it.sub ? `<span class="ctx-sub">${escapeHtml(it.sub)}</span>` : ''
      }${it.submenu ? '<span class="ctx-sub">›</span>' : ''}</div>`
  ).join('');
  ctxMenu.classList.remove('hidden');
  // 定位：防止溢出屏幕
  const r = ctxMenu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  ctxMenu.style.left = Math.max(4, px) + 'px';
  ctxMenu.style.top = Math.max(4, py) + 'px';
  ctxMenu.querySelectorAll('[data-ctx]').forEach((el) => {
    const it = items[Number(el.dataset.ctx)];
    if (it.submenu) {
      // 二级菜单：悬浮展开
      el.addEventListener('mouseenter', () => showSubmenu(el, it.submenu));
    } else {
      el.addEventListener('mouseenter', hideSubmenu);
      el.addEventListener('click', () => { hideCtxMenu(); it.fn?.(); });
    }
  });
}

// ─── 二级菜单 ───
const ctxSub = $('ctxSub');

function hideSubmenu() { ctxSub.classList.add('hidden'); }

function showSubmenu(anchor, items) {
  ctxSub.innerHTML = items.map((it, i) => it === 'sep'
    ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item${it.danger ? ' danger' : ''}" data-subctx="${i}">${ICONS[it.icon] || ''}<span>${escapeHtml(it.label)}</span></div>`
  ).join('');
  ctxSub.classList.remove('hidden');
  const a = anchor.getBoundingClientRect();
  const r = ctxSub.getBoundingClientRect();
  let left = a.right - 6;
  if (left + r.width > window.innerWidth - 8) left = Math.max(4, a.left - r.width + 6);
  let top = a.top - 6;
  if (top + r.height > window.innerHeight - 8) top = Math.max(4, window.innerHeight - r.height - 8);
  ctxSub.style.left = left + 'px';
  ctxSub.style.top = top + 'px';
  ctxSub.querySelectorAll('[data-subctx]').forEach((el) => {
    el.addEventListener('click', () => {
      const it = items[Number(el.dataset.subctx)];
      hideCtxMenu();
      it?.fn?.();
    });
  });
}

function hideCtxMenu() { ctxMenu.classList.add('hidden'); hideSubmenu(); }


// 点击其它区域 / 滚动 / Esc 时关闭
window.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
window.addEventListener('blur', () => {
  hideCtxMenu();
  endMarquee();           // 鼠标移出窗口松开时不会收到 mouseup
  syncWindowSuspension(); // 窗口失焦（后台）→ 暂停列表预览
  flushProgress();
});

window.addEventListener('focus', () => syncWindowSuspension());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushProgress(); // 最小化 / 被遮挡
  syncWindowSuspension();
});

scroller.addEventListener('scroll', hideCtxMenu, { passive: true });


/** 全局禁用 Web 默认右键菜单（输入框保留以支持粘贴等） */
window.addEventListener('contextmenu', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  e.preventDefault();
});

/** 收藏一个目录（去重） */
function addFavorite(dir) {
  if (!dir || (state.cfg.favorites ?? []).includes(dir)) return false;
  state.cfg.favorites = [...(state.cfg.favorites ?? []), dir];
  renderFavorites();
  saveCfg();
  return true;
}

/** 复制文本到剪贴板（带状态提示） */
async function copyText(t, tip = '已复制') {
  try { await navigator.clipboard.writeText(t); setStatus(tip); }
  catch { setStatus('复制失败', true); }
}

// ═══════════════ 文件操作（复制 / 剪切 / 粘贴 / 删除） ═══════════════
// 删除走系统回收站（可撤销），且始终二次确认；粘贴重名自动加序号（后端处理）
let clipboard = null;   // { mode: 'copy' | 'cut', paths: string[] }
let deleteBusy = false; // DEL 长按时不重复弹确认

/** 应用内确认框（WebView 原生 confirm 行为不可靠，这里自己做） */
function askConfirm(message, okLabel = '确定') {
  return new Promise((resolve) => {
    $('confirmMsg').textContent = message;
    $('confirmOk').textContent = okLabel;
    $('confirmModal').classList.remove('hidden');
    const done = (v) => {
      $('confirmModal').classList.add('hidden');
      $('confirmOk').removeEventListener('click', onOk);
      $('confirmCancel').removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onOk = () => done(true);
    const onNo = () => done(false);
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); done(false); }
      else if (ev.key === 'Enter') { ev.stopPropagation(); done(true); }
    };
    $('confirmOk').addEventListener('click', onOk);
    $('confirmCancel').addEventListener('click', onNo);
    document.addEventListener('keydown', onKey, true);
  });
}

/** 应用内输入框（替代原生 prompt，UI 与项目一致） */
function askPrompt(title, defaultValue = '') {
  return new Promise((resolve) => {
    $('promptTitle').textContent = title;
    const input = $('promptInput');
    input.value = defaultValue;
    $('promptModal').classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const done = (v) => {
      $('promptModal').classList.add('hidden');
      $('promptOk').removeEventListener('click', onOk);
      $('promptCancel').removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onOk = () => done(input.value.trim());
    const onNo = () => done(null);
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); done(null); }
      else if (ev.key === 'Enter') { ev.stopPropagation(); done(input.value.trim()); }
    };
    $('promptOk').addEventListener('click', onOk);
    $('promptCancel').addEventListener('click', onNo);
    document.addEventListener('keydown', onKey, true);
  });
}

/** 复制 / 剪切当前选择（CF_HDROP 写入系统剪贴板，可与 Windows 资源管理器互操作） */
function copySelection(cut = false) {
  const paths = selectedPaths();
  if (!paths.length) return;
  // 内部备份（IPC 失败 / 离线粘贴兜底）；权威数据以后端系统剪贴板为准
  clipboard = { mode: cut ? 'cut' : 'copy', paths };
  invoke('set_clipboard_files', { paths, cut })
    .then(() => setStatus(`${cut ? '已剪切' : '已复制'} ${paths.length} 项（可粘贴到资源管理器）`))
    .catch((e) => {
      // 后端失败：退回文本剪贴板，至少其它程序能拿到路径
      navigator.clipboard?.writeText(paths.join('\n')).catch(() => {});
      setStatus(`${cut ? '已剪切' : '已复制'} ${paths.length} 项（系统剪贴板不可用：${e}）`, true);
    });
}

/** 粘贴到目标目录（读取系统剪贴板，资源管理器复制的文件也能粘贴） */
async function pasteInto(dir) {
  // L318-5：集锦箱模式下，粘贴 = 把剪贴板文件加入当前集锦箱（文件夹取其内文件）
  if (state.collectionMode) { pasteIntoCollection(); return; }
  if (!dir) { setStatus('未选择目标目录', true); return; }
  let data = null;
  try {
    data = await invoke('get_clipboard_files');
  } catch { /* 后端不可用时退回内部剪贴板 */ }
  // 后端无数据 → 尝试应用内备份
  if (!data?.paths?.length && clipboard?.paths?.length) data = clipboard;
  if (!data?.paths?.length) { setStatus('剪贴板中没有文件', true); return; }
  const isCut = data.mode === 'cut';
  setStatus(isCut ? '移动中…' : '复制中…');
  try {
    const out = await invoke(isCut ? 'move_items' : 'copy_items', {
      paths: data.paths,
      destDir: dir,
    });
    if (isCut) clipboard = null;
    setStatus(`已${isCut ? '移动' : '复制'} ${out.length} 项`);
    await refreshCurrentDir();
    selectByPaths(out); // L126：粘贴后选中粘贴的文件/文件夹
  } catch (e) {
    setStatus(String(e), true);
  }
}

/** L318-5：集锦箱模式下粘贴——文件直接加入，文件夹则加入其内的全部媒体文件 */
async function pasteIntoCollection() {
  let data = null;
  try { data = await invoke('get_clipboard_files'); } catch { /* ignore */ }
  if (!data?.paths?.length && clipboard?.paths?.length) data = clipboard;
  if (!data?.paths?.length) { setStatus('剪贴板中没有文件', true); return; }
  const collected = [];
  let folderCount = 0;
  for (const p of data.paths) {
    const k = kindOf(p);
    if (k === 'folder') {
      folderCount++;
      try {
        const entries = await invoke('list_directory', { path: p });
        entries.forEach((it) => { if (it.kind !== 'folder') collected.push(it.path); });
      } catch { /* 单个文件夹失败不影响其他 */ }
    } else {
      collected.push(p);
    }
  }
  if (!collected.length) { setStatus('剪贴板中没有可加入的媒体文件', true); return; }
  let added = 0;
  collected.forEach((p) => { if (!collectionPaths.includes(p)) { collectionPaths.push(p); added++; } });
  saveCollectionBox();
  renderCollection();
  if (state.collectionMode) refreshCollectionMode();
  const parts = [];
  if (added) parts.push(`${added} 个文件`);
  if (folderCount) parts.push(`${folderCount} 个文件夹`);
  setStatus(`已加入 ${parts.join(' / ')} 到 ${collectionIdx} 号集锦箱`);
}

/** L126：按绝对路径列表选中（粘贴/拖入后定位新文件）；索引基于 state.filtered */
function normPathKey(p) {
  return String(p).replace(/[\\/]+/g, '\\').toLowerCase().replace(/\\+$/, '');
}
function selectByPaths(paths) {
  if (!paths?.length) return;
  const exact = new Set(paths);
  const loose = new Set(paths.map(normPathKey));
  const idxs = [];
  state.filtered.forEach((it, i) => {
    if (exact.has(it.path) || loose.has(normPathKey(it.path))) idxs.push(i);
  });
  if (!idxs.length) return;
  state.selection = new Set(idxs);
  state.selected = idxs[0];
  state.selVersion++;
  applySelectionClasses();
  updateSelStatus();
  showInfo(idxs[0]);
  content.querySelector(`[data-idx="${idxs[0]}"]`)?.scrollIntoView({ block: 'nearest' });
}

/**
 * 删除当前选择
 *   permanent=false（DEL）：移入系统回收站，无提示，可还原
 *   permanent=true （Shift+DEL）：永久删除，必须二次确认，不可恢复
 */
async function deleteSelection(permanent = false) {
  const paths = selectedPaths();
  if (!paths.length || deleteBusy) return;
  deleteBusy = true;
  try {
    if (permanent) {
      const names = paths.map((p) => p.split(/[\\/]/).pop()).slice(0, 3).join('、');
      const more = paths.length > 3 ? ` 等 ${paths.length} 项` : '';
      const ok = await askConfirm(
        `将永久删除「${names}」${more}，\n不进入回收站，删除后无法恢复。确定继续吗？`,
        '永久删除',
      );
      if (!ok) return;
    }
    const n = await invoke('delete_items', { paths, permanent });
    setStatus(permanent
      ? `已永久删除 ${n} 项`
      : `已删除 ${n} 项（移入回收站，可还原）`);
    await refreshCurrentDir();
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    deleteBusy = false;
  }
}

/** 重新扫描当前目录（文件操作后刷新，筛选/排序保留） */
async function refreshCurrentDir() {
  if (!state.currentDir) return;
  try {
    state.items = await invoke('list_directory', { path: state.currentDir });
  } catch (e) {
    setStatus(String(e), true);
  }
  applyFilter(); // 内部会重置选择并重绘
}


// ─── 媒体项右键（监听 scroller：磁盘根目录内容少时 content 不铺满，空白属于 scroller） ───
scroller.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('[data-idx]');
  e.preventDefault();
  if (!card) {
    // 空白区域：目录操作 + 视图/筛选
    if (!state.currentDir) return;
    showCtxMenu(e.clientX, e.clientY, [
      { label: '粘贴', icon: 'copy', sub: 'Ctrl+V', fn: () => pasteInto(state.currentDir) },
      'sep',
      { label: '刷新', icon: 'refresh', sub: 'F5', fn: () => openDirectory(state.currentDir) },
      { label: '资源管理器打开', icon: 'folder', fn: () => invoke('open_media', { path: state.currentDir }).catch((err) => setStatus(String(err), true)) },
      { label: '复制当前路径', icon: 'copy', fn: () => copyText(state.currentDir, '路径已复制') },
      'sep',
      { label: '收藏当前目录', icon: 'starYellow', fn: () => addFavorite(state.currentDir) },
    ]);
    return;
  }
  const idx = Number(card.dataset.idx);
  const item = state.filtered[idx];
  if (!item) return;
  // 已在多选中的项：保留多选，右键不破坏选择
  if (!state.selection.has(idx)) select(idx);
  const dir = item.path.replace(/[\\/][^\\/]+$/, '');
  const nSel = state.selection.size;
  const multi = nSel > 1;
  const menu = [];

  if (item.kind === 'folder') {
    menu.push(
      { label: '打开', icon: 'folder', fn: () => openDirectory(item.path) },
      { label: '在新标签页打开', icon: 'folder', fn: () => openDirectory(item.path, { newTab: true }) },
    );
  } else if (item.kind === 'audio') {
    menu.push(
      { label: '播放', icon: 'eye', fn: () => openViewer(idx) },
      { label: '下一首播放', icon: 'eye', fn: () => { audioPlayNext(item.path); setStatus('已设为下一首'); } },
      { label: '添加到播放列表', icon: 'star', fn: () => {
          const n = audioEnqueue(selectedPaths());
          setStatus(n ? `已加入 ${n} 首` : '都已在播放列表中');
        } },
    );
  } else {
    menu.push({ label: '预览', icon: 'eye', sub: 'Enter', fn: () => openViewer(idx) });
    if (item.kind === 'image') {
      // 图片：二级菜单「翻转 / 旋转」（视图级，不改原文件）
      menu.push({ label: '翻转 / 旋转', icon: 'refresh', submenu: imageTransformItemsFor(idx) });
    }
  }

  menu.push(
    { label: '系统默认打开', icon: 'open', fn: () => invoke('open_media', { path: item.path }).catch((err) => setStatus(String(err), true)) },
    'sep',
    { label: multi ? `复制 ${nSel} 项` : '复制', icon: 'copy', sub: 'Ctrl+C', fn: () => copySelection(false) },
    { label: multi ? `剪切 ${nSel} 项` : '剪切', icon: 'copy', sub: 'Ctrl+X', fn: () => copySelection(true) },
    // { label: '粘贴到此处', icon: 'copy', sub: 'Ctrl+V', fn: () => pasteInto(item.kind === 'folder' ? item.path : dir) },
    // 'sep',
    { label: '重命名', icon: 'rename', fn: () => renameItem(item) },
    { label: multi ? `删除 ${nSel} 项` : '删除', icon: 'trash', sub: 'Del', fn: () => deleteSelection(false) },
    { label: multi ? `永久删除 ${nSel} 项` : '永久删除', icon: 'trash', danger: true, sub: 'Shift+Del', fn: () => deleteSelection(true) },
    'sep',
    { label: multi ? `复制 ${nSel} 个路径` : '复制文件路径', icon: 'copy', fn: () => copyText(selectedPaths().join('\n'), '路径已复制') },
    { label: '复制文件名', icon: 'copy', fn: () => copyText(item.name, '文件名已复制') },
    'sep',
    { label: '打开所在文件夹', icon: 'folder', fn: () => invoke('open_media', { path: item.kind === 'folder' ? item.path : dir }).catch((err) => setStatus(String(err), true)) },
    item.kind === 'folder'
      ? { label: '收藏该文件夹', icon: 'starYellow', fn: () => addFavorite(item.path) }
      : { label: '收藏所在文件夹', icon: 'starYellow', fn: () => addFavorite(dir) },

  );
  // L82/L335：媒体文件右键集锦箱相关项
  if (item.kind !== 'folder') {
    const paths = selectedPaths().filter((p) => kindOf(p) !== 'folder');
    const inBox = paths.length > 0 && paths.every((p) => collectionPaths.includes(p));
    // L335：集锦箱界面，「移动到/复制到集锦箱」（爱心图标）放在「移出集锦箱」之上
    if (state.collectionMode) {
      const moveSub = [], copySub = [];
      for (let b = 1; b <= 5; b++) {
        const label = b === collectionIdx ? `${b} 号（当前）` : `${b} 号`;
        moveSub.push({ label, fn: () => moveToBox(paths, b) });
        copySub.push({ label, fn: () => copyToBox(paths, b) });
      }
      menu.push('sep',
        { label: '移动到集锦箱', icon: 'heart', submenu: moveSub },
        { label: '复制到集锦箱', icon: 'heart', submenu: copySub },
      );
    }
    menu.push({
      label: inBox ? '移出集锦箱' : '加入集锦箱',
      icon: 'heart',
      fn: () => {
        if (inBox) {
          paths.forEach((p) => {
            const i = collectionPaths.indexOf(p);
            if (i >= 0) collectionPaths.splice(i, 1);
          });
        } else {
          paths.forEach((p) => { if (!collectionPaths.includes(p)) collectionPaths.push(p); });
        }
        renderCollection();
        saveCollectionBox();
        setStatus(inBox ? '已移出集锦箱' : `已加入集锦箱 ${collectionIdx} 号 ${paths.length} 项`);
        if (inBox && state.collectionMode) refreshCollectionMode(); // L88：移出后刷新但不退出模式
      },
    });
    // L63：媒体项右键末尾加「属性」
    menu.push('sep', { label: '属性', icon: 'info', fn: () => openProps(item.path, item.kind) });
  }
  showCtxMenu(e.clientX, e.clientY, menu);
});

/** 重命名单个文件/文件夹：弹出输入框 → 调用后端 rename_item */
async function renameItem(item) {
  if (!item) return;
  const name = await askPrompt('重命名为：', item.name);
  if (!name || name === item.name) return;
  invoke('rename_item', { path: item.path, newName: name })
    .then(() => { setStatus(`已重命名为「${name}」`); openDirectory(state.currentDir); })
    .catch((err) => setStatus(`重命名失败：${err}`, true));
}

/** 当前选中项的路径列表（按索引升序） */
function selectedPaths() {
  return [...state.selection].sort((a, b) => a - b)
    .map((i) => state.filtered[i]?.path)
    .filter(Boolean);
}

/** 卡片菜单里的翻转项：先打开预览，再施加变换 */
function imageTransformItemsFor(idx) {
  return imageTransformItems().map((it) => ({
    label: it.label,
    fn: () => {
      if ($('viewer').classList.contains('hidden') || state.viewerIndex !== idx) openViewer(idx);
      it.fn();
    },
  }));
}



// ─── 侧边栏（磁盘 / 收藏 / 目录树）右键 ───
$('sidebar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // 集锦箱文件右键（L71：交互菜单）
  const colItem = e.target.closest('[data-col]');
  if (colItem) {
    const p = colItem.dataset.col;
    const dir = p.replace(/[\\/][^\\/]+$/, '');
    showCtxMenu(e.clientX, e.clientY, [
      { label: '定位文件', icon: 'folder', fn: () => {
          state.pendingReveal = p;
          if (dir === state.currentDir) {
            const i = state.filtered.findIndex((x) => x.path === p);
            if (i >= 0) { select(i); state.pendingReveal = null; }
          } else openDirectory(dir);
        } },
      { label: '系统默认程序打开', icon: 'open', fn: () => invoke('open_media', { path: p }).catch((err) => setStatus(String(err), true)) },
      { label: '复制路径', icon: 'copy', fn: () => copyText(p, '路径已复制') },
      'sep',
      { label: '移出集锦箱', icon: 'trash', danger: true, fn: () => toggleCollect(p) },
    ]);
    return;
  }
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    const p = fav.dataset.fav;
    showCtxMenu(e.clientX, e.clientY, [
      { label: '打开', icon: 'folder', fn: () => openDirectory(p) },
      { label: '在新标签页打开', icon: 'folder', fn: () => openDirectory(p, { newTab: true }) },
      'sep',
      { label: '复制路径', icon: 'copy', fn: () => copyText(p, '路径已复制') },
      { label: '在系统中打开', icon: 'open', fn: () => invoke('open_media', { path: p }).catch((err) => setStatus(String(err), true)) },
      'sep',
      { label: '移除收藏', icon: 'trash', danger: true, fn: () => {

          state.cfg.favorites = (state.cfg.favorites ?? []).filter((x) => x !== p);
          renderFavorites();
          saveCfg();
        } },
    ]);
    return;
  }
  const node = e.target.closest('.tree-node[data-path]');
  if (node) {
    const p = node.dataset.path;
    const isFav = (state.cfg.favorites ?? []).includes(p);
    showCtxMenu(e.clientX, e.clientY, [
      { label: '打开', icon: 'folder', fn: () => openDirectory(p) },
      { label: '在新标签页打开', icon: 'folder', fn: () => openDirectory(p, { newTab: true }) },
      'sep',
      isFav

        ? { label: '取消收藏', icon: 'starOff', fn: () => {
            state.cfg.favorites = (state.cfg.favorites ?? []).filter((x) => x !== p);
            renderFavorites(); saveCfg();
          } }
        : { label: '加入收藏', icon: 'starYellow', fn: () => addFavorite(p) },
      { label: '复制路径', icon: 'copy', fn: () => copyText(p, '路径已复制') },
      { label: '在系统中打开', icon: 'open', fn: () => invoke('open_media', { path: p }).catch((err) => setStatus(String(err), true)) },
    ]);
  }
});

// ─── 播放器（画廊预览内）右键 ───
$('viewer').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  // L234：右键拖拽缩放刚结束时不弹菜单（单击右键才弹）
  if (rzMoved) return;
  const item = state.filtered[state.viewerIndex];
  if (!item) return;
  const isVideo = !$('viewerVideo').classList.contains('hidden');
  const isImage = !$('viewerImg').classList.contains('hidden');
  const items = [];
  // L136-139：全屏放右键菜单顶部，状态对应「播放全屏」（与播放控件按钮同一入口）
  items.push({ label: viewerFsActive ? '退出全屏播放' : '全屏播放', icon: 'full', sub: 'Enter', fn: () => viewerFullscreenAction() }, 'sep');
  if (isVideo) {
    items.push(
      { label: $('viewerVideo').paused ? '播放' : '暂停', icon: 'eye', fn: () => toggleVideoPlay() },
      { label: '播放模式', icon: 'refresh', sub: $('videoPlayMode').title, fn: () => $('videoPlayMode').click() },
      { label: '静音切换', icon: 'copy', sub: $('viewerVideo').muted ? '已静音' : '', fn: () => $('videoMute').click() },
      'sep',
    );
  } else if (isImage) {
    // 图片：二级菜单「翻转 / 旋转」（视图级，不改原文件）
    items.push({ label: '翻转 / 旋转', icon: 'refresh', sub: transformLabel(), submenu: imageTransformItems() }, 'sep');
  }
  // L255：集锦箱加入/移出（作用于当前编号）
  const inBox = collectionPaths.includes(item.path);
  items.push(
    { label: '关闭预览', icon: 'eye', sub: 'Esc', fn: () => closeViewer() }, // L63：关闭预览移到上部
    'sep',
    { label: '系统默认程序打开', icon: 'open', fn: () => invoke('open_media', { path: item.path }).catch((err) => setStatus(String(err), true)) },
    { label: '复制文件路径', icon: 'copy', fn: () => copyText(item.path, '路径已复制') },
    { label: inBox ? '移出集锦箱' : '加入集锦箱', icon: 'heart', fn: () => toggleCollectViewerItem() },
    'sep',
    { label: '删除', icon: 'trash', sub: 'Del', fn: () => deleteViewerItem(false) },
    { label: '永久删除', icon: 'trash', danger: true, sub: 'Shift+Del', fn: () => deleteViewerItem(true) },
    'sep',
    { label: '属性', icon: 'info', fn: () => openProps(item.path, item.kind) },
  );
  showCtxMenu(e.clientX, e.clientY, items);
});

// ─── L63：属性面板（帧率/分辨率/编码/码率等） ───
async function openProps(path, kind) {
  const modal = $('propsModal'), body = $('propsBody');
  modal.classList.remove('hidden');
  $('propsFileName').textContent = path.split(/[\\/]/).pop();
  body.innerHTML = '<div class="opacity-50 text-xs py-6 text-center">读取中…</div>';
  try {
    const p = await invoke('get_media_props', { path, kind });
    const rows = [
      ['文件名', p.name],
      ['路径', p.path],
      ['类型', kindLabel(p.kind)],
      ['大小', fmtSize(p.size)],
      ['修改时间', p.modified ? new Date(p.modified * 1000).toLocaleString() : ''],
    ];
    if (p.width && p.height) rows.push(['分辨率', `${p.width} × ${p.height}`]);
    if (p.duration != null) rows.push(['时长', fmtDur(p.duration)]);
    if (p.frameRate) rows.push(['帧率', `${p.frameRate} fps`]);
    if (p.videoCodec) rows.push(['视频编码', p.videoCodec]);
    if (p.audioCodec) rows.push(['音频编码', p.audioCodec]);
    // L158：bitrate 后端返回形如 "1536 kb/s" 的字符串，需解析数字（直接相除会 NaN 导致行被过滤）
    const br = p.bitrate ? parseFloat(p.bitrate) : 0;
    if (br) rows.push(['码率', `${Math.round(br)} kbps`]);
    body.innerHTML = rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) =>
      `<div class="flex gap-3"><span class="w-20 shrink-0 opacity-50">${k}</span><span class="flex-1 break-all select-text">${escapeHtml(String(v))}</span></div>`
    ).join('');
  } catch (err) {
    body.innerHTML = `<div class="text-red-400 text-xs py-6 text-center">${escapeHtml(String(err))}</div>`;
  }
}
$('propsClose').addEventListener('click', () => $('propsModal').classList.add('hidden'));
$('propsBackdrop').addEventListener('click', () => $('propsModal').classList.add('hidden'));


// ─── 标题栏右键：窗口快捷操作 ───
$('titlebar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, [
    { label: '最小化', icon: 'info', fn: () => win.minimize() },
    { label: '最大化 / 还原', icon: 'info', fn: () => win.toggleMaximize() },
    'sep',
    { label: '设置', icon: 'info', fn: () => openSettings() },
    { label: '隐藏到托盘', icon: 'info', fn: () => $('btnClose').click() },
  ]);
});

// ═══════════════ 工具栏 ═══════════════
function applyViewMode() {
  document.querySelectorAll('.viewBtn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === (state.cfg?.viewMode ?? 'grid')));
  $('zoomSlider').value = activeThumbSize(); // L80：切视图后滑块同步到该视图的缩放状态
  renderVirtual();
  saveCfg();
}

document.querySelectorAll('.viewBtn').forEach((b) =>
  b.addEventListener('click', () => { state.cfg.viewMode = b.dataset.view; applyViewMode(); }));

$('btnTheme').addEventListener('click', () => {
  // 深色 ⇄ 浅色（跟随系统时切到与其相反的显式主题）
  const cur = state.cfg.theme ?? 'dark';
  const dark = cur === 'system' ? state.systemDark : cur !== 'light';
  state.cfg.theme = dark ? 'light' : 'dark';
  applyAppearance(); // L93：切换后按新主题读取各自的外观参数
  saveCfg();
});

// L318-7：画廊缩放防抖——避免小范围滑动频繁重排，80ms trailing
let galleryZoomTimer = null;
$('zoomSlider').addEventListener('input', (e) => {
  setActiveThumbSize(Number(e.target.value)); // L80：写入当前视图独立的缩放状态
  // L236：画廊模式缩放只改列宽并重排行（卡片 left/top/width 带 CSS 过渡），不重建 DOM
  if (state.cfg.viewMode === 'gallery') {
    clearTimeout(galleryZoomTimer);
    galleryZoomTimer = setTimeout(() => layoutGalleryNow(), 80);
  } else {
    renderVirtual();
  }
  saveCfg();
});

// L70/L80：Ctrl+滚轮缩放——图标与画廊视图均生效（步进 20，范围 60–800），同步滑块
let wheelColTransitionT = null;
scroller.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const mode = state.cfg?.viewMode;
  if (mode !== 'grid' && mode !== 'gallery') return;
  e.preventDefault();
  const cur = activeThumbSize();
  const nz = Math.min(800, Math.max(60, cur + (e.deltaY < 0 ? 20 : -20)));
  if (nz === cur) return;
  setActiveThumbSize(nz);
  $('zoomSlider').value = nz;
  if (mode === 'gallery') {
    const m = content.querySelector('.gallery-rows');
    if (m) {
      // 连滚期间禁用位置过渡，让卡片瞬时跳到新位置；同步给视频 geometry
      // 否则过渡期间 getBoundingClientRect 读到中间值，视频滞留 → 不同步
      m.classList.add('no-anim');
      layoutGalleryNow();
      // 缩放停止 250ms 后恢复过渡（鼠标停顿后视觉柔和）
      clearTimeout(wheelColTransitionT);
      wheelColTransitionT = setTimeout(() => m.classList.remove('no-anim'), 250);
    }
  } else {
    renderVirtual();
  }
  saveCfg();
}, { passive: false });

$('filterKind').addEventListener('change', (e) => {
  state.cfg.filterKind = e.target.value;
  applyFilter();
  saveCfg();
});

$('sortMode').addEventListener('change', (e) => {
  state.cfg.sortMode = e.target.value;
  applyFilter();
  saveCfg();
});

let searchTimer;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 200);
});

$('btnUp').addEventListener('click', goUp);
$('btnRefresh').addEventListener('click', () => {
  // L230：穿透中刷新仍按穿透递归扫描
  openDirectory(state.currentDir, state.penetrate ? { deep: true } : {});
});
$('btnHome').addEventListener('click', () => showHomeTab()); // L342：首页按钮（接管原「选择根目录」位置与发光样式）
$('btnAddFav').addEventListener('click', () => {
  if (addFavorite(state.currentDir)) setStatus('已收藏当前目录');
});

function goUp() {
  if (!state.currentDir) return;
  // L150：磁盘根目录（如 "D:\"）再往上 = 回到首页
  if (/^[A-Za-z]:[\\/]?$/.test(state.currentDir)) { showHomeTab(); return; }
  let parent = state.currentDir.replace(/[\\/][^\\/]+[\\/]?$/, '');
  if (!parent) { showHomeTab(); return; }
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\'; // "D:" → "D:\"，否则目录树定位不到磁盘根
  if (parent !== state.currentDir) openDirectory(parent);
}


async function pickRoot() {
  try {
    const [dir, items] = await invoke('pick_and_list');
    state.rootDir = dir;
    state.currentDir = dir;
    if (state.cfg) state.cfg.lastDir = dir;
    state.items = items;
    resetSelection();
    // 写入当前标签页（尚无标签则建一个）

    if (state.tabs.length === 0) {
      state.tabs.push(dir);
      setActiveTab(state.tabs.length - 1);
    } else {
      state.tabs[state.activeTab] = dir;
    }

    renderTabs();
    renderBreadcrumb();
    applyFilter();
    saveCfg();
    revealInTree(dir);
  } catch (e) {
    if (!String(e).includes('未选择')) setStatus(String(e), true);
  }
}


// ═══════════════ 侧栏开关 / 沉浸模式 ═══════════════
/** 应用左侧栏显示状态 */
function applySidebarVisible() {
  const on = state.cfg?.sidebarVisible !== false;
  $('sidebar').classList.toggle('hidden', !on);
  renderVirtual(); // 文件区宽度变化 → 重算网格
}

$('btnSidebar').addEventListener('click', () => {
  state.cfg.sidebarVisible = !(state.cfg.sidebarVisible !== false);
  applySidebarVisible();
  saveCfg();
});

// ─── 沉浸模式：只显示文件区；顶条已移除；鼠标移到顶部才显示退出按钮；进入时提示 ESC ───
let immersiveAutoFs = false;   // 记录是否由沉浸模式自动进入全屏
let immersionIdleTimer = null;
let immersionToastTimer = null;

async function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  const bar = $('immersionBar');
  if (on) {
    // L65：已全屏时保持全屏（不翻转状态）；未全屏且设置开启才自动全屏
    if (state.cfg?.immersiveFullscreen !== false) {
      try {
        const alreadyFs = await win.isFullscreen();
        if (!alreadyFs) {
          await invoke('toggle_fullscreen', { onlyExit: false });
          immersiveAutoFs = true;
        }
      } catch { /* 忽略 */ }
    }
    bar.classList.remove('immersion-show');
    // 进入时顶部显示「ESC 退出沉浸模式」，1 秒后缓慢消失
    const toast = $('immersionToast');
    if (toast) {
      toast.classList.remove('hidden');
      requestAnimationFrame(() => toast.classList.add('show'));
      clearTimeout(immersionToastTimer);
      immersionToastTimer = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 600);
      }, 1000);
    }
  } else {
    bar.classList.remove('immersion-show');
    clearTimeout(immersionIdleTimer);
    clearTimeout(immersionToastTimer);
    const toast = $('immersionToast');
    if (toast) { toast.classList.remove('show'); toast.classList.add('hidden'); }
    // 仅退出「由沉浸模式自动进入」的全屏；用户原本的全屏状态不动
    if (immersiveAutoFs) {
      immersiveAutoFs = false;
      invoke('toggle_fullscreen', { onlyExit: true }).catch(() => {});
    }
  }
  renderVirtual(); // 文件区尺寸变化 → 重算列数/行高
}

$('btnImmersion').addEventListener('click', () => setImmersive(true));
$('btnImmersionExit').addEventListener('click', () => setImmersive(false));

// L123/L318-9：工具栏自动播放开关（点亮显关键色，与设置面板状态同步；切换立即生效）
function syncAutoplayBtn() {
  $('btnAutoplay')?.classList.toggle('on', state.cfg?.videoAutoplay !== false);
}
$('btnAutoplay')?.addEventListener('click', () => {
  state.cfg.videoAutoplay = !(state.cfg.videoAutoplay !== false);
  syncAutoplayBtn();
  saveCfg();
  // L318-9：立即生效——开启时立刻启动可见视频预览，关闭时回收全部预览
  if (state.cfg.videoAutoplay !== false) scheduleAutoPreviews();
  else recycleAutoPreviews();
});
// L65：沉浸模式下仅鼠标移到顶部 48px 才显示退出按钮，离开后缓慢隐藏
document.addEventListener('mousemove', (e) => {
  if (!document.body.classList.contains('immersive')) return;
  const bar = $('immersionBar');
  if (e.clientY <= 48) {
    bar.classList.add('immersion-show');
    clearTimeout(immersionIdleTimer);
  } else if (bar.classList.contains('immersion-show') && !bar.matches(':hover')) {
    clearTimeout(immersionIdleTimer);
    immersionIdleTimer = setTimeout(() => {
      if (!bar.matches(':hover')) bar.classList.remove('immersion-show');
    }, 1200);
  }
});

// ═══════════════ 面板拖拽 ═══════════════
$('btnInfoPanel').addEventListener('click', () => {
  state.cfg.infoPanelVisible = !(state.cfg.infoPanelVisible ?? true);
  $('infoPanel').classList.toggle('hidden', !state.cfg.infoPanelVisible);
  saveCfg();
});


(function initPanelDrag() {
  let dragging = false;
  $('infoDrag').addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    state.cfg.infoPanelWidth = Math.max(200, window.innerWidth - e.clientX); // 上限放开

    $('infoPanel').style.width = state.cfg.infoPanelWidth + 'px';
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; saveCfg(); } });
})();

(function initSidebarDrag() {
  const bar = $('sidebar');
  let dragging = false;
  bar.addEventListener('mousemove', (e) => {
    bar.style.cursor = e.offsetX > bar.clientWidth - 4 ? 'col-resize' : '';
  });
  bar.addEventListener('mousedown', (e) => {
    if (e.offsetX > bar.clientWidth - 4) { dragging = true; e.preventDefault(); }
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      state.cfg.sidebarWidth = Math.min(420, Math.max(160, e.clientX));
      bar.style.width = state.cfg.sidebarWidth + 'px';
      renderVirtual();
    }
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; saveCfg(); } });
})();

// ═══════════════ 窗口控制 ═══════════════
$('btnMin').addEventListener('click', () => {
  setWindowSuspension(true); // 最小化即暂停列表预览（随后由轮询按真实状态维持）
  flushProgress();
  win.minimize();
});
$('btnMax').addEventListener('click', () => win.toggleMaximize());
$('btnClose').addEventListener('click', async () => {
  await persistGeometry();
  win.hide(); // 隐藏到托盘
});

// Tauri 窗口聚焦事件：判定"切到后台"的权威来源（DOM blur 只作补充）
win.onFocusChanged(({ payload: focused }) => {
  winFocused = focused;
  if (!focused) flushProgress();
  syncWindowSuspension();
}).catch(() => {});



async function persistGeometry() {
  try {
    const max = await win.isMaximized();
    if (max) {
      await invoke('save_window_geometry', { x: 0, y: 0, width: 1280, height: 800, maximized: true });
    } else {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      await invoke('save_window_geometry', {
        x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false,
      });
    }
  } catch { /* 忽略 */ }
}

// ═══════════════ 快捷键（本地，可配置） ═══════════════
const ACTION_NAMES = {
  openViewer: '预览器打开', viewerClose: '关闭预览',
  viewerPrev: '上一项', viewerNext: '下一项',
  goUp: '返回上级', focusSearch: '聚焦搜索',
  toggleTheme: '切换主题', togglePanel: '元信息面板',
  toggleImmersion: '沉浸模式',
  toggleAudioPanel: '音频播放器', // L237：M 呼出/收起
  toggleCardMute: '卡片静音开关', // L238：Ctrl+M
};

/** 事件是否匹配组合键字符串（"Ctrl+f" / "Escape"） */
function matchShortcut(combo, e) {
  if (!combo) return false;
  const parts = combo.split('+').map((s) => s.trim().toLowerCase());
  const key = parts.pop();
  const needCtrl = parts.includes('ctrl');
  const needAlt = parts.includes('alt');
  const needShift = parts.includes('shift');
  if (e.ctrlKey !== needCtrl || e.altKey !== needAlt) return false;
  if (e.shiftKey !== needShift) return false; // L122：无 Shift 的组合不匹配 Shift+按键（如 'd' 不匹配 Shift+D）
  const k = e.key.toLowerCase();
  return k === key || k === key.replace(/escape/, 'esc');
}

/** 触发动作 */
function runAction(action) {
  const viewerOpen = !$('viewer').classList.contains('hidden');
  switch (action) {
    // 文件夹不能进预览：跳到下一个可预览项
    case 'openViewer': if (state.selected >= 0) openViewer(state.selected); break;
    case 'viewerClose': if (viewerOpen) closeViewer(); break;
    // 上下文件只在预览层内生效，避免在文件区按 A/D 误开预览
    case 'viewerPrev': if (viewerOpen) viewerStep(-1); break;
    case 'viewerNext': if (viewerOpen) viewerStep(1); break;
    case 'goUp': goUp(); break;
    case 'focusSearch': $('searchInput').focus(); break;
    case 'toggleTheme': $('btnTheme').click(); break;
    case 'togglePanel': $('btnInfoPanel').click(); break;
    // L122：沉浸模式进入/退出（默认 Shift+D）
    case 'toggleImmersion': setImmersive(!document.body.classList.contains('immersive')); break;
    // L237：音频播放器呼出/收起
    case 'toggleAudioPanel':
      if ($('audioPanel').classList.contains('hidden')) openAudioPanel();
      else closeAudioPanel();
      break;
    // L238：全局卡片静音开关
    case 'toggleCardMute': toggleCardMute(); break;
  }
}

// [临时诊断] F8：切换一个不透明红色全屏层（z-index 99999）。
// 目的：判定"网页绘制层"与"原生视频层"的真实上下关系。
//  · 红层盖住视频 → WebView 层在视频之上，遮挡问题只出在设置面板自身的像素
//  · 视频盖住红层 → 整个 WebView 合成层实际位于视频之下，是原生挂载问题
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F8') return;
  const existing = document.getElementById('__zprobe');
  if (existing) { existing.remove(); return; }
  const d = document.createElement('div');
  d.id = '__zprobe';
  d.style.cssText =
    'position:fixed;inset:0;background:red;z-index:99999;pointer-events:none;';
  document.body.appendChild(d);
});

window.addEventListener('keydown', (e) => {
  // 确认框打开时：按键交给它自己处理
  if (!$('confirmModal').classList.contains('hidden')) return;

  // 设置弹窗打开时：仅 Esc 关闭
  if (!$('settingsModal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeSettings();
    return;
  }
  // 画廊表演设置面板打开时：F2 / Esc 关闭
  if (!$('perfModal').classList.contains('hidden')) {
    if (e.key === 'Escape' || e.key === 'F2') { closePerfSettings(); e.preventDefault(); }
    return;
  }

  // 全局：Shift+F 切换窗口全屏（隐藏任务栏），不限预览层
  if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') {
    toggleAppFullscreen(); e.preventDefault(); return;
  }

  // F1：进入 / 退出画廊表演；F2：表演中弹出设置面板
  if (e.key === 'F1') {
    if (perf.active) exitPerf(); else enterPerf();
    e.preventDefault(); return;
  }
  if (e.key === 'F2') {
    // F2 弹出 / 关闭设置面板（表演内外均可呼出预先配置）
    if ($('perfModal').classList.contains('hidden')) openPerfSettings();
    else closePerfSettings();
    e.preventDefault(); return;
  }
  // 表演中：空格暂停/继续；Tab 切换模式；数字键 1-5 直跳指定模式；Esc 由下方通用分支退出表演
  if (perf.active) {
    if (e.code === 'Space') { togglePerfPause(); e.preventDefault(); return; }
    if (e.key === 'Tab') { perfCycleMode(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    // 数字键 1-5：直跳对应模式
    const numModes = { '1': 'waterfall', '2': 'cards', '3': 'array', '4': 'slideshow', '5': 'cover' };
    if (numModes[e.key]) {
      const next = numModes[e.key];
      if (next !== perf.mode) {
        ensurePerfCfg().mode = next;
        saveCfg();
        syncPerfUI();
        startPerfMode(next);
        showTopToast('模式：' + ({ waterfall: '瀑布流', cards: '卡片动画', array: '阵列图案', slideshow: '幻灯片', cover: '封面流' })[next]);
      }
      e.preventDefault(); return;
    }
    // 方向键 / WASD / Enter 等导航键在表演期间屏蔽（避免与视口自动滚动冲突）
    const navKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Enter'];
    if (navKeys.includes(e.key) || 'wasd'.includes(e.key.toLowerCase())) { e.preventDefault(); return; }
  }

  // 本地可配置快捷键（L240 截屏 / L238 卡片静音需要在所有界面全局生效，提前取出）
  const ls = state.cfg?.localShortcuts ?? {};

  // L240：截屏全局可用（视频=原始帧，图片=原图，其他=窗口截图）；默认 F11，可配置
  const shotKey = state.cfg?.screenshotHotkey || 'F11';
  if (e.key === shotKey || matchShortcut(shotKey, e)) { takeScreenshot(); e.preventDefault(); return; }
  // L238：全局卡片静音/开启（默认 Ctrl+M，可配置）
  if (matchShortcut(ls.toggleCardMute || 'Ctrl+m', e)) { runAction('toggleCardMute'); e.preventDefault(); return; }

  // 音频播放界面打开时：空格播放/暂停、Esc 收起、左右切换、M（可配置）收起
  if (!$('audioPanel').classList.contains('hidden')) {
    if (e.key === 'Escape') { closeAudioPanel(); e.preventDefault(); return; }
    if (matchShortcut(ls.toggleAudioPanel || 'm', e)) { closeAudioPanel(); e.preventDefault(); return; }
    if (e.code === 'Space') { audioToggle(); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') { audioPrev(); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { audioNext(false); e.preventDefault(); return; }
    return;
  }

  if (!$('viewer').classList.contains('hidden')) {
    // 预览模式：Esc / 上下文件 + 播放器控制键
    if (matchShortcut(ls.viewerClose ?? 'Escape', e)) { closeViewer(); e.preventDefault(); return; }
    // L255：Del 移入回收站；Shift+Del 永久删除（右键菜单也有入口）
    if (e.key === 'Delete') { deleteViewerItem(e.shiftKey); e.preventDefault(); return; }
    // 可配置键 + 固定别名（方向键 / A / D）都能切上下文件
    const prevKey = matchShortcut(ls.viewerPrev ?? 'a', e) || e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a';
    const nextKey = matchShortcut(ls.viewerNext ?? 'd', e) || e.key === 'ArrowRight' || e.key.toLowerCase() === 'd';
    if (prevKey) { viewerStep(-1); e.preventDefault(); return; }
    if (nextKey) { viewerStep(1); e.preventDefault(); return; }
    // L139：Enter 走播放全屏统一入口（场景1/2回到文件预览；场景3切换播放全屏）
    if (e.key === 'Enter') {
      const t = e.target.tagName;
      if (t !== 'INPUT' && t !== 'SELECT' && t !== 'BUTTON' && t !== 'TEXTAREA') {
        viewerFullscreenAction(); e.preventDefault();
      }
      return;
    }
    const isVideo = !$('viewerVideo').classList.contains('hidden') || mpvPlaying;
    if (e.code === 'Space') { if (isVideo) toggleVideoPlay(); e.preventDefault(); return; }
    // L129/L136：F 在预览器内 = 播放全屏统一入口
    if (e.key.toLowerCase() === 'f') { viewerFullscreenAction(); e.preventDefault(); return; }
    // L237：预览器内的纯 M 仍是视频静音（Ctrl+M 已在全局作为卡片静音处理）
    if (!e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'm' && isVideo) { $('videoMute').click(); e.preventDefault(); return; }
    if (e.key.toLowerCase() === 'l' && isVideo) { $('videoPlayMode').click(); e.preventDefault(); return; } // L151：L 键改为切换播放模式
    // 上下方向键：音量增减（步长 5%）
    if (e.key === 'ArrowUp' && isVideo) {
      const cur = Number($('videoVol').value);
      const v = Math.min(100, cur + 5);
      $('videoVol').value = v;
      $('videoVol').dispatchEvent(new Event('input'));
      e.preventDefault(); return;
    }
    if (e.key === 'ArrowDown' && isVideo) {
      const cur = Number($('videoVol').value);
      const v = Math.max(0, cur - 5);
      $('videoVol').value = v;
      $('videoVol').dispatchEvent(new Event('input'));
      e.preventDefault(); return;
    }
    // Q / E：视频快退 / 快进，步长取设置
    const k = e.key.toLowerCase();
    if ((k === 'q' || k === 'e') && isVideo) {
      const step = Number(state.cfg?.videoSeekStep ?? 10);
      const curPos = mpvPlaying ? mpvPosition : (vVideo.currentTime || 0);
      const target = k === 'q' ? Math.max(0, curPos - step) : curPos + step;
      if (mpvPlaying) mpvCtl('seek', target);
      else if (vVideo.duration) vVideo.currentTime = Math.min(target, vVideo.duration);
      e.preventDefault(); return;
    }
    return;
  }


  // 表演中：Esc 优先退出画廊表演（在沉浸模式检查之前）
  if (perf.active && e.key === 'Escape') { exitPerf(); e.preventDefault(); return; }

  // 沉浸模式：Esc 退出
  if (document.body.classList.contains('immersive') && e.key === 'Escape') {
    setImmersive(false); e.preventDefault(); return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  // 常规多选键盘操作
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { selectAll(); e.preventDefault(); return; }
  if (e.key === 'Escape') { selectNone(); return; }

  // 文件操作：Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴 / Del 删除
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === 'c') { copySelection(false); e.preventDefault(); return; }
    if (k === 'x') { copySelection(true); e.preventDefault(); return; }
    if (k === 'v') { pasteInto(state.currentDir); e.preventDefault(); return; }
  }
  // DEL=回收站（无提示）；Shift+DEL=永久删除（带确认）
  if (e.key === 'Delete') { deleteSelection(e.shiftKey); e.preventDefault(); return; }
  // 重命名仅保留右键菜单入口（F2 快捷键已移除，释放给画廊表演设置面板）


  // 本地可配置快捷键优先
  for (const [action, combo] of Object.entries(ls)) {
    if (matchShortcut(combo, e)) { runAction(action); e.preventDefault(); return; }
  }
  // L125：画廊模式方向键 / WASD 只控制视口导航（平滑滚动），不切换选中文件
  if ((state.cfg?.viewMode ?? 'grid') === 'gallery') {
    const r = scroller.getBoundingClientRect();
    const step = state.cfg?.galleryScrollStep ?? 0.05; // 视口尺寸的比例（默认 5%）
    const sx = r.width * step, sy = r.height * step;
    const gKey = e.key.toLowerCase();
    let left = 0, top = 0;
    if (e.key === 'ArrowRight' || gKey === 'd') left = sx;
    else if (e.key === 'ArrowLeft' || gKey === 'a') left = -sx;
    if (e.key === 'ArrowDown' || gKey === 's') top = sy;
    else if (e.key === 'ArrowUp' || gKey === 'w') top = -sy;
    if (left !== 0 || top !== 0) {
      scroller.scrollBy({ left, top, behavior: 'smooth' });
      e.preventDefault(); return;
    }
  }
  // 固定补充：方向键导航 + F5 刷新
  switch (e.key) {
    case 'ArrowRight': moveSel(1, 0); break;
    case 'ArrowLeft': moveSel(-1, 0); break;
    case 'ArrowDown': moveSel(0, 1); break;
    case 'ArrowUp': moveSel(0, -1); break;
    case 'Home': select(0); break;

    case 'End': select(state.filtered.length - 1); break;
    case 'F5': if (state.currentDir) openDirectory(state.currentDir); break;
  }
});

function moveSel(dx, dy) {
  const n = state.filtered.length;
  if (!n) return;
  let idx = state.selected < 0 ? 0 : state.selected;
  if ((state.cfg?.viewMode ?? 'grid') === 'grid') {
    const cols = gridCols();
    idx += dy !== 0 ? dy * cols : dx;
  } else {
    idx += dx || dy;
  }
  idx = Math.max(0, Math.min(n - 1, idx));
  select(idx);
  const node = content.querySelector(`[data-idx="${idx}"]`);
  if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ═══════════════ 滚动监听 ═══════════════
let rafPending = false;
scroller.addEventListener('scroll', () => {
  // L37：滚动中不暂停仍在视野内的预览；
  // rAF 内仅暂停已完全离开视野的视频，停止 250ms 后对齐可见性
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderVirtual();
      pauseOffscreenPreviews();
    });
  }
});
// resize 节流：拖动窗口边框/最大化切换会高频触发 resize，每次重建 DOM + IPC
// 会让 UI 线程忙不过来，造成卡顿。150ms trailing debounce 让动作结束后一次性同步
let resizeT = null;
let resizeRafPending = false;
window.addEventListener('resize', () => {
  // rAF 内做 DOM 重建，避免阻塞 resize 事件本身
  if (!resizeRafPending) {
    resizeRafPending = true;
    requestAnimationFrame(() => {
      resizeRafPending = false;
      renderVirtual();
    });
  }
  resizeT = setTimeout(() => {
    jsDiag(`resize inner=${window.innerWidth}x${window.innerHeight} scrollerClientH=${scroller.clientHeight}`);
  }, 150);
});


// ═══════════════ 设置弹窗 ═══════════════
$('btnSettings').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closeSettings);
$('settingsBackdrop').addEventListener('click', closeSettings);

function openSettings() {
  syncSettingsUI();
  switchTab('appearance');
  $('settingsModal').classList.remove('hidden');
  refreshCacheStats();
}

function closeSettings() {
  $('settingsModal').classList.add('hidden');
  saveCfg();
}

function switchTab(id) {
  document.querySelectorAll('.settingsTab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.settingsPage').forEach((p) => {
    p.classList.toggle('hidden', p.id !== `tab-${id}`);
  });
}

document.querySelectorAll('.settingsTab').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

/** 打开弹窗时把 cfg 同步到控件（L93：外观项按当前生效主题读取） */
function syncSettingsUI() {
  const c = state.cfg;
  $('setOpacity').value = Math.round((eff('windowOpacity') ?? 1) * 100);
  $('setOpacityVal').textContent = Math.round((eff('windowOpacity') ?? 1) * 100) + '%';
  $('setWallpaperPath').textContent = c.wallpaperPath
    ? (c.wallpaperPath === BUILTIN_WALLPAPER ? 'wallpaper.jpg（内置默认）' : c.wallpaperPath.split(/[\\/]/).pop())
    : '未选择';
  $('setWallpaperToggle').classList.toggle('on', !!eff('wallpaperEnabled'));
  $('setWallpaperOpacity').value = Math.round((eff('wallpaperOpacity') ?? 1) * 100);
  $('setWallSat').value = eff('wallSaturation') ?? 100; // L192
  $('setWallSatVal').textContent = (eff('wallSaturation') ?? 100) + '%';
  $('setWallBri').value = eff('wallBrightness') ?? 100;
  $('setWallBriVal').textContent = (eff('wallBrightness') ?? 100) + '%';
  $('setBlur').value = eff('backgroundBlur') ?? 0;
  $('setMaskColor').value = eff('maskColor') || '#0f172a';
  $('setMaskOpacity').value = Math.round((eff('maskOpacity') ?? 0) * 100);
  $('setTheme').value = c.theme ?? 'dark';
  $('setMica').classList.toggle('on', eff('micaEnabled') !== false);
  $('setAccent').value = eff('accentColor') || '#0ea5e9';

  $('setCacheDir').textContent = c.cacheDir || '默认（%APPDATA%）';
  $('setCacheLimit').value = c.cacheLimitMb ?? 512;
  $('setLru').classList.toggle('on', !!c.lruEnabled);
  $('setFfmpegN').value = c.ffmpegConcurrency ?? 2;
  $('setOverscan').value = c.overscan ?? 2;
  $('setGalleryGap').value = c.galleryGap ?? 14; // L156
  $('setGalleryGapVal').textContent = (c.galleryGap ?? 14) + 'px';
  $('setGalleryScrollStep').value = Math.round((c.galleryScrollStep ?? 0.05) * 100);
  $('setGalleryScrollStepVal').textContent = Math.round((c.galleryScrollStep ?? 0.05) * 100) + '%';
  $('setDblClick').value = c.doubleClickAction ?? 'viewer';
  $('setVideoAutoplay').classList.toggle('on', c.videoAutoplay !== false);
  $('setVideoAutoplayN').value = c.videoAutoplayLimit ?? 0;
  $('setVideoWheel').classList.toggle('on', c.videoWheelSwitch !== false);
  $('setVideoSeekStep').value = c.videoSeekStep ?? 10;
  $('setScreenshotHotkey').value = c.screenshotHotkey ?? 'F11';
  $('setScreenshotDir').textContent = c.screenshotDir || '默认（项目/screenshots）';
  $('setCardVolume').value = c.cardVolume ?? 20; // L238
  $('setCardVolumeVal').textContent = Math.round(c.cardVolume ?? 20) + '%';
  $('setHideCursor').classList.toggle('on', c.autoHideCursor !== false); // L241
  $('setImmersionFs').classList.toggle('on', c.immersiveFullscreen !== false);
  $('setTreeCount').classList.toggle('on', c.treeFolderCount !== false);
  // L336：目录树系统/隐藏文件夹过滤
  $('setTreeHideSystem').classList.toggle('on', c.treeHideSystem !== false);
  $('setTreeShowHidden').classList.toggle('on', c.treeShowHidden === true);
  $('setListMeta').classList.toggle('on', c.listViewMeta !== false); // L341
  refreshFfmpegStatus();

  $('setHotkey').value = c.globalHotkey ?? 'Shift+S';
  renderShortcutList();
}

// ─── 外观 TAB：全部实时预览 + 节流保存（L93：外观项写入当前生效主题的覆盖） ───
$('setOpacity').addEventListener('input', (e) => {
  setEff('windowOpacity', Number(e.target.value) / 100);
  $('setOpacityVal').textContent = e.target.value + '%';
  applyAppearance();
  saveCfg();
});
$('setWallpaperPick').addEventListener('click', async () => {
  try {
    state.cfg.wallpaperPath = await invoke('pick_wallpaper'); // 壁纸路径共享
    if (!eff('wallpaperEnabled')) setEff('wallpaperEnabled', true);
    syncSettingsUI();
    applyAppearance();
    saveCfg();
  } catch (err) { if (!String(err).includes('未选择')) setStatus(String(err), true); }
});
$('setWallpaperToggle').addEventListener('click', (e) => {
  if (!state.cfg.wallpaperPath) return; // 未选壁纸时不可开
  const on = !eff('wallpaperEnabled');
  setEff('wallpaperEnabled', on);
  e.target.classList.toggle('on', on);
  applyAppearance();
  saveCfg();
});
$('setWallpaperOpacity').addEventListener('input', (e) => {
  setEff('wallpaperOpacity', Number(e.target.value) / 100);
  applyAppearance();
  saveCfg();
});
$('setBlur').addEventListener('input', (e) => {
  setEff('backgroundBlur', Number(e.target.value));
  applyAppearance();
  saveCfg();
});
// L192：壁纸饱和度 / 亮度
$('setWallSat').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  setEff('wallSaturation', v);
  $('setWallSatVal').textContent = v + '%';
  applyAppearance();
  saveCfg();
});
$('setWallBri').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  setEff('wallBrightness', v);
  $('setWallBriVal').textContent = v + '%';
  applyAppearance();
  saveCfg();
});
$('setMaskColor').addEventListener('input', (e) => {
  setEff('maskColor', e.target.value);
  applyAppearance();
  saveCfg();
});
$('setMaskOpacity').addEventListener('input', (e) => {
  setEff('maskOpacity', Number(e.target.value) / 100);
  applyAppearance();
  saveCfg();
});
$('setTheme').addEventListener('change', (e) => {
  state.cfg.theme = e.target.value;
  applyAppearance(); // L93：切换后按新主题读取各自参数
  syncSettingsUI();  // 控件值跟随新主题刷新
  saveCfg();
});
$('setMica').addEventListener('click', (e) => {
  const on = !eff('micaEnabled');
  setEff('micaEnabled', on);
  e.target.classList.toggle('on', on);
  applyAppearance();
  saveCfg();
});
$('setAccent').addEventListener('input', (e) => {
  setEff('accentColor', e.target.value);
  applyAppearance();
  saveCfg();
});

// ─── L239：默认外观（深/浅两套参数 + 壁纸路径）的保存与恢复 ───
$('btnSaveAppearanceDefault').addEventListener('click', () => {
  const c = state.cfg;
  c.appearanceDefaults = {
    wallpaperPath: c.wallpaperPath ?? null,
    dark: JSON.parse(JSON.stringify(c.appearanceDark ?? {})),
    light: JSON.parse(JSON.stringify(c.appearanceLight ?? {})),
  };
  saveCfg();
  showTopToast('当前外观已存为默认（深/浅两套）');
});
$('btnRestoreAppearanceDefault').addEventListener('click', () => {
  const d = state.cfg.appearanceDefaults;
  if (!d || (d.dark == null && d.light == null)) {
    setStatus('尚未保存过默认外观', true);
    return;
  }
  if (d.wallpaperPath) state.cfg.wallpaperPath = d.wallpaperPath;
  if (d.dark) state.cfg.appearanceDark = JSON.parse(JSON.stringify(d.dark));
  if (d.light) state.cfg.appearanceLight = JSON.parse(JSON.stringify(d.light));
  saveCfg();
  applyAppearance();
  syncSettingsUI();
  showTopToast('已恢复默认外观');
});

// ─── 行为 TAB ───
/** ffmpeg 检测状态展示 */
async function refreshFfmpegStatus() {
  const el = $('ffmpegStatus');
  const manual = state.cfg?.ffmpegPath;
  el.textContent = '检测中…';
  try {
    const info = await invoke('detect_ffmpeg');
    if (info.found) {
      const ver = info.version ? info.version.replace(/^ffmpeg version /i, '').split(' ').slice(0, 2).join(' ') : '';
      el.textContent = (manual ? '手动：' : '自动：') + (info.path || '') + (ver ? `（v${ver}）` : '');
      el.classList.remove('text-red-400');
    } else {
      el.textContent = manual ? `手动路径无效：${manual}` : '未找到 ffmpeg——请安装后加入 PATH，或点击「手动指定」';
      el.classList.add('text-red-400');
    }
  } catch (e) {
    el.textContent = '检测失败: ' + e;
    el.classList.add('text-red-400');
  }
}
$('setFfmpegDetect').addEventListener('click', () => { refreshFfmpegStatus(); });
$('setFfmpegPick').addEventListener('click', async () => {
  try {
    const p = await invoke('pick_ffmpeg');
    state.cfg.ffmpegPath = p;
    saveCfg();
    refreshFfmpegStatus();
  } catch (err) { if (!String(err).includes('未选择')) setStatus(String(err), true); }
});
$('setFfmpegClear').addEventListener('click', () => {
  state.cfg.ffmpegPath = '';
  saveCfg();
  refreshFfmpegStatus();
});
$('setVideoAutoplay').addEventListener('click', (e) => {
  state.cfg.videoAutoplay = !(state.cfg.videoAutoplay !== false);
  e.target.classList.toggle('on', state.cfg.videoAutoplay);
  syncAutoplayBtn(); // L123：同步工具栏按钮点亮态
  if (state.cfg.videoAutoplay === false) {
    // 关闭开关：移除所有卡片预览视频与控制条，并释放池
    clearTimeout(autoPreviewTimer);
    content.querySelectorAll('video.auto-preview, .card-ctrl').forEach((n) => n.remove());
    clearPreviewPool();
  } else {
    scheduleAutoPreviews(); // 重新打开：立即恢复视野内预览
  }
  saveCfg();
});
$('setVideoAutoplayN').addEventListener('input', (e) => {
  state.cfg.videoAutoplayLimit = Math.max(0, Math.min(64, Number(e.target.value) || 0));
  enforceAutoPreviewLimit(); // 收紧时立即裁剪超出的预览
  scheduleAutoPreviews();   // 放宽时补充挂载
  saveCfg();
});
$('setVideoWheel').addEventListener('click', (e) => {
  state.cfg.videoWheelSwitch = !(state.cfg.videoWheelSwitch !== false);
  e.target.classList.toggle('on', state.cfg.videoWheelSwitch);
  saveCfg();
});
$('setVideoSeekStep').addEventListener('change', (e) => {
  state.cfg.videoSeekStep = Number(e.target.value);
  saveCfg();
});
$('setScreenshotHotkey').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.blur(); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  state.cfg.screenshotHotkey = parts.join('+');
  e.target.value = state.cfg.screenshotHotkey;
  saveCfg();
});
$('setScreenshotDirPick').addEventListener('click', async () => {
  try {
    const dir = await invoke('pick_cache_dir');
    if (dir) {
      state.cfg.screenshotDir = dir;
      $('setScreenshotDir').textContent = dir;
      saveCfg();
    }
  } catch (e) { setStatus(`选择失败：${e}`, true); }
});
// L238：画廊卡片音量（Ctrl+M 取消静音时使用该音量）
$('setCardVolume').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  state.cfg.cardVolume = v;
  $('setCardVolumeVal').textContent = v + '%';
  applyCardAudioGlobal(); // 现存卡片即时跟随
  saveCfg();
});
// L241：鼠标静止自动隐藏指针
$('setHideCursor').addEventListener('click', (e) => {
  state.cfg.autoHideCursor = !(state.cfg.autoHideCursor !== false);
  e.target.classList.toggle('on', state.cfg.autoHideCursor);
  if (state.cfg.autoHideCursor) document.body.classList.remove('cursor-idle');
  saveCfg();
});
$('setImmersionFs').addEventListener('click', (e) => {
  state.cfg.immersiveFullscreen = !(state.cfg.immersiveFullscreen !== false);
  e.target.classList.toggle('on', state.cfg.immersiveFullscreen);
  saveCfg();
});
$('setTreeCount').addEventListener('click', async (e) => {
  state.cfg.treeFolderCount = !(state.cfg.treeFolderCount !== false);
  e.target.classList.toggle('on', state.cfg.treeFolderCount);
  await renderTree(); // 立即重绘目录树
  saveCfg();
});
// L336：隐藏系统文件夹 / 显示隐藏文件夹——切换后重绘树并恢复当前目录定位
$('setTreeHideSystem').addEventListener('click', async (e) => {
  state.cfg.treeHideSystem = !(state.cfg.treeHideSystem !== false);
  e.target.classList.toggle('on', state.cfg.treeHideSystem);
  await renderTree();
  if (state.currentDir) revealInTree(state.currentDir).catch(() => {});
  saveCfg();
});
$('setTreeShowHidden').addEventListener('click', async (e) => {
  state.cfg.treeShowHidden = !state.cfg.treeShowHidden;
  e.target.classList.toggle('on', state.cfg.treeShowHidden);
  await renderTree();
  if (state.currentDir) revealInTree(state.currentDir).catch(() => {});
  saveCfg();
});
// L341：列表视图信息列开关——切换后立即重绘文件区
$('setListMeta').addEventListener('click', (e) => {
  state.cfg.listViewMeta = !(state.cfg.listViewMeta !== false);
  e.target.classList.toggle('on', state.cfg.listViewMeta);
  renderVirtual();
  saveCfg();
});
$('setCacheDirPick').addEventListener('click', async () => {
  try {
    state.cfg.cacheDir = await invoke('pick_cache_dir');
    $('setCacheDir').textContent = state.cfg.cacheDir;
    saveCfg();
    refreshCacheStats();
  } catch (err) { if (!String(err).includes('未选择')) setStatus(String(err), true); }
});
$('setCacheLimit').addEventListener('input', (e) => {
  state.cfg.cacheLimitMb = Number(e.target.value) || 0;
  saveCfg();
});
$('setLru').addEventListener('click', (e) => {
  state.cfg.lruEnabled = !state.cfg.lruEnabled;
  e.target.classList.toggle('on', state.cfg.lruEnabled);
  saveCfg();
});
$('setFfmpegN').addEventListener('input', (e) => {
  state.cfg.ffmpegConcurrency = Math.max(1, Math.min(16, Number(e.target.value) || 2));
  saveCfg(); // 后端保存时自动应用并发
});
$('setOverscan').addEventListener('input', (e) => {
  state.cfg.overscan = Math.max(1, Math.min(20, Number(e.target.value) || 2));
  renderVirtual();
  saveCfg();
});
// L156：画廊卡片间隔（默认 14px = 调整前的现状）
$('setGalleryGap').addEventListener('input', (e) => {
  const v = Math.max(4, Math.min(32, Number(e.target.value) || 14));
  state.cfg.galleryGap = v;
  $('setGalleryGapVal').textContent = v + 'px';
  applyGalleryGap();
  saveCfg();
});
$('setGalleryScrollStep').addEventListener('input', (e) => {
  const pct = Number(e.target.value) || 5;
  state.cfg.galleryScrollStep = pct / 100;
  $('setGalleryScrollStepVal').textContent = pct + '%';
  saveCfg();
});
function applyGalleryGap() {
  document.documentElement.style.setProperty('--gallery-gap', (state.cfg?.galleryGap ?? 14) + 'px');
  if (state.cfg?.viewMode === 'gallery') layoutGalleryNow(); // L236：间距变化重排
}
$('setDblClick').addEventListener('change', (e) => {
  state.cfg.doubleClickAction = e.target.value;
  saveCfg();
});
$('setCacheClear').addEventListener('click', async () => {
  try {
    await invoke('clear_thumbnail_cache');
    state.thumbCache.clear(); // 内存缓存同步失效
    state.thumbFailed.clear();

    invalidateRender();       // 缩略图已失效：强制重建（渲染签名无法感知缓存变化）
    renderVirtual();
    refreshCacheStats();
  } catch (err) { setStatus(String(err), true); }
});

async function refreshCacheStats() {
  try {
    const s = await invoke('get_cache_stats');
    $('cacheStats').textContent = `${s.fileCount} 个文件 · ${fmtSize(s.totalBytes)}`;
  } catch {
    $('cacheStats').textContent = '统计失败';
  }
}

// ─── 快捷键 TAB ───
// 全局热键捕获输入框
$('setHotkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  if (e.key === 'Escape') { e.target.blur(); return; }
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return; // 只按修饰键不生效
  key = key.length === 1 ? key.toUpperCase() : key;
  state.cfg.globalHotkey = [...parts, key].join('+');
  e.target.value = state.cfg.globalHotkey;
  saveCfg(); // 保存时后端自动重注册热键
});

// 本地快捷键列表
function renderShortcutList() {
  const ls = state.cfg.localShortcuts ?? {};
  $('shortcutList').innerHTML = Object.entries(ACTION_NAMES).map(([action, label]) => `
    <div class="shortcutRow">
      <span>${label}</span>
      <input class="settingsInput w-40 text-center" readonly data-scaction="${action}"
             placeholder="点击后按键" value="${escapeAttr(ls[action] || '')}">
    </div>`).join('');
  // 捕获逻辑
  $('shortcutList').querySelectorAll('input[data-scaction]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { e.target.blur(); return; }
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      let key = e.key;
      key = key.length === 1 ? key.toLowerCase() : key;
      const combo = [...parts, key].join('+');
      state.cfg.localShortcuts[inp.dataset.scaction] = combo;
      // 避免与其它动作冲突：同组合键的动作清空
      for (const [a, v] of Object.entries(state.cfg.localShortcuts)) {
        if (a !== inp.dataset.scaction && v === combo) state.cfg.localShortcuts[a] = '';
      }
      renderShortcutList();
      saveCfg();
    });
  });
}

// ─── 关于 TAB ───
$('btnCheckUpdate').addEventListener('click', () => {
  $('aboutMsg').textContent = `当前版本 v${APP_VERSION}，已是最新版本。`;
});
$('btnResetAll').addEventListener('click', async () => {
  if (!confirm('确定要重置全部设置吗？收藏、外观、快捷键等都将恢复默认。')) return;
  try {
    await invoke('reset_config');
    location.reload(); // 重新加载即读取默认配置
  } catch (err) { setStatus(String(err), true); }
});

// ═══════════════ 配置持久化（节流） ═══════════════
let saveTimer;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.cfg) return;
    try {
      await invoke('save_config', { cfg: state.cfg });
    } catch (e) {
      // 热键注册失败等：提示但不清空配置
      if (String(e).includes('HotKey')) setStatus('热键注册失败（可能被占用）', true);
    }
  }, 600);
}

// ═══════════════ 工具函数 ═══════════════
function setStatus(msg, isErr = false) {
  const el = $('statusText');
  el.textContent = msg || '';
  el.classList.toggle('text-red-400', isErr);
}

/** 顶部短暂文字提示（截图等操作后显示，约 1.2 秒后淡出） */
let topToastTimer = null;
function showTopToast(msg) {
  // 预览器打开时显示在预览器内部顶部，否则显示在主窗口顶部
  const el = !$('viewer').classList.contains('hidden') ? $('viewerToast') : $('topToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  if (topToastTimer) clearTimeout(topToastTimer);
  topToastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 1200);
}

function kindIcon(kind) {
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${d}</svg>`;
  if (kind === 'folder') return svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
  if (kind === 'image') return svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-9 9"/>');
  if (kind === 'video') return svg('<polygon points="6 3 20 12 6 21 6 3"/>');
  return svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
}

/** 前端扩展名 → 媒体大类（集锦箱图标用；与 Rust utils.rs 保持一致） */
function kindOf(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (['jpg','jpeg','png','webp','avif','gif','bmp','tiff','tif','heic'].includes(ext)) return 'image';
  if (['mp4','mov','mkv','webm','avi','ts','rm','rmvb'].includes(ext)) return 'video';
  if (['mp3','wav','flac','aac','ogg','m4a'].includes(ext)) return 'audio';
  return 'folder';
}

function kindLabel(kind) {
  return kind === 'folder' ? '文件夹' : kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
}


function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${u[i]}`;
}

function fmtDur(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

// L341：列表视图「修改时间」列（Unix 秒 → YYYY-MM-DD HH:mm）
function fmtDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'); }

// ═══════════════ 画廊表演（F1 进出 / F2 设置面板 / 空格暂停 / Esc 退出） ═══════════════
// 三个模式：waterfall 瀑布流自动滚动 | cards 卡片动画视口定格快切 | array 随机阵列视口快切跳动
const perf = {
  active: false,
  paused: false,
  mode: 'waterfall',
  rafId: 0,            // 瀑布流 rAF
  lastTs: 0,           // rAF 时间戳（算 dt）
  dir: 1,              // 瀑布流当前方向（回弹翻转）
  scrollAccum: 0,      // 亚像素滚动累积（低速时每帧不足 1px 也不会卡死）
  dwellUntil: 0,       // 触底停留截止时间戳
  timer: 0,            // 卡片动画 / 随机阵列 interval
  deck: [],            // 卡片动画洗牌后的本轮牌堆（索引）
  deckPos: 0,          // 牌堆游标
  activatedImmersive: false, // 表演带入的沉浸模式（退出时仅还原自己开启的）
};

function perfCfg() {
  return state.cfg?.galleryPerf ?? {
    mode: 'waterfall', waterfallSpeed: 120, waterfallDirection: 'down',
    waterfallBottom: 'bounce', waterfallDwell: 1, waterfallScrollMode: 'smooth',
    cardsCount: 0, cardsInterval: 2, cardsNoRepeat: true, cardsFade: 450,
    cardsAnim: 'zoomIn', cardsSync: true, cardsSyncMin: 0, cardsSyncMax: 2000,
    cardsRandomFx: false, cardsRandomCount: false, cardsCountMin: 3, cardsCountMax: 12,
    cardsRandom: false, cardsFit: 'full',
    arrayInterval: 2, arrayAnim: 'zoomIn', arrayRandomFx: false,
    slideCount: 0, slideInterval: 5, slideDuration: 0.9,
    slideEffect: 'kenburns', slideRandomFx: true, slideIncludeVideo: false,
    slideRandom: false,
    coverInterval: 2.5, coverEffect: 'zoom', coverRandomFx: false, coverSideCount: 3,
    coverRandom: false,
    mute: true,
  };
}

/** 画廊表演的媒体池：排除文件夹/音频（无画面） */
function perfMedia() {
  return state.filtered.filter((it) => it.kind === 'image' || it.kind === 'video');
}
/** 幻灯片素材池：图片与视频均参与（视频直接播放） */
function perfSlideMedia() {
  return perfMedia();
}

/** 高质量图源：图片直接用原文件（清晰），视频走播放池直接播放 */
function perfFullSrc(item) {
  if (item.kind === 'image') return convertFileSrc(item.path);
  return '';
}
const PERF_VIDEO_THUMB = 1280;

// ─── 表演图片预加载队列：path -> Image 对象，已加载的进内存，展示时零闪烁 ───
const perfImgPool = new Map();
const PERF_IMG_MAX = 24; // 预加载图片上限（防内存膨胀）
function perfPreloadImage(path) {
  if (perfImgPool.has(path)) return;
  const im = new Image();
  im.decoding = 'async';
  im.src = convertFileSrc(path);
  perfImgPool.set(path, im);
  if (perfImgPool.size > PERF_IMG_MAX) {
    const first = perfImgPool.keys().next().value;
    perfImgPool.delete(first);
  }
}
/** 从预加载池取图；命中则直接复用 Image 对象（已缓存），未命中则创建并返回 */
function perfTakeImage(path) {
  return perfImgPool.get(path) || null;
}
/** 预加载一组媒体路径（图片才走 img 预载；视频走 perfEnsureVideo 池） */
function perfPreloadMedia(items) {
  for (const it of items) {
    if (!it) continue;
    if (it.kind === 'image') perfPreloadImage(it.path);
    else if (it.kind === 'video') perfEnsureVideo(it.path).catch(() => {});
  }
}

/**
 * 随机图片队列：维护一个不断补充的随机媒体队列。
 * 队列中的媒体都已预加载（图片进 perfImgPool，视频进 perfVidPool），
 * 调用方取出即播，完全无加载延迟。
 * - queueRef: 挂在 perf 对象上的字段名（每个模式独立队列）
 * - list: 完整媒体池
 * - n: 本次取几张
 */
function perfRandomQueue(queueRef, list, n) {
  if (!list.length) return [];
  if (!perf[queueRef]) perf[queueRef] = [];
  const q = perf[queueRef];
  // 队列水位低：补充一批新的随机媒体（不重复最近 5 张避免连续重复）
  while (q.length < n + 4) {
    const recent = new Set(q.slice(-5).map((x) => x.path));
    const avail = list.filter((it) => !recent.has(it.path));
    if (!avail.length) break;
    const pick = avail[Math.floor(Math.random() * avail.length)];
    q.push(pick);
    // 后台异步预加载（不阻塞主流程）
    if (pick.kind === 'image') perfPreloadImage(pick.path);
    else if (pick.kind === 'video') perfEnsureVideo(pick.path).catch(() => {});
  }
  // 再预加载队列中未来几张（确保轮到它们时已加载完成）
  perfPreloadMedia(q.slice(0, Math.min(q.length, n + 4)));
  return q.splice(0, n);
}

// ─── 表演视频预判播放队列：提前创建/缓冲 video，展示即播；离队暂停、超量回收 ───
// path -> { v: HTMLVideoElement, last: 时间戳 }。元素可在容器间移动（src 保留不重载）。
const perfVidPool = new Map();
const PERF_VID_MAX = 20;  // 同时缓冲的视频上限（当前展示 + 预判队列）
const PERF_PREFETCH = 6; // 预判未来多少个媒体位

/** 确保池中已有某视频（离屏即可开始缓冲，不播放） */
async function perfEnsureVideo(path) {
  let e = perfVidPool.get(path);
  if (e) return e;
  const playPath = await playableVideoSrc(path);
  // await 期间可能已被退出表演清空
  if (!perf.active) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = convertFileSrc(playPath);
  e = { v, last: 0 };
  perfVidPool.set(path, e);
  perfTrimPool();
  return e;
}

/** 把视频挂进展示容器并起播（命中池则同步挂载，零加载延迟；未命中走异步兜底） */
function perfShowVideo(path, host) {
  const attach = (e) => {
    if (!e || !perf.active || !host.isConnected) return;
    e.last = performance.now();
    // 裸元素挂载：清掉在别的模式（如幻灯片）残留的 class/样式
    e.v.className = '';
    e.v.removeAttribute('style');
    e.v.muted = perfCfg().mute !== false;
    if (e.v.parentElement !== host) host.appendChild(e.v);
    // 就绪检查：readyState>=2 有当前帧数据才能播；否则等 canplay 再起播，避免黑屏
    const markReady = () => e.v.classList.add('ready');
    if (e.v.readyState >= 2) {
      markReady();
      e.v.play().catch(() => {});
    } else {
      e.v.addEventListener('canplay', () => {
        markReady();
        if (e.v.isConnected && perf.active) e.v.play().catch(() => {});
      }, { once: true });
      e.v.load(); // 主动触发加载（某些浏览器对未显式 load 的 video 不预取）
    }
  };
  // 同步快速路径：池中已缓冲（预加载队列已提前完成 playableVideoSrc + 视频元素创建）
  const cached = perfVidPool.get(path);
  if (cached) { attach(cached); return; }
  // 异步兜底：未预加载（罕见，如预加载队列被 LRU 挤出），等加载完成再挂
  perfEnsureVideo(path).then(attach).catch(() => {});
}

/** 暂停所有已脱离展示容器的池内视频（保留缓冲以便复用） */
function perfPauseDetached() {
  for (const e of perfVidPool.values()) {
    if (!e.v.isConnected) e.v.pause();
  }
}

/** LRU 回收：超出上限的最久未用视频释放解码器与缓冲 */
function perfTrimPool() {
  if (perfVidPool.size <= PERF_VID_MAX) return;
  const extra = [...perfVidPool.entries()]
    .filter(([, e]) => !e.v.isConnected)
    .sort((a, b) => a[1].last - b[1].last);
  let n = perfVidPool.size - PERF_VID_MAX;
  for (const [p, e] of extra) {
    if (n-- <= 0) break;
    e.v.pause();
    e.v.removeAttribute('src');
    try { e.v.load(); } catch { /* 忽略 */ }
    perfVidPool.delete(p);
  }
}

/**
 * 预判队列：wanted 为「当前展示 + 未来即将展示」的路径序列。
 * 提前创建缓冲视频；不在队列中的离屏视频随后会被暂停/回收。
 */
function perfPrefetch(wanted) {
  const vids = wanted.filter((p) => kindOf(p) === 'video').slice(0, PERF_VID_MAX);
  const set = new Set(vids);
  for (const p of vids) {
    if (!perfVidPool.has(p)) perfEnsureVideo(p).then(() => perfTrimPool()).catch(() => {});
  }
  for (const [p, e] of perfVidPool) {
    if (!set.has(p) && !e.v.isConnected) e.v.last = Math.min(e.last, performance.now() - 1);
  }
  perfTrimPool();
}

/** 洗牌牌堆中从当前游标起未来 n 个媒体路径（预判用） */
function perfUpcoming(list, n = PERF_PREFETCH) {
  const out = [];
  for (let i = 0; i < n && perf.deckPos + i < perf.deck.length; i++) {
    const it = list[perf.deck[perf.deckPos + i]];
    if (it) out.push(it.path);
  }
  return out;
}

/** 退出表演：停掉并释放全部表演视频 */
function perfClearVideos() {
  for (const e of perfVidPool.values()) {
    e.v.pause();
    e.v.removeAttribute('src');
    try { e.v.load(); } catch { /* 忽略 */ }
  }
  perfVidPool.clear();
}

function enterPerf() {
  if (perf.active) return;
  if (!$('viewer').classList.contains('hidden')) return; // 预览器打开时不进表演
  if (!state.currentDir || !perfMedia().length) { setStatus('当前目录没有可表演的媒体', true); return; }
  perf.active = true;
  perf.paused = false;
  // 非画廊视图：自动切换到画廊（表演依赖瀑布流布局与卡片预览）
  if ((state.cfg?.viewMode ?? 'grid') !== 'gallery') {
    state.cfg.viewMode = 'gallery';
    applyViewMode();
  }
  // 复用沉浸模式：隐藏顶栏/侧栏，只留文件区；仅记录自己开启的，退出时还原
  perf.activatedImmersive = !document.body.classList.contains('immersive');
  if (perf.activatedImmersive) setImmersive(true);
  if (perfCfg().mute) muteAllCardPreviews();
  startPerfMode(perfCfg().mode || 'waterfall');
  showTopToast('画廊表演中 · F2 设置 · 1-5/Tab 切模式 · 空格 暂停 · F1/Esc 退出');
}

function exitPerf() {
  if (!perf.active) return;
  perf.active = false;
  perf.paused = false;
  stopPerfTimers();
  previewSuspend.perf = false;
  perfClearVideos(); // 释放表演视频队列
  const overlay = $('perfOverlay');
  overlay.classList.add('hidden');
  overlay.classList.remove('perf-overlay');
  scroller.classList.remove('perf-bg-blur');
  scroller.style.filter = '';
  scroller.style.transform = '';
  overlay.innerHTML = '';
  closePerfSettings();
  if (perf.activatedImmersive) { setImmersive(false); perf.activatedImmersive = false; }
  // 恢复视野内画廊预览播放
  scheduleAutoPreviews();
}

function togglePerfPause() {
  perf.paused = !perf.paused;
  showTopToast(perf.paused ? '表演已暂停（空格继续）' : '表演继续');
  if (perf.paused) {
    pauseAllCardPreviews();
    for (const e of perfVidPool.values()) e.v.pause(); // 弹卡视频一并暂停
  } else {
    // 继续：当前在展示容器内的表演视频恢复播放
    for (const e of perfVidPool.values()) if (e.v.isConnected) e.v.play().catch(() => {});
    scheduleAutoPreviews();
  }
}

function muteAllCardPreviews() {
  content.querySelectorAll('video.auto-preview').forEach((v) => { v.muted = true; });
}

// ─── L238：全局卡片音量/静音（设置/快捷键统一入口） ───
/** 把配置里的卡片音量与静音态同步到所有现存预览视频（含池中复用实例）及其控件 UI */
function applyCardAudioGlobal() {
  const vol = Math.min(1, Math.max(0, (state.cfg?.cardVolume ?? 20) / 100));
  const muted = state.cfg?.cardMuted !== false;
  const syncOne = (v, ctrl) => {
    v.volume = vol;
    v.muted = muted;
    if (!ctrl) return;
    const s = ctrl.querySelector('.card-vol');
    if (s && document.activeElement !== s) s.value = muted ? 0 : Math.round(vol * 100);
    const b = ctrl.querySelector('.card-ctl-btn');
    if (b) b.innerHTML = (muted || vol === 0) ? CARD_VOL_OFF : CARD_VOL_ON;
  };
  content.querySelectorAll('video.auto-preview').forEach((v) => {
    syncOne(v, v.closest('.thumb-box')?.querySelector('.card-ctrl') ?? null);
  });
  for (const e of previewPool.values()) syncOne(e.v, e.ctrl);
}

/** 翻转全局卡片静音（默认快捷键 Ctrl+M，可配置） */
function toggleCardMute() {
  state.cfg.cardMuted = state.cfg.cardMuted === false; // undefined/true → false；false → true
  applyCardAudioGlobal();
  saveCfg();
  showTopToast(state.cfg.cardMuted
    ? '卡片预览已静音'
    : `卡片预览已开启 · 音量 ${Math.round((state.cfg.cardVolume ?? 20))}%`);
}

function stopPerfTimers() {
  if (perf.rafId) { cancelAnimationFrame(perf.rafId); perf.rafId = 0; }
  if (perf.timer) { clearTimeout(perf.timer); clearInterval(perf.timer); perf.timer = 0; }
}

/** 循环切换表演模式：Tab 键 / 模式 TAB 点击均走这里 */
const PERF_MODES = ['waterfall', 'cards', 'array', 'slideshow', 'cover'];
function perfCycleMode(step = 1) {
  const cur = PERF_MODES.indexOf(perf.mode);
  const next = PERF_MODES[(cur + step + PERF_MODES.length) % PERF_MODES.length];
  const c = ensurePerfCfg();
  c.mode = next;
  saveCfg();
  syncPerfUI();
  startPerfMode(next);
  showTopToast('模式：' + ({ waterfall: '瀑布流', cards: '卡片动画', array: '阵列图案', slideshow: '幻灯片', cover: '封面流' })[next]);
}

/** 切换/启动表演模式（设置面板 TAB 选中即调用） */
function startPerfMode(mode) {
  stopPerfTimers();
  perf.mode = mode;
  const overlay = $('perfOverlay');
  // 定格类模式（卡片动画 / 阵列图案 / 幻灯片 / 封面流）用覆盖层；瀑布流看真实画廊
  const overlayModes = ['cards', 'array', 'slideshow', 'cover'];
  const isOverlay = overlayModes.includes(mode);
  overlay.classList.toggle('hidden', !isOverlay);
  // 必须显式挂 perf-overlay：背景模糊/压暗样式全靠它（初始 HTML 上没有）
  overlay.classList.toggle('perf-overlay', isOverlay);
  overlay.dataset.mode = isOverlay ? mode : '';
  overlay.innerHTML = '';
  // 弹卡模式：暂停底层画廊的全部预览，只播覆盖层内的媒体；切回滚动模式再恢复
  previewSuspend.perf = isOverlay;
  // 直接模糊+锁定画廊本体（覆盖层拦截点击，scroller 锁交互兜底，滚轮也传不过去）
  // 类 + 内联双保险：类负责 pointer-events，内联 filter 优先级最高，任何样式顺序都压不掉
  scroller.classList.toggle('perf-bg-blur', isOverlay);
  // 内联兜底与 CSS 同理拆开：scale() 写进 filter 是非法值，整条会被浏览器丢弃
  scroller.style.filter = isOverlay ? 'blur(15px)' : '';
  scroller.style.transform = isOverlay ? 'scale(1.06)' : '';
  if (isOverlay) pauseAllCardPreviews();
  if (!isOverlay) {
    perfClearVideos();
    scheduleAutoPreviews();
  }
  if (mode === 'waterfall') startWaterfall();
  else if (mode === 'cards') startCardsAnim();
  else if (mode === 'array') startRandomArray();
  else if (mode === 'slideshow') startSlideshow();
  else startCoverFlow();
}

// ─── 模式1 瀑布流：视口自动滚动（rAF 平滑 / setInterval 随机跳动） ───
function startWaterfall() {
  const c = perfCfg();
  perf.scrollMode = c.waterfallScrollMode === 'jump' ? 'jump' : 'smooth';
  perf.dir = c.waterfallDirection === 'up' ? -1 : 1;
  // 方向向上时从底部开始滚
  if (perf.dir < 0) scroller.scrollTop = scroller.scrollHeight;
  perf.lastTs = performance.now();
  perf.dwellUntil = 0;
  perf.scrollAccum = 0;
  perf._lastPreviewSync = 0;
  if (perf.scrollMode === 'jump') {
    // 随机跳动：整合旧随机阵列逻辑，跳动速度用 arrayInterval 控制
    jumpRandomViewport();
    scheduleWaterfallJumpTimer();
    return;
  }
  const tick = (ts) => {
    if (!perf.active || perf.mode !== 'waterfall') return;
    const dt = Math.min(0.1, (ts - perf.lastTs) / 1000); // 失焦恢复时限幅，避免一次跳很远
    perf.lastTs = ts;
    if (!perf.paused && ts >= perf.dwellUntil) {
      const cc = perfCfg();
      // 亚像素累积：浏览器 scrollTop 只接受整数，逐帧小数会被丢弃，
      // 导致低速（约 90px/s 以下）看起来完全不动
      perf.scrollAccum += perf.dir * cc.waterfallSpeed * dt;
      const whole = Math.trunc(perf.scrollAccum);
      if (whole !== 0) {
        scroller.scrollTop += whole;
        perf.scrollAccum -= whole;
      }
      const max = scroller.scrollHeight - scroller.clientHeight;
      const hitBottom = perf.dir > 0 && scroller.scrollTop >= max - 1;
      const hitTop = perf.dir < 0 && scroller.scrollTop <= 1;
      if (hitBottom || hitTop) {
        if (cc.waterfallBottom === 'bounce') { perf.dir = -perf.dir; perf.scrollAccum = 0; }
        else scroller.scrollTop = perf.dir > 0 ? 0 : max;          // 从头：跳回起点
        perf.dwellUntil = ts + (cc.waterfallDwell ?? 1) * 1000;
      }
    }
    // 视频保活：持续滚动时 scroll 事件的 250ms 防抖永不触发，
    // 这里每 400ms 直接对齐一次挂载/起播（不等滚动停止），配合外扩带提前播放
    if (!perf.paused && ts - perf._lastPreviewSync > 400) {
      perf._lastPreviewSync = ts;
      setupAutoPreviews();
    }
    perf.rafId = requestAnimationFrame(tick);
  };
  perf.rafId = requestAnimationFrame(tick);
}

/** 瀑布流 jump 模式：定时随机跳动视口 */
function scheduleWaterfallJumpTimer() {
  if (perf.timer) { clearTimeout(perf.timer); clearInterval(perf.timer); perf.timer = 0; }
  const arm = (ms) => {
    perf.timer = setTimeout(() => {
      if (!perf.active || perf.mode !== 'waterfall') return;
      if (perf.paused) { arm(250); return; }
      jumpRandomViewport();
      arm(Math.max(500, (perfCfg().arrayInterval ?? 2) * 1000));
    }, ms);
  };
  arm(Math.max(500, (perfCfg().arrayInterval ?? 2) * 1000));
}

// 滚轮直接控制瀑布流方向（被动监听，不 preventDefault：现有手动滚动完全不受限制）
scroller.addEventListener('wheel', (e) => {
  if (!perf.active || perf.mode !== 'waterfall' || perf.paused) return;
  if (!e.deltaY) return;
  if (perf.scrollMode === 'jump') return; // 随机跳动模式下滚轮只负责浏览，不改变方向
  perf.dir = e.deltaY > 0 ? 1 : -1;
  perf.dwellUntil = 0;
  perf.scrollAccum = 0;
  const c = ensurePerfCfg();
  c.waterfallDirection = perf.dir > 0 ? 'down' : 'up';
  const sel = $('perfWfDirection');
  if (sel) sel.value = c.waterfallDirection; // 设置面板同步显示
  saveCfg();
}, { passive: true });

// ─── 模式2 卡片动画：视口定格，卡片随机快切（去重洗牌 / 多种动画 / 错峰随机） ───
/** 估算"缩放显示的默认数量"：当前列宽下一屏能容纳的卡片数 */
function perfDefaultCount() {
  const colW = galleryColW(state.cfg?.galleryThumbSize ?? 260);
  const W = scroller.clientWidth || window.innerWidth;
  const H = scroller.clientHeight || window.innerHeight;
  const cols = Math.max(1, Math.floor(W / colW));
  const rows = Math.max(1, Math.round(H / colW));
  return Math.min(24, cols * rows);
}

/** Fisher-Yates 洗牌（通用：对给定素材列表洗牌，牌堆存索引） */
function perfShuffle(list) {
  const n = list.length;
  perf.deck = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [perf.deck[i], perf.deck[j]] = [perf.deck[j], perf.deck[i]];
  }
  perf.deckPos = 0;
}

/** 取素材：开启去重走洗牌牌堆，一轮用完重洗；关闭则纯随机 */
function perfNext(list) {
  if (!list.length) return null;
  if (!perfCfg().cardsNoRepeat) return list[Math.floor(Math.random() * list.length)];
  if (perf.deckPos >= perf.deck.length) perfShuffle(list);
  return list[perf.deck[perf.deckPos++]];
}

/** 媒体宽高比（缩略图元数据优先，未知按横竖类型兜底；forced=true 表示用了兜底） */
/** 图片真实宽高比缓存：path -> {w, h}。装箱前由 perfEnsureAspect 主动填充 */
const perfRealAspect = new Map();
function perfAspect(item) {
  // 优先取真实宽高比（perfRealAspect），其次缩略图元数据，最后兜底
  const real = perfRealAspect.get(item.path);
  if (real) return { w: real.w, h: real.h, forced: false };
  const t = thumbAny(item.path);
  const w = t?.w || item.width, h = t?.h || item.height;
  if (w > 0 && h > 0) return { w, h, forced: false };
  return item.kind === 'video' ? { w: 16, h: 9, forced: true } : { w: 1, h: 1, forced: true };
}

/** 主动加载图片拿真实宽高比（视频走 thumbAny 兜底），结果写入 perfRealAspect */
async function perfEnsureAspect(item) {
  if (perfRealAspect.has(item.path)) return;
  if (item.kind !== 'image') return; // 视频用 16:9 兜底，由 perfShowVideo 后续自适应
  if (!perfAspect(item).forced) return; // 已有元数据
  await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      if (im.naturalWidth > 0 && im.naturalHeight > 0) {
        perfRealAspect.set(item.path, { w: im.naturalWidth, h: im.naturalHeight });
      }
      resolve();
    };
    im.onerror = () => resolve();
    im.src = convertFileSrc(item.path);
  });
}

/**
 * 卡片动画铺设：整洁 + 大小有节奏差异 + 铺满。
 *
 * full（完整显示，contain 不裁切）：
 *   动态规划找最优行分组 → 每组按比例分配高度 → 每行反向缩放让宽度恰好铺满。
 *   框比=图比，contain 紧贴无留白；行高自然差异（如首行高、末行矮），不强制统一。
 *
 * fill（铺满，cover 兜底）：
 *   宽高比自适应递归二分 treemap：横图给横框、竖图给竖框，
 *   每次沿能使子框宽高比最接近子集媒体均值的方向切割。绝大多数框比≈图比，
 *   cover 裁切量最小化；仅极端宽高比图（如全景/长条）才需明显裁切。
 */
function perfJustified(picked, W, H, gap, pad, fit = 'full') {
  if (!picked.length) return [];
  const availW = W - pad * 2;
  const availH = H - pad * 2;
  const n = picked.length;
  const AR = picked.map((it) => { const a = perfAspect(it); return a.w / a.h; });

  // ─── fill：宽高比自适应 treemap ───
  if (fit === 'fill') {
    const boxes = [];
    function split(items, x, y, w, h) {
      if (!items.length) return;
      if (items.length === 1) {
        boxes.push({ item: items[0].it, x: x + gap / 2, y: y + gap / 2, w: w - gap, h: h - gap });
        return;
      }
      // 子集平均宽高比
      const mid = Math.ceil(items.length / 2);
      const L = items.slice(0, mid), R = items.slice(mid);
      const avgArL = L.reduce((s, o) => s + o.ar, 0) / L.length;
      const avgArR = R.reduce((s, o) => s + o.ar, 0) / R.length;
      // 候选 A：垂直切（左右分）。左框宽 lw，右框宽 w-lw。
      //   让 lw/w = mid/n，则左框 AR = (lw)/(h)，右框 AR = (w-lw)/h
      // 候选 B：水平切（上下分）。上框 AR = w/th，下框 AR = w/(h-th)
      // 评分：子框 AR 与子集媒体平均 AR 的偏差（log 比例越小越好）
      const lwA = w * mid / items.length;
      const scoreA = Math.abs(Math.log((lwA / h) / avgArL)) + Math.abs(Math.log(((w - lwA) / h) / avgArR));
      const thB = h * mid / items.length;
      const scoreB = Math.abs(Math.log((w / thB) / avgArL)) + Math.abs(Math.log((w / (h - thB)) / avgArR));
      if (scoreA <= scoreB) {
        split(L, x, y, lwA, h);
        split(R, x + lwA, y, w - lwA, h);
      } else {
        split(L, x, y, w, thB);
        split(R, x, y + thB, w, h - thB);
      }
    }
    split(picked.map((it, i) => ({ it, ar: AR[i] })), pad, pad, availW, availH);
    return boxes;
  }

  // ─── full：DP 最优行分组 + 行高比例分配 ───
  // step 1：DP 找最优行数 R
  // cost(i,j) = 第 i..j 张图组成一行时，铺满 availW 所需行高
  // totalH(R 行分组) = sum(行高) + (R-1)*gap，选 ≤ availH 且最大
  const cost = [];
  for (let i = 0; i < n; i++) {
    cost[i] = [];
    let sumAR = 0;
    for (let j = i; j < n; j++) {
      sumAR += AR[j];
      const gaps = (j - i) * gap;
      cost[i][j] = (availW - gaps) / sumAR;
    }
  }
  // dp[j] = 前 j 张图分成若干行，总高度 ≤ availH 时的最大高度
  // prev[j] = 第 j 张图所在行的起始索引
  const dp = new Array(n + 1).fill(-1);
  const prev = new Array(n + 1).fill(-1);
  dp[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      if (dp[i] < 0) continue;
      const rowH = cost[i][j - 1];
      const newTotal = dp[i] + rowH + (i > 0 ? gap : 0);
      if (newTotal <= availH && newTotal > dp[j]) {
        dp[j] = newTotal;
        prev[j] = i;
      }
    }
  }
  // 回溯得到行分组
  let rows = [];
  if (dp[n] >= 0) {
    let j = n;
    while (j > 0) {
      const i = prev[j];
      rows.unshift({ start: i, end: j - 1, height: cost[i][j - 1] });
      j = i;
    }
  } else {
    // 兜底：单行 + 行高不超 availH
    rows = [{ start: 0, end: n - 1, height: Math.min(cost[0][n - 1], availH) }];
  }

  // step 2：如果 DP 结果行数过少（单行但多图），强制分行
  if (rows.length === 1 && n > 1) {
    // 用理想行数强制分组
    const R = Math.max(2, Math.min(n, Math.round(Math.sqrt(n * availH / availW))));
    rows = [];
    const per = Math.ceil(n / R);
    for (let i = 0; i < n; i += per) {
      const end = Math.min(n - 1, i + per - 1);
      rows.push({ start: i, end, height: cost[i][end] });
    }
  }

  // step 3：高度按比例缩放到 availH
  const totalNat = rows.reduce((s, r) => s + r.height, 0) + (rows.length - 1) * gap;
  const scale = totalNat > 0 ? availH / totalNat : 1;
  // full 模式：仅在缩小或微调（≤1.02x）时应用 scale，避免放大后行宽不足
  const finalScale = Math.min(scale, 1.02);

  // step 4：生成 boxes
  const out = [];
  let y = pad;
  rows.forEach((row) => {
    const rh = row.height * finalScale;
    // 行内：每张图宽度 = rh * AR，反向缩放让总宽 = availW
    const items = picked.slice(row.start, row.end + 1);
    const sumAR = items.reduce((s, it) => { const a = perfAspect(it); return s + a.w / a.h; }, 0);
    const rowW = rh * sumAR + (items.length - 1) * gap;
    // 若行宽 ≠ availW（因 finalScale ≠ 1 或取整），反向缩放让宽度铺满
    const adjRh = rh * (availW - (items.length - 1) * gap) / (rh * sumAR);
    let x = pad;
    items.forEach((it) => {
      const a = perfAspect(it);
      const bw = adjRh * (a.w / a.h);
      out.push({ item: it, x, y, w: bw, h: adjRh });
      x += bw + gap;
    });
    y += adjRh + gap;
  });
  return out;
}

function startCardsAnim() {
  perfShuffle(perfMedia());
  dealCardsFrame(); // 立即铺第一帧
  scheduleCardsTimer();
}

/** 本帧停留时长：错峰开启时 +0~100% 随机；保底 ≥ 入场动画(淡入+错峰上限)+300ms 凝视 */
function cardsFrameDelay() {
  const c = perfCfg();
  const base = Math.max(300, (c.cardsInterval ?? 2) * 1000);
  const ms = c.cardsSync ? base + Math.random() * base : base;
  const floor = (c.cardsFade ?? 450)
    + (c.cardsSync ? Math.max(0, c.cardsSyncMax ?? 2000) : 0) + 300;
  return Math.max(ms, floor);
}

function scheduleCardsTimer() {
  if (perf.timer) { clearTimeout(perf.timer); perf.timer = 0; }
  const arm = (ms) => {
    perf.timer = setTimeout(() => {
      if (!perf.active || perf.mode !== 'cards') return;
      if (perf.paused) { arm(250); return; } // 暂停期间空转等待，不推进画面
      dealCardsFrame();
      arm(cardsFrameDelay());
    }, ms);
  };
  arm(cardsFrameDelay());
}

/** 卡片节点内容：图片走原文件保证清晰；视频交给播放池直接播放（见 dealCardsFrame） */
function perfCardInner(item) {
  const src = perfFullSrc(item);
  if (src) return `<img src="${src}" alt="" draggable="false" decoding="async">`;
  // 视频：先放缩略图占位（避免首次黑屏），perfShowVideo ready 后 video 覆盖在上面
  // thumbAny 返回 {url, duration, w, h} 对象，需取 .url
  const thumb = thumbAny(item.path)?.url || '';
  const cover = thumb ? `<img src="${thumb}" alt="" draggable="false" decoding="async" class="perf-vid-cover">` : '';
  return `<div class="perf-vid" data-perf-video="${escapeAttr(item.path)}">${cover}</div>`;
}

/**
 * 取本帧候选媒体（不立即消耗牌堆）：
 * 去重模式从洗牌牌堆当前游标顺序窥视；随机模式做帧内不重复抽样。
 * consume(n) 由调用方在确定实际用量后结算。
 */
function perfCandidates(list, maxN) {
  if (perfCfg().cardsNoRepeat !== false) {
    const items = [];
    for (let i = 0; i < maxN && perf.deckPos + i < perf.deck.length; i++) {
      const it = list[perf.deck[perf.deckPos + i]];
      if (it) items.push(it);
    }
    return {
      items,
      consume: (n) => {
        perf.deckPos += n;
        if (perf.deckPos >= perf.deck.length) perfShuffle(list); // 本轮用尽，下帧从新牌堆开始
      },
    };
  }
  const idx = Array.from({ length: list.length }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return { items: idx.slice(0, Math.min(maxN, idx.length)).map((i) => list[i]), consume: () => {} };
}

/** 快切一帧：真实宽高比的两端对齐布局（不堆叠、占比大）+ 每卡独立入场动画 + 错峰延迟 */
async function dealCardsFrame() {
  const overlay = $('perfOverlay');
  const c = perfCfg();
  const list = perfMedia();
  const myFrame = (perf._frame = (perf._frame || 0) + 1);
  const gap = 6, pad = 8;
  const W = window.innerWidth, H = window.innerHeight;
  // 先取最多 24 个候选，布局前拿到全部真实宽高比
  // （缺元数据时按 1:1/16:9 兜底会导致单行误判；改用 perfEnsureAspect 直接 new Image 拿 naturalWidth）
  const cand = perfCandidates(list, 24);
  await Promise.all(cand.items.map(perfEnsureAspect));
  if (!perf.active || perf.mode !== 'cards' || myFrame !== perf._frame) return;
  let picked;
  // 随机数量开关：开启时每帧在 [cardsCountMin, cardsCountMax] 区间内随机
  let targetCount = c.cardsCount;
  if (c.cardsRandomCount) {
    const lo = Math.max(1, Math.min(50, c.cardsCountMin ?? 3));
    const hi = Math.max(lo, Math.min(50, c.cardsCountMax ?? 12));
    targetCount = lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  if (!(targetCount > 0)) {
    // 自动数量：用固定目标行高（约屏高 1/2.6，一屏 2~3 行大卡）做贪心装箱，
    // 不断加入卡片直到排满视口高度。不能依赖 perfJustified 的结果反推数量——
    // 它为了填满高度会把单张宽图也放大到整行满高，任何"按填充率/总高"的
    // 判断都会停在 n=1，表现为所有卡片挤成中间一行。
    const availW = W - pad * 2;
    const targetRowH = H / 2.6;
    let rows = 1, rowW = 0, n = 0;
    for (let k = 0; k < cand.items.length; k++) {
      const a = perfAspect(cand.items[k]);
      const w = targetRowH * (a.w / a.h);
      if (rowW > 0 && rowW + w + gap > availW) { rows++; rowW = 0; }
      rowW += w;
      n = k + 1;
      if (rows * targetRowH >= (H - pad * 2) * 0.95) break;
    }
    picked = cand.items.slice(0, Math.max(1, n));
  } else {
    picked = cand.items.slice(0, Math.min(24, targetCount));
  }
  if (!picked.length) return;
  // 随机图片开启：从预加载随机队列取（媒体已在后台加载完毕，无白闪）
  if (c.cardsRandom) {
    picked = perfRandomQueue('_cardsQueue', perfMedia(), targetCount);
    if (!picked.length) return;
    // 随机分支：拿队列媒体的真实宽高比
    await Promise.all(picked.map(perfEnsureAspect));
    if (!perf.active || perf.mode !== 'cards' || myFrame !== perf._frame) return;
  } else {
    cand.consume(picked.length);
  }
  const fit = c.cardsFit === 'fill' ? 'fill' : 'full';
  const boxes = perfJustified(picked, W, H, gap, pad, fit);
  overlay.dataset.fit = fit; // CSS 按 data-fit 切换 object-fit
  const dur = Math.max(0, c.cardsFade ?? 450);
  const lo = Math.min(c.cardsSyncMin ?? 0, c.cardsSyncMax ?? 2000);
  const hi = Math.max(lo, c.cardsSyncMax ?? 2000);
  // 每卡独立动画（CSS 用 data-anim 而非 overlay.dataset.anim：保证每帧/每卡都能重新触发）
  const FX_LIST = ['zoomIn', 'zoomOut', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'blur', 'rotateIn', 'expand', 'swing', 'fade'];
  let html = '';
  for (const b of boxes) {
    const anim = c.cardsRandomFx
      ? FX_LIST[Math.floor(Math.random() * FX_LIST.length)]
      : (c.cardsAnim || 'zoomIn');
    // 同步开启：每张卡片独立的随机入场延迟（错峰出现，充满随机）
    const delay = c.cardsSync && dur > 0 ? Math.round(lo + Math.random() * (hi - lo)) : 0;
    html += `<div class="perf-card" data-anim="${anim}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;` +
      `transition-duration:${dur}ms;transition-delay:${delay}ms">${perfCardInner(b.item)}</div>`;
  }
  overlay.innerHTML = html;
  // 视频卡：从预判播放池取出直接播放（命中预缓冲，零起播延迟）
  overlay.querySelectorAll('[data-perf-video]').forEach((n) => {
    perfShowVideo(n.dataset.perfVideo, n);
  });
  // 预判：当前展示 + 牌堆未来序列，提前缓冲视频；旧帧视频脱离容器后暂停
  perfPrefetch([...picked.map((it) => it.path), ...perfUpcoming(list)]);
  perfPauseDetached();
  // 强制 reflow 后加 .on 触发入场过渡
  void overlay.offsetWidth;
  overlay.querySelectorAll('.perf-card').forEach((el) => el.classList.add('on'));
}

// ─── 模式3 阵列图案：弹出式，卡片随机整齐排列成图案（网格/条纹/团簇/环/菱形） ───
const ARRAY_PATTERNS = ['grid', 'rows', 'cols', 'cluster', 'ring', 'diamond'];

function startRandomArray() {
  perfShuffle(perfMedia());
  dealArrayFrame(); // 立即铺第一帧
  scheduleArrayTimer();
}

function scheduleArrayTimer() {
  if (perf.timer) { clearTimeout(perf.timer); perf.timer = 0; }
  const arm = (ms) => {
    perf.timer = setTimeout(() => {
      if (!perf.active || perf.mode !== 'array') return;
      if (perf.paused) { arm(250); return; }
      dealArrayFrame();
      arm(Math.max(300, (perfCfg().arrayInterval ?? 2) * 1000));
    }, ms);
  };
  arm(Math.max(300, (perfCfg().arrayInterval ?? 2) * 1000));
}

/**
 * 生成一帧图案布局：随机一种图案 + 随机数量/大小，返回 [{item,x,y,w,h}]
 * 所有图案都基于网格对齐，保证"随机但整齐"
 */
function arrayPatternLayout(picked, W, H) {
  const pattern = ARRAY_PATTERNS[Math.floor(Math.random() * ARRAY_PATTERNS.length)];
  const pad = 24, gap = 10;
  const availW = W - pad * 2, availH = H - pad * 2;
  const n = picked.length;
  const boxes = [];
  // 通用网格定位：rows × cols 均分布置，返回 cell 中心与尺寸
  const gridCells = (rows, cols, regionW, regionH, offX = 0, offY = 0) => {
    const cw = (regionW - (cols - 1) * gap) / cols;
    const ch = (regionH - (rows - 1) * gap) / rows;
    const cells = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        cells.push({ x: offX + c * (cw + gap), y: offY + r * (ch + gap), w: cw, h: ch });
    return cells;
  };
  if (pattern === 'grid') {
    // 均分网格：行列数随机（2-4 列，1-3 行），卡数 = 行×列
    const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(n))));
    const rows = Math.max(1, Math.ceil(n / cols));
    const cells = gridCells(rows, cols, availW, availH, pad, pad);
    for (let i = 0; i < n; i++) boxes.push({ item: picked[i], ...cells[i] });
  } else if (pattern === 'rows' || pattern === 'cols') {
    // 横向条纹 / 纵向条纹：随机分带数（2-4），每带随机卡数
    const bands = 2 + Math.floor(Math.random() * 3); // 2-4
    const isRows = pattern === 'rows';
    const bandSize = (isRows ? availH : availW) / bands;
    let idx = 0;
    for (let b = 0; b < bands && idx < n; b++) {
      const inBand = Math.max(1, Math.round(n / bands)) + (b < n % bands ? 1 : 0);
      const cells = isRows
        ? gridCells(1, inBand, availW, bandSize - gap, pad, pad + b * bandSize)
        : gridCells(inBand, 1, bandSize - gap, availH, pad + b * bandSize, pad);
      for (let i = 0; i < inBand && idx < n; i++, idx++) boxes.push({ item: picked[idx], ...cells[i] });
    }
  } else if (pattern === 'cluster') {
    // 中央团簇：1 张大主卡（约 1/3 屏）居中，周围环绕小卡（环形排列）
    const mainW = availW * (0.28 + Math.random() * 0.08);
    const mainH = availH * (0.42 + Math.random() * 0.1);
    const mx = pad + (availW - mainW) / 2, my = pad + (availH - mainH) / 2;
    boxes.push({ item: picked[0], x: mx, y: my, w: mainW, h: mainH });
    const ringN = n - 1;
    if (ringN > 0) {
      const cx = pad + availW / 2, cy = pad + availH / 2;
      const rx = mainW / 2 + 90, ry = mainH / 2 + 90;
      const ringW = 130, ringH = 130;
      for (let i = 0; i < ringN; i++) {
        const a = (i / ringN) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * rx - ringW / 2;
        const y = cy + Math.sin(a) * ry - ringH / 2;
        boxes.push({ item: picked[i + 1], x, y, w: ringW, h: ringH });
      }
    }
  } else if (pattern === 'ring') {
    // 环形阵列：卡片均匀分布在圆环上（半径自适应）
    const cx = pad + availW / 2, cy = pad + availH / 2;
    const radius = Math.min(availW, availH) * (0.3 + Math.random() * 0.1);
    const size = Math.max(90, Math.min(180, Math.floor((Math.min(availW, availH) * 0.8) / n)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * radius - size / 2;
      const y = cy + Math.sin(a) * radius - size / 2;
      boxes.push({ item: picked[i], x, y, w: size, h: size });
    }
  } else if (pattern === 'diamond') {
    // 菱形阵列：1-2-3-2-1 或 2-3-2 等菱形行分布
    const rowsSeq = n <= 3 ? [n] : n <= 5 ? [1, n - 2, 1] : n <= 9 ? [1, 2, n - 6 >= 0 ? n - 6 : 2, 2, 1] : [2, 3, n - 10 >= 0 ? n - 10 : 3, 3, 2];
    const rows = rowsSeq.length;
    const maxInRow = Math.max(...rowsSeq);
    const cellH = (availH - (rows - 1) * gap) / rows;
    let idx = 0;
    for (let r = 0; r < rows && idx < n; r++) {
      const inRow = rowsSeq[r];
      const cellW = (availW - (maxInRow - 1) * gap) / maxInRow;
      const rowW = inRow * cellW + (inRow - 1) * gap;
      const startX = pad + (availW - rowW) / 2;
      const y = pad + r * (cellH + gap);
      for (let c = 0; c < inRow && idx < n; c++, idx++) {
        boxes.push({ item: picked[idx], x: startX + c * (cellW + gap), y, w: cellW, h: cellH });
      }
    }
  }
  // 最后按媒体真实宽高比修正每个框（保持整齐的同时让比例不畸形）
  for (const b of boxes) {
    const a = perfAspect(b.item);
    const ar = a.w / a.h;
    const boxAr = b.w / b.h;
    if (Math.abs(ar - boxAr) / boxAr > 0.4) {
      // 差异过大：以高度为基准收缩宽度（保持整齐行高，只调宽度）
      const newW = Math.min(b.w, b.h * ar);
      b.x += (b.w - newW) / 2;
      b.w = newW;
    }
  }
  return boxes;
}

/** 铺一阵列图案帧 */
async function dealArrayFrame() {
  const overlay = $('perfOverlay');
  const c = perfCfg();
  const list = perfMedia();
  const myFrame = (perf._frame = (perf._frame || 0) + 1);
  const W = window.innerWidth, H = window.innerHeight;
  // 随机数量：每次 6-14 张之间浮动（保证每次都不一样）
  const want = 6 + Math.floor(Math.random() * 9);
  const cand = perfCandidates(list, Math.max(want, 14));
  await Promise.all(cand.items.map(async (it) => {
    if (perfAspect(it).forced) { try { await loadThumb(it.path, it.kind, 512); } catch { /* 忽略 */ } }
  }));
  if (!perf.active || perf.mode !== 'array' || myFrame !== perf._frame) return;
  const picked = cand.items.slice(0, want);
  if (!picked.length) return;
  cand.consume(picked.length);
  const boxes = arrayPatternLayout(picked, W, H);
  const dur = Math.max(0, c.cardsFade ?? 450);
  // 每卡独立动画：随机开关开启则每卡随机，否则用统一设置
  const FX_LIST = ['zoomIn', 'zoomOut', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'blur', 'rotateIn', 'expand', 'swing', 'fade'];
  let html = '';
  for (const b of boxes) {
    const anim = c.arrayRandomFx
      ? FX_LIST[Math.floor(Math.random() * FX_LIST.length)]
      : (c.arrayAnim || 'zoomIn');
    const delay = c.cardsSync && dur > 0 ? Math.round(Math.random() * (c.cardsSyncMax ?? 2000)) : 0;
    html += `<div class="perf-card" data-anim="${anim}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;` +
      `transition-duration:${dur}ms;transition-delay:${delay}ms">${perfCardInner(b.item)}</div>`;
  }
  overlay.innerHTML = html;
  overlay.querySelectorAll('[data-perf-video]').forEach((n) => {
    perfShowVideo(n.dataset.perfVideo, n);
  });
  perfPrefetch([...picked.map((it) => it.path), ...perfUpcoming(list)]);
  perfPauseDetached();
  void overlay.offsetWidth;
  overlay.querySelectorAll('.perf-card').forEach((el) => el.classList.add('on'));
}

/** 快切跳动：优先跳到与当前视口无重叠的位置；内容不足一屏则纯随机 */
function jumpRandomViewport() {
  const viewH = scroller.clientHeight;
  const max = scroller.scrollHeight - viewH;
  if (max <= 0) return; // 一屏都装不满：无需跳
  const cur = scroller.scrollTop;
  // 无重叠区间：[0, cur - viewH] ∪ [cur + viewH, max]
  const lo = cur - viewH, hi = cur + viewH;
  const ranges = [];
  if (lo > 0) ranges.push([0, lo]);
  if (hi < max) ranges.push([hi, max]);
  let target;
  if (ranges.length) {
    const [a, b] = ranges[Math.floor(Math.random() * ranges.length)];
    target = a + Math.random() * (b - a);
  } else {
    target = Math.random() * max; // 卡片不够：忽略无重叠条件
  }
  scroller.scrollTop = target; // 快切，无平滑
  // 跳动后等虚拟列表完成重建（两帧）立即挂载新位置视频，不必等 250ms 防抖
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (perf.active && (perf.mode === 'array' || perf.mode === 'waterfall') && !perf.paused) setupAutoPreviews();
  }));
}

// ─── 模式4 幻灯片：1-2 张大图/视频轮流展示，Ken Burns / 平移 / 翻转 / 圆形展开等 ───
const SLIDE_FX = ['kenburns', 'panL', 'panR', 'fade', 'blur', 'flip', 'slideL', 'circle', 'blackout'];
let slideTurn = 0;
let slideDual = false; // 自动模式：当前是否双槽（竖版媒体左右并排）
function startSlideshow() {
  const list = perfSlideMedia();
  if (!list.length) { // 无媒体：提示并回退瀑布流，避免黑屏
    setStatus('当前目录没有可用于幻灯片的媒体', true);
    startPerfMode('waterfall');
    return;
  }
  perfShuffle(list);
  slideTurn = 0;
  slideDual = false;
  const overlay = $('perfOverlay');
  // 0 = 自动：按媒体方向动态切换——竖版媒体左右并排 2 张，横版媒体单张全屏；
  // 强制 2 张时按屏幕方向排列（竖屏窗口上下、横屏窗口左右）
  const cfgN = perfCfg().slideCount | 0;
  const auto = cfgN === 0;
  const portrait = window.innerHeight > window.innerWidth;
  const n = auto ? 2 : Math.min(2, Math.max(1, cfgN)); // 自动模式常驻双槽，按媒体方向显隐
  overlay.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const slot = document.createElement('div');
    slot.className = 'slide-slot';
    if (!auto && n === 2) {
      if (portrait) { slot.style.top = i === 0 ? '0' : '50%'; slot.style.height = '50%'; }
      else { slot.style.left = i === 0 ? '0' : '50%'; slot.style.width = '50%'; }
    }
    overlay.appendChild(slot);
  }
  // 首轮上片：自动模式走 slideTick（按首个媒体方向定单/双槽），固定模式每格先上一张
  if (auto) { layoutSlideSlots(overlay, false); slideTick(overlay, list); }
  else overlay.querySelectorAll('.slide-slot').forEach((s) => swapSlide(s, list));
  perfPrefetch(perfUpcoming(list, 8));
  if (perf.timer) clearInterval(perf.timer);
  perf.timer = setInterval(() => {
    if (perf.paused) return;
    slideTick(overlay, list);
  }, Math.max(500, (perfCfg().slideInterval ?? 5) * 1000));
}

/** 自动模式槽位布局：双槽=左右各半（竖版媒体并排），单槽=全屏（另一槽隐藏） */
function layoutSlideSlots(overlay, dual) {
  overlay.querySelectorAll('.slide-slot').forEach((s, i) => {
    s.style.top = '0'; s.style.height = '100%';
    if (dual) { s.style.display = ''; s.style.left = i === 0 ? '0' : '50%'; s.style.width = '50%'; }
    else { s.style.display = i === 0 ? '' : 'none'; s.style.left = '0'; s.style.width = '100%'; }
  });
}

/** 每个间隔换一次片：固定模式轮槽；自动模式先看媒体方向，竖版切双槽、横版切单槽。
 *  fillOnly=true 表示首轮补位：不再翻转布局，避免一次 tick 内单/双槽来回跳导致两张叠在同一槽 */
function slideTick(overlay, list, fillOnly) {
  const slots = overlay.querySelectorAll('.slide-slot');
  if (!slots.length) return;
  const auto = (perfCfg().slideCount | 0) === 0;
  if (auto) {
    const item = perfNext(list);
    if (!item) return;
    const a = perfAspect(item);
    let wantDual = fillOnly ? slideDual : a.h > a.w; // 竖版媒体：候选左右并排两张
    // 宽度预算：两张并排按屏高折算的自然宽度之和超出屏宽（预留边距与 Ken Burns 运动余量）时，只显示一张
    if (wantDual && !fillOnly) {
      const otherPath = slideDual ? slots[1 - (slideTurn % 2)]?.dataset.path : null;
      const otherItem = otherPath ? list.find((x) => x.path === otherPath) : null;
      const oa = otherItem ? perfAspect(otherItem) : a; // 尚无同伴时按两张同宽估算
      const sumW = window.innerHeight * (a.w / a.h + oa.w / oa.h);
      if (sumW > window.innerWidth * 0.85) wantDual = false;
    }
    if (!fillOnly && wantDual !== slideDual) {
      slideDual = wantDual;
      layoutSlideSlots(overlay, slideDual);
      slideTurn = 0;
      if (!slideDual) {
        // 双槽切单槽：摘下另一槽媒体（视频脱离后由下方 perfPauseDetached 统一暂停）
        const extra = slots[1];
        const m = extra.querySelector('.slide-img');
        if (m) m.remove();
        delete extra.dataset.path;
      }
    }
    const target = slots[slideTurn % (slideDual ? 2 : 1)];
    target.dataset.path = item.path; // 同步占位标记，防止补位判断在视频异步上片前误判空槽
    swapSlide(target, list, item);
    slideTurn++;
    // 刚切成双槽时另一侧还是空的，立即补一张（补位不再翻转布局），避免半屏空白一个间隔
    if (slideDual && !slots[1].dataset.path) slideTick(overlay, list, true);
  } else {
    swapSlide(slots[slideTurn % slots.length], list);
    slideTurn++;
  }
  perfPrefetch(perfUpcoming(list, 8));
  perfPauseDetached();
}

/** 在指定幻灯片槽位替换一个媒体：新图/视频带效果入场，旧媒体过渡后移出（视频回池暂停） */
async function swapSlide(slot, list, forcedItem) {
  const c = perfCfg();
  // 随机图片开启：从预加载随机队列取（已提前加载，无白闪）
  let item = forcedItem;
  if (!item) {
    if (c.slideRandom) {
      const got = perfRandomQueue('_slideQueue', list, 1);
      item = got[0];
    } else {
      item = perfNext(list);
    }
  }
  if (!item) return;
  // 随机动画开关开启：每张独立抽一种；否则用固定效果
  const fx = c.slideRandomFx !== false
    ? SLIDE_FX[Math.floor(Math.random() * SLIDE_FX.length)]
    : (c.slideEffect || 'kenburns');
  const dur = Math.max(0, (c.slideDuration ?? 0.9) * 1000);
  // 多格时每格隔 N 个间隔才轮一次：运镜时长按每格实际停留计算，保持持续运镜
  // 只数可见槽（自动单槽模式下另一槽只是 display:none，不该计入）
  const slotN = Array.from(slot.parentElement.querySelectorAll('.slide-slot')).filter((s) => s.style.display !== 'none').length || 1;
  const holdMs = (c.slideInterval ?? 5) * 1000 * slotN;

  let media;
  if (item.kind === 'video') {
    const e = await perfEnsureVideo(item.path);
    if (!e || !perf.active || !slot.isConnected) return;
    media = e.v; // 复用预判池中已缓冲的视频，搬到槽位即播
  } else {
    media = document.createElement('img');
    media.draggable = false;
    media.decoding = 'async';
    media.src = perfFullSrc(item);
  }
  const old = slot.querySelector('.slide-img');
  if (old) {
    if (old.tagName === 'VIDEO') old.remove();          // 池视频：立即脱离，随后统一暂停
    else { old.classList.add('leave'); setTimeout(() => old.remove(), dur + 100); }
  }
  media.removeAttribute('style');
  media.className = `slide-img fx-${fx}`;
  // Ken Burns 类动画时长 = 停留时长（缓慢运镜）；其余 = 过渡时长
  const animMs = (fx === 'kenburns' || fx === 'panL' || fx === 'panR') ? Math.max(dur, holdMs) : dur;
  media.style.animationDuration = animMs + 'ms';
  media.style.setProperty('--slide-dur', dur + 'ms');
  // Ken Burns 推近：每次随机运镜焦点，画面更有变化
  if (fx === 'kenburns') {
    media.style.transformOrigin = `${20 + Math.random() * 60}% ${20 + Math.random() * 60}%`;
  }
  slot.appendChild(media);
  slot.dataset.path = item.path;
  if (item.kind === 'video') {
    media.muted = c.mute !== false;
    media.play().catch(() => {});
  }
}

// ─── 模式5 封面流（Cover Flow）：卡片与媒体绑定，推进时整排平滑横向流动 ───
function coverVisible() { return Math.max(2, Math.min(4, perfCfg().coverSideCount ?? 3)); }
let coverCenter = 0;
let coverStage = null;
let coverList = [];
let coverCards = new Map(); // idx（媒体在本轮序列中的位置）-> 卡片对象；卡随媒体走
let coverPrevCenter = -99;
const coverPreloadSet = new Set(); // 已预加载的图片 URL

function startCoverFlow() {
  const list = perfMedia();
  if (!list.length) { startPerfMode('waterfall'); return; }
  if (!perfCfg().coverRandom) perfShuffle(list); // 随机图片关闭时按洗牌顺序播放
  coverList = list;
  coverCenter = 0;
  coverPrevCenter = -99;
  coverCards = new Map();
  coverPreloadSet.clear();
  perf._coverQueue = null; // 随机图片队列会动态重建
  const overlay = $('perfOverlay');
  overlay.innerHTML = '<div class="cover-stage"></div>';
  coverStage = overlay.querySelector('.cover-stage');
  renderCover();
  if (perf.timer) clearInterval(perf.timer);
  perf.timer = setInterval(() => {
    if (perf.paused) return;
    if (perfCfg().coverRandom) {
      // 随机图片：从预加载随机队列取出新的中央媒体（已提前加载，无白闪）
      const got = perfRandomQueue('_coverQueue', list, coverVisible() * 2 + 3);
      // 重建 coverList 为这个随机批次
      coverList = got;
      coverCenter++;
      if (coverCenter >= coverList.length) {
        coverCenter = 0;
        for (const card of coverCards.values()) card.el.remove();
        coverCards.clear();
        perfClearVideos();
        coverPreloadSet.clear();
      }
      renderCover();
    } else {
      coverCenter++;
      if (coverCenter >= list.length) {
        // 一轮结束：序列重排，旧卡整体清空重建，避免 idx→媒体映射突变造成的错帧
        for (const card of coverCards.values()) card.el.remove();
        coverCards.clear();
        perfClearVideos();
        coverPreloadSet.clear();
        if (!perfCfg().coverRandom) perfShuffle(list);
        coverCenter = 0;
      }
      renderCover();
    }
  }, Math.max(500, (perfCfg().coverInterval ?? 2.5) * 1000));
}

/** 预加载即将成为中央/侧边的图片进内存，减少切换白闪 */
function coverPreload(idxList) {
  for (const idx of idxList) {
    if (idx < 0 || idx >= coverList.length) continue;
    const item = coverList[idx];
    if (item.kind !== 'image') continue;
    const src = perfFullSrc(item);
    if (!src || coverPreloadSet.has(src)) continue;
    coverPreloadSet.add(src);
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
  }
}

/** 卡框尺寸：在（中央 90vw×92vh，侧位 0.72 倍）最大框内按媒体比例等比贴合，边框即媒体边界 */
function coverApplySize(card, ar, atCenter) {
  if (!ar || ar <= 0 || !isFinite(ar)) return;
  card.ar = ar;
  const k = atCenter ? 1 : 0.72;
  const maxW = window.innerWidth * 0.9 * k;
  const maxH = window.innerHeight * 0.92 * k;
  let h = maxH, w = h * ar;
  if (w > maxW) { w = maxW; h = w / ar; }
  card.el.style.width = `${w.toFixed(1)}px`;
  card.el.style.height = `${h.toFixed(1)}px`;
}

/** 按相对中央的偏移写位移/旋转/透明度（CSS transition 负责平滑补间）
 *  间距/深度/旋转随 coverSideCount 自适应；中央卡加正向 Z 提升，确保它在所有侧卡前面
 *  （侧卡 rotateY 后其近端边缘可能越过 Z=0 平面，必须把中央卡主动推到更前） */
function coverPlace(card, o) {
  const V = coverVisible();
  const abs = Math.min(V + 1, Math.abs(o));
  const inView = Math.abs(o) <= V;
  card.el.style.opacity = inView ? String(1 - Math.min(V, abs) * 0.22) : '0';
  card.el.style.zIndex = String(10 - Math.min(V, abs));
  // V=2 → 间距 38vw / 深度 260 / 旋转 46°；V=4 → 间距 22vw / 深度 150 / 旋转 32°
  const spacing = 46 - V * 6;       // vw 间距
  const depth = 320 - V * 42;       // px z 深度（每后退一级）
  const tilt = 54 - V * 5;          // 旋转角
  const tx = o * spacing;
  // 中央卡前置 80px，离中央越近侧卡越靠前，越远越后退（层级感）
  const tz = o === 0 ? 80 : 80 - abs * depth - 60;
  const ry = o < 0 ? tilt : o > 0 ? -tilt : 0;
  const scale = o === 0 ? 1 : 1 - Math.min(V, abs) * 0.12;
  card.el.style.transform =
    `translate(-50%,-50%) translateX(${tx}vw) translateZ(${tz}px) rotateY(${ry}deg) scale(${scale})`;
}

/** 创建一张与指定媒体绑定的卡片（尺寸/内容一次定型，之后只移动不变内容） */
function createCoverCard(idx) {
  const item = coverList[idx];
  const el = document.createElement('div');
  el.className = 'cover-card';
  el.innerHTML = '<div class="cover-inner"><img alt="" draggable="false"></div>';
  const inner = el.querySelector('.cover-inner');
  const img = el.querySelector('img');
  const card = { idx, el, inner, img, path: item.path, isVideo: item.kind === 'video', ar: 0 };
  const asp = perfAspect(item);
  coverApplySize(card, asp.w / asp.h, idx === coverCenter);
  img.addEventListener('load', () => {
    if (img.naturalWidth > 0) coverApplySize(card, img.naturalWidth / img.naturalHeight, card.idx === coverCenter);
  });
  if (item.kind === 'image') {
    img.src = perfFullSrc(item); // 图片走原文件，保证清晰
  } else {
    // 侧位视频用高清封面帧；滑到中央时才换成池视频直接播放
    const cached = thumbAny(item.path);
    if (cached) {
      img.src = cached.url;
      if (cached.w > 0) coverApplySize(card, cached.w / cached.h, idx === coverCenter);
    }
    loadThumb(item.path, item.kind, PERF_VIDEO_THUMB).then((t) => {
      if (t && card.path === item.path) {
        img.src = t.url;
        if (t.w > 0) coverApplySize(card, t.w / t.h, card.idx === coverCenter);
      }
    });
  }
  return card;
}

function renderCover() {
  const list = coverList;
  const wanted = new Set();
  const V = coverVisible();
  // 1) 目标范围 ±VISIBLE：已有卡移动到新偏移；新卡先放屏外再两帧归位（横向滑入）
  for (let idx = coverCenter - V - 1; idx <= coverCenter + V + 1; idx++) {
    if (idx < 0 || idx >= list.length) continue;
    wanted.add(idx);
    let card = coverCards.get(idx);
    if (!card) {
      card = createCoverCard(idx);
      card.idx = idx;
      coverCards.set(idx, card);
      const side = idx < coverCenter ? -1 : 1;
      coverPlace(card, side * (V + 1)); // 挂载即位于屏外
      coverStage.appendChild(card.el);
      requestAnimationFrame(() => requestAnimationFrame(() => coverPlace(card, idx - coverCenter)));
    } else {
      coverPlace(card, idx - coverCenter); // 同一张卡：偏移变化 → transition 平滑流动
    }
  }
  // 2) 离场卡：滑出屏外并淡出，过渡结束再移除
  for (const [idx, card] of Array.from(coverCards)) {
    if (!wanted.has(idx)) {
      const side = idx < coverCenter ? -1 : 1;
      coverPlace(card, side * (V + 1));
      card.el.style.opacity = '0';
      coverCards.delete(idx);
      setTimeout(() => card.el.remove(), 700);
    }
  }
  // 3) 中央视频进播放池；退到侧位的视频摘除并恢复封面；卡框随中央/侧位身份平滑缩放
  for (const card of coverCards.values()) {
    const atCenter = card.idx === coverCenter;
    const hasV = !!card.inner.querySelector('video');
    if (card.isVideo && atCenter && !hasV) {
      card.img.style.display = 'none';
      perfShowVideo(card.path, card.inner);
      const pv = card.inner.querySelector('video');
      if (pv) {
        const fit = () => { if (pv.videoWidth > 0) coverApplySize(card, pv.videoWidth / pv.videoHeight, true); };
        if (pv.readyState >= 1) fit();
        else pv.addEventListener('loadedmetadata', fit, { once: true });
      }
    } else if (card.isVideo && !atCenter && hasV) {
      card.inner.querySelector('video').remove(); // 脱离即由 perfPauseDetached 暂停
      card.img.style.display = '';
    }
    coverApplySize(card, card.ar, atCenter);
  }
  // 4) 新登基的中央卡：播放所选切换特效（作用于 inner，不影响卡片位移动画）
  //    触发方式：animation:none 内联重置 + reflow + 清空内联让 CSS 类接管 ——
  //    比 className 重写更可靠（同名类重复赋值时浏览器不一定重启动画）
  const centerCard = coverCards.get(coverCenter);
  if (centerCard && coverPrevCenter !== coverCenter) {
    const c = perfCfg();
    const COVER_FX_LIST = ['zoom', 'flip', 'slide', 'fade', 'rotate', 'zoomBlur', 'slideUp', 'flipX', 'elastic', 'curtain', 'glow'];
    const fx = c.coverRandomFx
      ? COVER_FX_LIST[Math.floor(Math.random() * COVER_FX_LIST.length)]
      : (c.coverEffect || 'zoom');
    const inner = centerCard.inner;
    inner.style.animation = 'none';         // 强制取消当前动画（如有）
    inner.className = 'cover-inner';        // 同步清掉 fx 类，避免残留
    void inner.offsetWidth;                 // 强制 reflow，让 animation:none 生效
    inner.style.animation = '';             // 清空内联 → CSS 类的 animation 属性接管
    inner.className = `cover-inner cover-pop fx-${fx}`;
  }
  // 退位卡清掉入场特效类与内联：下次登基时干净起步
  for (const card of coverCards.values()) {
    if (card.idx !== coverCenter) {
      if (card.inner.classList.contains('cover-pop') || card.inner.style.animation) {
        card.inner.style.animation = '';
        card.inner.className = 'cover-inner';
      }
    }
  }
  coverPrevCenter = coverCenter;
  perfPauseDetached();
  // 预判：中央 + 推进方向未来几张，提前缓冲，滑到即播
  const upcoming = [];
  for (let i = 0; i < 5 && coverCenter + i < list.length; i++) upcoming.push(list[coverCenter + i].path);
  perfPrefetch(upcoming);
  // 预加载当前可见 ±V+1 的临近图片进内存，减少中央卡切换白闪
  const V2 = coverVisible();
  const preloadIdx = [];
  for (let i = -V2 - 1; i <= V2 + 1; i++) preloadIdx.push(coverCenter + i);
  coverPreload(preloadIdx);
}

// ─── 表演设置面板（半透明居中；主 TAB 选中即切换表演模式） ───
function openPerfSettings() {
  syncPerfUI();
  $('perfModal').classList.remove('hidden');
}
function closePerfSettings() {
  $('perfModal').classList.add('hidden');
  saveCfg();
}

function syncPerfUI() {
  const c = perfCfg();
  document.querySelectorAll('.perfTab').forEach((b) =>
    b.classList.toggle('active', b.dataset.perf === (c.mode || 'waterfall')));
  document.querySelectorAll('.perfPage').forEach((p) =>
    p.classList.toggle('hidden', p.id !== `perf-${c.mode || 'waterfall'}`));
  // 瀑布流
  $('perfWfSpeed').value = c.waterfallSpeed ?? 120;
  $('perfWfSpeedVal').textContent = (c.waterfallSpeed ?? 120) + 'px/s';
  const scrollMode = c.waterfallScrollMode === 'jump' ? 'jump' : 'smooth';
  const wfScrollMode = $('perfWfScrollMode'); if (wfScrollMode) wfScrollMode.value = scrollMode;
  $('perfWfDirection').value = c.waterfallDirection ?? 'down';
  $('perfWfBottom').value = c.waterfallBottom ?? 'bounce';
  $('perfWfDwell').value = c.waterfallDwell ?? 1;
  $('perfWfDwellVal').textContent = (c.waterfallDwell ?? 1) + 's';
  // 跳动速度（jump 模式下用）
  const wfJump = $('perfWfJumpSpeed'); if (wfJump) wfJump.value = c.arrayInterval ?? 2;
  const wfJumpVal = $('perfWfJumpSpeedVal'); if (wfJumpVal) wfJumpVal.textContent = (c.arrayInterval ?? 2) + 's';
  // jump 模式显隐：方向/触底/停留行隐藏，跳动速度行显示
  const wfRowIds = { smooth: ['perfWfDirectionRow', 'perfWfBottomRow', 'perfWfDwellRow'], jump: ['perfWfJumpSpeedRow'] };
  for (const id of [...wfRowIds.smooth, ...wfRowIds.jump]) {
    const el = $(id); if (!el) continue;
    const showInSmooth = wfRowIds.smooth.includes(id);
    el.classList.toggle('hidden', scrollMode === 'jump' ? !wfRowIds.jump.includes(id) : !showInSmooth);
  }
  // 卡片动画
  $('perfCardsCount').value = c.cardsCount ?? 0;
  $('perfCardsInterval').value = c.cardsInterval ?? 2;
  $('perfCardsIntervalVal').textContent = (c.cardsInterval ?? 2) + 's';
  $('perfCardsNoRepeat').classList.toggle('on', c.cardsNoRepeat !== false);
  $('perfCardsFade').value = c.cardsFade ?? 450;
  $('perfCardsFadeVal').textContent = (c.cardsFade ?? 450) + 'ms';
  $('perfCardsAnim').value = c.cardsAnim ?? 'zoomIn';
  $('perfCardsSync').classList.toggle('on', c.cardsSync !== false);
  $('perfCardsSyncMin').value = c.cardsSyncMin ?? 0;
  $('perfCardsSyncMax').value = c.cardsSyncMax ?? 2000;
  $('perfCardsSyncRangeVal').textContent = `${c.cardsSyncMin ?? 0}–${c.cardsSyncMax ?? 2000}ms`;
  // 卡片动画新控件
  const rc = $('perfCardsRandomCount'); if (rc) rc.classList.toggle('on', c.cardsRandomCount === true);
  const cmin = $('perfCardsCountMin'); if (cmin) cmin.value = c.cardsCountMin ?? 3;
  const cmax = $('perfCardsCountMax'); if (cmax) cmax.value = c.cardsCountMax ?? 12;
  const crr = $('perfCardsCountRangeRow'); if (crr) crr.classList.toggle('hidden', c.cardsRandomCount !== true);
  const crf = $('perfCardsRandomFx'); if (crf) crf.classList.toggle('on', c.cardsRandomFx === true);
  const crand = $('perfCardsRandom'); if (crand) crand.classList.toggle('on', c.cardsRandom === true);
  const cfit = $('perfCardsFit'); if (cfit) cfit.value = c.cardsFit === 'fill' ? 'fill' : 'full';
  // 阵列图案
  $('perfArrayInterval').value = c.arrayInterval ?? 2;
  $('perfArrayIntervalVal').textContent = (c.arrayInterval ?? 2) + 's';
  const aa = $('perfArrayAnim'); if (aa) aa.value = c.arrayAnim ?? 'zoomIn';
  const arf = $('perfArrayRandomFx'); if (arf) arf.classList.toggle('on', c.arrayRandomFx === true);
  // 幻灯片
  $('perfSlideCount').value = String(c.slideCount ?? 0);
  $('perfSlideInterval').value = c.slideInterval ?? 5;
  $('perfSlideIntervalVal').textContent = (c.slideInterval ?? 5) + 's';
  $('perfSlideDuration').value = c.slideDuration ?? 0.9;
  $('perfSlideDurationVal').textContent = (c.slideDuration ?? 0.9) + 's';
  $('perfSlideEffect').value = c.slideEffect ?? 'kenburns';
  $('perfSlideRandomFx').classList.toggle('on', c.slideRandomFx !== false);
  const srand = $('perfSlideRandom'); if (srand) srand.classList.toggle('on', c.slideRandom === true);
  // 封面流
  $('perfCoverInterval').value = c.coverInterval ?? 2.5;
  $('perfCoverIntervalVal').textContent = (c.coverInterval ?? 2.5) + 's';
  $('perfCoverEffect').value = c.coverEffect ?? 'zoom';
  const csc = $('perfCoverSideCount'); if (csc) csc.value = String(c.coverSideCount ?? 3);
  const covrf = $('perfCoverRandomFx'); if (covrf) covrf.classList.toggle('on', c.coverRandomFx === true);
  const covrand = $('perfCoverRandom'); if (covrand) covrand.classList.toggle('on', c.coverRandom === true);
  $('perfMute').classList.toggle('on', c.mute !== false);
}

function ensurePerfCfg() {
  if (!state.cfg.galleryPerf) state.cfg.galleryPerf = perfCfg();
  return state.cfg.galleryPerf;
}

document.querySelectorAll('.perfTab').forEach((b) =>
  b.addEventListener('click', () => {
    const c = ensurePerfCfg();
    c.mode = b.dataset.perf; // 选中 TAB 即切换表演模式
    syncPerfUI();
    saveCfg();
    if (perf.active) startPerfMode(c.mode);
  }));
$('perfClose').addEventListener('click', closePerfSettings);
$('perfBackdrop').addEventListener('click', closePerfSettings);

// 模式1 子设置
$('perfWfSpeed').addEventListener('input', (e) => {
  ensurePerfCfg().waterfallSpeed = Number(e.target.value);
  $('perfWfSpeedVal').textContent = e.target.value + 'px/s';
  saveCfg();
});
$('perfWfScrollMode')?.addEventListener('change', (e) => {
  ensurePerfCfg().waterfallScrollMode = e.target.value;
  saveCfg();
  syncPerfUI(); // 显隐 方向/触底 行 vs 跳动速度 行
  if (perf.active && perf.mode === 'waterfall') startPerfMode('waterfall'); // 立即重启模式
});
$('perfWfDirection').addEventListener('change', (e) => {
  ensurePerfCfg().waterfallDirection = e.target.value;
  saveCfg();
  if (perf.active && perf.mode === 'waterfall') startPerfMode('waterfall'); // 方向立即生效
});
$('perfWfBottom').addEventListener('change', (e) => { ensurePerfCfg().waterfallBottom = e.target.value; saveCfg(); });
$('perfWfDwell').addEventListener('input', (e) => {
  ensurePerfCfg().waterfallDwell = Number(e.target.value);
  $('perfWfDwellVal').textContent = e.target.value + 's';
  saveCfg();
});
$('perfWfJumpSpeed')?.addEventListener('input', (e) => {
  ensurePerfCfg().arrayInterval = Number(e.target.value); // 复用 arrayInterval 字段
  $('perfWfJumpSpeedVal').textContent = e.target.value + 's';
  saveCfg();
  if (perf.active && perf.mode === 'waterfall' && perf.scrollMode === 'jump') scheduleWaterfallJumpTimer();
});
// 模式2 子设置（数量/间隔/过渡变化即时生效）
$('perfCardsCount').addEventListener('change', (e) => {
  ensurePerfCfg().cardsCount = Math.max(0, Math.min(24, Number(e.target.value) || 0));
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsInterval').addEventListener('input', (e) => {
  ensurePerfCfg().cardsInterval = Number(e.target.value);
  $('perfCardsIntervalVal').textContent = e.target.value + 's';
  saveCfg();
  if (perf.active && perf.mode === 'cards') scheduleCardsTimer();
});
$('perfCardsNoRepeat').addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.cardsNoRepeat = !(c.cardsNoRepeat !== false);
  e.target.classList.toggle('on', c.cardsNoRepeat);
  saveCfg();
});
$('perfCardsFade').addEventListener('input', (e) => {
  ensurePerfCfg().cardsFade = Number(e.target.value);
  $('perfCardsFadeVal').textContent = e.target.value + 'ms';
  saveCfg();
});
$('perfCardsAnim').addEventListener('change', (e) => {
  ensurePerfCfg().cardsAnim = e.target.value;
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsSync').addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.cardsSync = !(c.cardsSync !== false);
  e.target.classList.toggle('on', c.cardsSync);
  saveCfg();
});
$('perfCardsSyncMin').addEventListener('input', (e) => {
  const c = ensurePerfCfg();
  c.cardsSyncMin = Math.min(Number(e.target.value), c.cardsSyncMax ?? 2000);
  $('perfCardsSyncRangeVal').textContent = `${c.cardsSyncMin}–${c.cardsSyncMax}ms`;
  saveCfg();
});
$('perfCardsSyncMax').addEventListener('input', (e) => {
  const c = ensurePerfCfg();
  c.cardsSyncMax = Math.max(Number(e.target.value), c.cardsSyncMin ?? 0);
  $('perfCardsSyncRangeVal').textContent = `${c.cardsSyncMin}–${c.cardsSyncMax}ms`;
  saveCfg();
});
// 卡片动画：随机数量 / 随机特效
$('perfCardsRandomCount')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.cardsRandomCount = !(c.cardsRandomCount === true);
  e.target.classList.toggle('on', c.cardsRandomCount);
  syncPerfUI(); // 显隐数量范围行
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsCountMin')?.addEventListener('change', (e) => {
  const c = ensurePerfCfg();
  c.cardsCountMin = Math.max(1, Math.min(50, Number(e.target.value) || 3));
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsCountMax')?.addEventListener('change', (e) => {
  const c = ensurePerfCfg();
  c.cardsCountMax = Math.max(1, Math.min(50, Number(e.target.value) || 12));
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsRandomFx')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.cardsRandomFx = !(c.cardsRandomFx === true);
  e.target.classList.toggle('on', c.cardsRandomFx);
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsRandom')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.cardsRandom = !(c.cardsRandom === true);
  e.target.classList.toggle('on', c.cardsRandom);
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
$('perfCardsFit')?.addEventListener('change', (e) => {
  ensurePerfCfg().cardsFit = e.target.value;
  saveCfg();
  if (perf.active && perf.mode === 'cards') dealCardsFrame();
});
// 模式3 子设置
$('perfArrayInterval').addEventListener('input', (e) => {
  ensurePerfCfg().arrayInterval = Number(e.target.value);
  $('perfArrayIntervalVal').textContent = e.target.value + 's';
  saveCfg();
  if (perf.active && perf.mode === 'array') scheduleArrayTimer();
});
$('perfArrayAnim')?.addEventListener('change', (e) => {
  ensurePerfCfg().arrayAnim = e.target.value;
  saveCfg();
  if (perf.active && perf.mode === 'array') dealArrayFrame();
});
$('perfArrayRandomFx')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.arrayRandomFx = !(c.arrayRandomFx === true);
  e.target.classList.toggle('on', c.arrayRandomFx);
  saveCfg();
  if (perf.active && perf.mode === 'array') dealArrayFrame();
});
// 模式4 幻灯片子设置
$('perfSlideCount').addEventListener('change', (e) => {
  ensurePerfCfg().slideCount = Math.max(0, Math.min(2, Number(e.target.value) || 0));
  saveCfg();
  if (perf.active && perf.mode === 'slideshow') startPerfMode('slideshow');
});
$('perfSlideInterval').addEventListener('input', (e) => {
  ensurePerfCfg().slideInterval = Number(e.target.value);
  $('perfSlideIntervalVal').textContent = e.target.value + 's';
  saveCfg();
  if (perf.active && perf.mode === 'slideshow') startPerfMode('slideshow');
});
$('perfSlideDuration').addEventListener('input', (e) => {
  ensurePerfCfg().slideDuration = Number(e.target.value);
  $('perfSlideDurationVal').textContent = e.target.value + 's';
  saveCfg();
});
$('perfSlideEffect').addEventListener('change', (e) => {
  ensurePerfCfg().slideEffect = e.target.value;
  saveCfg(); // 下一张换场即生效，不打断当前播放
});
$('perfSlideRandomFx').addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.slideRandomFx = !(c.slideRandomFx !== false);
  e.target.classList.toggle('on', c.slideRandomFx);
  saveCfg();
});
$('perfSlideRandom')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.slideRandom = !(c.slideRandom === true);
  e.target.classList.toggle('on', c.slideRandom);
  saveCfg();
  if (perf.active && perf.mode === 'slideshow') startPerfMode('slideshow');
});
// 模式5 封面流子设置
$('perfCoverInterval').addEventListener('input', (e) => {
  ensurePerfCfg().coverInterval = Number(e.target.value);
  $('perfCoverIntervalVal').textContent = e.target.value + 's';
  saveCfg();
  if (perf.active && perf.mode === 'cover') startPerfMode('cover');
});
$('perfCoverEffect').addEventListener('change', (e) => {
  ensurePerfCfg().coverEffect = e.target.value;
  saveCfg(); // 下一次推进时生效
});
$('perfCoverSideCount')?.addEventListener('change', (e) => {
  ensurePerfCfg().coverSideCount = Math.max(2, Math.min(4, Number(e.target.value) || 3));
  saveCfg();
  if (perf.active && perf.mode === 'cover') startPerfMode('cover'); // 重建舞台
});
$('perfCoverRandomFx')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.coverRandomFx = !(c.coverRandomFx === true);
  e.target.classList.toggle('on', c.coverRandomFx);
  saveCfg(); // 下一次推进时生效
});
$('perfCoverRandom')?.addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.coverRandom = !(c.coverRandom === true);
  e.target.classList.toggle('on', c.coverRandom);
  saveCfg();
  if (perf.active && perf.mode === 'cover') startPerfMode('cover');
});
// 通用：静音（同时作用于预判播放池中的表演视频）
$('perfMute').addEventListener('click', (e) => {
  const c = ensurePerfCfg();
  c.mute = !(c.mute !== false);
  e.target.classList.toggle('on', c.mute);
  for (const pe of perfVidPool.values()) pe.v.muted = c.mute !== false;
  if (c.mute && perf.active) muteAllCardPreviews();
  saveCfg();
});

// （渲染管线已移除：画廊视频卡片预览统一用 HTML5 <video>，TS 等格式经 get_playable_path 重封装）
const RG = { enabled: false, suppressed: false };

async function initRenderGallery() {}
async function destroyRenderGallery() {}
async function toggleRenderPipeline() {}
function scheduleRenderSync() {}
function boxRadiusCss() { return 0; }
/** 画廊视频卡片同步（渲染管线已移除，卡片预览用 HTML5 video） */
async function syncRenderGallery() {}
window.syncRenderGallery = syncRenderGallery;
