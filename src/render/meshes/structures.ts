import * as THREE from 'three';
import { BUILDINGS } from '../../data/buildings';
import { FACTORIES } from '../../data/factories';
import { CELL } from '../../core/island';
import type { BuildingType, FactoryType } from '../../core/types';
import { mat, matOwn } from '../mat';
import { getPalette, getHouses } from '../palette';
import { bakeStatic } from '../bake';
import { makeFlowerBed, makeLamp, makeMailbox, makePlanter } from './props';
import { mulberry32, pick, range } from '../rng';
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
  const houses = getHouses();
  const p =
    palette ?? houses[Math.floor(rng() * houses.length)] ?? { body: getPalette().cloud, roof: 0xe07a5f, accent: getPalette().water };
  const g = new THREE.Group();
  const lights: THREE.MeshStandardMaterial[] = [];

  // 两种真正不同的农舍原型：山墙农舍 / 带门廊的独栋。
  // 不再做平顶联排，也不做三层公寓。
  const style: 'gable' | 'porch' = rng() < 0.62 ? 'gable' : 'porch';
  const w = range(rng, 1.18, 1.48) * (style === 'porch' ? 1.08 : 1);
  const d = range(rng, 1.02, 1.26);
  const floorH = range(rng, 0.86, 0.96);
  const floors = level >= 3 ? 2 : 1;
  const roofH = range(rng, 0.72, 0.94) * (level >= 2 ? 1.08 : 1);

  const timber = mat(0x6f4b34);
  const timberLight = mat(0x9a6d48);
  const trim = mat(new THREE.Color(p.body).lerp(new THREE.Color(0xffffff), 0.58).getHex());
  const stone = mat(getPalette().rock);
  const stoneDark = mat(getPalette().rockDark);
  const shutterColor = pick(rng, [0x4f7f78, 0xb8664f, 0x7d9165, 0x9a6c8d]);
  const shutter = mat(shutterColor);
  // 白天是偏冷的天光玻璃，入夜才由昼夜系统点亮成暖黄；
  // 不要直接用 accent 当玻璃色，否则白天像一排亮着的黄灯。
  const winMat = matOwn(new THREE.Color(0x6fabbc).lerp(new THREE.Color(p.accent), 0.22).getHex());
  lights.push(winMat);
  const lampMat = matOwn(0xffe2a4, { emissive: 0xffd38a, emissiveIntensity: 0 });
  lights.push(lampMat);

  // 石基座：不是一块平板，而是一圈有厚度的毛石
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.18, d + 0.16), stoneDark);
  plinth.position.y = 0.09;
  plinth.receiveShadow = true;
  g.add(plinth);
  for (let i = 0; i < 6; i++) {
    const sx = -w / 2 + (i / 5) * w + range(rng, -0.03, 0.03);
    const s = new THREE.Mesh(
      new THREE.BoxGeometry(range(rng, 0.12, 0.22), range(rng, 0.07, 0.13), 0.06),
      stone,
    );
    s.position.set(sx, range(rng, 0.04, 0.1), d / 2 + 0.1);
    s.rotation.z = range(rng, -0.08, 0.08);
    g.add(s);
  }

  // 楼体
  for (let f = 0; f < floors; f++) {
    const baseY = f * floorH;
    const bodyColor = f === 0 ? new THREE.Color(p.body).lerp(new THREE.Color(0xffefd6), 0.34) : new THREE.Color(p.body).lerp(new THREE.Color(0xffefd6), 0.42);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, floorH, d), mat(bodyColor.getHex()));
    body.position.y = baseY + floorH / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    if (f > 0) {
      // 二层不叠“盒子”，而是比底层收进一点，形成挑檐下的阴影
      const inset = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.07, d + 0.08), timberLight);
      inset.position.y = baseY;
      g.add(inset);
    }
  }
  const topY = floors * floorH;

  // 窗户：单个窗户 = 窗框 + 玻璃 + 百叶 + 花箱 + 十字窗棂
  const windowUnit = (withBox = true): THREE.Group => {
    const u = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.05), trim);
    frame.position.z = 0.012;
    u.add(frame);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.055), winMat);
    win.position.z = 0.035;
    win.userData.noBake = true;
    u.add(win);
    const barV = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.26, 0.07), trim);
    barV.position.z = 0.045;
    u.add(barV);
    const barH = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.018, 0.07), trim);
    barH.position.z = 0.046;
    u.add(barH);
    for (const side of [-1, 1]) {
      const sh = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.29, 0.035), shutter);
      sh.position.set(side * 0.205, 0, 0.012);
      sh.castShadow = true;
      u.add(sh);
    }
    if (withBox) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.15), timberLight);
      box.position.set(0, -0.19, 0.08);
      u.add(box);
      const bloomColors = [0xf0687a, 0xffd45e, 0xc48ae0, 0xffffff];
      for (let i = 0; i < 3; i++) {
        const bloom = new THREE.Mesh(
          new THREE.IcosahedronGeometry(range(rng, 0.035, 0.055), 0),
          mat(bloomColors[Math.floor(rng() * bloomColors.length)]),
        );
        bloom.position.set(-0.11 + i * 0.11, -0.14, 0.11);
        u.add(bloom);
      }
    }
    return u;
  };
  const addFrontWindow = (x: number, y: number, box = true) => {
    const u = windowUnit(box);
    u.position.set(x, y, d / 2 + 0.035);
    g.add(u);
  };
  const addSideWindow = (side: 1 | -1, z: number, y: number) => {
    const u = windowUnit(false);
    u.position.set(side * (w / 2 + 0.03), y, z);
    u.rotation.y = side * Math.PI / 2;
    g.add(u);
  };

  // 底层：门在中间偏左，右边两扇窗；上层两扇窗
  const doorX = 0;
  const wx = Math.min(w * 0.31, w / 2 - 0.27);
  addFrontWindow(-wx, floorH * 0.58);
  addFrontWindow(wx, floorH * 0.58);
  addSideWindow(1, -d * 0.18, floorH * 0.56);
  if (floors >= 2) {
    addFrontWindow(-w * 0.22, floorH + floorH * 0.58);
    addFrontWindow(w * 0.24, floorH + floorH * 0.58);
    addSideWindow(-1, d * 0.12, floorH + floorH * 0.56);
  }

  // 门：木门 + 石门楣 + 小雨棚 + 门灯 + 台阶
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.52, 0.06), timber);
  door.position.set(doorX, 0.31, d / 2 + 0.045);
  g.add(door);
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.09), stone);
  lintel.position.set(doorX, 0.6, d / 2 + 0.05);
  g.add(lintel);
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.045, 0.22), mat(p.roof));
  canopy.position.set(doorX, 0.78, d / 2 + 0.15);
  canopy.rotation.x = -0.16;
  canopy.castShadow = true;
  g.add(canopy);
  for (const side of [-1, 1]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.22, 0.03), timber);
    bracket.position.set(doorX + side * 0.22, 0.56, d / 2 + 0.1);
    bracket.rotation.z = side * 0.55;
    g.add(bracket);
  }
  const step = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.18), stone);
  step.position.set(doorX, 0.035, d / 2 + 0.13);
  g.add(step);
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.09), lampMat);
  lantern.position.set(doorX + 0.28, 0.48, d / 2 + 0.07);
  lantern.userData.noBake = true;
  g.add(lantern);

  // 木构架：角柱 / 中柱 / 腰梁 / 侧墙斜撑
  for (const tx of [-w / 2 + 0.035, w / 2 - 0.035]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.045, topY * 0.94, 0.04), timber);
    beam.position.set(tx, topY * 0.47, d / 2 + 0.055);
    g.add(beam);
  }
  for (const y of [0.18, topY * 0.96]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.045, 0.04), timber);
    beam.position.set(0, y, d / 2 + 0.055);
    g.add(beam);
  }
  for (const side of [-1, 1]) {
    for (const z of [-d * 0.28, d * 0.28]) {
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.48, 0.04), timber);
      brace.position.set(side * (w / 2 + 0.055), floorH * 0.68, z);
      brace.rotation.x = side * 0.58;
      g.add(brace);
    }
  }

  // 屋顶：加大的出檐 + 屋脊压条 + 檐口封板 + 椽头
  const roofW = w + 0.42;
  const roofD = d + 0.36;
  const roof = buildRoof('gable', roofW, roofH, roofD, p.roof, p.body);
  roof.position.y = topY;
  g.add(roof);
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(roofW + 0.02, 0.075, 0.14), mat(new THREE.Color(p.roof).offsetHSL(0, 0, -0.06).getHex()));
  ridge.position.y = topY + roofH - 0.02;
  g.add(ridge);
  for (const side of [-1, 1]) {
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(roofW, 0.06, 0.055), trim);
    fascia.position.set(0, topY + 0.015, side * (roofD / 2 - 0.02));
    g.add(fascia);
    for (let i = -1; i <= 1; i++) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 0.32), timberLight);
      tail.position.set(i * roofW * 0.3, topY + 0.02, side * (roofD / 2 + 0.1));
      g.add(tail);
    }
  }

  // Lv2：屋顶天窗。比“贴一块盒子”更像真实的老虎窗/阁楼窗，
  // 也不会在坡屋顶上留下一个悬空的白色方块。
  if (level >= 2) {
    const skZ = d * 0.27;
    const roofFrac = 1 - skZ / (roofD / 2);
    const skY = topY + roofH * Math.max(0.2, roofFrac);
    const angle = Math.atan2(roofH, roofD / 2);
    // 四条边框 + 一块略高的玻璃，保证俯视时看到的是窗面而不是白边
    const sk = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.035, 0.34), winMat);
    sk.position.set(w * 0.18, skY + 0.055, skZ);
    sk.rotation.x = -angle;
    sk.userData.noBake = true;
    g.add(sk);
    for (const [bw, bd, bx, bz] of [
      [0.36, 0.035, 0, -0.19], [0.36, 0.035, 0, 0.19],
      [0.035, 0.42, -0.18, 0], [0.035, 0.42, 0.18, 0],
    ] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.045, bd), trim);
      bar.position.set(w * 0.18 + bx, skY + 0.05, skZ + bz);
      bar.rotation.x = -angle;
      g.add(bar);
    }
  }

  // 烟囱：毛石烟囱 + 两个陶土烟帽，偏在一侧
  const chX = w * 0.36;
  const chZ = -d * 0.06;
  const chH = roofH * 0.9 + 0.35;
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.2, chH, 0.2), stoneDark);
  chimney.position.set(chX, topY + chH / 2 + 0.06, chZ);
  chimney.castShadow = true;
  g.add(chimney);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.06, 0.28), stone);
  cap.position.set(chX, topY + chH + 0.06, chZ);
  g.add(cap);
  for (const off of [-0.055, 0.055]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.12, 6), mat(0xb05a42));
    pot.position.set(chX + off, topY + chH + 0.15, chZ);
    g.add(pot);
  }

  // 门廊：只在门前做一小段“灰空间”，不再用一片大屋顶把整面墙盖住
  if (style === 'porch') {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(w * 1.0, 0.08, 0.5), timberLight);
    deck.position.set(0, 0.04, d / 2 + 0.28);
    deck.castShadow = true;
    g.add(deck);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, floorH * 0.92, 0.07), timber);
      post.position.set(side * w * 0.5, floorH * 0.46, d / 2 + 0.45);
      post.castShadow = true;
      g.add(post);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), timber);
      brace.position.set(side * w * 0.46, floorH * 0.82, d / 2 + 0.32);
      brace.rotation.z = side * 0.7;
      g.add(brace);
    }
    // 门廊用开放木架收头，不再压一片大屋顶，正面的窗与木构架保持可见
    const porchBeam = new THREE.Mesh(new THREE.BoxGeometry(w * 1.0, 0.07, 0.07), timber);
    porchBeam.position.set(0, floorH * 0.95, d / 2 + 0.45);
    porchBeam.castShadow = true;
    g.add(porchBeam);
    const hanging = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), mat(0x7d9165));
    hanging.position.set(w * 0.18, floorH * 0.82, d / 2 + 0.45);
    g.add(hanging);
  }

  // Lv3：单层侧翼，和主屋共用坡顶语言
  if (level >= 3) {
    const aw = w * 0.46;
    const ad = d * 0.66;
    const ah = floorH * 0.9;
    const ax = w / 2 + aw / 2 - 0.04;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(aw, ah, ad), mat(p.body));
    wing.position.set(ax, ah / 2, -d * 0.08);
    wing.castShadow = true;
    wing.receiveShadow = true;
    g.add(wing);
    const wingBase = new THREE.Mesh(new THREE.BoxGeometry(aw + 0.1, 0.14, ad + 0.1), stone);
    wingBase.position.set(ax, 0.07, -d * 0.08);
    g.add(wingBase);
    // 单坡顶：从主屋山墙向外低下去
    const wingRoof = new THREE.Mesh(new THREE.BoxGeometry(aw + 0.24, 0.07, ad + 0.18), mat(p.roof));
    wingRoof.position.set(ax + 0.06, ah + 0.13, -d * 0.08);
    wingRoof.rotation.z = -0.22;
    wingRoof.castShadow = true;
    g.add(wingRoof);
    const wingWin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.2, 0.05), winMat);
    wingWin.position.set(ax, ah * 0.58, -d * 0.08 + ad / 2 + 0.03);
    wingWin.userData.noBake = true;
    g.add(wingWin);
  }

  // 攀藤：几片贴墙的深绿，给白墙一点“长出来”的生气
  if (rng() > 0.45) {
    const vineMat = mat(getPalette().leafDeep);
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(range(rng, 0.04, 0.075), 0), vineMat);
      leaf.scale.set(1.4, 0.7, 0.45);
      leaf.position.set(w / 2 + 0.04, range(rng, 0.4, topY - 0.1), range(rng, -d * 0.35, d * 0.35));
      g.add(leaf);
    }
  }

  bakeStatic(g);
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
  bakeStatic(g);
  return g;
}

