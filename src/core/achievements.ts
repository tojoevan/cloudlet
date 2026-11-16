import { codexFound, codexTotal } from './codex';
import { prosperityOf } from './economy';
import type { GameState } from './types';

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  coins: number;
  check: (s: GameState) => boolean;
  /** 进度（当前值 / 目标值），用于目标墙的进度条；一次性事件型可以不填 */
  progress?: (s: GameState) => { cur: number; target: number };
  /** 分组，便于把 19 项成就按主题排开 */
  group?: 'farm' | 'trade' | 'town' | 'focus' | 'collect';
}

/**
 * 成就只在达成那一刻给一次奖励，不提供持续加成——
 * 它负责给回归理由，不负责破坏数值平衡。
 */
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_harvest', name: '初次收获', desc: '收下第一批作物', coins: 50, check: (s) => s.stats.harvests >= 1 , group: 'farm', progress: (s) => ({ cur: s.stats.harvests, target: 1 }) },
  { id: 'harvest_100', name: '熟练农夫', desc: '累计收获 100 次', coins: 500, check: (s) => s.stats.harvests >= 100 , group: 'farm', progress: (s) => ({ cur: s.stats.harvests, target: 100 }) },
  { id: 'first_order', name: '第一单', desc: '完成第一笔订单', coins: 50, check: (s) => s.stats.ordersDone >= 1 , group: 'trade', progress: (s) => ({ cur: s.stats.ordersDone, target: 1 }) },
  { id: 'order_50', name: '送货老手', desc: '累计完成 50 单', coins: 800, check: (s) => s.stats.ordersDone >= 50 , group: 'trade', progress: (s) => ({ cur: s.stats.ordersDone, target: 50 }) },
  { id: 'fever', name: '热潮初体验', desc: '首次触发收益翻倍', coins: 200, check: (s) => s.stats.bestCombo >= 5 , group: 'trade', progress: (s) => ({ cur: s.stats.bestCombo, target: 5 }) },
  { id: 'coins_1k', name: '小有积蓄', desc: '持有 1,000 金币', coins: 0, check: (s) => s.coins >= 1_000 , group: 'town', progress: (s) => ({ cur: s.coins, target: 1000 }) },
  { id: 'coins_50k', name: '富甲一方', desc: '持有 50,000 金币', coins: 0, check: (s) => s.coins >= 50_000 , group: 'town', progress: (s) => ({ cur: s.coins, target: 50000 }) },
  { id: 'builder_5', name: '小镇初成', desc: '建成 5 座建筑', coins: 300, check: (s) => s.buildings.length >= 5 , group: 'town', progress: (s) => ({ cur: s.buildings.length, target: 5 }) },
  { id: 'builder_20', name: '繁华初现', desc: '建成 20 座建筑', coins: 2_000, check: (s) => s.buildings.length >= 20 , group: 'town', progress: (s) => ({ cur: s.buildings.length, target: 20 }) },
  { id: 'first_factory', name: '工业起步', desc: '建成第一座工厂', coins: 200, check: (s) => s.factories.length >= 1 , group: 'town', progress: (s) => ({ cur: s.factories.length, target: 1 }) },
  { id: 'all_factories', name: '全线开工', desc: '三座工厂全部建成', coins: 1_500, check: (s) => s.factories.length >= 3 , group: 'town', progress: (s) => ({ cur: s.factories.length, target: 3 }) },
  { id: 'level_10', name: '小有名气', desc: '达到 10 级', coins: 400, check: (s) => s.level >= 10 , group: 'town', progress: (s) => ({ cur: s.level, target: 10 }) },
  { id: 'level_25', name: '声名远播', desc: '达到 25 级', coins: 3_000, check: (s) => s.level >= 25 , group: 'town', progress: (s) => ({ cur: s.level, target: 25 }) },
  { id: 'focus_1', name: '专注一刻', desc: '完成一次番茄钟', coins: 300, check: (s) => s.stats.focusSessions >= 1 , group: 'focus', progress: (s) => ({ cur: s.stats.focusSessions, target: 1 }) },
  { id: 'focus_10', name: '心流常客', desc: '累计完成 10 次番茄钟', coins: 2_000, check: (s) => s.stats.focusSessions >= 10 , group: 'focus', progress: (s) => ({ cur: s.stats.focusSessions, target: 10 }) },
  { id: 'codex_10', name: '收藏家', desc: '图鉴收录 10 项', coins: 500, check: (s) => codexFound(s) >= 10 , group: 'collect', progress: (s) => ({ cur: codexFound(s), target: 10 }) },
  { id: 'codex_all', name: '博物学家', desc: '图鉴全部收录', coins: 5_000, check: (s) => codexFound(s) >= codexTotal() , group: 'collect', progress: (s) => ({ cur: codexFound(s), target: codexTotal() }) },
  { id: 'wishes_10', name: '热心肠', desc: '累计满足 10 个心愿', coins: 800, check: (s) => (s.stats.wishesDone ?? 0) >= 10 , group: 'collect', progress: (s) => ({ cur: (s.stats.wishesDone ?? 0), target: 10 }) },
  { id: 'prosperity_50', name: '宜居小镇', desc: '繁荣度达到 50', coins: 1_000, check: (s) => prosperityOf(s) >= 50 , group: 'town', progress: (s) => ({ cur: prosperityOf(s), target: 50 }) },
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementById(id: string): AchievementDef | undefined {
  return BY_ID.get(id);
}

/** 检查新达成的成就，发放奖励，返回本次新解锁的列表 */
export function checkAchievements(state: GameState): AchievementDef[] {
  const gained: AchievementDef[] = [];
  for (const a of ACHIEVEMENTS) {
    if (state.achievements.includes(a.id)) continue;
    if (!a.check(state)) continue;
    state.achievements.push(a.id);
    state.coins += a.coins;
    gained.push(a);
  }
  return gained;
}
