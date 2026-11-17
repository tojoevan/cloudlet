import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat, matOwn } from '../mat';
import { bakeStatic } from '../bake';
import { getPalette } from '../palette';
import { mulberry32 } from '../rng';

/**
 * 中间尺度道具（栅栏 / 路灯 / 花坛 / 邮筒 / 水井 / 木桶 / 路牌）。
 *
 * 为什么单独一个模块：画面从"一个岛"变成"一个镇"，靠的不是大建筑，
 * 而是这些 0.2~0.6 世界单位的小物件——它们提供了尺度参照和生活痕迹。
 * 全部程序化生成，材质走共享缓存，几何体都很轻（每件 ≤ 30 三角面）。
 */

const WOOD = 0xc99a63;
const WOOD_DARK = 0x9c7443;

/** 一段栅栏：2 根立柱 + 2 道横栏，沿 +x 方向长 len */
export function makeFence(len = 1.15): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.BoxGeometry(0.07, 0.30, 0.07);
  for (const x of [-len / 2, len / 2]) {
    const p = new THREE.Mesh(post, mat(WOOD_DARK));
    p.position.set(x, 0.15, 0);
    p.castShadow = true;
    g.add(p);
  }
  const rail = new THREE.BoxGeometry(len, 0.045, 0.035);
  for (const y of [0.11, 0.21]) {
    const r = new THREE.Mesh(rail, mat(WOOD));
    r.position.set(0, y, 0);
    r.castShadow = true;
    g.add(r);
  }
  bakeStatic(g);
  return g;
}

/**
 * 一整段栅栏（合并几何体）。
 * 栅栏是场景里数量最多的道具，逐柱建 mesh 会轻松吃掉一百多个 draw call；
 * 这里把立柱与横栏各自合并成 1 个网格，一段栅栏只要 2 次绘制。
 */
export function makeFenceLine(len: number): THREE.Group {
  const g = new THREE.Group();
  const span = Math.max(2, Math.round(len / 0.95));
  const boxes = (w: number, h: number, d: number, x: number, y: number) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, y, 0);
    return b;
  };
  const posts: THREE.BufferGeometry[] = [];
  for (let i = 0; i <= span; i++) {
    posts.push(boxes(0.075, 0.34, 0.075, -len / 2 + (len / span) * i, 0.17));
  }
  const rails: THREE.BufferGeometry[] = [
    boxes(len, 0.05, 0.04, 0, 0.12),
    boxes(len, 0.05, 0.04, 0, 0.23),
  ];
  const pg = mergeGeometries(posts, false);
  const rg = mergeGeometries(rails, false);
  posts.forEach((b) => b.dispose());
  rails.forEach((b) => b.dispose());
  if (pg) {
    const m = new THREE.Mesh(pg, mat(WOOD_DARK));
    m.castShadow = true;
    g.add(m);
  }
  if (rg) {
    const m = new THREE.Mesh(rg, mat(WOOD));
    m.castShadow = true;
    g.add(m);
  }
  bakeStatic(g);
  return g;
}

/** 路灯：细杆 + 暖色灯球（夜间自发光，符合"入夜亮灯"的整体语言） */
export function makeLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.95, 6), mat(0x6b7d8f));
  pole.position.y = 0.475;
  pole.castShadow = true;
  g.add(pole);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.035, 0.035), mat(0x6b7d8f));
  arm.position.set(0.09, 0.95, 0);
  g.add(arm);
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 8, 6),
    matOwn(0xfff0c0, { emissive: new THREE.Color(0xffd98a), emissiveIntensity: 0 }),
  );
  glass.position.set(0.19, 0.90, 0);
  glass.name = 'lampGlass';
  g.add(glass);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.07, 6), mat(0x5b6b7b));
  cap.position.set(0.19, 0.985, 0);
  g.add(cap);
  bakeStatic(g);
  return g;
}

