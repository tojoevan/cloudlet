/**
 * 核心玩法冒烟测试。只跑纯逻辑层，不碰渲染与 DOM。
 *   npm test
 */

// localStorage 的最小替身，让 save.ts 能在 Node 下跑
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import {
  build,
  buildFactory,
  harvest,
  harvestAll,
  plant,
  startRecipe,
  unlockSlot,
} from '../src/core/actions';
import { checkAchievements } from '../src/core/achievements';
import {
  codexFound,
  codexTotal,
  recordBuilding,
  recordCrop,
  recordFactory,
  recordProduct,
} from '../src/core/codex';
import { capacityOf, expForLevel, invTotal } from '../src/core/economy';
import { CROPS } from '../src/data/crops';
import { cancelFocus, focusProgress, isFocusing, settleFocus, startFocus } from '../src/core/focus';
import { deliver } from '../src/core/orders';
import { exportCode, importCode, loadLocal, migrate, saveLocal } from '../src/core/save';
import { advance, rewardMult, tick } from '../src/core/simulation';
import { createInitialState } from '../src/core/state';
import type { GameState } from '../src/core/types';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

const t0 = Date.now();

section('初始状态');
const s: GameState = createInitialState('550e8400-e29b-41d4-a716-446655440000');
check('16 块地', s.plots.length === 16, `实际 ${s.plots.length}`);
check('3 个订单', s.orders.length === 3, `实际 ${s.orders.length}`);
check('初始金币 300', s.coins === 300, `实际 ${s.coins}`);
check('1 座小屋', s.buildings.length === 1);

section('种植与收获');
check('播种成功', plant(s, 0, 'wheat', t0).ok);
check('地块已占用', !plant(s, 0, 'corn', t0).ok);
check('未成熟收不了', !harvest(s, 0, t0 + 5_000).ok);
check('成熟后能收', harvest(s, 0, t0 + 31_000).ok);
check('收获 2 个小麦', s.inventory.wheat === 2, `实际 ${s.inventory.wheat}`);
check('收获后地空了', s.plots[0].crop === null);
check('等级不够种不了草莓', !plant(s, 1, 'strawberry', t0).ok);

section('一键收获');
for (let i = 1; i < 6; i++) plant(s, i, 'wheat', t0);
const bulk = harvestAll(s, t0 + 31_000);
check('一键收获成功', bulk.ok);
check('收了 5 块地', bulk.ok && bulk.data.plots === 5, bulk.ok ? `实际 ${bulk.data.plots}` : '');
check('仓库累计 12 个小麦', (s.inventory.wheat ?? 0) === 12, `实际 ${s.inventory.wheat}`);
check('没有成熟时返回失败', !harvestAll(s, t0 + 31_000).ok);

section('等级与解锁');
s.level = 2;
s.exp = 0;
check('2 级所需经验为正', expForLevel(2) > expForLevel(1));

section('工厂与加工');
s.coins = 10_000;
check('建面包坊', buildFactory(s, 'bakery', t0).ok);
check('不能重复建', !buildFactory(s, 'bakery', t0).ok);
check('有 1 个工厂', s.factories.length === 1);
check('开始生产面包', startRecipe(s, 0, 0, 'bakery:bread', t0).ok);
check('扣了 3 个小麦', (s.inventory.wheat ?? 0) === 9, `实际 ${s.inventory.wheat}`);
check('槽位被占用', !startRecipe(s, 0, 0, 'bakery:bread', t0).ok);
check('未到点没有产出', tick(s, t0 + 60_000).length === 0);
const done = tick(s, t0 + 121_000);
check('到点产出面包', (s.inventory.bread ?? 0) === 1, `实际 ${s.inventory.bread}`);
check('产出有事件回调', done.length === 1);
check('产出后槽位清空', s.factories[0].slots[0].recipe === null);
s.inventory.wheat = 1; // 只剩 1 个，配方要 3 个
check('材料不足无法开工', !startRecipe(s, 0, 0, 'bakery:bread', t0 + 121_000).ok);

