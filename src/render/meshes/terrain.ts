import * as THREE from 'three';
import { mat, matOwn, matVC, tintGradient } from '../mat';
import { bakeStatic } from '../bake';
import { ISLAND_RADIUS, getPalette } from '../palette';
import { CELL, SQUARE_N } from '../../core/island';
import type { IslandShape } from '../../core/types';
import { mulberry32, pick, range } from '../rng';


/**
 * 按顶点位置哈希给几何体刷一层极轻微的明暗差（±amount），做「草坪有肌理」的观感。
 *
 * 为什么不用贴图：圆岛草皮是 CylinderGeometry 顶盖，UV 是极坐标式的，
 * 贴图上去会出现放射状错乱；而顶点色与 UV 无关，且重复顶点用同一哈希着色，
 * 接缝处颜色天然连续。
 */
function tintByPosition(geo: THREE.BufferGeometry, amount = 0.055, seed = 0x9e3779b9): void {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = Math.round(pos.getX(i) * 97);
    const y = Math.round(pos.getY(i) * 97);
    const z = Math.round(pos.getZ(i) * 97);
    let h = seed ^ (x * 374761393) ^ (y * 668265263) ^ (z * 2147483647);
    h = (h ^ (h >>> 13)) * 1274126177;
    h = (h ^ (h >>> 16)) >>> 0;
    const v = 1 + ((h % 1000) / 1000 - 0.5) * amount * 2;
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** 全部扰动共用一个种子：层与层的交界环才能算出相同偏移 */
const JITTER_SEED = 0x51ed270b;

/**
 * 对几何体顶点做随机扰动，做出手凿岩石的手感。
 * 偏移由「量化后的顶点坐标」哈希决定，而不是按调用顺序抽随机数——
 * 分属不同几何体、但坐标完全相同的顶点（各层交界环、非索引几何体里
 * 共点的面片角）会得到相同偏移：接缝严丝合缝，面片不会撕开。
 * 岛屿各层因此先把几何体平移到世界坐标再扰动（见 makeIsland）。
 */
export function jitter(
  geo: THREE.BufferGeometry,
  amount: number,
  flatTopY?: number,
): THREE.BufferGeometry {
  if (amount <= 0) return geo;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // 顶面保持水平，建筑与作物才不会歪
    if (flatTopY !== undefined && Math.abs(y - flatTopY) < 1e-4) continue;
    let h = (Math.imul(Math.round(x * 512), 0x85ebca6b) ^
      Math.imul(Math.round(y * 512), 0xc2b2ae35) ^
      Math.imul(Math.round(z * 512), 0x27d4eb2f) ^ JITTER_SEED) >>> 0;
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ (h >>> 12)) >>> 0;
    const r1 = h / 0x100000000;
    h = (Math.imul(h ^ (h >>> 15), 0x297a2d39) ^ (h >>> 12)) >>> 0;
    const r2 = h / 0x100000000;
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ (h >>> 12)) >>> 0;
    const r3 = h / 0x100000000;
    pos.setXYZ(
      i,
      x + (r1 - 0.5) * amount,
      y + (r2 - 0.5) * amount * 0.35,
      z + (r3 - 0.5) * amount,
    );
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** 浮空岛：草皮 + 土层 + 扰动过的岩锥，底部收成尖。
 *  radius 可调：建筑越往外排，岛屿就整圈跟着长大，避免房子悬空或踩在小块地基上。 */