/** 花坛：矮石框 + 几簇彩色花点，给画面提供暖色点缀 */
export function makeFlowerBed(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.16, 8), mat(getPalette().rock));
  rim.position.y = 0.08;
  rim.castShadow = true;
  rim.receiveShadow = true;
  g.add(rim);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.02, 8), mat(getPalette().tilled));
  soil.position.y = 0.165;
  g.add(soil);
  const colors = [0xf0687a, 0xffd45e, 0xc48ae0, 0xffffff, 0xf79a48];
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * 0.26;
    const bloom = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.045 + rng() * 0.02, 0),
      mat(colors[Math.floor(rng() * colors.length)]),
    );
    bloom.position.set(Math.cos(a) * r, 0.19 + rng() * 0.04, Math.sin(a) * r);
    g.add(bloom);
  }
  bakeStatic(g);
  return g;
}

/** 邮筒：柱 + 圆筒 + 小旗，小镇生活感最强的小物件之一 */
export function makeMailbox(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 5), mat(WOOD_DARK));
  pole.position.y = 0.21;
  g.add(pole);
  const box = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.26, 8), mat(0xe07a5f));
  box.rotation.z = Math.PI / 2;
  box.position.y = 0.50;
  box.castShadow = true;
  g.add(box);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.09, 0.06), mat(0xf5e8b8));
  flag.position.set(0.02, 0.60, 0.09);
  g.add(flag);
  bakeStatic(g);
  return g;
}

/** 水井：石圈 + 双柱 + 小顶，农田边上的经典点缀 */
export function makeWell(): THREE.Group {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.26, 8), mat(getPalette().rock));
  ring.position.y = 0.13;
  ring.castShadow = true;
  ring.receiveShadow = true;
  g.add(ring);
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.02, 8),
    matOwn(getPalette().water, { transparent: true, opacity: 0.9 }),
  );
  water.position.y = 0.255;
  g.add(water);
  for (const x of [-0.24, 0.24]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.5, 0.055), mat(WOOD_DARK));
    post.position.set(x, 0.5, 0);
    post.castShadow = true;
    g.add(post);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.40, 0.22, 4), mat(0xe07a5f));
  roof.position.y = 0.83;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  g.add(roof);
  bakeStatic(g);
  return g;
}

/** 木桶堆：两三个错落摆放，给仓储区一点"东西很多"的暗示 */
export function makeBarrels(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 8), mat(WOOD));
    barrel.position.set((rng() - 0.5) * 0.36, 0.15, (rng() - 0.5) * 0.36);
    barrel.rotation.y = rng() * Math.PI;
    barrel.castShadow = true;
    g.add(barrel);
    const hoop = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.035, 8), mat(WOOD_DARK));
    hoop.position.copy(barrel.position);
    hoop.position.y = 0.22;
    g.add(hoop);
  }
  bakeStatic(g);
  return g;
}

/** 路牌：柱 + 两块指路木牌，朝向由调用方旋转 */
export function makeSignpost(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.85, 5), mat(WOOD_DARK));
  pole.position.y = 0.425;
  pole.castShadow = true;
  g.add(pole);
  const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.10, 0.03), mat(WOOD));
  b1.position.set(0.12, 0.72, 0);
  g.add(b1);
  const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.03), mat(0xd9a86c));
  b2.position.set(-0.09, 0.56, 0.02);
  g.add(b2);
  bakeStatic(g);
  return g;
}

/** 场景里所有灯的玻璃球都挂这个名字，供夜间统一点亮 */
export const LAMP_GLASS = 'lampGlass';

/** 市集摊位：柜台 + 四柱 + 条纹雨棚，小镇商业气息的来源 */
export function makeStall(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const w = 0.86;
  const d = 0.5;
  // 柜台
  const counter = new THREE.Mesh(new THREE.BoxGeometry(w, 0.34, d), mat(WOOD));
  counter.position.y = 0.17;
  counter.castShadow = true;
  counter.receiveShadow = true;
  g.add(counter);
  // 四角立柱
  for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) {
    for (const sz of [-d / 2 + 0.05, d / 2 - 0.05]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.86, 0.045), mat(WOOD_DARK));
      post.position.set(sx, 0.43, sz);
      post.castShadow = true;
      g.add(post);
    }
  }
  // 条纹雨棚：两色交替的窄条
  const stripe = [0xef8b6a, 0xfdf3e3];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(w / n + 0.005, 0.035, d + 0.16),
      mat(stripe[i % 2]),
    );
    seg.position.set(-w / 2 + (w / n) * (i + 0.5), 0.9, 0);
    seg.rotation.x = -0.14;
    seg.castShadow = true;
    g.add(seg);
  }
  // 摊上的货
  for (let i = 0; i < 3; i++) {
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.1, 0.14),
      mat(i === 1 ? 0xffd45e : 0xf0687a),
    );
    crate.position.set(-0.2 + rng() * 0.4, 0.39, (rng() - 0.5) * 0.2);
    g.add(crate);
  }
  bakeStatic(g);
  return g;
}

