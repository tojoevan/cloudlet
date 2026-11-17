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
import { deliverWish } from '../src/core/wishes';
import { switchIsland } from '../src/core/island';
import { ensureExpansionPlots, plotCountOf, unlockExpansion } from '../src/core/expansion';
import { build } from '../src/core/actions';
import { CROP_ORDER } from '../src/data/crops';
import { BUILDING_ORDER } from '../src/data/buildings';
import { FACTORY_ORDER, PRODUCTS } from '../src/data/factories';
import { ACHIEVEMENTS } from '../src/core/achievements';
import { codexTotal } from '../src/core/codex';
import { seasonOf, SEASONS, setSeasonOverride, decoAvailableIn, seasonGrassTint } from '../src/core/season';
import { festivalOf, FESTIVALS, setFestivalDate } from '../src/core/festival';
import { randomLine, SEASON_LINES, FESTIVAL_LINES } from '../src/data/lines';
import { satisfactionOf, satisfactionBonus } from '../src/core/satisfaction';
import { COLLECTION_SETS } from '../src/core/collection';
import { prosperityOf, BUILDINGS as _B } from '../src/core/economy';
import { accumulateSlowMs, shouldDowngrade, DOWNGRADE_AFTER_MS } from '../src/core/quality';
import type { GameState } from '../src/core/types';
import { setNightOverride, dayNightIncome } from '../src/core/daynight';

// 测试默认固定在白天：昼夜会轻微影响作物时间与被动收益，
// 不锁定的话同一份测试在凌晨跑和在下午跑会得到不同数字。
setNightOverride(false);

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
check(
  '图鉴总数 = 各类合计',
  codexTotal() ===
    CROP_ORDER.length + Object.keys(PRODUCTS).length + BUILDING_ORDER.length + FACTORY_ORDER.length,
  `实际 ${codexTotal()}`,
);

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

section('居民心愿');
{
  const w = createInitialState('wish-test');
  check('初始就有心愿', (w.wishes ?? []).length > 0, String(w.wishes?.length));
  const wish = w.wishes[0];
  w.inventory = { [wish.item]: wish.count };
  const coins0 = w.coins;
  const gems0 = w.gems;
  const r = deliverWish(w, wish.id, Date.now());
  check('能满足心愿', r !== null);
  check('满足后给金币', w.coins > coins0, `+${w.coins - coins0}`);
  check('满足后给宝石', w.gems > gems0, `+${w.gems - gems0}`);
  check('心愿交付后自动补满', (w.wishes ?? []).length === 2, String(w.wishes?.length));
  check('物品被扣掉', (w.inventory[wish.item] ?? 0) === 0);
  check('统计计数增加', (w.stats.wishesDone ?? 0) === 1);
}

section('岛屿解锁');
{
  const isl = createInitialState('island-test');
  check('默认有 6 座岛', isl.islands.length === 6, String(isl.islands.length));
  check('繁荣不足时切不到果园岛', switchIsland(isl, 'orchard') === false);
  check('仍停在原岛', isl.activeIsland === 'round', isl.activeIsland);
  // 堆够繁荣度（每栋小屋 +1）
  for (let i = 0; i < 30; i++) {
    isl.buildings.push({ id: `h${i}`, type: 'house', seed: i, level: 1 } as never);
  }
  check('繁荣 30 后可以切到果园岛', switchIsland(isl, 'orchard') === true);
  check('激活岛已切换', isl.activeIsland === 'orchard', isl.activeIsland);
  check('切换后可切回', switchIsland(isl, 'round') === true);
}

