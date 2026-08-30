/**
 * 清新 low-poly 色板：马卡龙糖果风——高明度、中高饱和，整体明亮通透。
 * 用 MeshStandardMaterial 后光照是按物理强度算的（不再有 Lambert 的乘暗系数），
 * 所以这里的取值可以直接取「想看到的颜色」，不用再刻意留余量。
 */
export const PALETTE = {
  // 天空与时段：更亮的天蓝 + 粉调黄昏 + 不那么沉的夜空
  sky: 0x8fd6ff,
  skyDusk: 0xffb3c8,
  skyNight: 0x5566b0,

  // 草地：糖果绿，活力感
  grass: 0xbdf08f,
  grassDark: 0x9be07a,
  soil: 0xf6d588,
  soilDark: 0xe0bd6e,
  tilled: 0xd2a06a,
  rock: 0xd9e2ec,
  rockDark: 0xbcc8d6,

  // 树：暖棕树干 + 三档鲜绿
  trunk: 0xc28e5a,
  leafGreen: 0x8fe06a,
  leafDeep: 0x6cc457,
  leafLight: 0xc0f08a,

  // 水面：明亮青蓝
  water: 0x76d9f0,
  cloud: 0xffffff,
  path: 0xf2e6c8,
} as const;

export const ISLAND_RADIUS = 9;