section('扩槽位');
const before = s.coins;
check('扩到 2 槽', unlockSlot(s, 0, t0).ok);
check('扣了钱', s.coins < before);
check('槽位数为 2', s.factories[0].slots.length === 2);

section('订单交付');
const order = s.orders[0];
for (const line of order.lines) {
  s.inventory[line.id] = (s.inventory[line.id] ?? 0) + line.count;
}
const coinsBefore = s.coins;
const delivered = deliver(s, order.id, t0);
check('发货成功', delivered !== null);
check('金币增加', s.coins > coinsBefore);
check('物品被扣掉', order.lines.every((l) => (s.inventory[l.id] ?? 0) >= 0));
check('订单自动补充', s.orders.length === 3);
check('combo 计数', s.combo === 1);

section('Fever 热潮');
s.combo = 4;
s.comboUntil = t0 + 60_000;
const o2 = s.orders[0];
for (const line of o2.lines) s.inventory[line.id] = (s.inventory[line.id] ?? 0) + line.count;
const d2 = deliver(s, o2.id, t0 + 1_000);
check('第 5 单触发热潮', d2?.fever === true);
check('热潮有时限', s.feverUntil > t0);

section('离线结算');
s.savedAt = t0;
s.factories[0].slots[0].recipe = 'bakery:bread';
s.factories[0].slots[0].readyAt = t0 + 60_000;
s.inventory.wheat = 50;
const report = advance(s, t0 + 3_600_000);
check('结算 1 小时', Math.abs(report.seconds - 3600) < 2, `实际 ${report.seconds}`);
check('离线有经营收入', report.coins > 0, `实际 ${report.coins}`);
check('工厂离线完成一次', report.produced.bread === 1, `实际 ${report.produced.bread}`);
check('savedAt 已推进', s.savedAt === t0 + 3_600_000);

section('离线上限');
s.savedAt = t0;
const long = advance(s, t0 + 48 * 3_600_000);
check('超长离线被截断', long.capped === true);
check('截断到上限内', long.seconds <= 12 * 3600 + 1, `实际 ${long.seconds}`);

section('仓库容量');
check('容量随等级增长', capacityOf(s) > 120);
s.inventory.wheat = 99999;
check('库存总量计算', invTotal(s) >= 99999);

section('番茄钟');
const f: GameState = createInitialState('device-focus');
check('初始未在专注', !isFocusing(f, t0));
startFocus(f, 25, t0);
check('专注已开始', isFocusing(f, t0 + 1_000));
check('进度随时间推进', focusProgress(f, t0 + 12 * 60_000) > 0.4);
check('未到点不结算', settleFocus(f, t0 + 10 * 60_000) === null);
check('专注中收益 ×1.5', rewardMult(f, t0 + 60_000) === 1.5);
const fr = settleFocus(f, t0 + 25 * 60_000 + 1_000);
check('到点结算', fr !== null);
check('发 2 颗果实', fr?.gems === 2, `实际 ${fr?.gems}`);
check('计入统计', f.stats.focusSessions === 1 && f.stats.focusMinutes === 25);
check('结算后状态清空', !isFocusing(f, t0 + 26 * 60_000));
check('结算后倍率回到 1', rewardMult(f, t0 + 26 * 60_000) === 1);

startFocus(f, 45, t0);
const cancelled = cancelFocus(f, t0 + 30 * 60_000);
check('放弃时折半结算', cancelled?.minutes === 30, `实际 ${cancelled?.minutes}`);
check('放弃后不再专注', !isFocusing(f, t0 + 31 * 60_000));

section('专注期间自动农活');
const af: GameState = createInitialState('device-autofarm');
af.lastCrop = 'wheat';
for (let i = 0; i < 4; i++) plant(af, i, 'wheat', t0);
check('未专注时不会自动收', tick(af, t0 + 31_000).length === 0);
check('作物保持成熟状态', af.plots[0].crop === 'wheat' && af.plots[0].readyAt <= t0 + 31_000);

