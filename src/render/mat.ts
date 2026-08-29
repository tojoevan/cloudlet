import * as THREE from 'three';

const cache = new Map<number, THREE.MeshLambertMaterial>();

/**
 * 共享材质。low-poly 场景里颜色种类远少于网格数量，
 * 复用材质能显著减少 draw call 的状态切换。
 */
export function mat(color: number): THREE.MeshLambertMaterial {
  let m = cache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    cache.set(color, m);
  }
  return m;
}

/** 需要独立改色/透明度时用这个（比如选中的高亮） */
export function matOwn(color: number, opts?: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
}
