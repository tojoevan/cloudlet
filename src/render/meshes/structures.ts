import * as THREE from 'three';
import { BUILDINGS } from '../../data/buildings';
import { FACTORIES } from '../../data/factories';
import { CELL } from '../../core/island';
import type { BuildingType, FactoryType } from '../../core/types';
import { mat, matOwn } from '../mat';
import { getPalette, getHouses } from '../palette';
import { mulberry32, range } from '../rng';
import { makeTree } from './terrain';

export interface StructureMesh {
  group: THREE.Group;
  /** 夜间会亮的窗户材质，交给昼夜系统 */
  lights: THREE.MeshStandardMaterial[];
  /** 烟囱顶（局部坐标）。只有工厂有，生产气泡要从这儿冒 */
  chimneyTop?: THREE.Vector3;
}

/**
 * 住宅配色已随色系走，改由 palette.ts 的 getHouses() 提供（见 palette.ts 顶部注释）。
 * 按 seed 抽一组，所以同一栋永远一个样，整条街却各不相同。
 * 墙色要带够色相——太淡的话在光照下全都收敛成灰白，看着还是一整片同色。
 */

/**
 * 四棱锥屋顶，底面对齐 w×d。
 * 必须先在几何体层面旋转 45° 再缩放——反过来会把屋顶拉成平行四边形。
 */
function roofOf(w: number, h: number, d: number, color: number): THREE.Mesh {
  const r = Math.max(w, d) / Math.SQRT2;
  const geo = new THREE.ConeGeometry(r, h, 4);
  geo.rotateY(Math.PI / 4);
  geo.scale(w / (r * Math.SQRT2), 1, d / (r * Math.SQRT2));
  geo.computeVertexNormals();
  const cone = new THREE.Mesh(geo, mat(color));
  cone.castShadow = true;
  return cone;
}

