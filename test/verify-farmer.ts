/**
 * 专职农民验证（确定性，不依赖渲染/浏览器）：
 * 1. syncFarmer 后恰有一名农民，且用 farmerId 区分于居民的 agentId（点击能命中）
 * 2. 农民位置锚点存在，且始终在农田范围内（巡视不跑出田）
 * 3. randomId 不会返回农民（农民不自动闲聊）
 * 4. 农田台词库可用
 */
import * as THREE from 'three';
import { Agents } from '../src/render/agents';
import { FARM_LINES, randomFarmLine } from '../src/data/lines';

const FARM = new THREE.Vector2(-2.9, 3.1);
const FARM_RADIUS = 2.4;

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const a = new Agents();
a.syncFarmer();

// 1. 命中体：恰一个，且带 farmerId、不带 agentId
const ht = a.hitTargets;
assert(ht.length === 1, `syncFarmer 后命中体数量=1（实际 ${ht.length}）`);
const fhit = ht[0] as THREE.Object3D & { userData: Record<string, unknown> };
const farmerId = fhit.userData.farmerId as number | undefined;
assert(farmerId !== undefined, '农民命中体带 farmerId');
assert(fhit.userData.agentId === undefined, '农民命中体不带 agentId（与居民区分）');

// 2. 位置锚点存在，且初始在农田中心
const p0 = a.positionOf(farmerId as number);
assert(p0 !== null, '能取到农民头顶位置');
const d0 = Math.hypot(p0!.x - FARM.x, p0!.z - FARM.y);
assert(d0 <= 0.01, `农民初始在农田中心（偏移 ${d0.toFixed(3)}）`);

// 3. 巡逻 10 秒：始终不跑出田地（允许一帧步长的小幅越界）
let maxDist = 0;
let sawPause = false;
let moved = false;
const startXZ = { x: p0!.x, z: p0!.z };
for (let i = 0; i < 600; i++) {
  a.update(1 / 60);
  const p = a.positionOf(farmerId as number)!;
  const d = Math.hypot(p.x - FARM.x, p.z - FARM.y);
  maxDist = Math.max(maxDist, d);
  if (Math.hypot(p.x - startXZ.x, p.z - startXZ.z) > 0.3) moved = true;
}
assert(moved, '农民在田里走动（位置发生了明显变化）');
assert(maxDist <= FARM_RADIUS + 0.2, `巡逻不跑出田地（最大半径 ${maxDist.toFixed(2)} ≤ ${(FARM_RADIUS + 0.2).toFixed(2)}）`);

// 4. 随机闲聊只挑居民，绝不会挑到农民
assert(a.randomId() === null, '没有居民时 randomId 返回 null（农民不算居民，不会自动闲聊）');

// 5. 农田台词
const line = randomFarmLine();
assert(typeof line === 'string' && line.length > 0, 'randomFarmLine 返回非空字符串');
assert(FARM_LINES.includes(line), '随机台词出自农田台词库');

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
