# Rainver 落雨影音

基于Tauri v2 + Rust + HTML/Tailwind 瀑布流画廊媒体查看器（图片 / 视频 / 音频），媒体资源管理器


## 功能

- 图片 (jpg, png, webp, gif, bmp, tiff, heic…) / 视频 (mp4, mov, mkv, webm, avi) / 音频 (mp3, wav, flac, aac, ogg, m4a)
- 网格 / 列表 / 画廊三视图，虚拟滚动（预渲染行数可配置）
- 顶部工具栏：类型筛选 / 排序下拉 / 文件名搜索 / 缩放滑块 / 视图切换
- 左侧面板：磁盘根列表、可折叠目录树、收藏文件夹（添加/移除）、刷新、面包屑导航
- 右侧元信息面板：可开关、拖拽调宽
- 图片缩略图：EXIF 自动旋转，blake3 哈希缓存；视频缩略图：ffmpeg 首帧 + 时长角标，并发任务数可配置
- 音频元信息：标题/艺术家/专辑/时长，内嵌封面提取，无封面生成纯色占位图
- 画廊预览：图片 / 视频播放 / 音频播放，键盘导航
- 设置弹窗（右上角齿轮，TAB 分页）：
  - **外观**：窗口全局不透明度、自定义本地壁纸（透明度/模糊度/遮罩颜色+透明度）、深色/浅色/跟随系统、Mica 开关、强调色——全部实时预览，无应用按钮
  - **行为**：缓存目录选择、缓存大小上限、一键清理、LRU 淘汰开关、ffmpeg 并发数、虚拟滚动参数、双击行为
  - **快捷键**：全局唤起/隐藏热键（默认 Shift+S，点击后按键自定义）、本地快捷键逐项配置
  - **关于**：版本信息、开源说明、检查更新、重置全部设置
- 全局热键 + 系统托盘（关闭即隐藏到托盘）
- 配置持久化（tauri-plugin-store）：全部设置、收藏、窗口几何

## 第三方依赖

- [mpv](https://mpv.io/) (GPL-2.0+) — 视频播放引擎（运行时动态加载）
- [FFmpeg](https://ffmpeg.org/) (LGPL/GPL) — 缩略图生成与媒体元信息
- [web-demuxer](https://github.com/Momo707577045/web-demuxer) (MIT) — 浏览器端解封装
- [Tauri](https://tauri.app/) (MIT/Apache-2.0) — 应用框架
- [Tailwind CSS](https://tailwindcss.com/) (MIT)

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE) 开源。

## 目录结构

```
Rainver/
├── package.json
├── src/                 # 前端
│   ├── index.html       # 无边框标题栏 + 三栏布局 + 画廊预览层
│   ├── main.js          # 虚拟滚动 / 视图 / 热键 / 配置
│   ├── input.css        # Tailwind 源 + 自定义样式
│   ├── style.css        # 构建产物
│   └── vendor/          # @tauri-apps/api ESM（静态服务用）
└── src-tauri/
    ├── tauri.conf.json  # Mica 透明窗口 / CSP / 托盘
    ├── capabilities/default.json
    └── src/
        ├── main.rs      # IPC 注册、托盘、全局热键、启动配置应用（Mica/透明度/LRU）
        ├── fs.rs        # walkdir 扫描 + MediaItem + 磁盘根列表
        ├── thumb.rs     # 缩略图缓存（可配目录/上限/LRU/统计/清理）+ ffmpeg 可配并发
        ├── media_info.rs# 音频标签/封面 + symphonia 时长
        ├── settings.rs  # Mica / Win32 窗口不透明度 / 系统打开
        ├── config.rs    # 全量配置（外观/行为/快捷键/收藏）持久化 + 副作用
        └── utils.rs     # 后缀过滤 / 路径防穿越
```

## 安全约束

- 只读媒体文件，绝不修改/删除原文件；所有缓存写入 `%APPDATA%/com.rainver.app/thumbnails`
- 所有路径经规范化防穿越校验（拒绝 `..` 越界）
- 后端 IO / ffmpeg 均在 `spawn_blocking` 异步任务执行，避免阻塞
- 前端 CSP：`default-src 'self'`，媒体经 asset 协议加载
