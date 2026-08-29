import * as THREE from 'three';
import { mulberry32, range } from './rng';

interface Bubble {
  mesh: THREE.Mesh;
  /** 0~1 的生命周期进度 */
  t: number;
  speed: number;
  ox: number;
  oz: number;
}

export interface BubbleOptions {
  count?: number;
  radius?: number;
  /** 上升高度 */
  rise?: number;
  /** 水平抖动范围 */
  spread?: number;
  color?: number;
  /**
   * 相对父物体的起点。默认屋顶正上方；
   * 有烟囱时传烟囱口坐标，气泡就从烟囱冒出来。
   */
  origin?: THREE.Vector3;
}

/**
 * 工厂运转时头顶冒的气泡。
 * 纯视觉、无文字——玩家扫一眼就知道哪几座在开工，
 * 不用读任何提示，也不打断挂机时的画面。
 */
export class Bubbles {
  readonly group = new THREE.Group();
  private bubbles: Bubble[] = [];
  private active = false;
  private readonly rise: number;

  constructor(opts: BubbleOptions = {}, seed = 1) {
    const count = opts.count ?? 4;
    // 半径别太小：0.07 世界单位在屏幕上只有约 2px，肉眼几乎看不见
    const radius = opts.radius ?? 0.14;
    const rise = opts.rise ?? 0.9;
    const spread = opts.spread ?? 0.2;
    const color = opts.color ?? 0xffffff;
    const rng = mulberry32(seed);

    this.rise = rise;
    this.group.position.copy(opts.origin ?? new THREE.Vector3(0, 1.5, 0));

    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false, // 半透明免排序，也不会在岛上打洞
      });
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 0), mat);
      mesh.renderOrder = 5;
      this.group.add(mesh);

      this.bubbles.push({
        mesh,
        t: i / count, // 错开相位，避免整齐划一地一起冒
        speed: range(rng, 0.45, 0.72),
        ox: range(rng, -spread, spread),
        oz: range(rng, -spread, spread),
      });
    }

    this.group.visible = false;
  }

  setActive(on: boolean): void {
    this.active = on;
    if (!on) this.group.visible = false;
  }

  /** 产出待收取时换成另一种颜色，玩家自然知道该点了 */
  setColor(color: number): void {
    for (const b of this.bubbles) {
      (b.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
  }

  update(dt: number): void {
    if (!this.active) return;
    this.group.visible = true;

    for (const b of this.bubbles) {
      b.t += dt * b.speed;
      if (b.t >= 1) b.t -= 1;

      const p = b.t;
      b.mesh.position.set(b.ox, p * this.rise, b.oz);
      // 越升越大、中途最实，两端淡出
      b.mesh.scale.setScalar(0.3 + p * 0.95);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(p * Math.PI) * 0.72;
    }
  }

  dispose(): void {
    for (const b of this.bubbles) {
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.MeshBasicMaterial).dispose();
    }
    this.bubbles = [];
  }
}

export const BUBBLE_RUNNING = 0xffffff;
export const BUBBLE_READY = 0xffd166;