section('岛屿加成');
{
  setSeasonOverride('summer'); // 夏天对小麦无加成，断言才可复现
  const b = createInitialState('bonus-test');
  b.level = 12; // 草莓需要 10 级
  b.stats.harvests = 3; // 跳过新手加速，断言的是常规倍率
  const t = Date.now();
  // 主岛：草莓按原速
  plant(b, 0, 'strawberry', t);
  const normal = b.plots[0].readyAt - t;
  // 果园岛：草莓快 30%
  for (let i = 0; i < 30; i++) b.buildings.push({ id: `h${i}`, type: 'house', seed: i, level: 1 } as never);
  switchIsland(b, 'orchard');
  plant(b, 0, 'strawberry', t);
  const boosted = b.plots[0].readyAt - t;
  check('果园岛草莓更快', boosted < normal, `${boosted} vs ${normal}`);
  check('加速约 30%', Math.abs(boosted - Math.round(normal / 1.3)) <= 2, String(boosted));
  // 非水果作物不受影响
  plant(b, 1, 'wheat', t);
  const wheatBoosted = b.plots[1].readyAt - t;
  check('小麦不受果园加成影响', wheatBoosted === 30_000, String(wheatBoosted));
  setSeasonOverride(null);
}

section('收集奖励');
{
  setSeasonOverride('summer');
  const c = createInitialState('collection-test');
  c.level = 12;
  c.stats.harvests = 3; // 跳过新手加速
  const t = Date.now();
  // 未集齐时无加成
  plant(c, 0, 'wheat', t);
  const normal = c.plots[0].readyAt - t;
  check('未集齐时按原速', normal === 30_000, String(normal));
  // 集齐作物图鉴 → 作物 +10%
  c.codex.crops = [...CROP_ORDER];
  plant(c, 1, 'wheat', t);
  const boosted = c.plots[1].readyAt - t;
  check('集齐作物后更快', boosted < normal, `${boosted} vs ${normal}`);
  check('约快 10%', Math.abs(boosted - Math.round(normal / 1.1)) <= 2, String(boosted));
  setSeasonOverride(null);
}

section('成就目标墙');
{
  const a = createInitialState('ach-test');
  check('成就都分了组', ACHIEVEMENTS.every((x) => !!x.group), '');
  const bad = ACHIEVEMENTS.filter((x) => x.progress && x.progress(a).target <= 0);
  check('进度目标都为正', bad.length === 0, bad.map((x) => x.id).join(','));
  const first = ACHIEVEMENTS.find((x) => x.id === 'first_harvest')!;
  const p0 = first.progress!(a);
  check('新档进度从 0 开始', p0.cur === 0 && p0.target === 1, `${p0.cur}/${p0.target}`);
  a.stats.harvests = 42;
  check('进度随统计增长', first.progress!(a).cur === 42, String(first.progress!(a).cur));
}

section('季节');
{
  check('3 月是春天', seasonOf(new Date(2026, 2, 15)) === 'spring');
  check('7 月是夏天', seasonOf(new Date(2026, 6, 15)) === 'summer');
  check('10 月是秋天', seasonOf(new Date(2026, 9, 15)) === 'autumn');
  check('1 月是冬天', seasonOf(new Date(2026, 0, 15)) === 'winter');
  const allHaveDeco = Object.values(SEASONS).every((x) => !!x.deco && x.crops.length > 0);
  check('每季都有专属装饰与加成作物', allHaveDeco);
  check('稻草人只在秋天可建', decoAvailableIn('scarecrow', 'autumn') && !decoAvailableIn('scarecrow', 'spring'));
  check('普通装饰常年可建', decoAvailableIn('bench', 'spring') && decoAvailableIn('bench', 'winter'));
  setSeasonOverride('summer');
  const summer = seasonGrassTint(0xa8d98b);
  setSeasonOverride('winter');
  const winter = seasonGrassTint(0xa8d98b);
  setSeasonOverride(null);
  check('不同季节草地色不同', summer !== winter);
  check('冬天更冷（蓝分量更高）', (winter & 0xff) > (summer & 0xff), `${winter & 0xff} vs ${summer & 0xff}`);
}

section('昼夜耦合');
{
  setNightOverride(false);
  const d = createInitialState('daynight-test');
  d.level = 12;
  const t = Date.now();
  plant(d, 0, 'wheat', t);
  const day = d.plots[0].readyAt - t;
  setNightOverride(true);
  plant(d, 1, 'wheat', t);
  const night = d.plots[1].readyAt - t;
  check('夜间作物更快', night < day, `${night} vs ${day}`);
  check('约快 15%', Math.abs(night - Math.round(day / 1.15)) <= 2, String(night));
  check('夜间被动收益倍率 > 1', dayNightIncome() > 1, String(dayNightIncome()));
  setNightOverride(false);
}