/**
 * 把一栋建筑等比缩放到 w×h 格内。
 * 旧实现用 (fw, 1, fd) 非等比缩放，房子在方岛上会被压扁/拉长；
 * 这里按包围盒取统一的缩放系数，造型不失真。
 */
function fitToCell(group: THREE.Group, w: number, h: number): void {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  const targetW = w * CELL * 0.82;
  const targetD = h * CELL * 0.82;
  const sx = targetW / Math.max(0.001, size.x);
  const sz = targetD / Math.max(0.001, size.z);
  const k = Math.min(sx, sz);
  group.scale.set(k, k, k);
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
  // 季节限定装饰：四种造型，各有鲜明的轮廓
  if (type === 'sakura' || type === 'sunflower' || type === 'scarecrow' || type === 'snowman') {
    const g = new THREE.Group();
    const rng2 = mulberry32(seed);
    if (type === 'sakura') {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.62, 6), mat(def.body));
      trunk.position.y = 0.31;
      trunk.castShadow = true;
      g.add(trunk);
      for (let i = 0; i < 4; i++) {
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2 + rng2() * 0.08, 0), mat(def.roof));
        blob.position.set((rng2() - 0.5) * 0.42, 0.66 + rng2() * 0.22, (rng2() - 0.5) * 0.42);
        blob.castShadow = true;
        g.add(blob);
      }
      // 地上的落花
      for (let i = 0; i < 5; i++) {
        const petal = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), mat(def.accent));
        petal.scale.set(1, 0.35, 1);
        petal.position.set((rng2() - 0.5) * 0.6, 0.03, (rng2() - 0.5) * 0.6);
        g.add(petal);
      }
    } else if (type === 'sunflower') {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.8, 5), mat(def.body));
      stem.position.y = 0.4;
      stem.castShadow = true;
      g.add(stem);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 10), mat(def.roof));
      disc.rotation.x = Math.PI / 2 - 0.25;
      disc.position.set(0, 0.82, 0.02);
      disc.castShadow = true;
      g.add(disc);
      const center = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 8), mat(def.accent));
      center.rotation.x = Math.PI / 2 - 0.25;
      center.position.set(0, 0.83, 0.05);
      g.add(center);
    } else if (type === 'scarecrow') {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), mat(def.roof));
      post.position.y = 0.5;
      post.castShadow = true;
      g.add(post);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.07, 0.07), mat(def.roof));
      bar.position.y = 0.72;
      g.add(bar);
      const body2 = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.5, 6), mat(def.body));
      body2.position.y = 0.56;
      body2.castShadow = true;
      g.add(body2);
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 0), mat(0xe8d5a8));
      head.position.y = 0.95;
      g.add(head);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.16, 6), mat(def.accent));
      hat.position.y = 1.08;
      g.add(hat);
    } else {
      // 雪人：两个雪球 + 胡萝卜鼻 + 帽子
      const bottom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), mat(def.body));
      bottom.position.y = 0.24;
      bottom.castShadow = true;
      g.add(bottom);
      const top = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0), mat(def.body));
      top.position.y = 0.56;
      top.castShadow = true;
      g.add(top);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.18, 5), mat(def.accent));
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, 0.56, 0.16);
      g.add(nose);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 8), mat(def.roof));
      brim.position.y = 0.7;
      g.add(brim);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.16, 8), mat(def.roof));
      crown.position.y = 0.79;
      g.add(crown);
    }
    bakeStatic(g);
    if (fit) fitToCell(g, w, h);
    g.userData.lights = [];
    return { group: g, lights: [] };
  }

  // 纯装饰：直接复用街道道具的造型，缩放交给 fitToCell
  if (type === 'bench' || type === 'lamp' || type === 'planter' || type === 'statue') {
    const g = new THREE.Group();
    const lights: THREE.MeshStandardMaterial[] = [];
    if (type === 'bench') {
      g.add(makeParkBench(seed));
    } else if (type === 'lamp') {
      const lamp = makeLamp();
      g.add(lamp);
      // 路灯玻璃要交给昼夜系统
      lamp.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.name === 'lampGlass' && m.material) {
          lights.push(m.material as THREE.MeshStandardMaterial);
        }
      });
    } else if (type === 'planter') {
      g.add(makePlanter(seed));
    } else {
      // 雕像：石台 + 立柱 + 金色人像，是镇子里的精神地标
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.16, 8), mat(def.roof));
      base.position.y = 0.08;
      base.receiveShadow = true;
      g.add(base);
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.42), mat(def.body));
      plinth.position.y = 0.33;
      plinth.castShadow = true;
      g.add(plinth);
      const body2 = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 7), mat(def.accent));
      body2.position.y = 0.75;
      body2.castShadow = true;
      g.add(body2);
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), mat(def.accent));
      head.position.y = 1.06;
      g.add(head);
      const wingL = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 4), mat(def.body));
      wingL.position.set(-0.16, 0.82, 0);
      wingL.rotation.z = 0.5;
      g.add(wingL);
      const wingR = wingL.clone();
      wingR.position.x = 0.16;
      wingR.rotation.z = -0.5;
      g.add(wingR);
    }
    if (fit) fitToCell(g, w, h);
    g.userData.lights = lights;
    return { group: g, lights };
  }

  // 新增的市政/商业建筑：各有独立的构图，不再复用民宅外形
  if (type === 'post' || type === 'flower' || type === 'garden' || type === 'school' || type === 'hall') {
    const custom = makeTownBuilding(type, seed, level);
    if (fit) fitToCell(custom.group, w, h);
    return custom;
  }

  // 住宅走随机配色；咖啡馆、公园、喷泉各有固定形象，别打乱
  let base: StructureMesh;
  if (type === 'house') base = makeHouse(seed, undefined, level);
  else base = makeHouse(seed, { body: def.body, roof: def.roof, accent: def.accent }, level);

  // 方岛：把模型等比缩放到实际网格占地（w×h 格），避免压到邻格
  if (fit) fitToCell(base.group, w, h);
  // 圆岛没有网格约束：住宅略放大，让“人住的房子”在画面里更有存在感
  else base.group.scale.setScalar(1.14);
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