export function makeIsland(seed = 20260829, radius = ISLAND_RADIUS): THREE.Group {
  const rng = mulberry32(seed);
  const R = radius;
  const g = new THREE.Group();

  const topH = 0.7;
  const soilH = 1.3;
  const rockH = 2.2;
  const tipH = 3.6;
  // 各层交界高度（世界坐标）。交界环两侧顶点必须完全重合，
  // 段数统一 16 + 等量扰动 + 坐标哈希，三层之间才能严丝合缝。
  const ySoil = -topH; // 草皮/土层
  const yRock = -topH - soilH; // 土层/岩层
  const yTip = yRock - rockH; // 岩层/底尖

  // 几何体一律先平移到世界坐标再扰动：哈希按「同一个点」匹配偏移
  const top = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R, R * 0.97, topH, 16).translate(0, -topH / 2, 0), 0),
    // 顶面用独立材质挂程序化肌理：不能直接用共享的 mat(grass)，
    // 否则所有同色物件（树冠等）都会被贴上草皮噪点。
    mat(getPalette().grass),
  );
  top.receiveShadow = true;
  g.add(top);

  // 顶环不扰动：草皮底环没扰动，土层顶环保持原位才能对齐（顶面藏在草皮下）
  const soil = new THREE.Mesh(
    jitter(
      new THREE.CylinderGeometry(R * 0.97, R * 0.82, soilH, 16).translate(0, ySoil - soilH / 2, 0),
      0.5,
      ySoil,
    ),
    mat(getPalette().soilDark),
  );
  g.add(soil);

  const rock = new THREE.Mesh(
    jitter(
      new THREE.CylinderGeometry(R * 0.82, R * 0.5, rockH, 16).translate(0, yRock - rockH / 2, 0),
      0.5,
    ),
    mat(getPalette().rock),
  );
  g.add(rock);

  // 底尖：顶环 R*0.5 与岩层底环重合、向下收成一点。
  // 用 (R*0.5→0) 的圆柱而不是翻转的 Cone——rotateX(π) 会把交界环
  // 在 z 向镜像（z→-z），段数对齐也对不上，缝就是这么来的。
  const tip = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(R * 0.5, 0, tipH, 16).translate(0, yTip - tipH / 2, 0), 0.5),
    mat(getPalette().rockDark),
  );
  g.add(tip);

  // 岛缘一圈小岩块，打破完美圆形的呆板
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng() * 0.5;
    const r = R * range(rng, 0.86, 0.94);
    const s = range(rng, 0.18, 0.34);
    const chunk = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.4), mat(getPalette().rock));
    chunk.position.set(Math.cos(a) * r, -range(rng, 0.1, 0.45), Math.sin(a) * r);
    chunk.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(chunk);
  }

  return g;
}

/**
 * 圆角正方形浮空岛：草皮顶面是带圆角的方框（ExtrudeGeometry），其下土层/岩层/底尖
 * 逐级收窄，沿用圆岛的层叠语言。顶面还铺了一层淡淡的网格线，呼应「以农田为 1 格」的
 * 规划感。half 取 SQUARE_N/2*CELL + 余量，让 13×13 的规划网格稳稳落在岛内。
 */
export function makeSquareIsland(seed = 20260829, half = 8.27, corner = 2.6): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const topH = 0.7;
  const soilH = 1.3;
  const rockH = 2.2;
  const tipH = 3.4;
  const ySoil = -topH;
  const yRock = ySoil - soilH;
  const yTip = yRock - rockH;

  const topShape = new THREE.Shape();
  roundedRectPath(topShape, -half, -half, half * 2, half * 2, corner);
  const squareTopGeo = makeExtrudedRounded(topShape, topH, 0);
  tintByPosition(squareTopGeo);
  const top = new THREE.Mesh(
    squareTopGeo,
    matOwn(getPalette().grass, { vertexColors: true }),
  );
  top.receiveShadow = true;
  g.add(top);

  // 土层：略小一圈的圆角方框
  const soilShape = new THREE.Shape();
  const sh = half * 0.9;
  roundedRectPath(soilShape, -sh, -sh, sh * 2, sh * 2, corner * 0.85);
  const soil = new THREE.Mesh(
    makeExtrudedRounded(soilShape, soilH, ySoil - soilH / 2),
    mat(getPalette().soilDark),
  );
  g.add(soil);

  // 岩层
  const rockShape = new THREE.Shape();
  const rh = half * 0.72;
  roundedRectPath(rockShape, -rh, -rh, rh * 2, rh * 2, corner * 0.7);
  const rock = new THREE.Mesh(
    makeExtrudedRounded(rockShape, rockH, yRock - rockH / 2),
    mat(getPalette().rock),
  );
  g.add(rock);

  // 底尖：四面棱锥（4 段圆柱），顶半径对齐岩层底、向下收成一点——
  // 与圆岛 CylinderGeometry(R*0.5,0,…) 同一套「上宽下收」语言，避免底裙外扩
  // 在俯视角下被误读成「近小远大」。
  const tip = new THREE.Mesh(
    jitter(new THREE.CylinderGeometry(rh, 0, tipH, 4).rotateY(Math.PI / 4), 0.5),
    mat(getPalette().rockDark),
  );
  tip.position.y = yTip - tipH / 2;
  g.add(tip);

  // 岛缘散布小岩块，呼应圆岛的碎岩感
  for (let i = 0; i < 9; i++) {
    const edge = half * range(rng, 0.82, 0.95);
    const a = rng() * Math.PI * 2;
    const s = range(rng, 0.16, 0.3);
    const chunk = new THREE.Mesh(jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.4), mat(getPalette().rock));
    chunk.position.set(Math.cos(a) * edge, -range(rng, 0.1, 0.4), Math.sin(a) * edge);
    chunk.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(chunk);
  }

  // 顶面淡网格线：呼应规划感。线落在每格边界，颜色比草皮略深。
  const grid = makeGridLines(half, corner);
  g.add(grid);

  return g;
}

