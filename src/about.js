// ═══════════════════════════════════════════════════════
// about.js — 「关于」面板的全部文字信息
//   改文案 / 版本号 / 作者信息只改这个文件，无需动 index.html 与 main.js
// ═══════════════════════════════════════════════════════

export const ABOUT = {
  name: 'Rainver 落雨影音',
  version: '0.2.0',
  stack: 'Tauri v2 + Rust + Tailwind',
  intro:
    '专项媒体查看器：图片 / 视频 / 音频浏览与预览。只读设计——绝不修改你的原始媒体文件；' +
    '缩略图与元数据缓存目录可自定义，支持 LRU 自动淘汰。',
  oss:
    '开源说明：本项目基于 MIT 许可的开源组件构建（Tauri、image、symphonia、id3、metaflac、' +
    'mp4ameta、blake3、FFmpeg 等）。FFmpeg 为独立工具，需自行安装并加入 PATH。',
  author: {
    label: 'Bilibili：音乐制作王某人',
    url: 'https://space.bilibili.com/80192671',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 生成「关于」面板正文 HTML（按钮与提示语仍在 index.html） */
export function renderAboutHtml() {
  const a = ABOUT;
  return `
    <div class="flex items-center gap-3">
      <svg class="w-12 h-12 accent-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C8 7 4 10.5 4 15a8 8 0 1 0 16 0c0-4.5-4-8-8-13z"/>
      </svg>
      <div>
        <p class="font-semibold text-base">${esc(a.name)}</p>
        <p class="text-xs opacity-60">版本 ${esc(a.version)} · ${esc(a.stack)}</p>
      </div>
    </div>
    <p class="text-xs opacity-70 leading-relaxed">${esc(a.intro)}</p>
    <div class="border-t border-white/20 dark:border-white/5 pt-3 space-y-1">
      <p class="text-xs font-semibold uppercase tracking-wider opacity-60">作者</p>
      <button id="aboutAuthor" type="button"
              class="text-xs underline text-left hover:opacity-100 opacity-80"
              style="color:var(--accent)">${esc(a.author.label)}</button>
      <p class="text-xs opacity-50 select-text">${esc(a.author.url)}</p>
    </div>
    <p class="text-xs opacity-70 leading-relaxed">${esc(a.oss)}</p>`;
}