/** 树篱：一段绿色矮墙，用来分隔街区/围合院落 */
export function makeHedge(len = 2.2): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(len, 0.34, 0.26), mat(getPalette().leafDeep));
  body.position.y = 0.17;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  const top = new THREE.Mesh(new THREE.BoxGeometry(len * 0.96, 0.12, 0.2), mat(getPalette().leafGreen));
  top.position.y = 0.36;
  g.add(top);
  bakeStatic(g);
  return g;
}

/**
 * 沿街花箱：木框 + 泥土 + 一小簇花。
 * 只做 3 个网格（框、土、花团），是"沿街填满"最划算的单元——
 * 梦想城镇那种丰盛感，很大比例来自这种重复出现的小物件。
 */
export function makePlanter(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.26, 0.34), mat(WOOD));
  box.position.y = 0.13;
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);
  const soil = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.04, 0.26), mat(getPalette().tilled));
  soil.position.y = 0.27;
  g.add(soil);
  // 花用 4 朵小花而不是一大坨：小尺寸的花点才像"花箱"，大色块会读成彩色方块
  const colors = [0xf0687a, 0xffd45e, 0xc48ae0, 0xffffff, 0xf79a48];
  for (let i = 0; i < 4; i++) {
    const bloom = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.055 + rng() * 0.02, 0),
      mat(colors[Math.floor(rng() * colors.length)]),
    );
    bloom.position.set(-0.16 + i * 0.1, 0.32 + rng() * 0.04, (rng() - 0.5) * 0.16);
    g.add(bloom);
  }
  // 一点绿叶垫底
  const leaves = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.22), mat(getPalette().leafDeep));
  leaves.position.y = 0.29;
  g.add(leaves);
  bakeStatic(g);
  return g;
}

/** 一组木箱/木桶，堆在路边像刚卸下的货 */
export function makeCrateStack(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const s = 0.18 + rng() * 0.08;
    const crate = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat(rng() > 0.5 ? WOOD : WOOD_DARK));
    crate.position.set((rng() - 0.5) * 0.3, s / 2 + (i === 2 ? 0.04 : 0), (rng() - 0.5) * 0.3);
    crate.rotation.y = rng() * 0.6;
    crate.castShadow = true;
    g.add(crate);
  }
  bakeStatic(g);
  return g;
}

/**
 * 草垛：三只叠在一起，带两道捆绳。
 * 它是农田与牧场之间最有效的“有人在干活”符号，也让大片草地有了暖色块。
 */
export function makeHayBale(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const straw = 0xe3b95c;
  const strawDark = 0xc99a3f;
  for (let i = 0; i < 3; i++) {
    const r = 0.2 + rng() * 0.04;
    const bale = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.42 + rng() * 0.1, 9),
      mat(i === 1 ? strawDark : straw),
    );
    bale.rotation.z = Math.PI / 2;
    bale.rotation.y = rng() * 0.4;
    bale.position.set(0, r + i * 0.4, (rng() - 0.5) * 0.08);
    bale.castShadow = true;
    g.add(bale);
    for (const x of [-0.16, 0.16]) {
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.92, 0.012, 4, 9),
        mat(0x9c7443),
      );
      band.rotation.y = Math.PI / 2;
      band.position.set(x, r + i * 0.4, 0);
      g.add(band);
    }
  }
  bakeStatic(g);
  return g;
}