/** 把圆角方框挤出成厚度 d 的实体，顶面落在 centerY（向下延伸 d）。
 * 与圆岛 CylinderGeometry(...).translate(0, y/2, 0) 同一套「顶面贴层交界」语义，
 * 草皮顶面落在 y=0，与圆岛一致——否则整座方岛会悬浮 1.05 个单位，
 * 建筑陷进草皮、网格线与草皮边错位，等距俯视下看着像「远边长」。 */
function makeExtrudedRounded(shape: THREE.Shape, d: number, centerY: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, steps: 1 });
  geo.rotateX(-Math.PI / 2); // 挤出的厚度从 +Z 转到 +Y，方框平铺到 xz 平面
  geo.translate(0, centerY - d, 0); // 顶面落在 centerY，向下延伸 d
  return geo;
}

/** 顶面网格线：沿 x、z 各画 N+1 条，颜色取草皮的暗色，透明度压低，只在方岛出现 */
function makeGridLines(_half: number, _corner: number): THREE.LineSegments {
  const C = CELL; // 来自 core/island
  const N = SQUARE_N;
  const outer = (N / 2) * C; // 网格最外边界
  const pts: number[] = [];
  for (let i = 0; i <= N; i++) {
    const p = -outer + i * C;
    pts.push(-outer, 0.02, p, outer, 0.02, p); // 沿 z 的线
    pts.push(p, 0.02, -outer, p, 0.02, outer); // 沿 x 的线
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const matLines = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.06 });
  return new THREE.LineSegments(geo, matLines);
}

export type TreeKind = 'pine' | 'broadleaf' | 'umbrella';

export function makeTree(seed: number, kind?: TreeKind): THREE.Group {
  const rng = mulberry32(seed);
  const k = kind ?? pick(rng, ['pine', 'broadleaf', 'broadleaf', 'umbrella'] as const);
  const g = new THREE.Group();
  const scale = range(rng, 0.85, 1.25);

  const trunkH = range(rng, 0.45, 0.7);
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(range(rng, 0.06, 0.09), range(rng, 0.1, 0.14), trunkH, 6),
    mat(getPalette().trunk),
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  g.add(trunk);

  // 树冠单独拎进一个 subgroup，方便整体随风轻摆（树干不动）
  const foliage = new THREE.Group();
  g.add(foliage);
  g.userData.foliage = foliage;

  if (k === 'pine') {
    let y = trunkH * 0.75;
    let r = range(rng, 0.42, 0.55);
    for (let i = 0; i < 3; i++) {
      const h = range(rng, 0.45, 0.6);
      const coneGeo = new THREE.ConeGeometry(r, h, 7);
      const coneColor = i % 2 ? getPalette().leafDeep : getPalette().leafGreen;
      tintGradient(coneGeo, coneColor, 0.86, 1.12);
      const cone = new THREE.Mesh(coneGeo, matVC());
      cone.position.y = y + h / 2;
      cone.castShadow = true;
      foliage.add(cone);
      y += h * 0.55;
      r *= 0.72;
    }
  } else if (k === 'umbrella') {
    // 伞形：细高的干 + 两层压得很扁的宽冠，远看轮廓和另两种完全不同
    const trunkTall = trunkH * 1.35;
    trunk.scale.y = 1.35;
    const layer = (r: number, y: number, color: number) => {
      const capGeo = jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.12);
      tintGradient(capGeo, color, 0.84, 1.14);
      const cap = new THREE.Mesh(capGeo, matVC());
      cap.scale.set(1, 0.42, 1);
      cap.position.y = y;
      cap.castShadow = true;
      foliage.add(cap);
    };
    layer(range(rng, 0.62, 0.78), trunkTall + 0.16, getPalette().leafDeep);
    layer(range(rng, 0.46, 0.58), trunkTall + 0.42, getPalette().leafGreen);
  } else if (k === 'broadleaf') {
    const blobs = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < blobs; i++) {
      const r = range(rng, 0.3, 0.46);
      const blobGeo = jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.18);
      tintGradient(blobGeo, i % 2 ? getPalette().leafGreen : getPalette().leafLight, 0.82, 1.16);
      const blob = new THREE.Mesh(blobGeo, matVC());
      blob.position.set(range(rng, -0.25, 0.25), trunkH + range(rng, 0.05, 0.4), range(rng, -0.25, 0.25));
      blob.castShadow = true;
      foliage.add(blob);
    }
  }

  // 树干 + 树冠合并成 1 个网格（顶点色保留深浅），单棵树从 5~8 次绘制降到 1 次
  bakeStatic(g);
  g.scale.setScalar(scale);
  return g;
}

