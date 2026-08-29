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
}

export function isModalOpen(): boolean {
  return scrim !== null;
}

export function swatch(color: number): HTMLElement {
  const s = el('span', 'swatch');
  s.style.background = hex(color);
  return s;
}