/** 蜂箱：三层木箱 + 小屋顶 + 出入口，旁边可以配花丛。 */
export function makeBeehive(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const wood = 0xd8b47a;
  const woodDark = 0xb08a58;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.26), mat(woodDark));
  base.position.y = 0.04;
  g.add(base);
  for (let i = 0; i < 3; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.13, 0.24), mat(i % 2 ? woodDark : wood));
    box.position.y = 0.15 + i * 0.15;
    box.castShadow = true;
    g.add(box);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.12, 4), mat(0x8a6a48));
  roof.rotation.y = Math.PI / 4;
  roof.position.y = 0.66;
  g.add(roof);
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.03, 8), mat(0x3b2a1d));
  hole.position.set(0, 0.2, 0.126);
  g.add(hole);
  // 小支架，蜂箱不直接坐在草里
  for (const [x, z] of [[-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1], [0.1, 0.1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.03), mat(woodDark));
    leg.position.set(x, 0.04, z);
    g.add(leg);
  }
  bakeStatic(g);
  void rng;
  return g;
}

/** 一只小鸡：白/黄两色身体、红冠、橙喙。三四只放一起就有农场感。 */
export function makeChicken(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const bodyColor = rng() > 0.45 ? 0xfff8e8 : 0xf3d78f;
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), mat(bodyColor));
  body.scale.set(0.9, 0.85, 1.25);
  body.position.y = 0.13;
  body.castShadow = true;
  g.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 0), mat(bodyColor));
  head.position.set(0, 0.24, 0.1);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 4), mat(0xe8a23c));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.23, 0.18);
  g.add(beak);
  const comb = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 4), mat(0xd4513f));
  comb.position.set(0, 0.31, 0.09);
  g.add(comb);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 4), mat(0xf7efe0));
  tail.rotation.x = -0.9;
  tail.position.set(0, 0.18, -0.13);
  g.add(tail);
  bakeStatic(g);
  g.scale.setScalar(0.85 + rng() * 0.35);
  return g;
}

/** 晾衣绳：两根木桩 + 一道绳 + 三块布，生活气比任何装饰都强。 */
export function makeClothesline(seed: number, len = 1.5): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  for (const x of [-len / 2, len / 2]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), mat(0xb08a58));
    post.position.set(x, 0.375, 0);
    post.castShadow = true;
    g.add(post);
  }
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, len, 4), mat(0xe9dfc8));
  rope.rotation.z = Math.PI / 2;
  rope.position.y = 0.7;
  g.add(rope);
  const cloths = [0xe88b7a, 0x9fc9df, 0xf3d78f];
  for (let i = 0; i < 3; i++) {
    const cloth = new THREE.Mesh(
      new THREE.BoxGeometry(0.22 + rng() * 0.1, 0.26 + rng() * 0.12, 0.012),
      mat(cloths[i]),
    );
    cloth.position.set(-0.38 + i * 0.38, 0.58, 0.01);
    cloth.rotation.z = (rng() - 0.5) * 0.12;
    cloth.castShadow = true;
    g.add(cloth);
  }
  bakeStatic(g);
  return g;
}

/** 小温室：木框 + 半透玻璃 + 一排花，放在农田旁是“精致农业”的视觉注脚。 */
export function makeGreenhouse(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const w = 1.35;
  const d = 0.95;
  const h = 0.62;
  const frame = 0x8d6a45;
  // 石基
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.1, d + 0.12), mat(getPalette().rock));
  base.position.y = 0.05;
  base.receiveShadow = true;
  g.add(base);
  // 玻璃房体
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    matOwn(0xcdeef2, { transparent: true, opacity: 0.32, depthWrite: false, roughness: 0.2 }),
  );
  glass.position.y = 0.1 + h / 2;
  g.add(glass);
  // 木框：四角 + 顶梁
  for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), mat(frame));
    post.position.set(x, 0.1 + h / 2, z);
    post.castShadow = true;
    g.add(post);
  }
  for (const y of [0.1, 0.1 + h * 0.55, 0.1 + h]) {
    for (const [x, z, ww, dd] of [[0, -d / 2, w, 0.045], [0, d / 2, w, 0.045], [-w / 2, 0, 0.045, d], [w / 2, 0, 0.045, d]] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(ww, 0.045, dd), mat(frame));
      bar.position.set(x, y, z);
      g.add(bar);
    }
  }
  // 双坡玻璃屋顶
  for (const sign of [-1, 1]) {
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w * 0.62, 0.03, d + 0.1),
      matOwn(0xd9f2f3, { transparent: true, opacity: 0.38, depthWrite: false }),
    );
    roof.position.set(sign * w * 0.23, 0.1 + h + 0.14, 0);
    roof.rotation.z = sign * 0.42;
    g.add(roof);
  }
  // 花：在屋里与屋外各摆一排
  const colors = [0xf0687a, 0xffd45e, 0xc48ae0, 0xf79a48];
  for (let i = 0; i < 7; i++) {
    const bloom = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.05 + rng() * 0.03, 0),
      mat(colors[i % colors.length]),
    );
    bloom.position.set(-w / 2 + 0.12 + (i / 6) * (w - 0.24), 0.28, (rng() - 0.5) * 0.4);
    g.add(bloom);
  }
  bakeStatic(g);
  return g;
}

