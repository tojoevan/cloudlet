let uiRoot: HTMLElement;
let floatLayer: HTMLElement;
let toastLayer: HTMLElement;
let scrim: HTMLElement | null = null;

export function initUI(root: HTMLElement): void {
  uiRoot = root;
  floatLayer = el('div', 'floats');
  toastLayer = el('div', 'toasts');
  root.appendChild(floatLayer);
  root.appendChild(toastLayer);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

export function fmt(n: number): string {
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 番茄钟倒计时用，只到分秒 */
export function fmtMMSS(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60 ? `${m % 60}分` : ''}`;
}

export function toast(text: string): void {
  const t = el('div', 'toast', text);
  toastLayer.appendChild(t);
  setTimeout(() => t.remove(), 2300);
}

/** 世界坐标上的飘字，收获与完成订单时的即时反馈 */
export function floatAt(x: number, y: number, text: string, kind: '' | 'gold' | 'good' = ''): void {
  const f = el('div', `float ${kind}`.trim(), text);
  f.style.left = `${x}px`;
  f.style.top = `${y}px`;
  floatLayer.appendChild(f);
  setTimeout(() => f.remove(), 1150);
}

export function openModal(title: string, hint: string, body: HTMLElement): void {
  closeModal();
  // 弹窗打开时压暗左右悬浮面板：遮罩是半透明的，否则它们会从弹窗旁边透出来抢注意力
  document.body.classList.add('modal-open');
  scrim = el('div', 'scrim');
  const modal = el('div', 'modal');
  modal.style.position = 'relative';

  const close = el('button', 'close', '×');
  close.addEventListener('click', closeModal);

  modal.appendChild(close);
  modal.appendChild(el('h3', undefined, title));
  if (hint) modal.appendChild(el('p', 'hint', hint));
  modal.appendChild(body);

  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) closeModal();
  });

  scrim.appendChild(modal);
  uiRoot.appendChild(scrim);
}

export function closeModal(): void {
  if (scrim) {
    scrim.remove();
    scrim = null;
  }
  document.body.classList.remove('modal-open');
}

export function isModalOpen(): boolean {
  return scrim !== null;
}

export function swatch(color: number): HTMLElement {
  const s = el('span', 'swatch');
  s.style.background = hex(color);
  return s;
}

/** 资源条/徽章用的 16×16 内联 SVG 图标，靠 currentColor 着色，颜色由 CSS 决定 */
export type IconName = 'level' | 'coin' | 'prosper' | 'store' | 'codex' | 'ach' | 'tier';

const ICON_PATHS: Record<IconName, string> = {
  // 星徽（等级）
  level:
    '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3 4.2 13.6l.7-4.3-3.1-3 4.3-.6z" fill="currentColor"/>',
  // 硬币
  coin:
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="2.4" fill="currentColor"/>',
  // 叶子（繁荣/人口）
  prosper:
    '<path d="M13.4 3.1C7.6 2.9 4.2 5.9 4.2 10.9c0 .5.1.9.2 1.3 1-4.4 4-7.1 8.4-8.1.3-1 .1-1.9-.4-2.5z" fill="currentColor"/>',
  // 仓库（箱子）
  store: '<path d="M3 6.2 8 3.2l5 3v6.6H3z" fill="currentColor"/>',
  // 图鉴（书本）
  codex:
    '<rect x="2.8" y="3.2" width="10.4" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3.2v9.6" stroke="currentColor" stroke-width="1.3"/>',
  // 奖杯（成就）
  ach:
    '<path d="M5 3.2h6v3a3 3 0 01-6 0z" fill="currentColor"/><path d="M5 4.2H3v.8a2 2 0 002 2M11 4.2h2v.8a2 2 0 01-2 2M8 9v3.2M6 13.2h4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  // 皇冠（会员）
  tier:
    '<path d="M3 6.2 5.2 10.2h5.6L13 6.2 10 7.6 8 4.2 6 7.6z" fill="currentColor"/>',
};

export function icon(name: IconName): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'ic');
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}
