import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { matVC } from './mat';

/**
 * 静态合批：把一组零件烘焙成 1 个带顶点色的网格。
 *
 * 为什么必要：场景原本 904 次 draw call，但三角面只有 2.5 万——完全是 draw call 受限
 * （每个树冠、每根栏杆、每块砖都是一次绘制）。低多边形游戏的正确做法是把
 * 「静止不动、材质相同」的零件合并，颜色差异改用顶点色保留，画质不掉、绘制次数降一个量级。
 *
 * 规则：
 *  - 跳过自发光（窗户/路灯玻璃）与半透明件，它们必须独立才能做昼夜与混合；
 *  - 统一转成非索引几何体再合并（索引/非索引混用会让 mergeGeometries 直接返回 null）；
 *  - 几何体已有的顶点色（树冠渐变）要**乘**上材质色，不能覆盖，否则整片树林变白；
 *  - 调用时 group 必须还在原点（未定位），否则世界坐标会被烘进几何体。
 */
export function bakeStatic(group: THREE.Object3D): number {
  group.updateMatrixWorld(true);
  const geos: THREE.BufferGeometry[] = [];
  const remove: THREE.Object3D[] = [];

  group.traverse((o) => {
    const m = o as THREE.Mesh & { isMesh?: boolean };
    if (!m.isMesh) return;
    if (Array.isArray(m.material)) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (!mat) return;
    // 需要昼夜控制的对象（窗户、灯罩）不能被烘进静态网格
    if ((m.userData as { noBake?: boolean })?.noBake) return;
    if (m.name === 'lampGlass') return;
    // emissiveIntensity 默认就是 1，不能用它判断自发光，要看 emissive 颜色本身
    const em = mat.emissive;
    if (em && em.r + em.g + em.b > 0.01) return;
    if (mat.transparent) return;

    let g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (g.index) {
      const flat = g.toNonIndexed();
      g.dispose();
      g = flat;
    }

    const c = mat.color;
    const pos = g.attributes.position;
    const src = g.attributes.color as THREE.BufferAttribute | undefined;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // 已有顶点色（树冠渐变/地面斑驳）与材质色相乘；没有就直接用材质色
      const r = src ? src.getX(i) : 1;
      const gg = src ? src.getY(i) : 1;
      const b = src ? src.getZ(i) : 1;
      colors[i * 3] = c.r * r;
      colors[i * 3 + 1] = c.g * gg;
      colors[i * 3 + 2] = c.b * b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    }
    geos.push(g);
    remove.push(m);
  });

  if (geos.length < 2) {
    geos.forEach((g) => g.dispose());
    return 0;
  }
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) return 0;

  for (const m of remove) m.parent?.remove(m);
  const mesh = new THREE.Mesh(merged, matVC());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return remove.length;
}
