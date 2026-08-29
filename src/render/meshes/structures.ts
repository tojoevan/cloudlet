import * as THREE from 'three';
import { BUILDINGS } from '../../data/buildings';
import { FACTORIES } from '../../data/factories';
import type { BuildingType, FactoryType } from '../../core/types';
import { mat, matOwn } from '../mat';
import { PALETTE } from '../palette';
import { mulberry32, range } from '../rng';
import { makeTree } from './terrain';

export interface StructureMesh {
  group: THREE.Group;
  /** 夜间会亮的窗户材质，交给昼夜系统 */
  lights: THREE.MeshLambertMaterial[];
  /** 烟囱顶（局部坐标）。只有工厂有，生产气泡要从这儿冒 */
  chimneyTop?: THREE.Vector3;
}

/**
 * 住宅配色。按 seed 抽一组，所以同一栋永远一个样，整条街却各不相同。
 * 墙色要带够色相——太淡的话在光照下全都收敛成灰白，看着还是一整片同色。
 */
const HOUSE_PALETTES: { body: number; roof: number; accent: number }[] = [
  { body: 0xfff4e2, roof: 0xe0805f, accent: 0x9ed2e8 }, // 奶白 + 珊瑚
  { body: 0xfbe6b8, roof: 0xc4644a, accent: 0xffe0b0 }, // 奶油黄 + 砖红
  { body: 0xcfe9db, roof: 0x5b8fa8, accent: 0xffe0b0 }, // 薄荷 + 湖蓝
  { body: 0xf8cfd8, roof: 0x8f9db0, accent: 0xffd0bc }, // 浅粉 + 灰蓝
  { body: 0xd8eab2, roof: 0xc09050, accent: 0xa8d8c0 }, // 淡黄绿 + 驼
  { body: 0xc4dcf0, roof: 0xf2f2ea, accent: 0xb0cfe8 }, // 天蓝 + 白
  { body: 0xefdcb8, roof: 0x7fa87f, accent: 0xffe0b0 }, // 米黄 + 苔绿
  { body: 0xdccbe8, roof: 0x9b7fa8, accent: 0xffd0e0 }, // 淡紫 + 紫灰
  { body: 0xfad9b0, roof: 0xd97b3a, accent: 0xc8e0c0 }, // 杏 + 橙
  { body: 0xc4e2de, roof: 0x5f9e9c, accent: 0xffe3b0 }, // 青 + 深青
];

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
): StructureMesh {
  const rng = mulberry32(seed);
  // 没指定配色就按 seed 抽一组——住宅要各色各样，才像住了一条街的人家
  const p =
    palette ?? HOUSE_PALETTES[Math.floor(rng() * HOUSE_PALETTES.length)] ?? { body: PALETTE.cloud, roof: 0xe07a5f, accent: PALETTE.water };
  const g = new THREE.Group();
  const lights: THREE.MeshLambertMaterial[] = [];

  const w = range(rng, 1.0, 1.35);
  const d = range(rng, 1.0, 1.3);
  const h = range(rng, 0.75, 1.05);

  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(p.body));
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  const rh = range(rng, 0.45, 0.7);
  const roof = roofOf(w, rh, d, p.roof);
  roof.position.y = h + rh / 2;
  g.add(roof);

  // 门
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.42, 0.06), mat(p.roof));
  door.position.set(0, 0.21, d / 2 + 0.02);
  g.add(door);

  // 窗：单独材质，夜间点亮。抬到门楣之上（门顶固定在 y=0.42），
  // 与门在 y 上彻底错开，避免两者正面共面（z=d/2+0.05）造成旋转时 z-fighting 闪烁。
  const winMat = matOwn(p.accent);
  lights.push(winMat);
  const winY = Math.max(0.56, h * 0.62);
  const winCount = rng() > 0.5 ? 2 : 1;
  for (let i = 0; i < winCount; i++) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.06), winMat);
    win.position.set((i - (winCount - 1) / 2) * 0.42, winY, d / 2 + 0.02);
    g.add(win);
  }
  const side = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.22), winMat);
  side.position.set(w / 2 + 0.02, winY, 0);
  g.add(side);

  // 烟囱
  if (rng() > 0.4) {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.16), mat(PALETTE.rockDark));
    ch.position.set(w * 0.26, h + rh * 0.55, -d * 0.2);
    g.add(ch);
  }

  g.userData.lights = lights;
  return { group: g, lights };
}

export function makeFactory(type: FactoryType, seed: number): StructureMesh {
  const rng = mulberry32(seed);
  const def = FACTORIES[type];
  const g = new THREE.Group();
  const lights: THREE.MeshLambertMaterial[] = [];

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
  const logMat = mat(PALETTE.trunk);
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
  const lights: THREE.MeshLambertMaterial[] = [];

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.7, 0.22, 10), mat(0xe8f1f5));
  base.position.y = 0.11;
  base.receiveShadow = true;
  g.add(base);

  const water = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 10), mat(PALETTE.water));
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
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.22), mat(PALETTE.trunk));
  seat.position.y = 0.24;
  g.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.05), mat(PALETTE.trunk));
  back.position.set(0, 0.38, -0.09);
  g.add(back);
  for (const x of [-0.24, 0.24]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.24, 0.2), mat(PALETTE.rockDark));
    leg.position.set(x, 0.12, 0);
    g.add(leg);
  }
  g.rotation.y = range(rng, 0, Math.PI * 2);
  return g;
}

export function makeBuilding(type: BuildingType, seed: number): StructureMesh {
  const def = BUILDINGS[type];
  if (type === 'fountain') return makeFountain(seed);
  if (type === 'park') {
    const rng = mulberry32(seed);
    const g = new THREE.Group();
    const lawn = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.95, 0.12, 10), mat(def.body));
    lawn.position.y = 0.06;
    lawn.receiveShadow = true;
    g.add(lawn);
    g.add(makeParkBench(seed + 1));
    for (let i = 0; i < 2; i++) {
      const t = makeTree(seed + 20 + i, i % 2 ? 'broadleaf' : 'pine');
      t.position.set(range(rng, -0.55, 0.55), 0.1, range(rng, -0.55, 0.55));
      t.scale.multiplyScalar(0.8);
      g.add(t);
    }
    g.userData.lights = [];
    return { group: g, lights: [] };
  }
  // 住宅走随机配色；咖啡馆、公园、喷泉各有固定形象，别打乱
  if (type === 'house') return makeHouse(seed);
  return makeHouse(seed, { body: def.body, roof: def.roof, accent: def.accent });
}
