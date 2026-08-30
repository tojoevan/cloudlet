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

// 马卡龙：当前默认，高明度中高饱和，整体明亮通透
const MACARON: Palette = {
  sky: 0x8fd6ff,
  skyDusk: 0xffb3c8,
  skyNight: 0x5566b0,
  grass: 0xbdf08f,
  grassDark: 0x9be07a,
  soil: 0xf6d588,
  soilDark: 0xe0bd6e,
  tilled: 0xd2a06a,
  rock: 0xd9e2ec,
  rockDark: 0xbcc8d6,
  trunk: 0xc28e5a,
  leafGreen: 0x8fe06a,
  leafDeep: 0x6cc457,
  leafLight: 0xc0f08a,
  water: 0x76d9f0,
  cloud: 0xffffff,
  path: 0xf2e6c8,
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
};

// ---------- 住宅配色（从马卡龙基础色派生各色系变体） ----------

const HOUSE_BASE: HousePalette[] = [
  { body: 0xfff0e0, roof: 0xff8c69, accent: 0x8fe0f0 },
  { body: 0xffe9a8, roof: 0xff7043, accent: 0xffd28a },
  { body: 0xc8f0d8, roof: 0x4fb0a0, accent: 0xffe0a8 },
  { body: 0xffd6e0, roof: 0x9b8fc8, accent: 0xffb0c8 },
  { body: 0xe2f3a8, roof: 0xd49a3c, accent: 0xb6e8c8 },
  { body: 0xc4e4ff, roof: 0xe86a6a, accent: 0xcfe6ff },
  { body: 0xffe8c4, roof: 0x7fc97f, accent: 0xffd8a8 },
  { body: 0xe6d4f0, roof: 0xb07fd0, accent: 0xffc8ec },
  { body: 0xffd9a8, roof: 0xff7a33, accent: 0xc8ecc0 },
  { body: 0xc4f0ea, roof: 0x4fb6b0, accent: 0xffe6a8 },
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
    name: '马卡龙',
    light: { hemi: 0.98, sun: 1.12, fill: 0.4 },
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
