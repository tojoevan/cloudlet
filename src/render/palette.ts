/**
 * 多色系注册表。每套色系同时携带：
 *  - palette    ：场景用色（天/草/水/树/土壤…）
 *  - light      ：配套光照强度（换色系时曝光自动调好，避免越亮越过曝）
 *  - houses     ：住宅配色（随色系走，整条街风格统一）
 *  - shirts     ：居民衣服色（随色系走）
 * 运行时通过 getPalette()/getScheme() 取「当前激活色系」，切换色系只需改 activeId。
 */

export interface Palette {
  sky: number;
  skyDusk: number;
  skyNight: number;
  grass: number;
  grassDark: number;
  soil: number;
  soilDark: number;
  tilled: number;
  rock: number;
  rockDark: number;
  trunk: number;
  leafGreen: number;
  leafDeep: number;
  leafLight: number;
  water: number;
  cloud: number;
  path: number;
  road: number;
}

export interface HousePalette {
  body: number;
  roof: number;
  accent: number;
}

export interface Scheme {
  id: string;
  name: string;
  light: { hemi: number; sun: number; fill: number };
  houses: HousePalette[];
  shirts: number[];
  palette: Palette;
}

// a 朝 b 方向混合 t（0..1），用于从基础住宅/衣服色派生各色系变体
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// ---------- 各色系调色板 ----------

// 云海：Islanders 的干净色块 + 光遇的轻盈大气。
// 纪律：只有一个主色（草绿）、一个辅色（暖沙土）、一个强调（珊瑚红），
// 其余色相全部向天空靠拢并降饱和——画面因此"通透"而不是"花"。
const MACARON: Palette = {
  sky: 0x86c3e8,
  skyDusk: 0xffc09a,
  skyNight: 0x172347,
  grass: 0x8cc45d,
  grassDark: 0x6a9d45,
  soil: 0xdcb27b,
  soilDark: 0xbc8a59,
  tilled: 0x98653f,
  rock: 0xcabda5,
  rockDark: 0xa19683,
  trunk: 0x94623e,
  leafGreen: 0x65a94c,
  leafDeep: 0x34704a,
  leafLight: 0xb7d97c,
  water: 0x4fb4c7,
  cloud: 0xfffdf4,
  path: 0xead4ac,
  road: 0xb2a48c,
};

// 奶油水彩：掺白最多、低饱和，像被柔光罩住（配稍弱光照，防过曝）
const CREAM: Palette = {
  sky: 0xbfe6ff,
  skyDusk: 0xffd0de,
  skyNight: 0x8a93cf,
  grass: 0xc6e8a8,
  grassDark: 0xa9dd90,
  soil: 0xf7e2b0,
  soilDark: 0xe6c987,
  tilled: 0xddb27e,
  rock: 0xe2e8f0,
  rockDark: 0xc6d0dc,
  trunk: 0xd9b38c,
  leafGreen: 0xb6e3a0,
  leafDeep: 0x9bd089,
  leafLight: 0xcdeeb4,
  water: 0xa8e6f0,
  cloud: 0xffffff,
  path: 0xf5ecd2,
  road: 0xa8b0ba,
};

// 果冻糖果：霓虹级四原色（亮黄/亮红/亮蓝/亮绿），小朋友高辨识度，最激进
// 草地绿保留；其余颜色统一提亮
const JELLY: Palette = {
  sky: 0xc8f5ff,
  skyDusk: 0xff9ecf,
  skyNight: 0x6a78e0,
  grass: 0x8ef05a,
  grassDark: 0x6fe03f,
  soil: 0xffe9a8,
  soilDark: 0xf5cf75,
  tilled: 0xf7bd5a,
  rock: 0xe8f2fb,
  rockDark: 0xc8d8e8,
  trunk: 0xf0b070,
  leafGreen: 0x8ef05a,
  leafDeep: 0x63d833,
  leafLight: 0xc2f588,
  water: 0x4addff,
  cloud: 0xffffff,
  path: 0xfff0c0,
  road: 0x93a4b6,
};

// 晨雾清新：极明度、弱对比，清晨通透感（光照最弱，避免洗白）
const MIST: Palette = {
  sky: 0xd6f0ff,
  skyDusk: 0xffd9e6,
  skyNight: 0x9aa2e0,
  grass: 0xd2ecc0,
  grassDark: 0xbfe0aa,
  soil: 0xfaead0,
  soilDark: 0xe8d2a8,
  tilled: 0xe0c394,
  rock: 0xe6ecf3,
  rockDark: 0xccd5e0,
  trunk: 0xe0c4a0,
  leafGreen: 0xc8e8b8,
  leafDeep: 0xb0dc9c,
  leafLight: 0xdcf0d0,
  water: 0xc4eef5,
  cloud: 0xffffff,
  path: 0xf6efdc,
  road: 0xaab2bc,
};

// ---------- 住宅配色（从马卡龙基础色派生各色系变体） ----------

