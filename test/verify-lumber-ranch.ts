import * as THREE from 'three';
import {
  FACTORIES,
  FACTORY_ORDER,
  PRODUCTS,
  RECIPES,
  isDirectSell,
  recipesOf,
} from '../src/data/factories';
import { makeOrder } from '../src/core/orders';
import { startAllSlots } from '../src/core/actions';
import { tick } from '../src/core/simulation';
import { Agents } from '../src/render/agents';
import type { GameState } from '../src/core/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

console.log('=== 数据层 ===');
check('FACTORIES 含 lumber', FACTORIES.lumber !== undefined);
check('FACTORIES 含 ranch', FACTORIES.ranch !== undefined);
check('FACTORY_ORDER 含 lumber/ranch', FACTORY_ORDER.includes('lumber') && FACTORY_ORDER.includes('ranch'));
check('PRODUCTS 含 wood（进仓库，非卖钱）', PRODUCTS.wood?.sellDirect !== true);
check('PRODUCTS 含 milk（进仓库，非卖钱）', PRODUCTS.milk?.sellDirect !== true);
check('RECIPES 含 lumber:wood', RECIPES.some((r) => r.id === 'lumber:wood' && r.output === 'wood'));
check('RECIPES 含 ranch:milk', RECIPES.some((r) => r.id === 'ranch:milk' && r.output === 'milk'));
check('isDirectSell(wood)=false', isDirectSell('wood') === false);
check('isDirectSell(milk)=false', isDirectSell('milk') === false);
check('isDirectSell(bread)=false', isDirectSell('bread') === false);

console.log('=== 订单候选：仓库物可交付 ===');
// 木材、牛奶都已改为进仓库，可作为订单候选出现；订单生成是随机的，
// 用多次抽单确认两者都能成为候选。
const orderState = {
  level: 5,
  factories: [
    { type: 'lumber' as const, slots: [{ recipe: null, readyAt: 0 }] },
    { type: 'ranch' as const, slots: [{ recipe: null, readyAt: 0 }] },
  ],
} as unknown as GameState;
let sawWood = false;
let sawMilk = false;
for (let i = 0; i < 40; i++) {
  const o = makeOrder(orderState, 1000 + i);
  if (o.lines.some((l) => l.id === 'wood')) sawWood = true;
  if (o.lines.some((l) => l.id === 'milk')) sawMilk = true;
}
check('订单可含 wood（木材进仓库可交付）', sawWood);
check('订单可含 milk（牛奶进仓库可交付）', sawMilk);

console.log('=== tick 让木材进仓库 ===');
const now = 1000;
const state = {
  version: 2,
  deviceId: 'v',
  savedAt: 0,
  level: 5,
  exp: 0,
  coins: 0,
  gems: 0,
  plots: [],
  factories: [{ type: 'lumber' as const, slots: [{ recipe: 'lumber:wood', readyAt: 0 }] }],
  buildings: [],
  inventory: {},
  orders: [],
  stats: { harvests: 0, ordersDone: 0, playSeconds: 0, bestCombo: 0, focusSessions: 0, focusMinutes: 0 },
  settings: { channel: 'off', radioUrl: '', volume: 0.5, powerSave: false, cloudSync: false },
  feverUntil: 0,
  combo: 0,
  comboUntil: 0,
  lastCrop: null,
  focus: { until: 0, startedAt: 0, totalMs: 0, harvested: 0, planted: 0, produced: 0 },
  codex: { crops: [], products: [], buildings: [], factories: [] },
  achievements: [],
} as unknown as GameState;

const events = tick(state, now);
check('coins 未直接增加（走仓库）', (state as { coins: number }).coins === 0, `实际 ${(state as { coins: number }).coins}`);
check('库存进了 wood ×1', ((state as { inventory: Record<string, number> }).inventory as Record<string, number>).wood === 1, `实际 ${JSON.stringify((state as { inventory: Record<string, number> }).inventory)}`);
check('codex 记录了 wood', (state as { codex: { products: string[] } }).codex.products.includes('wood'));
check('事件含 factory/wood', events.some((e) => e.kind === 'factory' && e.item === 'wood'));