/**
 * 市政 / 商业建筑。
 * 与民宅的区别：它们要有"招牌式"的轮廓（钟楼、柱廊、拱门），
 * 玩家扫一眼就能认出"这是学校/市政厅"，而不是又一栋房子。
 */
export function makeTownBuilding(
  type: 'post' | 'flower' | 'garden' | 'school' | 'hall',
  seed: number,
  level = 1,
): StructureMesh {
  const def = BUILDINGS[type];
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const lights: THREE.MeshStandardMaterial[] = [];
  const pal = { body: def.body, roof: def.roof, accent: def.accent };

  if (type === 'post') {
    const house = makeHouse(seed, pal, 1);
    g.add(house.group);
    lights.push(...house.lights);
    // 门口邮筒 + 一块木牌
    const box = makeMailbox();
    box.position.set(0.42, 0, 0.52);
    box.rotation.y = -Math.PI / 5;
    g.add(box);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.04), mat(pal.roof));
    sign.position.set(0, 0.62, 0.62);
    g.add(sign);
  } else if (type === 'flower') {
    const house = makeHouse(seed, pal, 1);
    g.add(house.group);
    lights.push(...house.lights);
    // 条纹雨棚 + 门口三桶花
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.03, 0.26),
        mat(i % 2 ? 0xfdf3e3 : pal.roof),
      );
      seg.position.set(-0.26 + i * 0.13, 0.52, 0.62);
      seg.rotation.x = -0.16;
      g.add(seg);
    }
    const bucket = (x: number, color: number) => {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.14, 7), mat(0xb58a63));
      pot.position.set(x, 0.07, 0.72);
      g.add(pot);
      for (let i = 0; i < 3; i++) {
        const bloom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), mat(color));
        bloom.position.set(x + (rng() - 0.5) * 0.08, 0.18 + rng() * 0.04, 0.72 + (rng() - 0.5) * 0.08);
        g.add(bloom);
      }
    };
    bucket(-0.3, pal.accent);
    bucket(0, 0xffd45e);
    bucket(0.3, 0xc48ae0);
  } else if (type === 'garden') {
    // 花园：草坪 + 四角花坛 + 拱门；没有屋顶，靠"绿"和"花"认出来
    const lawn = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.0, 0.1, 12), mat(def.body));
    lawn.position.y = 0.05;
    lawn.receiveShadow = true;
    g.add(lawn);
    // 十字小径
    for (const [w2, d2, x, z] of [[1.5, 0.26, 0, 0], [0.26, 1.5, 0, 0]] as const) {
      const path = new THREE.Mesh(new THREE.BoxGeometry(w2, 0.03, d2), mat(getPalette().path));
      path.position.set(x, 0.105, z);
      path.receiveShadow = true;
      g.add(path);
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bed = makeFlowerBed(seed + i * 17);
      bed.position.set(Math.cos(a) * 0.62, 0.1, Math.sin(a) * 0.62);
      bed.scale.setScalar(0.72);
      g.add(bed);
    }
    // 入口拱门
    for (const x of [-0.34, 0.34]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.62, 6), mat(getPalette().trunk));
      post.position.set(x, 0.31, 0.78);
      post.castShadow = true;
      g.add(post);
    }
    const arch = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.06, 0.06), mat(getPalette().trunk));
    arch.position.set(0, 0.64, 0.78);
    g.add(arch);
    for (let i = 0; i < 5; i++) {
      const bloom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), mat(i % 2 ? pal.accent : 0xffd45e));
      bloom.position.set(-0.3 + i * 0.15, 0.69, 0.78);
      g.add(bloom);
    }
    g.scale.setScalar(1 + (level - 1) * 0.06);
  } else if (type === 'school') {
    const house = makeHouse(seed, pal, 2);
    g.add(house.group);
    lights.push(...house.lights);
    // 钟楼：细高方塔 + 四坡小顶 + 铜钟
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.86, 0.34), mat(pal.body));
    tower.position.set(0.55, 0.43 + 1.6 * 0.0, 0.0);
    tower.position.y = 0.43;
    tower.castShadow = true;
    g.add(tower);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.34, 4), mat(pal.roof));
    cap.position.set(0.55, 1.03, 0);
    cap.rotation.y = Math.PI / 4;
    cap.castShadow = true;
    g.add(cap);
    const bell = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.14, 6), mat(0xd9b45a));
    bell.position.set(0.55, 0.82, 0.19);
    bell.rotation.x = Math.PI;
    g.add(bell);
    // 旗杆
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 1.1, 5), mat(0xf4f4f4));
    pole.position.set(-0.62, 0.55, 0);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.02), mat(pal.accent));
    flag.position.set(-0.49, 1.02, 0);
    g.add(flag);
  } else {
    // 市政厅：台基 + 四柱门廊 + 山花 + 旗
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.16, 1.2), mat(getPalette().rock));
    base.position.y = 0.08;
    base.receiveShadow = true;
    g.add(base);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 1.0), mat(pal.body));
    body.position.y = 0.61;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);
    // 门廊四柱
    for (let i = 0; i < 4; i++) {
      const x = -0.6 + i * 0.4;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.86, 6), mat(0xf7f2e6));
      col.position.set(x, 0.59, 0.56);
      col.castShadow = true;
      g.add(col);
    }
    // 柱廊顶 + 山花
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.4), mat(0xf7f2e6));
    lintel.position.set(0, 1.06, 0.42);
    g.add(lintel);
    const pediment = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.18, 3), mat(pal.roof));
    pediment.rotation.z = Math.PI / 2;
    pediment.rotation.y = Math.PI / 2;
    pediment.position.set(0, 1.2, 0.42);
    pediment.scale.set(1, 1, 0.55);
    g.add(pediment);
    // 屋顶：平顶 + 檐口
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.12, 1.12), mat(pal.roof));
    roof.position.y = 1.12;
    roof.castShadow = true;
    g.add(roof);
    // 旗杆与旗
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.9, 5), mat(0xf4f4f4));
    pole.position.set(0, 1.6, -0.2);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.02), mat(pal.accent));
    flag.position.set(0.16, 1.94, -0.2);
    g.add(flag);
    g.scale.setScalar(1 + (level - 1) * 0.05);
  }

  g.userData.lights = lights;
  return { group: g, lights };
}

