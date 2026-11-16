import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 远景背板：两三层小浮岛 + 云团。
 *
 * 为什么是浮岛而不是远山：本体就是一座悬空的岛，周围再压一圈山脊会和题材打架，
 * 正交视角下还会读成「淡蓝纸片」。同类作品（Ghibli 式浮岛、A Short Hike、Sky 一类）
 * 用的是「同语言的更小更淡的同类物」——远处还有别的浮岛、底下有云海，
 * 观者会自动把画面读成「世界很大」，而不会觉得是贴图。
 *
 * 大气透视不靠 fog：fog 按距离整体压淡，远景层会被压到与天空同色、丢掉轮廓。
 * 这里改成「顶点色按层深向天空色 lerp」，层次与形状都可控。
 */

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 一座小浮岛：扁圆台 + 下方倒锥 + 几棵小树剪影 */
function makeIsle(rnd: () => number, radius: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const r = radius * (0.8 + rnd() * 0.4);
  const topH = r * 0.28;
  const top = new THREE.CylinderGeometry(r, r * 0.94, topH, 9);
  top.translate(0, -topH / 2, 0);
  const tip = new THREE.ConeGeometry(r * 0.94, r * 0.95, 9);
  tip.rotateX(Math.PI);
  tip.translate(0, -topH - r * 0.475, 0);
  parts.push(top, tip);

  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const h = 0.28 + rnd() * 0.26;
    const cone = new THREE.ConeGeometry(h * 0.55, h, 5);
    const a = rnd() * Math.PI * 2;
    const rr = rnd() * r * 0.55;
    cone.translate(Math.cos(a) * rr, h / 2, Math.sin(a) * rr);
    parts.push(cone);
  }
  return parts;
}

/** 按层深把顶点色向天空色 lerp，模拟大气透视 */
function tintAll(geo: THREE.BufferGeometry, base: THREE.Color, sky: THREE.Color, fade: number): void {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const lift = Math.min(0.12, Math.max(0, pos.getY(i)) * 0.12);
    c.copy(base).lerp(sky, fade).addScalar(lift);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** 云团：几个压扁的球合并，圆润而非棱角 */
function makeCloudCluster(rnd: () => number, spread: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const n = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const s = 0.9 + rnd() * 1.3;
    const g = new THREE.IcosahedronGeometry(s, 1);
    g.scale(1.5, 0.78, 1.2);
    g.translate((rnd() - 0.5) * spread, (rnd() - 0.5) * 0.35, (rnd() - 0.5) * spread * 0.7);
    parts.push(g);
  }
  return parts;
}

/**
 * 星空：用 Points 撒点，而不是画在天穹 shader 上。
 * 为什么：天穹是个大球壳，在正交等距 + 近裁剪的这套设置下实际是看不见的
 * （可见的"天空"其实是场景背景色），画在它上面的星星自然也不可见。
 * Points 直接挂在场景里，位置可靠、只占 1 个 draw call。
 */
function makeStars(count: number, seed: number): THREE.Points {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // 正交相机的视锥只有 ~21 单位高，星空必须放在这个盒子里才看得见，
    // 放在几十上百单位的远处会直接被裁掉（这是它一开始"没有星星"的原因）。
    const a = rnd() * Math.PI * 2;
    const r = 4 + rnd() * 12;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 16 + rnd() * 10;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}

export interface Backdrop {
  group: THREE.Group;
  update(dt: number): void;
  setNight(night: boolean): void;
}

export function createBackdrop(): Backdrop {
  const rnd = makeRng(20261115);
  const group = new THREE.Group();
  group.name = 'backdrop';

  const sky = new THREE.Color(0xbfe4ff);
  const isleMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const cloudMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    fog: false,
  });

  const layers: { obj: THREE.Object3D; spin: number; base: number }[] = [];

  // 两层远景浮岛：远层更淡更小、转得更慢（视差）
  const layout = [
    { count: 6, radius: 26, size: [0.7, 1.3] as [number, number], fade: 0.74, y: -7.0, tint: 0x8fb9c9, spin: 0.0035 },
    { count: 4, radius: 20, size: [0.55, 1.0] as [number, number], fade: 0.62, y: -8.6, tint: 0x7fae9e, spin: 0.006 },
  ];

  for (const L of layout) {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < L.count; i++) {
      const a = (i / L.count) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
      const r = L.radius * (0.85 + rnd() * 0.35);
      const isle = makeIsle(rnd, L.size[0] + rnd() * (L.size[1] - L.size[0]));
      const merged = mergeGeometries(isle, false);
      isle.forEach((g) => g !== merged && g.dispose());
      if (!merged) continue;
      merged.rotateY(rnd() * Math.PI);
      merged.translate(Math.cos(a) * r, L.y + (rnd() - 0.5) * 1.2, Math.sin(a) * r);
      parts.push(merged);
    }
    const all = mergeGeometries(parts, false) ?? parts[0];
    parts.forEach((p) => p !== all && p.dispose());
    if (!all) continue;
    tintAll(all, new THREE.Color(L.tint), sky, L.fade);
    const mesh = new THREE.Mesh(all, isleMat);
    group.add(mesh);
    layers.push({ obj: mesh, spin: L.spin, base: L.y });
  }

  // 云团：贴着岛底一圈，压得很低，只露出轮廓
  const cloudParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rnd() * 0.4;
    const r = 24 + rnd() * 7;
    const cluster = makeCloudCluster(rnd, 2.0);
    const merged = mergeGeometries(cluster, false);
    cluster.forEach((g) => g !== merged && g.dispose());
    if (!merged) continue;
    merged.translate(Math.cos(a) * r, -11.5 + (rnd() - 0.5) * 1.2, Math.sin(a) * r);
    cloudParts.push(merged);
  }
  const clouds = mergeGeometries(cloudParts, false) ?? cloudParts[0];
  cloudParts.forEach((p) => p !== clouds && p.dispose());
  let cloudMesh: THREE.Mesh | null = null;
  if (clouds) {
    cloudMesh = new THREE.Mesh(clouds, cloudMat);
    group.add(cloudMesh);
  }

  const stars = makeStars(260, 20261117);
  group.add(stars);

  let t = 0;
  return {
    group,
    update(dt: number) {
      t += dt;
      for (const L of layers) {
        L.obj.rotation.y = t * L.spin;
        L.obj.position.y = Math.sin(t * 0.22 + L.base) * 0.35;
      }
      if (cloudMesh) {
        cloudMesh.rotation.y = t * 0.008;
        cloudMesh.position.y = Math.sin(t * 0.3) * 0.28;
      }
    },
    setNight(night: boolean) {
      isleMat.color.setScalar(night ? 0.72 : 1);
      cloudMat.color.setScalar(night ? 0.78 : 1);
      (stars.material as THREE.PointsMaterial).opacity = night ? 0.95 : 0;
    },
  };
}
