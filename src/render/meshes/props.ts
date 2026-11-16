import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mat, matOwn } from '../mat';
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
  return g;
}

/** 场景里所有灯的玻璃球都挂这个名字，供夜间统一点亮 */
export const LAMP_GLASS = 'lampGlass';