/**
 * 屋顶形态库：四坡（hip）/ 双坡（gable）/ 单坡（shed）。
 * 三种剪影差别明显，按 seed 分配后，同一条街的房子不再是复制粘贴。
 */
type RoofKind = 'hip' | 'gable' | 'shed';

function buildRoof(
  kind: RoofKind,
  w: number,
  rh: number,
  d: number,
  roofColor: number,
  bodyColor: number,
): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'shed') {
    const slope = Math.hypot(d, rh);
    const angle = Math.atan2(rh, d);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, slope), mat(roofColor));
    slab.position.set(0, rh / 2, 0);
    slab.rotation.x = angle;
    slab.castShadow = true;
    g.add(slab);
    return g;
  }
  if (kind === 'gable') {
    const halfD = d / 2;
    const slope = Math.hypot(halfD, rh);
    const angle = Math.atan2(rh, halfD);
    for (const dir of [1, -1] as const) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, slope), mat(roofColor));
      slab.position.set(0, rh / 2, (dir * halfD) / 2);
      slab.rotation.x = dir * angle;
      slab.castShadow = true;
      g.add(slab);
    }
    // 两端山墙三角：补上开口，否则侧面能看进屋顶内部
    const shape = new THREE.Shape();
    shape.moveTo(-halfD, 0);
    shape.lineTo(halfD, 0);
    shape.lineTo(0, rh);
    shape.closePath();
    for (const dir of [1, -1] as const) {
      const triGeo = new THREE.ShapeGeometry(shape);
      triGeo.rotateY(Math.PI / 2);
      const tri = new THREE.Mesh(triGeo, mat(bodyColor));
      // 山墙三角与墙体共面会 z-fighting，旋转时表现为屋顶边缘闪烁；外移 12mm
      tri.position.set((dir * (w + 0.024)) / 2, 0, 0);
      g.add(tri);
    }
    return g;
  }
  // roofOf 的 ConeGeometry 以中心为原点：必须上移半高，屋顶底面才落在 topY，
  // 否则整座屋顶会陷进墙里，从俯视角看像一圈白色女儿墙围着一个坑。
  const roof = roofOf(w, rh, d, roofColor);
  roof.position.y = rh / 2;
  g.add(roof);
  return g;
}