/** 热气球：漂在岛上方，是“云上”题材最直给的一张名片。 */
export function makeBalloon(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const colors = [0xe07a5f, 0xf6e7c9, 0x5aa9b8, 0xf3c969];
  const R = 1.45;
  for (let i = 0; i < 8; i++) {
    const phi = (i / 8) * Math.PI * 2;
    const gore = new THREE.Mesh(
      new THREE.SphereGeometry(R, 6, 10, phi, Math.PI / 4),
      mat(colors[i % colors.length]),
    );
    // 把球体下端收窄成热气球的水滴形
    gore.scale.set(1, 1.08, 1);
    gore.position.y = 0.2;
    gore.castShadow = true;
    g.add(gore);
  }
  // 球顶与底口
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.25, 10), mat(0xe07a5f));
  cap.position.y = R + 0.3;
  g.add(cap);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.32, 0.18, 10), mat(0x7c5b3f));
  skirt.position.y = -R * 0.72;
  g.add(skirt);
  // 吊篮与绳索
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.55, 3), mat(0x6f4a2f));
    rope.position.set(Math.cos(a) * 0.34, -R * 0.98, Math.sin(a) * 0.34);
    g.add(rope);
  }
  const basket = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.42), mat(0xa9794f));
  basket.position.y = -R * 1.2;
  basket.castShadow = true;
  g.add(basket);
  const rim = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.05, 0.48), mat(0x8d6a45));
  rim.position.y = -R * 1.05;
  g.add(rim);
  g.userData.phase = rng() * 10;
  return g;
}

/** 绵羊：云朵一样的身体 + 深色脸和腿。放在草坡上，画面的“活物”密度立刻上来。 */
export function makeSheep(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const wool = new THREE.IcosahedronGeometry(0.22, 0);
  for (const [x, y, z, s] of [
    [0, 0.3, 0, 1], [-0.12, 0.32, 0.08, 0.72], [0.13, 0.29, -0.03, 0.68],
    [0.02, 0.4, -0.05, 0.62],
  ] as const) {
    const puff = new THREE.Mesh(wool.clone(), mat(0xf7f2e4));
    puff.position.set(x, y, z);
    puff.scale.setScalar(s);
    puff.castShadow = true;
    g.add(puff);
  }
  const face = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), mat(0x4a4039));
  face.scale.set(0.9, 0.9, 1.2);
  face.position.set(0, 0.34, 0.22);
  g.add(face);
  for (const [x, z] of [[-0.11, 0.12], [0.11, 0.12], [-0.11, -0.12], [0.11, -0.12]] as const) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), mat(0x4a4039));
    leg.position.set(x, 0.11, z);
    g.add(leg);
  }
  const earL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 0.05), mat(0x4a4039));
  earL.position.set(-0.13, 0.38, 0.2);
  earL.rotation.z = 0.4;
  g.add(earL);
  const earR = earL.clone();
  earR.position.x = 0.13;
  earR.rotation.z = -0.4;
  g.add(earR);
  bakeStatic(g);
  g.rotation.y = rng() * Math.PI * 2;
  g.scale.setScalar(0.9 + rng() * 0.25);
  return g;
}