export function makeHouse(
  seed: number,
  palette?: { body: number; roof: number; accent: number },
  level = 1,
): StructureMesh {
  const rng = mulberry32(seed);
  // 没指定配色就按 seed 抽一组——住宅要各色各样，才像住了一条街的人家
  const houses = getHouses();
  const p =
    palette ?? houses[Math.floor(rng() * houses.length)] ?? { body: getPalette().cloud, roof: 0xe07a5f, accent: getPalette().water };
  const g = new THREE.Group();
  const lights: THREE.MeshStandardMaterial[] = [];

  // 三种户型：坡顶小屋 / 平顶联排 / 带门廊的独栋。
  // 单一户型会让一条街看起来像复制粘贴，三种交替就立刻有"街区"的丰富度。
  const styleRoll = rng();
  const style: 'gable' | 'town' | 'villa' =
    styleRoll < 0.4 ? 'gable' : styleRoll < 0.72 ? 'town' : 'villa';
  // 联排更瘦高、独栋更宽，体量差本身也是辨识度
  const w = range(rng, 1.0, 1.35) * (style === 'town' ? 0.86 : style === 'villa' ? 1.12 : 1);
  const d = range(rng, 1.0, 1.3) * (style === 'town' ? 0.9 : 1);
  const floorH = range(rng, 0.72, 0.95) * (style === 'town' ? 1.12 : 1);
  // 等级 = 楼层数：1 层平房 → 2 层小屋 → 3 层。占地不变，只往高长，
  // 所以「升级已有房屋」能在不扩张岛屿的前提下提供容量。
  const floors = Math.max(1, Math.min(level, 3));

  // 夜间点亮的窗（整栋共用一个材质，便于昼夜系统统一控制）
  const winMat = matOwn(p.accent);
  lights.push(winMat);

  for (let f = 0; f < floors; f++) {
    const baseY = f * floorH;

    // 楼层主体
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, floorH, d), mat(p.body));
    body.position.y = baseY + floorH / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // 楼层之间的小檐（底层不加），让多层更像小屋而非光秃秃的柱子
    if (f > 0) {
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.07, d + 0.1), mat(p.roof));
      ledge.position.y = baseY;
      ledge.castShadow = true;
      g.add(ledge);
    }

    // 窗：每层正面 + 侧面，抬到该层高度，避免与各层门共面 z-fighting
    const winY = baseY + floorH * 0.62;
    const winCount = rng() > 0.5 ? 2 : 1;
    for (let i = 0; i < winCount; i++) {
      const wx = (i - (winCount - 1) / 2) * 0.42;
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.06), winMat);
      win.position.set(wx, winY, d / 2 + 0.02);
      g.add(win);
      // 窗台花箱：一点点暖色，是"有人住"的关键细节
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.1), mat(p.roof));
      box.position.set(wx, winY - 0.14, d / 2 + 0.05);
      g.add(box);
      const bloom = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.05, 0),
        mat(rng() > 0.5 ? 0xf0687a : 0xffd45e),
      );
      bloom.position.set(wx + (rng() - 0.5) * 0.14, winY - 0.1, d / 2 + 0.08);
      g.add(bloom);
    }
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.22), winMat);
    side.position.set(w / 2 + 0.02, winY, 0);
    g.add(side);

    // 门只在底层，配一个出挑的小雨棚——正面立刻有"入口"这个视觉重点
    if (f === 0) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.42, 0.06), mat(p.roof));
      door.position.set(0, 0.21, d / 2 + 0.02);
      g.add(door);
      const awning = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.2), mat(p.accent));
      awning.position.set(0, 0.47, d / 2 + 0.11);
      awning.rotation.x = -0.18;
      awning.castShadow = true;
      g.add(awning);
      const step = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.14), mat(getPalette().rock));
      step.position.set(0, 0.03, d / 2 + 0.1);
      g.add(step);
    }
  }

  // 顶层屋顶：按户型分三种收法
  const topY = floors * floorH;
  const rh = range(rng, 0.45, 0.7);
  if (style === 'town') {
    // 平顶 + 女儿墙：联排的都市感，也让天际线有"平"的变化
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.08, d + 0.08), mat(p.roof));
    slab.position.y = topY + 0.04;
    slab.castShadow = true;
    g.add(slab);
    const rim: [number, number, number, number][] = [
      [0, d / 2 + 0.02, w + 0.08, 0.06],
      [0, -d / 2 - 0.02, w + 0.08, 0.06],
      [w / 2 + 0.02, 0, 0.06, d + 0.08],
      [-w / 2 - 0.02, 0, 0.06, d + 0.08],
    ];
    for (const [sx, sz, sw, sd] of rim) {
      const par = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.17, sd), mat(p.body));
      par.position.set(sx, topY + 0.16, sz);
      par.castShadow = true;
      g.add(par);
    }
    // 二层正面加一个阳台，联排的"生活感"就靠它
    if (floors >= 2) {
      const bal = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, 0.05, 0.28), mat(p.body));
      bal.position.set(0, floorH + 0.06, d / 2 + 0.14);
      g.add(bal);
      for (let i = 0; i < 4; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.19, 0.03), mat(p.accent));
        post.position.set(-w * 0.33 + (i * w * 0.66) / 3, floorH + 0.16, d / 2 + 0.26);
        g.add(post);
      }
    }
  } else if (style === 'villa') {
    // 独栋：门廊顶 + 两根柱子，前面形成一块"入户灰空间"
    const porch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.07, 0.52), mat(p.roof));
    porch.position.set(0, floorH * 0.96, d / 2 + 0.26);
    porch.castShadow = true;
    g.add(porch);
    for (const px of [-w * 0.38, w * 0.38]) {
      const col = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.055, floorH * 0.96, 6),
        mat(p.accent),
      );
      col.position.set(px, floorH * 0.48, d / 2 + 0.48);
      col.castShadow = true;
      g.add(col);
    }
    const roof = roofOf(w + 0.18, rh, d + 0.18, p.roof);
    roof.position.y = topY + rh / 2;
    g.add(roof);
  } else {
    // 坡顶小屋（尺寸外扩 0.16：出檐是"像房子"的廉价大招）
    const roof = roofOf(w + 0.16, rh, d + 0.16, p.roof);
    roof.position.y = topY + rh / 2;
    g.add(roof);
  }

  // 老虎窗：多层住宅屋顶上的小凸窗，剪影立刻不一样
  if (style !== 'town' && floors >= 2 && rng() > 0.45) {
    const dormer = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.24), mat(p.body));
    dormer.position.set(w * 0.18, topY + rh * 0.45, d / 2 - 0.08);
    dormer.castShadow = true;
    g.add(dormer);
    const dWin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.04), winMat);
    dWin.position.set(w * 0.18, topY + rh * 0.45, d / 2 + 0.05);
    g.add(dWin);
  }

  // 烟囱在顶层（平顶联排不摆烟囱，避免和女儿墙打架）
  if (style !== 'town' && rng() > 0.4) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.16), mat(getPalette().rockDark));
    ch.position.set(w * 0.26, topY + rh * 0.55, -d * 0.2);
    g.add(ch);
  }

  g.userData.lights = lights;
  return { group: g, lights };
}