export function makeRock(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const s = range(rng, 0.16, 0.38);
  const rock = new THREE.Mesh(
    jitter(new THREE.IcosahedronGeometry(s, 0), s * 0.5),
    mat(rng() > 0.5 ? getPalette().rock : getPalette().rockDark),
  );
  rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
  rock.position.y = s * 0.55;
  rock.castShadow = true;
  g.add(rock);
  bakeStatic(g);
  return g;
}

export function makeGrassTuft(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const h = range(rng, 0.14, 0.28);
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.05, h, 4), mat(rng() > 0.5 ? getPalette().grassDark : getPalette().leafLight));
    blade.position.set(range(rng, -0.1, 0.1), h / 2, range(rng, -0.1, 0.1));
    blade.rotation.z = range(rng, -0.25, 0.25);
    g.add(blade);
  }
  bakeStatic(g);
  return g;
}

/** 池塘：嵌在草地里的静态水景。土色浅盆承着半透明水面，再点缀几片睡莲。
 * 水面 mesh 存在 userData.water，基准 y 在 userData.waterBaseY，方便每帧轻轻起伏。 */
export function makePond(seed = 13579): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const R = 1.4;

  // 土岸：环形（外圈 R+0.3，内圈 R），围出中间的水面。
  // 必须用空心环，否则实心土盘会把水完全包住，只看到棕色。
  const bankShape = new THREE.Shape();
  bankShape.absarc(0, 0, R + 0.3, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, R, 0, Math.PI * 2, true);
  bankShape.holes.push(hole);

  const bed = new THREE.Mesh(
    new THREE.ExtrudeGeometry(bankShape, { depth: 0.12, bevelEnabled: false, steps: 1 }),
    mat(getPalette().soilDark),
  );
  // ExtrudeGeometry 沿 z 轴挤出，旋转后平铺在 xz 平面
  bed.rotation.x = -Math.PI / 2;
  bed.position.y = 0.02; // 岸底略高于草地，避免 z-fighting
  bed.receiveShadow = true;
  g.add(bed);

  // 水：填在环心，半透明蓝，略高于草地
  const water = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, 0.16, 28),
    matOwn(getPalette().water, { transparent: true, opacity: 0.92 }),
  );
  const waterBaseY = 0.06; // 顶面 ≈ +0.14，与土岸顶齐平
  water.position.y = waterBaseY;
  water.receiveShadow = true;
  g.add(water);
  g.userData.water = water;
  g.userData.waterBaseY = waterBaseY;

  // 浅色岸线：土岸顶面压一圈亮沙色细环。
  // 借鉴 2D 等距插画的"描边"思路——低多边形靠一条亮边就能和草地分开，画面更干净。
  const rim = new THREE.Mesh(
    new THREE.RingGeometry(R - 0.03, R + 0.3, 32),
    matOwn(0xf5ead0, { side: THREE.DoubleSide }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.145;
  rim.receiveShadow = true;
  g.add(rim);

  // 水面高光：左侧一小片椭圆亮斑，模拟天光反射；没有它水面像一块蓝色塑料
  const gloss = new THREE.Mesh(
    new THREE.CircleGeometry(0.46, 18).rotateX(-Math.PI / 2),
    matOwn(0xffffff, { transparent: true, opacity: 0.26, depthWrite: false }),
  );
  gloss.scale.set(1, 1, 0.5);
  gloss.position.set(-0.22, waterBaseY + 0.09, -0.2);
  g.add(gloss);

  // 几片睡莲点缀，水不至于太死板
  const pads = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < pads; i++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * (R - 0.4);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 0.04, 8),
      mat(getPalette().leafLight),
    );
    pad.position.set(Math.cos(a) * r, waterBaseY + 0.08, Math.sin(a) * r);
    g.add(pad);
  }

  // —— 活水感：扩散水波 + 中心喷泉粒子 ——
  // 三层错位的圆环，周期性放大并淡出，像水面被风或鱼轻轻搅动
  const ripples: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.24, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = waterBaseY + 0.11;
    g.add(ring);
    ripples.push(ring);
  }

  // 中心小喷泉：一束向上的水珠粒子，受重力回落、循环复用
  const FN = 46;
  const fpos = new Float32Array(FN * 3);
  const fvel = new Float32Array(FN * 3);
  const frng = mulberry32(seed ^ 0x9e3779b9);
  const fountainBaseY = waterBaseY + 0.12;
  const spawn = (i: number) => {
    const a = frng() * Math.PI * 2;
    const spread = 0.18 + frng() * 0.18;
    fpos[i * 3] = Math.cos(a) * 0.06;
    fpos[i * 3 + 1] = fountainBaseY;
    fpos[i * 3 + 2] = Math.sin(a) * 0.06;
    fvel[i * 3] = Math.cos(a) * spread * frng();
    fvel[i * 3 + 1] = 1.1 + frng() * 0.9;
    fvel[i * 3 + 2] = Math.sin(a) * spread * frng();
  };
  for (let i = 0; i < FN; i++) {
    spawn(i);
    // 错开初始高度，避免所有粒子同时起落
    fpos[i * 3 + 1] = fountainBaseY + frng() * 0.5;
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  const fountain = new THREE.Points(
    fgeo,
    new THREE.PointsMaterial({
      color: 0xbfefff,
      size: 0.07,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    }),
  );
  g.add(fountain);

  g.userData.water = water;
  g.userData.waterBaseY = waterBaseY;
  g.userData.ripples = ripples;
  g.userData.fountain = { points: fountain, pos: fpos, vel: fvel, n: FN, baseY: fountainBaseY, spawn };

  return g;
}