section('节日活动');
{
  check('3/25 是樱花祭', festivalOf(new Date(2026, 2, 25))?.id === 'sakura');
  check('8/1 是夏日祭', festivalOf(new Date(2026, 7, 1))?.id === 'nightmarket');
  check('10/1 是丰收节', festivalOf(new Date(2026, 9, 1))?.id === 'harvest');
  check('12/25 是雪灯节', festivalOf(new Date(2026, 11, 25))?.id === 'snowlight');
  check('1/3 仍在雪灯节（跨年）', festivalOf(new Date(2026, 0, 3))?.id === 'snowlight');
  check('6/1 没有节日', festivalOf(new Date(2026, 5, 1)) === null);
  check('每个节日都有加成', FESTIVALS.every((f) => (f.crop ?? 1) > 1 || (f.income ?? 1) > 1 || (f.order ?? 1) > 1));
}

section('居民满意度');
{
  const j = createInitialState('joy-test');
  const base = satisfactionOf(j);
  for (let i = 0; i < 10; i++) {
    j.buildings.push({ id: `dp${i}`, type: 'planter', seed: i, level: 1 } as never);
  }
  const withDeco = satisfactionOf(j);
  check('装饰提升满意度', withDeco > base, `${withDeco} vs ${base}`);
  j.buildings.push({ id: 'pk1', type: 'park', seed: 1, level: 1 } as never);
  check('公共设施继续提升', satisfactionOf(j) > withDeco, `${satisfactionOf(j)} vs ${withDeco}`);
  check('满意度不超过 100', satisfactionOf(j) <= 100, String(satisfactionOf(j)));
  check('订单加成落在 1~1.2 之间', satisfactionBonus(j) > 1 && satisfactionBonus(j) <= 1.2, String(satisfactionBonus(j)));
  j.stats.wishesDone = 50;
  check('满足心愿也计入', satisfactionOf(j) > withDeco);
}

section('画质与设置');
{
  const q = createInitialState('quality-test');
  check('新档默认自动画质开启', q.settings.autoQuality === true);
  check('新档默认标准画质', q.settings.quality === 'standard');
  // 老档缺字段时补齐
  const legacy = JSON.parse(JSON.stringify(q));
  delete legacy.settings.autoQuality;
  // 走完整加载链路：migrate 只做版本迁移，normalize 才补默认值
  localStorage.setItem('cloudlet.save', JSON.stringify(legacy));
  const l = loadLocal();
  check('老档补上自动画质字段', l?.settings.autoQuality === true);
}

section('自动画质判定');
{
  let acc = 0;
  for (let i = 0; i < 60; i++) acc = accumulateSlowMs(acc, 16);
  check('流畅时不会累积', acc === 0, String(acc));
  for (let i = 0; i < 400; i++) acc = accumulateSlowMs(acc, 60);
  check('持续掉帧会累积到阈值', shouldDowngrade(acc), String(acc));
  check('阈值是 6 秒', DOWNGRADE_AFTER_MS === 6000);
}

section('装饰图鉴');
{
  const d = createInitialState('deco-set');
  // 用足够大的繁荣度基数，避免四舍五入把 8% 抹平
  for (let i = 0; i < 10; i++) {
    d.buildings.push({ id: `dp${i}`, type: 'planter', seed: i, level: 1 } as never);
  }
  d.codex.buildings = [];
  const before = prosperityOf(d);
  const set = COLLECTION_SETS.find((x) => x.id === 'deco')!;
  check('装饰全集只算常驻装饰', set.total === 4, String(set.total));
  check('未集齐时进度为 0', set.found(d) === 0);
  d.codex.buildings = ['bench', 'lamp', 'planter', 'statue'];
  check('收集后进度满', set.found(d) === set.total, String(set.found(d)));
  const after = prosperityOf(d);
  check('集齐后繁荣度提升', after > before, `${after} vs ${before}`);
  check('提升 8%', after === Math.round(before * 1.08), `${after} vs ${Math.round(before * 1.08)}`);
}

