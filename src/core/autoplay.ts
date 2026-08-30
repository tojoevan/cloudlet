import type { GameState, ItemId } from './types';
import { BUILDINGS, BUILDING_ORDER } from '../data/buildings';
import { FACTORIES } from '../data/factories';
import { deliver } from './orders';
import { build, unlockSlot, sell } from './actions';
import { hasItems, roomFor } from './economy';

/**
 * 专注期间的小镇自动经营：满足发货要求就自动发货、能盖的建筑/升级自动放下、
 * 仓库满了就分批把不被订单需要的冗余物卖掉腾地方。
 * 由主循环在「专注中」时每约 1 秒调用一次，是番茄钟「挂机陪读」的核心。
 */
export function autoFocusStep(state: GameState, now: number): void {
  // 1) 能交的订单自动交（优先把库存变成金币与经验，也顺带推进 combo / 等级）
  for (const order of [...state.orders]) {
    if (hasItems(state, order.lines)) deliver(state, order.id, now);
  }

  // 2) 放下能盖的建筑 / 升级（每次只做一处，并留 300 金币缓冲，别一夜清零）
  for (const type of BUILDING_ORDER) {
    const def = BUILDINGS[type];
    const owned = state.buildings.filter((b) => b.type === type).length;
    const cost = Math.floor(def.cost * Math.pow(def.costGrowth, owned));
    if (cost + 300 <= state.coins) {
      const r = build(state, type, now);
      if (r.ok) {
        state.focus.placed += 1;
        break; // 一次一处，下秒再继续
      }
    }
  }
  // 工厂槽位升级：同样留缓冲，每次一处
  for (let i = 0; i < state.factories.length; i++) {
    const f = state.factories[i];
    const next = f.slots.length;
    const def = FACTORIES[f.type];
    if (next - 1 >= def.slotCosts.length) continue; // 已满槽
    const slotCost = def.slotCosts[next - 1];
    if (slotCost + 300 <= state.coins) {
      const r = unlockSlot(state, i, now);
      if (r.ok) {
        state.focus.placed += 1;
        break;
      }
    }
  }

  // 3) 仓库满 → 分批卖冗余（不被订单需要的、数量最多的几种，每种卖 5 个）
  autoSellSurplus(state);
}

/** 仓库塞满时，把不被任何未交付订单需要的、数量最多的冗余物分批卖掉，腾出空间继续生产 */
function autoSellSurplus(state: GameState): void {
  if (roomFor(state, 1) > 0) return; // 没满不卖
  const needed = new Set<ItemId>();
  for (const o of state.orders) for (const l of o.lines) needed.add(l.id);

  const candidates = Object.entries(state.inventory)
    .filter(([id]) => !needed.has(id as ItemId))
    .sort((a, b) => b[1] - a[1]);

  let sold = 0;
  for (const [id, n] of candidates) {
    if (sold >= 2) break; // 一次最多处理 2 种，分批而非一次性清空库存
    const cnt = Math.min(5, n);
    sell(state, id as ItemId, cnt);
    sold += 1;
  }
}