export function makeFactory(type: FactoryType, seed: number): StructureMesh {
  const rng = mulberry32(seed);
  const def = FACTORIES[type];
  const g = new THREE.Group();
  const lights: THREE.MeshStandardMaterial[] = [];

  const w = 1.5;
  const d = 1.4;
  const h = 1.0;

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(def.body));
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const roof = roofOf(w, 0.45, d, def.roof);
  roof.position.y = h + 0.225;
  g.add(roof);

  // 烟囱：工厂的身份标识，也是生产气泡的出口
  const chimneyH = 0.9;
  const chimney = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.16, chimneyH, 6),
    mat(def.chimney),
  );
  chimney.position.set(w * 0.34, h + chimneyH / 2, -d * 0.28);
  chimney.castShadow = true;
  g.add(chimney);

  // 招牌色带
  const band = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, 0.16, d * 1.02), mat(def.roof));
  band.position.y = h * 0.72;
  g.add(band);

  // 入口雨棚：可生产建筑的身份牌（住宅一律没有）。
  // 白色与建筑自身屋顶色交替——颜色随建筑走不突兀，「带棚」这个形状才是标识。
  const awning = new THREE.Group();
  const segW = (w * 0.94) / 6;
  for (let i = 0; i < 6; i++) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.05, 0.34), mat(i % 2 ? 0xfff7ee : def.roof));
    seg.position.x = -w * 0.47 + segW * (i + 0.5);
    seg.castShadow = true;
    awning.add(seg);
  }
  awning.position.set(0, h * 0.92, d / 2 + 0.14);
  awning.rotation.x = 0.32; // 前缘微微下垂
  g.add(awning);

  const winMat = matOwn(0xffe9a8);
  lights.push(winMat);
  for (let i = 0; i < 2; i++) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.06), winMat);
    win.position.set(-0.3 + i * 0.6, h * 0.42, d / 2 + 0.02);
    g.add(win);
  }

  g.userData.lights = lights;
  g.userData.factoryType = type;
  if (type === 'lumber') decorateLumber(g, w, d);
  else if (type === 'ranch') decorateRanch(g, w, d);
  void rng;

  // 冒烟要从烟囱口出来，稍微抬高一点免得埋在烟囱里
  const chimneyTop = new THREE.Vector3(
    chimney.position.x,
    chimney.position.y + chimneyH / 2 + 0.06,
    chimney.position.z,
  );
  return { group: g, lights, chimneyTop };
}