console.log('=== tick 让牛奶进仓库（与木材对称） ===');
const mState = {
  ...state,
  factories: [{ type: 'ranch' as const, slots: [{ recipe: 'ranch:milk', readyAt: 0 }] }],
  inventory: {},
} as unknown as GameState;
const mEvents = tick(mState, 2000);
check('milk coins 未直接增加（走仓库）', (mState as { coins: number }).coins === 0, `实际 ${(mState as { coins: number }).coins}`);
check('库存进了 milk ×1', ((mState as { inventory: Record<string, number> }).inventory as Record<string, number>).milk === 1, `实际 ${JSON.stringify((mState as { inventory: Record<string, number> }).inventory)}`);
check('事件含 factory/milk', mEvents.some((e) => e.kind === 'factory' && e.item === 'milk'));

console.log('=== 厂区工人生成与点击体 ===');
const agents = new Agents();
agents.syncWorker('lumber', new THREE.Vector2(1, 2), 2.2);
agents.syncWorker('ranch', new THREE.Vector2(-3, 4), 1.5);
// 再调用一次应幂等（不新建）
agents.syncWorker('lumber', new THREE.Vector2(1, 2), 2.2);

const hits = agents.hitTargets;
const lumberHit = hits.find((h) => (h.userData as { lumberId?: number }).lumberId !== undefined);
const ranchHit = hits.find((h) => (h.userData as { ranchId?: number }).ranchId !== undefined);
check('hitTargets 含 lumberId', lumberHit !== undefined);
check('hitTargets 含 ranchId', ranchHit !== undefined);
// 居民未 sync，点击体应恰好是这两个工人
check('点击体恰好 2 个（仅工人）', hits.length === 2, `实际 ${hits.length}`);

if (lumberHit) {
  const lid = (lumberHit.userData as { lumberId: number }).lumberId;
  const pos = agents.positionOf(lid);
  check('lumberjack positionOf 非 null', pos !== null);
}
if (ranchHit) {
  const rid = (ranchHit.userData as { ranchId: number }).ranchId;
  const pos = agents.positionOf(rid);
  check('ranch worker positionOf 非 null', pos !== null);
}

console.log('=== 一键全部生产 startAllSlots ===');
// 伐木场木头无材料需求，3 个空闲槽位应全部开工
const allState = {
  level: 5,
  inventory: {},
  coins: 0,
  focus: { until: 0, startedAt: 0, totalMs: 0, harvested: 0, planted: 0, produced: 0 },
  factories: [
    { type: 'lumber' as const, slots: [
      { recipe: null, readyAt: 0 },
      { recipe: null, readyAt: 0 },
      { recipe: null, readyAt: 0 },
    ] },
  ],
} as unknown as GameState;
const r1 = startAllSlots(allState, 0, 1000);
check('startAllSlots 返回 ok', r1.ok === true);
check('开工 3 个槽位', r1.ok && r1.data.started === 3, `实际 ${r1.ok ? r1.data.started : '-'}`);
check('三个槽位都挂上了配方', (allState as { factories: { slots: { recipe: string | null }[] }[] }).factories[0].slots.every((s) => s.recipe === 'lumber:wood'));

// 已有生产中的槽位应被跳过，只开空闲的
const mixState = {
  level: 5,
  inventory: {},
  coins: 0,
  focus: { until: 0, startedAt: 0, totalMs: 0, harvested: 0, planted: 0, produced: 0 },
  factories: [
    { type: 'lumber' as const, slots: [
      { recipe: 'lumber:wood', readyAt: 5000 },
      { recipe: null, readyAt: 0 },
    ] },
  ],
} as unknown as GameState;
const r2 = startAllSlots(mixState, 0, 1000);
check('混合状态只开 1 个空闲槽', r2.ok && r2.data.started === 1, `实际 ${r2.ok ? r2.data.started : '-'}`);
check('已生产槽位保持原配方', (mixState as { factories: { slots: { recipe: string | null }[] }[] }).factories[0].slots[0].recipe === 'lumber:wood');

// 无空闲槽位应失败
const fullState = {
  level: 5,
  inventory: {},
  coins: 0,
  focus: { until: 0, startedAt: 0, totalMs: 0, harvested: 0, planted: 0, produced: 0 },
  factories: [
    { type: 'lumber' as const, slots: [{ recipe: 'lumber:wood', readyAt: 5000 }] },
  ],
} as unknown as GameState;
const r3 = startAllSlots(fullState, 0, 1000);
check('无空闲槽位返回失败', r3.ok === false, `实际 ok=${r3.ok}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