startFocus(af, 25, t0);
const farmEvents = tick(af, t0 + 31_000);
check('专注时自动收获', farmEvents.some((e) => e.kind === 'autofarm'));
check('4 块地都收了', af.stats.harvests === 4, `实际 ${af.stats.harvests}`);
check('入库 8 个小麦', (af.inventory.wheat ?? 0) === 8, `实际 ${af.inventory.wheat}`);
check('收完自动补种', af.plots.slice(0, 4).every((p) => p.crop === 'wheat'));
check('补种后重新计时', af.plots[0].readyAt > t0 + 31_000);
// 补种会把所有空地都种上，所以是 16 块而不是收掉的 4 块
check('战果累计到 focus', af.focus.harvested === 4, `实际 ${af.focus.harvested}`);
check('空地一并补种', af.focus.planted === 16, `实际 ${af.focus.planted}`);

// 仓库塞满时不能卡死，装不下的折成金币
af.inventory.wheat = capacityOf(af);
const coinsBeforeFull = af.coins;
tick(af, t0 + 62_000);
check('仓库满时折成金币', af.coins > coinsBeforeFull, `实际 ${af.coins}`);
check('仓库满时不再入库', (af.inventory.wheat ?? 0) === capacityOf(af));

// 结束专注后恢复手动
const afReward = settleFocus(af, t0 + 25 * 60_000 + 1_000);
// 4 块（入库）+ 16 块（仓库满折金币）
check('结算带回农活统计', afReward?.harvested === 20, `实际 ${afReward?.harvested}`);
const afterEnd = tick(af, t0 + 26 * 60_000);
check('专注结束后不再自动', !afterEnd.some((e) => e.kind === 'autofarm'));

section('专注期间自动生产');
const ap: GameState = createInitialState('device-autofact');
ap.level = 2;
ap.coins = 20_000;
check('工厂建成', buildFactory(ap, 'bakery', t0).ok);
ap.inventory.wheat = 30;

tick(ap, t0 + 1_000);
check('不专注时不自动开工', ap.factories[0].slots[0].recipe === null);

startFocus(ap, 25, t0);
tick(ap, t0 + 1_000);
check('专注时自动投料', ap.factories[0].slots[0].recipe === 'bakery:bread');
check('扣了 3 个小麦', (ap.inventory.wheat ?? 0) === 27, `实际 ${ap.inventory.wheat}`);
check(
  '专注提速到 80 秒',
  Math.round((ap.factories[0].slots[0].readyAt - (t0 + 1_000)) / 1000) === 80,
  `实际 ${Math.round((ap.factories[0].slots[0].readyAt - (t0 + 1_000)) / 1000)}`,
);

tick(ap, t0 + 1_000 + 81_000);
check('到点产出面包', (ap.inventory.bread ?? 0) === 1, `实际 ${ap.inventory.bread}`);
check('产出后槽位清空', ap.factories[0].slots[0].recipe === null);

tick(ap, t0 + 1_000 + 81_100);
check('下一轮自动续投', ap.factories[0].slots[0].recipe === 'bakery:bread');
check('续投再扣料', (ap.inventory.wheat ?? 0) === 24, `实际 ${ap.inventory.wheat}`);
check('累计生产批次', ap.focus.produced === 2, `实际 ${ap.focus.produced}`);

// 没料了就安静停下，不硬投
ap.inventory.wheat = 0;
const producedBefore = ap.focus.produced;
tick(ap, t0 + 1_000 + 200_000);
check('没料时不再开工', ap.focus.produced === producedBefore, `实际 ${ap.focus.produced}`);

section('图鉴');
const cx: GameState = createInitialState('device-codex');
check('初始图鉴为空', codexFound(cx) === 0);
check('首次收录返回 true', recordCrop(cx, 'wheat') === true);
check('重复收录返回 false', recordCrop(cx, 'wheat') === false);
check('收录数 +1', codexFound(cx) === 1);
recordProduct(cx, 'bread');
recordBuilding(cx, 'house');
recordFactory(cx, 'bakery');
check('四类分别计入', codexFound(cx) === 4, `实际 ${codexFound(cx)}`);
check('总数 = 6 作物 + 5 加工品 + 4 建筑 + 5 工厂', codexTotal() === 20, `实际 ${codexTotal()}`);

