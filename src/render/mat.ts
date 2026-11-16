import * as THREE from 'three';

const cache = new Map<number, THREE.MeshStandardMaterial>();

/**
 * 共享材质。low-poly 场景里颜色种类远少于网格数量，
 * 复用材质能显著减少 draw call 的状态切换。
 *
 * 用 MeshStandardMaterial（保留 flatShading 保留硬边积木感）+ 高 roughness/零
 * metalness，得到哑光、干净的塑料/木质观感；像素级 PBR 光照让转角比 Lambert 更
 * 立体。窗户（matOwn）需要 Standard 才支持 emissive，配合 World.applyTimeOfDay
 * 在夜间真正点亮。
 */
export function mat(color: number): THREE.MeshStandardMaterial {
  let m = cache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      flatShading: true,
      roughness: 0.92,
      metalness: 0.0,
    });
    cache.set(color, m);
  }
  return m;
}

/** 需要独立改色/透明度时用这个（比如选中的高亮、半透明水面、自发光窗户） */
export function matOwn(
  color: number,
  opts?: THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.92,
    metalness: 0.0,
    ...opts,
  });
}

/**
 * 顶点色材质（共享一份）。
 *
 * 借鉴 Dorfromantik 的做法：低多边形不靠贴图，而靠**顶点色渐变**建立体积与手绘感
 * （见 80.lv 对 Dorfromantik 的访谈：custom vertex color pipelines）。
 * 材质底色必须是白色——顶点色会与材质色相乘，底色带颜色就会整体发暗。
 */
let vcMat: THREE.MeshStandardMaterial | null = null;
export function matVC(): THREE.MeshStandardMaterial {
  if (!vcMat) {
    vcMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      roughness: 0.92,
      metalness: 0,
    });
  }
  return vcMat;
}

/**
 * 给几何体刷「下深上浅」的顶点色渐变。
 * 这是让树冠、灌木、作物一眼看起来"有光从上面来"的最便宜手段，
 * 纯色低多边形会显得像塑料块。
 */
export function tintGradient(
  geo: THREE.BufferGeometry,
  color: number,
  lo = 0.84,
  hi = 1.14,
): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return;
  const span = Math.max(0.001, bb.max.y - bb.min.y);
  const base = new THREE.Color(color);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - bb.min.y) / span));
    // 轻微非线性：底部压得更深一点，像被草丛遮住的环境光
    const k = lo + (hi - lo) * Math.pow(t, 0.8);
    colors[i * 3] = base.r * k;
    colors[i * 3 + 1] = base.g * k;
    colors[i * 3 + 2] = base.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
