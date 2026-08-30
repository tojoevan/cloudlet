import type { BuildingType } from '../core/types';

export interface BuildingDef {
  id: BuildingType;
  name: string;
  cost: number;
  /** 第 k 座的成本 = cost * costGrowth^k */
  costGrowth: number;
  pop: number;
  prosperity: number;
  /** 建造所需人口 */
  reqPop: number;
  unlockLevel: number;
  body: number;
  roof: number;
  accent: number;
  desc: string;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  house: {
    id: 'house', name: '小屋', cost: 500, costGrowth: 1.15,
    pop: 5, prosperity: 1, reqPop: 0, unlockLevel: 1,
    body: 0xfdf6e3, roof: 0xe07a5f, accent: 0x8ecae6,
    desc: '居民入住，带来人口',
  },
  cafe: {
    id: 'cafe', name: '咖啡馆', cost: 1_200, costGrowth: 1.2,
    pop: 0, prosperity: 3, reqPop: 10, unlockLevel: 3,
    body: 0xfff6ee, roof: 0xb07a52, accent: 0xffdfba,
    desc: '小镇的第一缕香气',
  },
  park: {
    id: 'park', name: '公园', cost: 2_000, costGrowth: 1.22,
    pop: 0, prosperity: 4, reqPop: 20, unlockLevel: 6,
    body: 0xbfe9ea, roof: 0x7cc45f, accent: 0xf7f0dc,
    desc: '居民散步的地方',
  },
  fountain: {
    id: 'fountain', name: '喷泉', cost: 5_000, costGrowth: 1.25,
    pop: 0, prosperity: 8, reqPop: 40, unlockLevel: 12,
    body: 0xeff7fa, roof: 0x5b97bd, accent: 0xbfe4ea,
    desc: '入夜会亮起灯',
  },
  road: {
    id: 'road', name: '道路', cost: 50, costGrowth: 1,
    pop: 0, prosperity: 0, reqPop: 0, unlockLevel: 1,
    body: 0xcdb89a, roof: 0xb59c7c, accent: 0xcdb89a,
    desc: '把房屋连起来，居民沿路散步',
  },
};

export const BUILDING_ORDER: BuildingType[] = ['house', 'cafe', 'park', 'fountain', 'road'];

/** 方岛网格占地（单位：格）。住宅基础 1×1，可升级成 1×2 / 2×1；
 *  咖啡馆/公园/喷泉为 2×2 的点缀型；道路 1×1 可拼接。 */
export const BUILDING_FOOTPRINT: Record<BuildingType, { w: number; h: number }> = {
  house: { w: 1, h: 1 },
  cafe: { w: 2, h: 2 },
  park: { w: 2, h: 2 },
  fountain: { w: 2, h: 2 },
  road: { w: 1, h: 1 },
};

/** 工厂在方岛上的占地恒为 2×2（生产型建筑） */
export const FACTORY_FOOTPRINT = { w: 2, h: 2 };

export interface IslandDef {
  id: string;
  name: string;
  reqProsperity: number;
  desc: string;
}

/** MVP 只开放主岛，其余按繁荣度解锁。数据结构先留好。 */
export const ISLANDS: IslandDef[] = [
  { id: 'main', name: '云上町', reqProsperity: 0, desc: '一切开始的地方' },
  { id: 'orchard', name: '果园岛', reqProsperity: 30, desc: '果树与果汁坊' },
  { id: 'ranch', name: '牧场岛', reqProsperity: 80, desc: '牛羊与毛纺厂' },
  { id: 'onsen', name: '温泉岛', reqProsperity: 160, desc: '观光客的歇脚处' },
  { id: 'summit', name: '云顶', reqProsperity: 300, desc: '稀有作物与气象站' },
];
