import * as THREE from 'three';
import { el } from './dom';

/**
 * 居民头顶的对话气泡。
 * 用 HTML 而不是 3D 文字：中文不需要字体资源，样式也更好控。
 * 居民一直在走，所以位置每帧都要跟着投影更新。
 */
export class SpeechBubble {
  private readonly node: HTMLElement;
  private readonly pos = new THREE.Vector3();
  private until = 0;
  private readonly projected = new THREE.Vector3();
  /**
   * 位置从回调取，而不是在说话那一刻定死——
   * 居民一直在走，气泡得跟着人跑。居民消失时回调返回 null，气泡自行收起。
   */
  private follow: (() => THREE.Vector3 | null) | null = null;

  constructor(parent: HTMLElement) {
    this.node = el('div', 'speech');
    this.node.style.display = 'none';
    parent.appendChild(this.node);
  }

  sayAt(getPos: () => THREE.Vector3 | null, text: string, now: number): void {
    const start = getPos();
    if (!start) return;
    this.follow = getPos;
    this.pos.copy(start);
    this.node.textContent = text;
    this.node.style.display = '';
    this.until = now + 3600;

    // 重新触发入场动画：先摘 class，强制回流，再挂上
    this.node.classList.remove('in');
    void this.node.offsetWidth;
    this.node.classList.add('in');
  }

  update(camera: THREE.Camera, canvas: HTMLCanvasElement, now: number): void {
    if (this.node.style.display === 'none' || !this.follow) return;
    if (now > this.until) {
      this.node.style.display = 'none';
      return;
    }

    const p = this.follow();
    if (!p) {
      // 人不在了（人口下降回收了居民），气泡跟着收起
      this.node.style.display = 'none';
      return;
    }
    this.pos.copy(p);

    this.projected.copy(this.pos).project(camera);
    this.node.style.left = `${((this.projected.x + 1) / 2) * canvas.clientWidth}px`;
    this.node.style.top = `${((-this.projected.y + 1) / 2) * canvas.clientHeight}px`;
  }

  get visible(): boolean {
    return this.node.style.display !== 'none';
  }
}