section('成就');
const ac: GameState = createInitialState('device-ach');
check('初始无成就', ac.achievements.length === 0);
ac.stats.harvests = 1;
const got1 = checkAchievements(ac);
check('达成「初次收获」', got1.some((a) => a.id === 'first_harvest'));
check('发放了奖励', ac.coins > 300, `实际 ${ac.coins}`);
check('不会重复发放', checkAchievements(ac).length === 0);
ac.level = 10;
// 初始 1 座，补齐到 5 座同时满足「小有名气」与「小镇初成」
for (let i = 0; i < 4; i++) ac.buildings.push({ id: `h${i}`, type: 'house', seed: i });
const got2 = checkAchievements(ac);
check('一次可达成多个', got2.length >= 2, `实际 ${got2.length}`);

section('存档迁移 v1 → v2');
const v1 = {
  version: 1,
  deviceId: 'u1',
  savedAt: t0,
  level: 3,
  exp: 10,
  coins: 500,
  gems: 0,
  plots: [],
  factories: [],
  buildings: [],
  inventory: {},
  orders: [],
  stats: { harvests: 2, ordersDone: 1, playSeconds: 0, bestCombo: 0 },
  settings: { channel: 'citypop', radioUrl: '', volume: 0.6, powerSave: false },
  feverUntil: 0,
  combo: 0,
  comboUntil: 0,
  lastCrop: 'wheat',
};
const mig = migrate(v1 as never);
check('版本号升到 2', mig.version === 2);
check('补上 focus', !!mig.focus && mig.focus.until === 0);
check('补上 codex', !!mig.codex && Array.isArray(mig.codex.factories));
check('补上 achievements', Array.isArray(mig.achievements) && mig.achievements.length === 0);
check('补上专注统计', mig.stats.focusSessions === 0 && mig.stats.focusMinutes === 0);
check('保留原有进度', mig.level === 3 && mig.coins === 500 && mig.stats.harvests === 2);

section('存档');
saveLocal(s);
const reloaded = loadLocal();
check('能读回存档', reloaded !== null);
check('等级一致', reloaded?.level === s.level);
check('金币一致', reloaded?.coins === s.coins);
const code = exportCode(s);
const imported = importCode(code);
check('存档码可导入', imported !== null);
check('导入后金币一致', imported?.coins === s.coins);
check('坏存档码返回 null', importCode('not-a-real-code') === null);

section('放置循环（P0 回归）');
{
  const g = createInitialState('loop-test');
  g.level = 5;
  const t = Date.now();
  // 仓库塞满后仍然要能收：放置游戏里循环一旦停摆，画面上就没有东西在长了
  g.inventory = { wheat: capacityOf(g) };
  plant(g, 0, 'wheat', t - CROPS.wheat.growMs);
  const coins0 = g.coins;
  const r = harvest(g, 0, t);
  check('仓满仍能收获（循环不停摆）', r.ok);
  check('仓满部分折成金币', r.ok && r.data.overflow > 0 && g.coins > coins0);

  // 在线被动收益：开着页面就有进账，但量级必须远小于订单
  g.inventory = {};
  g.coins = 1000;
  g.lastYieldAt = t;
  const before = g.coins;
  for (let i = 1; i <= 60; i++) tick(g, t + i * 1000);
  const gained = g.coins - before;
  check('在线有被动金币', gained > 0, `+${gained}`);
  check('被动收益量级合理（每分钟 < 200）', gained < 200, `+${gained}`);
  check('playSeconds 会累积', g.stats.playSeconds >= 59, String(g.stats.playSeconds));

  // 切后台回来不该一次性爆产
  const c2 = g.coins;
  tick(g, t + 60_000 + 2 * 3600_000);
  check('长时间停顿只补 10 分钟', g.coins - c2 < 200, `+${g.coins - c2}`);
}

console.log(`\n${pass} 通过，${fail} 失败\n`);
if (fail > 0) process.exit(1);