export function makeCloud(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const r = range(rng, 0.5, 1.1);
    const puff = new THREE.Mesh(
      jitter(new THREE.IcosahedronGeometry(r, 0), r * 0.2),
      new THREE.MeshStandardMaterial({
        color: getPalette().cloud,
        flatShading: true,
        roughness: 0.92,
        metalness: 0,
        transparent: true,
        opacity: 0.96,
        // 白色自发光提亮背光面：Lambert 下球体侧面只吃到半天空光，
        // 会读成灰蓝；加自发光后整朵云才「白」得起来（顶面本就过曝纯白）
        emissive: 0xffffff,
        emissiveIntensity: 0.35,
      }),
    );
    puff.position.set(range(rng, -1.4, 1.4), range(rng, -0.2, 0.3), range(rng, -0.5, 0.5));
    g.add(puff);
  }
  g.scale.setScalar(range(rng, 0.8, 1.4));
  bakeStatic(g);
  return g;
}

/** 农田地块。带 userData.plotId，射线检测后据此定位逻辑对象。 */
/** 在 Shape/Path 上画一个圆角矩形路径（俯视 XY 平面） */
function roundedRectPath(s: THREE.Path, x: number, y: number, w: number, h: number, r: number): void {
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
}

export function makePlot(plotId: number, size = 0.92): THREE.Mesh {
  const half = size / 2;
  const radius = size * 0.3; // 圆角，柔和不生硬
  const shape = new THREE.Shape();
  roundedRectPath(shape, -half, -half, size, size, radius);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); // 厚度从 +Z 转到 +Y，地块平铺在草地上
  geo.translate(0, -0.07, 0); // 让地块一半埋进草面，与原方块一致
  const tile = new THREE.Mesh(geo, mat(getPalette().tilled));
  tile.userData.plotId = plotId;
  tile.receiveShadow = true;
  return tile;
}