section('建筑可建造性');
{
  const town = createInitialState('buildable-test');
  town.level = 60;
  town.coins = 1e9;
  // 先切岛再加房子：switchIsland 会把当前建筑整批挪到另一座岛
  switchIsland(town, 'square');
  // 人口要够（最高 reqPop 110 → 22 栋小屋）
  for (let i = 0; i < 22; i++) {
    town.buildings.push({ id: `bh${i}`, type: 'house', seed: i, level: 1 } as never);
  }
  const failed: string[] = [];
  for (const type of BUILDING_ORDER) {
    if (type === 'road') continue;
    const r = build(town, type, Date.now());
    if (!r.ok) failed.push(`${type}:${r.reason}`);
  }
  check('所有建筑都能实际建造', failed.length === 0, failed.join(' | '));
  check('建造后建筑数增加', town.buildings.length > 22, String(town.buildings.length));
}

section('居民对话');
{
  setFestivalDate(null);
  setSeasonOverride('winter');
  setNightOverride(false);
  const winterLines = new Set<string>();
  for (let i = 0; i < 500; i++) winterLines.add(randomLine());
  check('冬天会说应季的话', [...winterLines].some((l) => SEASON_LINES.winter.includes(l)));
  check('对话非空', [...winterLines].every((l) => l.length > 0));

  setFestivalDate(new Date(2026, 11, 20)); // 雪灯节
  const festLines = new Set<string>();
  for (let i = 0; i < 800; i++) festLines.add(randomLine());
  check('节日期间会提节日', [...festLines].some((l) => FESTIVAL_LINES.snowlight.includes(l)));

  setFestivalDate(null);
  setSeasonOverride(null);
  setNightOverride(false);
}

section('新手加速');
{
  setSeasonOverride('summer'); // 夏天对小麦无加成，便于比较
  setNightOverride(false);
  setFestivalDate(null);
  const b = createInitialState('beginner-test');
  const t = Date.now();
  plant(b, 0, 'wheat', t);
  const first = b.plots[0].readyAt - t;
  check('首株作物只需一半时间', first === 15_000, String(first));
  b.stats.harvests = 3; // 收满三次后恢复正常
  plant(b, 1, 'wheat', t);
  const later = b.plots[1].readyAt - t;
  check('三次收获后恢复原速', later === 30_000, String(later));
  setSeasonOverride(null);
}

section('横向拓荒');
{
  const s = createInitialState('expand-test');
  s.stats.harvests = 5;
  s.stats.ordersDone = 2;
  s.level = 3;
  s.coins = 10_000;
  check('初始 16 块田', s.plots.length === 16, String(s.plots.length));
  const r = unlockExpansion(s, 'clover');
  check('锚定三叶岛', r.ok && (s.expansions ?? []).includes('clover'));
  check('新增 4 块田', s.plots.length === 20, String(s.plots.length));
  check('总田块 = 20', plotCountOf(s) === 20);
  check('扣除锚定费', s.coins === 8_000, String(s.coins));
  check('不能重复锚定', !unlockExpansion(s, 'clover').ok);
  check('第二座岛需要繁荣度', !unlockExpansion(s, 'windbell').ok);
  check('新田可种植', plant(s, 16, 'wheat', Date.now()).ok);
  // 补一座市政厅撑繁荣，验证第二座岛的解锁顺序
  s.buildings.push({ id: 'test-hall', type: 'hall', seed: 1, level: 3 });
  check('第一座岛后可锚定第二座', unlockExpansion(s, 'windbell').ok);
  check('两岛总田块 24', plotCountOf(s) === 24, String(plotCountOf(s)));
  // 旧存档只有 16 块田但已有 clover：加载时应补齐
  s.plots.length = 16;
  ensureExpansionPlots(s);
  check('旧档按已锚定数量补齐田块', s.plots.length === 24, String(s.plots.length));
}

console.log(`\n${pass} 通过，${fail} 失败\n`);
if (fail > 0) process.exit(1);
