import { el } from './dom';

/**
 * 新手引导：三步（种 → 收 → 交）。
 *
 * 设计意图：面向小学生/休闲玩家，第一分钟必须"有事可做且知道做什么"。
 * 不做遮罩式强制引导（那种很烦），只做一张轻提示卡 + 一个指向目标的脉冲圈，
 * 玩家自己点，达成了就自动进入下一步。
 */
export class Guide {
  readonly el = el('div', 'guide');
  private text = el('div', 'guide-text', '');
  private ring = el('div', 'guide-ring');
  private visible = false;

  constructor() {
    const dot = el('span', 'guide-dot', '');
    const body = el('div', 'guide-body');
    body.appendChild(dot);
    body.appendChild(this.text);
    this.el.appendChild(body);
    this.ring.style.display = 'none';
  }

  /** 指向画布上的某个屏幕坐标（世界点投影后） */
  pointAt(x: number, y: number): void {
    this.ring.style.display = '';
    // 位置用 left/top，transform 留给脉冲动画（否则动画会把位移覆盖掉）
    this.ring.style.left = `${x - 29}px`;
    this.ring.style.top = `${y - 29}px`;
  }

  /** 改为高亮某个 DOM 区域（比如右侧订单面板） */
  highlight(node: HTMLElement | null, on: boolean): void {
    if (!node) return;
    node.classList.toggle('guide-glow', on);
  }

  show(message: string): void {
    this.text.textContent = message;
    if (!this.visible) {
      this.visible = true;
      // ring 与卡片分开挂：卡片在 UI 层，圈要在画布上跟随世界坐标
      document.getElementById('ui')?.appendChild(this.ring);
      document.getElementById('ui')?.appendChild(this.el);
      requestAnimationFrame(() => this.el.classList.add('in'));
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove('in');
    this.ring.style.display = 'none';
    this.el.remove();
    this.ring.remove();
  }
}
