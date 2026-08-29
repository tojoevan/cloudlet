/**
 * 验证浮空岛分层交界无缝：
 * 土层(soil) / 岩层(rock) / 底尖(tip) 三层几何体在交界环上顶点必须一一重合。
 * 岩层夹在中间，它的每一个顶点都应能在「土层 ∪ 底尖」中找到同位置的顶点——
 * 若找不到，说明交界有缝（旧实现：段数 16/12/8 不齐 + 各自随机扰动）。
 *
 * 运行：npx esbuild test/verify-island-base.ts --bundle --platform=node --outfile=/tmp/verify-island.mjs && node /tmp/verify-island.mjs
 */
import * as THREE from 'three';
import { makeIsland } from '../src/render/meshes/terrain';

function verts(g: THREE.BufferGeometry): THREE.Vector3[] {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  return out;
}

function hasMatch(v: THREE.Vector3, set: THREE.Vector3[], eps = 1e-6): boolean {
  const e2 = eps * eps;
  return set.some((w) => w.distanceToSquared(v) < e2);
}

const island = makeIsland();
// children 顺序：0 草皮、1 土层、2 岩层、3 底尖、4+ 岛缘岩块
const soilV = verts((island.children[1] as THREE.Mesh).geometry);
const rockV = verts((island.children[2] as THREE.Mesh).geometry);
const tipV = verts((island.children[3] as THREE.Mesh).geometry);
const soilTip = [...soilV, ...tipV];

console.log(`顶点数：土层 ${soilV.length} / 岩层 ${rockV.length} / 底尖 ${tipV.length}`);

const unmatched = rockV.filter((v) => !hasMatch(v, soilTip));
if (unmatched.length > 0) {
  console.error(`✗ 岩层有 ${unmatched.length} 个顶点在土层/底尖中找不到重合点——交界有缝`);
  for (const v of unmatched.slice(0, 5)) {
    console.error('   ', v.toArray().map((n) => n.toFixed(3)).join(', '));
  }
  process.exit(1);
}
console.log(`✓ 岩层全部 ${rockV.length} 个顶点与土层/底尖严格重合——两层交界无缝`);

let minY = Infinity;
for (const v of tipV) minY = Math.min(minY, v.y);
console.log(`✓ 底尖最低点 y=${minY.toFixed(3)}（预期 ≈ -7.8，向下收成尖）`);
