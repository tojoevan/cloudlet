import * as THREE from 'three';

export type WeatherKind = 'clear' | 'rain' | 'snow' | 'sakura';

/**
 * 天气粒子：雨 / 雪 / 樱花。
 *
 * 约束：正交相机的可视体积只有约 21 世界单位高，粒子必须放在这个盒子里，
 * 否则会被直接裁掉（星空就踩过一次这个坑）。这里用 28×28、高 18 的盒子。
 *
 * 只用 1 个 Points（1 个 draw call），换天气时重建几何体即可。
 */
interface Preset {
  count: number;
  color: number;
  size: number; // 屏幕像素（sizeAttenuation=false）
  fall: number; // 世界单位 / 秒
  sway: number; // 横向漂移幅度
  opacity: number;
}

const PRESETS: Record<Exclude<WeatherKind, 'clear'>, Preset> = {
  // 雨用线段画成"雨丝"，比圆点更像下雨；长度按世界单位算
  rain: { count: 420, color: 0xbfe0ff, size: 0.42, fall: 15, sway: 0.3, opacity: 0.62 },
  snow: { count: 520, color: 0xffffff, size: 4.5, fall: 1.5, sway: 1.1, opacity: 0.95 },
  sakura: { count: 380, color: 0xffb7cf, size: 4, fall: 1.1, sway: 1.8, opacity: 0.95 },
};

/**
 * 软粒子贴图：Points 默认画的是方块，雪/樱花瓣会显得像"纸屑"。
 * 一张 32×32 的径向渐变就能把它们变成柔和的圆点，成本极低。
 */
let softTex: THREE.Texture | null = null;
function softDot(): THREE.Texture {
  if (softTex) return softTex;
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  softTex = tex;
  return tex;
}

const AREA = 28;
const TOP = 18;

export class Weather {
  readonly group = new THREE.Group();
  private kind: WeatherKind = 'clear';
  private points: THREE.Points | null = null;
  private lines: THREE.LineSegments | null = null;
  private vel: Float32Array = new Float32Array(0);
  private phase: Float32Array = new Float32Array(0);
  private t = 0;

  constructor() {
    this.group.name = 'weather';
  }

  get current(): WeatherKind {
    return this.kind;
  }

  set(kind: WeatherKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.dispose();
    if (kind === 'clear') return;

    const p = PRESETS[kind];
    // 雨：每滴两个顶点（上/下端点），画成一条雨丝
    const verts = kind === 'rain' ? p.count * 2 : p.count;
    const pos = new Float32Array(verts * 3);
    this.vel = new Float32Array(p.count);
    this.phase = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = (Math.random() - 0.5) * AREA;
      const y = Math.random() * TOP;
      const z = (Math.random() - 0.5) * AREA;
      this.vel[i] = p.fall * (0.75 + Math.random() * 0.5);
      this.phase[i] = Math.random() * Math.PI * 2;
      if (kind === 'rain') {
        pos[i * 6] = x;
        pos[i * 6 + 1] = y;
        pos[i * 6 + 2] = z;
        pos[i * 6 + 3] = x;
        pos[i * 6 + 4] = y - p.size;
        pos[i * 6 + 5] = z;
      } else {
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (kind === 'rain') {
      const mat = new THREE.LineBasicMaterial({
        color: p.color,
        transparent: true,
        opacity: p.opacity,
        depthWrite: false,
        fog: false,
      });
      const lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      this.group.add(lines);
      this.lines = lines;
      return;
    }
    const mat = new THREE.PointsMaterial({
      color: p.color,
      size: p.size,
      map: softDot(),
      alphaTest: 0.08,
      sizeAttenuation: false,
      transparent: true,
      opacity: p.opacity,
      depthWrite: false,
      fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    this.points = points;
  }

  update(dt: number): void {
    const p = this.kind === 'clear' ? null : PRESETS[this.kind];
    if (!p) return;
    // 雨丝：整体沿 y 下移，落到地面后回到顶部
    if (this.lines) {
      this.t += dt;
      const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < this.vel.length; i++) {
        const top = i * 6 + 1;
        const bot = i * 6 + 4;
        const dy = this.vel[i] * dt;
        arr[top] -= dy;
        arr[bot] -= dy;
        if (arr[bot] < 0) {
          const y = TOP;
          arr[top] = y;
          arr[bot] = y - p.size;
        }
      }
      attr.needsUpdate = true;
      return;
    }
    if (!this.points) return;
    this.t += dt;
    const attr = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const n = this.vel.length;
    for (let i = 0; i < n; i++) {
      const iy = i * 3 + 1;
      arr[iy] -= this.vel[i] * dt;
      // 横向漂移：雪/花瓣更明显，雨近乎垂直
      arr[i * 3] += Math.sin(this.t * 1.4 + this.phase[i]) * p.sway * dt;
      if (arr[iy] < 0) {
        arr[iy] += TOP;
        arr[i * 3] = (Math.random() - 0.5) * AREA;
        arr[i * 3 + 2] = (Math.random() - 0.5) * AREA;
      }
      if (arr[i * 3] > AREA / 2) arr[i * 3] -= AREA;
      if (arr[i * 3] < -AREA / 2) arr[i * 3] += AREA;
    }
    attr.needsUpdate = true;
  }

  private dispose(): void {
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.points = null;
    }
    if (this.lines) {
      this.group.remove(this.lines);
      this.lines.geometry.dispose();
      (this.lines.material as THREE.Material).dispose();
      this.lines = null;
    }
  }
}