/**
 * 地块高亮圈：选中与可收获时给反馈。
 * 改成与地块同款的「圆角矩形描边」——外圈圆角矩形掏一个内圈圆角矩形，
 * 形成一圈等宽描边，套在地块外围，比原来的圆环更贴合方块田地、更精致。
 */
export function makePlotRing(size = 1.0, color = 0xffffff): THREE.Mesh {
  const outer = size;
  const thickness = 0.09;
  const inner = outer - thickness * 2;
  const rOuter = outer * 0.3; // 与地块（圆角 0.3）同曲率
  const rInner = Math.max(0.02, rOuter - thickness); // 等距内缩，避免转角夹死
  const shape = new THREE.Shape();
  roundedRectPath(shape, -outer / 2, -outer / 2, outer, outer, rOuter);
  const hole = new THREE.Path();
  roundedRectPath(hole, -inner / 2, -inner / 2, inner, inner, rInner);
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2); // 平铺到地面
  const ring = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  return ring;
}

/**
 * 地面色块：一块略深/略浅的不规则草皮，压在岛面上破掉"单一绿色大平面"。
 * 用极低的 y 偏移 + polygonOffset 避免与岛面 z-fighting。
 */
export function makeGrassPatch(seed: number, radius: number, darker: boolean): THREE.Mesh {
  const rng = mulberry32(seed);
  const segs = 9;
  const shape = new THREE.Shape();
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const r = radius * (0.7 + rng() * 0.5);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const p = getPalette();
  // 直接从主草色派生出更深/更浅的一档，不新增 palette 字段（换配色方案时自动跟随）
  const base = new THREE.Color(p.grass).offsetHSL(0, 0, darker ? -0.045 : 0.05).getHex();
  const mat = matOwn(base, {
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** 花丛：几朵小花 + 细茎，给大片草地点几处暖色，成本极低 */
export function makeFlowerCluster(seed: number): THREE.Group {
  const rng = mulberry32(seed);
  const g = new THREE.Group();
  const colors = [0xf0687a, 0xffd45e, 0xc48ae0, 0xfdf6e3, 0xf79a48];
  const n = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const h = 0.10 + rng() * 0.12;
    const x = (rng() - 0.5) * 0.5;
    const z = (rng() - 0.5) * 0.5;
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.01, h, 3),
      mat(getPalette().leafDeep),
    );
    stem.position.set(x, h / 2, z);
    g.add(stem);
    const bloom = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.035 + rng() * 0.02, 0),
      mat(colors[Math.floor(rng() * colors.length)]),
    );
    bloom.position.set(x, h, z);
    g.add(bloom);
  }
  bakeStatic(g);
  return g;
}

/**
 * 可烘焙 AO 的地面覆盖层。
 *
 * 为什么是"覆盖层 + 顶点色"而不是贴花：贴花与岛面几乎共面，深度精度会让它大面积丢片
 * （实测只有抬到 0.25 才可见）。改成不透明的细分网格、把遮蔽直接乘进顶点色，
 * 既不透明也不共面竞争，且只有 1 个 draw call。
 *
 * @param shape round=极坐标圆盘；square=投影到圆角矩形的网格
 * @param size  半径（round）或半边长（square）
 * @param corner 圆角半径（仅 square）
 */
