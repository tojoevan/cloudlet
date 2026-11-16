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
  /** 纯装饰（不计入功能建筑分组） */
  deco?: boolean;
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
  post: {
    id: 'post', name: '邮局', cost: 2_400, costGrowth: 1.2,
    pop: 0, prosperity: 4, reqPop: 18, unlockLevel: 5,
    body: 0xfdf3e3, roof: 0x7fb7ab, accent: 0x9fd8ea,
    desc: '信件从这里寄往别的浮岛',
  },
  garden: {
    id: 'garden', name: '花园', cost: 4_200, costGrowth: 1.22,
    pop: 0, prosperity: 7, reqPop: 26, unlockLevel: 7,
    body: 0xd8ecc8, roof: 0x86c46b, accent: 0xf0687a,
    desc: '花开的时候，居民都爱来坐坐',
  },
  flower: {
    id: 'flower', name: '花店', cost: 3_200, costGrowth: 1.2,
    pop: 0, prosperity: 5, reqPop: 30, unlockLevel: 8,
    body: 0xfff0f2, roof: 0xef8b6a, accent: 0xf0687a,
    desc: '门口永远摆着当天最新鲜的一束',
  },
  school: {
    id: 'school', name: '学校', cost: 16_000, costGrowth: 1.24,
    pop: 0, prosperity: 14, reqPop: 70, unlockLevel: 14,
    body: 0xf7e9c8, roof: 0xd9714f, accent: 0x9fd8ea,
    desc: '钟声一响，小镇就热闹起来',
  },
  bench: {
    id: 'bench', name: '长椅', cost: 120, costGrowth: 1.08,
    pop: 0, prosperity: 1, reqPop: 0, unlockLevel: 2, deco: true,
    body: 0xd9a86c, roof: 0x9c7443, accent: 0xf7f2e6,
    desc: '走累了就能坐一会儿',
  },
  lamp: {
    id: 'lamp', name: '路灯', cost: 100, costGrowth: 1.08,
    pop: 0, prosperity: 1, reqPop: 0, unlockLevel: 3, deco: true,
    body: 0x6b7d8f, roof: 0x5b6b7b, accent: 0xffd98a,
    desc: '夜里会亮起来',
  },
  planter: {
    id: 'planter', name: '花箱', cost: 80, costGrowth: 1.06,
    pop: 0, prosperity: 2, reqPop: 0, unlockLevel: 4, deco: true,
    body: 0xc99a63, roof: 0xb58a63, accent: 0xf0687a,
    desc: '沿街摆一排，镇子立刻有颜色',
  },
  statue: {
    id: 'statue', name: '雕像', cost: 1_500, costGrowth: 1.15,
    pop: 0, prosperity: 6, reqPop: 0, unlockLevel: 12, deco: true,
    body: 0xe8e4d8, roof: 0xcdd9e2, accent: 0xd9b45a,
    desc: '镇子的精神地标',
  },
  sakura: {
    id: 'sakura', name: '樱花树', cost: 320, costGrowth: 1.1,
    pop: 0, prosperity: 3, reqPop: 0, unlockLevel: 3, deco: true,
    body: 0x8a6a52, roof: 0xf7c6d8, accent: 0xffe6ef,
    desc: '春天限定 · 花瓣会落',
  },
  sunflower: {
    id: 'sunflower', name: '向日葵', cost: 260, costGrowth: 1.1,
    pop: 0, prosperity: 2, reqPop: 0, unlockLevel: 3, deco: true,
    body: 0x7cb85f, roof: 0xffc233, accent: 0x8a5a3b,
    desc: '夏天限定 · 朝着太阳',
  },
  scarecrow: {
    id: 'scarecrow', name: '稻草人', cost: 300, costGrowth: 1.1,
    pop: 0, prosperity: 3, reqPop: 0, unlockLevel: 3, deco: true,
    body: 0xc9a06a, roof: 0x8a5a3b, accent: 0xf0687a,
    desc: '秋天限定 · 守着南瓜地',
  },
  snowman: {
    id: 'snowman', name: '雪人', cost: 280, costGrowth: 1.1,
    pop: 0, prosperity: 3, reqPop: 0, unlockLevel: 3, deco: true,
    body: 0xffffff, roof: 0x5b6b7b, accent: 0xf08a3c,
    desc: '冬天限定 · 别让它化掉',
  },
  hall: {
    id: 'hall', name: '市政厅', cost: 40_000, costGrowth: 1.26,
    pop: 0, prosperity: 22, reqPop: 110, unlockLevel: 20,
    body: 0xfdf3e3, roof: 0x8aa7c9, accent: 0xffd45e,
    desc: '小镇的心脏，屋顶上飘着旗子',
  },
};

export const BUILDING_ORDER: BuildingType[] = [
  'house', 'cafe', 'park', 'fountain', 'post', 'garden', 'flower', 'school', 'hall',
  'bench', 'lamp', 'planter', 'statue',
  'sakura', 'sunflower', 'scarecrow', 'snowman',
  'road',
];

/** 纯装饰：建造面板里单独分组，避免和功能建筑混在一起 */
export const DECO_TYPES: BuildingType[] = [
  'bench', 'lamp', 'planter', 'statue',
  'sakura', 'sunflower', 'scarecrow', 'snowman',
];

/** 季节限定装饰：只有在对应季节才出现在建造面板里 */
export const SEASONAL_DECO: Record<string, BuildingType> = {
  spring: 'sakura',
  summer: 'sunflower',
  autumn: 'scarecrow',
  winter: 'snowman',
};

/** 方岛网格占地（单位：格）。住宅基础 1×1，可升级成 1×2 / 2×1；
 *  咖啡馆/公园/喷泉为 2×2 的点缀型；道路 1×1 可拼接。 */
export const BUILDING_FOOTPRINT: Record<BuildingType, { w: number; h: number }> = {
  house: { w: 1, h: 1 },
  cafe: { w: 2, h: 2 },
  park: { w: 2, h: 2 },
  fountain: { w: 2, h: 2 },
  post: { w: 1, h: 1 },
  garden: { w: 2, h: 2 },
  flower: { w: 1, h: 1 },
  school: { w: 2, h: 2 },
  hall: { w: 2, h: 2 },
  bench: { w: 1, h: 1 },
  lamp: { w: 1, h: 1 },
  planter: { w: 1, h: 1 },
  statue: { w: 1, h: 1 },
  sakura: { w: 1, h: 1 },
  sunflower: { w: 1, h: 1 },
  scarecrow: { w: 1, h: 1 },
  snowman: { w: 1, h: 1 },
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