function decorateLumber(g: THREE.Group, w: number, d: number): void {
  const logMat = mat(getPalette().trunk);
  const stack = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.62, 6), logMat);
    log.rotation.z = Math.PI / 2;
    log.position.set(0, 0.12 + i * 0.24, i % 2 ? 0.12 : -0.12);
    log.castShadow = true;
    stack.add(log);
  }
  stack.position.set(w / 2 + 0.5, 0, -d / 2 + 0.35);
  g.add(stack);

  const saw = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 0.12), mat(0x9aa3ad));
  saw.position.set(-w / 2 - 0.4, 0.2, d / 2 - 0.25);
  saw.rotation.y = 0.5;
  saw.castShadow = true;
  g.add(saw);
}

function decorateRanch(g: THREE.Group, w: number, d: number): void {
  const fenceMat = mat(0xb5483b);
  const fence = new THREE.Group();
  for (const x of [-0.55, 0, 0.55]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.08), fenceMat);
    post.position.set(x, 0.21, 0);
    fence.add(post);
  }
  const rail1 = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.07, 0.06), fenceMat);
  rail1.position.y = 0.3;
  fence.add(rail1);
  const rail2 = rail1.clone();
  rail2.position.y = 0.13;
  fence.add(rail2);
  fence.position.set(0, 0, d / 2 + 0.55);
  g.add(fence);

  const hay = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 8), mat(0xe8c45a));
  hay.rotation.z = Math.PI / 2;
  hay.position.set(-w / 2 - 0.45, 0.24, -d / 2 + 0.35);
  hay.castShadow = true;
  g.add(hay);
}

export function makeFountain(seed: number): StructureMesh {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const lights: THREE.MeshStandardMaterial[] = [];

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.22, 10), mat(0xe8f1f5));
  base.position.y = 0.11;
  base.receiveShadow = true;
  g.add(base);

  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 10), mat(getPalette().water));
  water.position.y = 0.24;
  g.add(water);

  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.5, 8), mat(0xe8f1f5));
  pillar.position.y = 0.47;
  g.add(pillar);

  const jet = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 8), mat(0xbde0fe));
  jet.position.y = 0.82;
  jet.userData.spin = true;
  g.add(jet);

  g.userData.lights = lights;
  void rng;
  return { group: g, lights };
}

export function makeParkBench(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.22), mat(getPalette().trunk));
  seat.position.y = 0.24;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.05), mat(getPalette().trunk));
  back.position.set(0, 0.38, -0.09);
  g.add(back);
  for (const x of [-0.24, 0.24]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.2), mat(getPalette().rockDark));
    leg.position.set(x, 0.12, 0);
    g.add(leg);
  }
  g.rotation.y = range(rng, 0, Math.PI * 2);
  return g;
}

export function makeBuilding(
  type: BuildingType,
  seed: number,
  level = 1,
  w = 1,
  h = 1,
  fit = false,
  roadMask = -1,
): StructureMesh {
  const def = BUILDINGS[type];
  if (type === 'road') return makeRoad(seed, roadMask);
  if (type === 'fountain') {
    const r = makeFountain(seed);
    r.group.scale.setScalar(1 + (level - 1) * 0.12);
    return r;
  }
  if (type === 'park') {
    const g = new THREE.Group();
    const lawn = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.95, 0.12, 10), mat(def.body));
    lawn.position.y = 0.06;
    lawn.receiveShadow = true;
    g.add(lawn);
    g.add(makeParkBench(seed + 1));
    // 两棵树放在对角、远离中央长椅，避免遮挡座位
    const treeSpots: Array<[number, number]> = [
      [-0.52, 0.42],
      [0.52, -0.42],
    ];
    for (let i = 0; i < 2; i++) {
      const t = makeTree(seed + 20 + i, i % 2 ? 'broadleaf' : 'pine');
      t.position.set(treeSpots[i][0], 0.1, treeSpots[i][1]);
      t.scale.multiplyScalar(0.8);
      g.add(t);
    }
    g.userData.lights = [];
    g.scale.setScalar(1 + (level - 1) * 0.12);
    return { group: g, lights: [] };
  }
  // 住宅走随机配色；咖啡馆、公园、喷泉各有固定形象，别打乱
  let base: StructureMesh;
  if (type === 'house') base = makeHouse(seed, undefined, level);
  else base = makeHouse(seed, { body: def.body, roof: def.roof, accent: def.accent }, level);

  // 方岛：把模型缩放到实际网格占地（w×h 格），避免压到邻格
  if (fit) {
    const BASE = 1.1;
    const fw = (w * CELL * 0.82) / BASE;
    const fd = (h * CELL * 0.82) / BASE;
    base.group.scale.set(fw, 1, fd);
  }
  return base;
}