const HOUSE_BASE: HousePalette[] = [
  { body: 0xfffaf1, roof: 0xe8703f, accent: 0x9fd8ea },
  { body: 0xfff4dd, roof: 0xc9542c, accent: 0xffe2b0 },
  { body: 0xfbfdfb, roof: 0x4f9c8e, accent: 0xffd9a0 },
  { body: 0xfff6ea, roof: 0xa9643f, accent: 0xbfe6f2 },
  { body: 0xf5efe4, roof: 0xe3a55c, accent: 0xd8ecc8 },
  { body: 0xeef4f6, roof: 0x8aa7c9, accent: 0xffd9c0 },
];

const HOUSES_CREAM = HOUSE_BASE.map((h) => ({
  body: mix(h.body, 0xffffff, 0.25),
  roof: mix(h.roof, 0xffffff, 0.15),
  accent: mix(h.accent, 0xffffff, 0.2),
}));
const HOUSES_MIST = HOUSE_BASE.map((h) => ({
  body: mix(h.body, 0xffffff, 0.4),
  roof: mix(h.roof, 0xffffff, 0.3),
  accent: mix(h.accent, 0xffffff, 0.35),
}));
// 果冻系：屋顶用高明度浅亮色（明亮不刺眼），墙体保留鲜活色
const HOUSES_JELLY: HousePalette[] = [
  { body: 0xfff0a0, roof: 0xffe85c, accent: 0x35e0ff }, // 亮黄屋顶 + 亮蓝点缀
  { body: 0xffc2a8, roof: 0xff7a7a, accent: 0xfff04d }, // 亮红屋顶
  { body: 0xb6d4ff, roof: 0x6aa6ff, accent: 0x9affd6 }, // 亮蓝屋顶
  { body: 0xb0f0a0, roof: 0x86f070, accent: 0xfff04d }, // 亮绿屋顶
  { body: 0xffc0e0, roof: 0xff8ecb, accent: 0xfff04d }, // 亮粉屋顶
  { body: 0xd8c0ff, roof: 0xc19bf0, accent: 0x35e0ff }, // 亮紫屋顶
  { body: 0xffe0a0, roof: 0xffb45c, accent: 0x35e0ff }, // 亮橙屋顶
  { body: 0xa0f0e0, roof: 0x6fe6dc, accent: 0xfff04d }, // 亮青屋顶
];

// ---------- 居民衣服色（同样从基础色派生） ----------

const SHIRTS_BASE = [0xff7a5c, 0x4f9ddb, 0x6cc24a, 0xffc233, 0xb08ae0, 0xff9a5c];
const SHIRTS_CREAM = SHIRTS_BASE.map((c) => mix(c, 0xffffff, 0.25));
const SHIRTS_MIST = SHIRTS_BASE.map((c) => mix(c, 0xffffff, 0.4));
// 果冻系居民：亮黄·亮红·亮蓝·亮绿四原色为主，再加亮粉/亮橙补多样性
const SHIRTS_JELLY = [0xffe600, 0xff2e2e, 0x2e7bff, 0x35e035, 0xff3ea8, 0xff8a00];

export const SCHEMES: Record<string, Scheme> = {
  macaron: {
    id: 'macaron',
    name: '云海',
    light: { hemi: 0.42, sun: 3.05, fill: 0.3 },
    houses: HOUSE_BASE,
    shirts: SHIRTS_BASE,
    palette: MACARON,
  },
  cream: {
    id: 'cream',
    name: '奶油水彩',
    light: { hemi: 0.95, sun: 0.95, fill: 0.42 },
    houses: HOUSES_CREAM,
    shirts: SHIRTS_CREAM,
    palette: CREAM,
  },
  jelly: {
    id: 'jelly',
    name: '果冻糖果',
    light: { hemi: 1.12, sun: 1.3, fill: 0.5 },
    houses: HOUSES_JELLY,
    shirts: SHIRTS_JELLY,
    palette: JELLY,
  },
  mist: {
    id: 'mist',
    name: '晨雾清新',
    light: { hemi: 1.03, sun: 0.85, fill: 0.46 },
    houses: HOUSES_MIST,
    shirts: SHIRTS_MIST,
    palette: MIST,
  },
};

export const SCHEME_LIST = Object.values(SCHEMES);
export const DEFAULT_SCHEME = 'macaron';

let activeId = DEFAULT_SCHEME;

export function getScheme(): Scheme {
  return SCHEMES[activeId] ?? SCHEMES[DEFAULT_SCHEME];
}
export function getSchemeId(): string {
  return activeId;
}
export function getPalette(): Palette {
  return getScheme().palette;
}
export function getHouses(): HousePalette[] {
  return getScheme().houses;
}
export function getShirts(): number[] {
  return getScheme().shirts;
}
export function setScheme(id: string): void {
  if (SCHEMES[id]) activeId = id;
}

export const ISLAND_RADIUS = 9;
