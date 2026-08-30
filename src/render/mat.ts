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