/**
 * 道路：按网格邻接自动拼接(autotile)。
 * mask 是 4 个方向位（N=1 E=2 S=4 W=8，对应 gz-1/gx+1/gz+1/gx-1）。
 *  - 4 连 → 十字路口；3 连 → 丁字路口；2 对连 → 直路；2 邻连 → 左/右拐弯；1 连 → 末端。
 * 每段向连通方向伸出「臂」到格边，与邻段在边界处严丝合缝，保证整张路网连续。
 * mask<0（圆岛/预览占位）走传统单砖渲染。
 */
const ROAD_DIRS = [
  { bit: 1, dx: 0, dz: -1 }, // N  (-z)
  { bit: 2, dx: 1, dz: 0 }, //  E  (+x)
  { bit: 4, dx: 0, dz: 1 }, //  S  (+z)
  { bit: 8, dx: -1, dz: 0 }, // W  (-x)
];
export function makeRoad(seed: number, mask = -1): StructureMesh {
  const g = new THREE.Group();
  void seed;
  // 传统单砖：圆岛（极坐标散布、无网格拼接）或建造预览占位
  if (mask < 0) {
    const tile = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 0.94, 0.08, CELL * 0.94),
      mat(getPalette().rockDark),
    );
    tile.position.y = 0.05;
    tile.receiveShadow = true;
    g.add(tile);
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(CELL * 0.94, 0.02, 0.08),
      mat(getPalette().cloud),
    );
    line.position.y = 0.1;
    g.add(line);
    g.userData.lights = [];
    return { group: g, lights: [] };
  }

  const rw = CELL * 0.3; // 半幅：路宽 0.6 格，留草边
  const H = 0.07;
  const surf = mat(getPalette().road);
  const lineMat = mat(getPalette().cloud);

  // 中心岛：十字/T/拐弯的交汇处都靠它填满
  const pad = new THREE.Mesh(new THREE.BoxGeometry(rw * 2, H, rw * 2), surf);
  pad.position.y = 0.05;
  pad.receiveShadow = true;
  g.add(pad);

  const along = CELL * 0.5; // 臂长：从中心伸到格边，与邻段在边界相接
  const lw = 0.07; // 中线宽
  for (const d of ROAD_DIRS) {
    if (!(mask & d.bit)) continue;
    const sx = d.dx !== 0 ? along : rw * 2;
    const sz = d.dz !== 0 ? along : rw * 2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(sx, H, sz), surf);
    arm.position.set((d.dx * CELL) / 4, 0.05, (d.dz * CELL) / 4);
    arm.receiveShadow = true;
    g.add(arm);
    // 中线：沿臂方向，使直路成线、拐弯成 L、路口汇聚
    const lx = d.dx !== 0 ? along : lw;
    const lz = d.dz !== 0 ? along : lw;
    const line = new THREE.Mesh(new THREE.BoxGeometry(lx, 0.02, lz), lineMat);
    line.position.set((d.dx * CELL) / 4, 0.095, (d.dz * CELL) / 4);
    g.add(line);
  }
  g.userData.lights = [];
  return { group: g, lights: [] };
}