export function makeGroundOverlay(
  shape: IslandShape,
  size: number,
  corner: number,
  segs = 44,
  baseColor?: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const base = new THREE.Color(baseColor ?? getPalette().grass);

  const push = (x: number, z: number, mottle: number) => {
    positions.push(x, 0, z);
    // 极轻微的明暗差，避免整块死平
    const k = 1 + (mottle - 0.5) * 0.09;
    colors.push(base.r * k, base.g * k, base.b * k);
  };

  if (shape === 'round') {
    // 极坐标网格：环数 × 段数，中心一个点
    const rings = Math.max(8, Math.round(segs * 0.5));
    const segsN = segs;
    push(0, 0, 0.5);
    let h = 0x51ed270b;
    const rnd = () => {
      h = (h * 1664525 + 1013904223) >>> 0;
      return h / 4294967296;
    };
    for (let r = 1; r <= rings; r++) {
      const rr = (size * r) / rings;
      for (let s = 0; s < segsN; s++) {
        const a = (s / segsN) * Math.PI * 2;
        push(Math.cos(a) * rr, Math.sin(a) * rr, rnd());
      }
    }
    // 中心扇形
    for (let s = 0; s < segsN; s++) {
      const i0 = 0;
      const i1 = 1 + s;
      const i2 = 1 + ((s + 1) % segsN);
      indices.push(i0, i2, i1);
    }
    // 环带
    for (let r = 1; r < rings; r++) {
      const startA = 1 + (r - 1) * segsN;
      const startB = 1 + r * segsN;
      for (let s = 0; s < segsN; s++) {
        const s2 = (s + 1) % segsN;
        const a0 = startA + s;
        const a1 = startA + s2;
        const b0 = startB + s;
        const b1 = startB + s2;
        indices.push(a0, b1, a1, a0, b0, b1);
      }
    }
  } else {
    // 网格 → 投影到圆角矩形边界内
    const n = segs;
    const half = size;
    const inner = half - corner;
    const clampToRound = (x: number, z: number): [number, number] => {
      const ax = Math.abs(x);
      const az = Math.abs(z);
      if (ax <= inner || az <= inner) {
        return [Math.max(-half, Math.min(half, x)), Math.max(-half, Math.min(half, z))];
      }
      const cx = Math.sign(x) * inner;
      const cz = Math.sign(z) * inner;
      const dx = x - cx;
      const dz = z - cz;
      const d = Math.hypot(dx, dz);
      if (d <= corner) return [x, z];
      const k = corner / d;
      return [cx + dx * k, cz + dz * k];
    };
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -half + (2 * half * i) / n;
        const z = -half + (2 * half * j) / n;
        const [px, pz] = clampToRound(x, z);
        push(px, pz, ((i * 7919 + j * 104729) % 1000) / 1000);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 小型广场：石铺圆盘 + 一圈圈铺装带。
 * 梦想城镇式的"镇中心"就是靠这种硬质铺装 + 长椅/路灯/花坛围合出来的场域感，
 * 比在草地上撒道具更能立刻读出"这里是个广场"。
 */
export function makePlaza(radius: number, segs = 40): THREE.Mesh {
  const geo = makeGroundOverlay('round', radius, 0, segs, 0xf3ebd8);
  // 环状铺装带：按半径分圈，隔圈略压暗，远看就是石砖的同心纹路
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i)) / radius;
    const band = Math.floor(r * 4.5);
    const k = band % 2 === 0 ? 1 : 0.975;
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
  const mesh = new THREE.Mesh(
    geo,
    matOwn(0xffffff, {
      vertexColors: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

export interface AoCaster {
  x: number;
  z: number;
  /** 投影半径 */
  r: number;
  /** 遮蔽强度 0~1 */
  k: number;
}

/**
 * 把遮蔽烘进顶点色：每个顶点找最近的若干投影，按距离衰减压暗。
 * 依赖几何体已被 makeGroundOverlay 铺过颜色，函数内先备份基色再反复重算，
 * 所以可以随建筑增删多次调用。
 */
export function bakeGroundAO(geo: THREE.BufferGeometry, casters: AoCaster[]): void {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  if (!col) return;
  if (!geo.userData.aoBase) {
    geo.userData.aoBase = Float32Array.from(col.array as Float32Array);
  }
  const baseArr = geo.userData.aoBase as Float32Array;
  const n = pos.count;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let occ = 0;
    for (let c = 0; c < casters.length; c++) {
      const o = casters[c];
      const dx = x - o.x;
      const dz = z - o.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const reach = o.r * 2.1;
      if (d >= reach) continue;
      const t = 1 - d / reach;
      const v = t * t * o.k;
      if (v > occ) occ = v;
    }
    const f = 1 - Math.min(0.55, occ * 0.75);
    col.setXYZ(i, baseArr[i * 3] * f, baseArr[i * 3 + 1] * f, baseArr[i * 3 + 2] * f);
  }
  col.needsUpdate = true;
}
