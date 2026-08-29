/**
 * 清新 low-poly 色板：莫兰迪打底，高饱和点缀。
 * 注意 Lambert 材质会把颜色乘以光照系数（实测约 0.65），
 * 所以这里的取值要留足余量，否则渲染出来会发灰。
 */
export const PALETTE = {
  sky: 0xa8dcf8,
  skyDusk: 0xffc8a2,
  skyNight: 0x3a4d80,

  grass: 0xa8e6a0,
  grassDark: 0x8ad48a,
  soil: 0xe3c76e,
  soilDark: 0xd0af62,
  tilled: 0xb89566,
  rock: 0xbfcbd6,
  rockDark: 0xa3b0bd,

  trunk: 0x9c7a55,
  leafGreen: 0x7cc45f,
  leafDeep: 0x63a04a,
  leafLight: 0xa3de82,

  water: 0x9ed8f0,
  cloud: 0xffffff,
  path: 0xe8dcc2,
} as const;

export const ISLAND_RADIUS = 9;
