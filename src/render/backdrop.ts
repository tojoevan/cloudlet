import * as THREE from 'three';

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

/** 一张柔边云贴图：用多个径向渐变叠出蓬松轮廓，避免再出现“白色多边形石头”。 */
function makeCloudTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    let s = 7331;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const lobe = (cx: number, cy: number, r: number) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,253,246,0.98)');
      g.addColorStop(0.55, 'rgba(255,252,242,0.72)');
      g.addColorStop(1, 'rgba(255,250,240,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    for (let i = 0; i < 9; i++) {
      lobe(44 + rnd() * 168, 118 + rnd() * 44, 34 + rnd() * 38);
    }
    for (let i = 0; i < 5; i++) {
      lobe(60 + rnd() * 136, 94 + rnd() * 36, 26 + rnd() * 28);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

export interface Backdrop {
  group: THREE.Group;
  update(dt: number): void;
  setNight(night: boolean): void;
}

/** 星空：Points 撒点，夜里才显形。 */
function makeStars(count: number, seed: number): THREE.Points {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 6 + rnd() * 14;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = 14 + rnd() * 12;
    pos[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.3,
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

export function createBackdrop(): Backdrop {
  const rnd = makeRng(20261115);
  const group = new THREE.Group();
  group.name = 'backdrop';

  // 远景不放大块浮岛：避免低模剪影在天空里读成“纸片”。
  // ---- 云：柔边 Sprite，不再用低模球 ----
  const cloudTex = makeCloudTexture();
  const cloudMat = new THREE.SpriteMaterial({
    map: cloudTex,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    depthTest: true,
    fog: false,
    color: 0xfffaf0,
  });
  const clouds: { sprite: THREE.Sprite; baseY: number; drift: number; phase: number }[] = [];
  const addCloud = (x: number, y: number, z: number, w: number, h: number, opacity: number) => {
    const m = cloudMat.clone();
    m.opacity = opacity;
    const sp = new THREE.Sprite(m);
    sp.position.set(x, y, z);
    sp.scale.set(w, h, 1);
    group.add(sp);
    clouds.push({ sprite: sp, baseY: y, drift: 0.2 + rnd() * 0.25, phase: rnd() * Math.PI * 2 });
  };
  // 地平线云带：放在岛后，给岛一个“浮在云海上”的底座
  for (let i = 0; i < 6; i++) {
    addCloud(-24 + i * 9.5 + rnd() * 2, -3.2 + rnd() * 1.1, -22 - rnd() * 5, 8 + rnd() * 4, 3.0 + rnd() * 1.4, 0.34);
  }
  // 岛下云海：只露边缘，不抢主体
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.2;
    addCloud(Math.cos(a) * (17 + rnd() * 4), -10.5 - rnd() * 1.5, Math.sin(a) * (17 + rnd() * 4), 10 + rnd() * 4, 3.4 + rnd() * 1.6, 0.38);
  }
  // 高空卷云：更淡更薄
  for (let i = 0; i < 3; i++) {
    addCloud(-18 + i * 18, 10 + rnd() * 3, -26, 14 + rnd() * 6, 2.4, 0.10);
  }

  // ---- 鸟群：几笔 V 形剪影，给天空一点“活物” ----
  const birdMat = new THREE.LineBasicMaterial({ color: 0x4f625f, transparent: true, opacity: 0.55, fog: false });
  const birds = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.28, 0, 0, 0, 0.12, 0, 0.28, 0, 0], 3));
    const b = new THREE.Line(g, birdMat);
    b.position.set((rnd() - 0.5) * 8, (rnd() - 0.5) * 2, (rnd() - 0.5) * 4);
    b.rotation.y = rnd() * Math.PI;
    birds.add(b);
  }
  birds.position.set(-9, 8.5, -14);
  group.add(birds);

  const stars = makeStars(240, 20261117);
  group.add(stars);

  let t = 0;
  return {
    group,
    update(dt: number) {
      t += dt;
      for (const c of clouds) {
        c.sprite.position.x += c.drift * dt * 0.06;
        if (c.sprite.position.x > 30) c.sprite.position.x = -30;
        c.sprite.position.y = c.baseY + Math.sin(t * 0.18 + c.phase) * 0.14;
      }
      birds.position.x = -9 + Math.sin(t * 0.045) * 3;
      birds.position.y = 8.5 + Math.sin(t * 0.5) * 0.12;
      for (const b of birds.children) b.rotation.z = Math.sin(t * 2.3 + b.position.x) * 0.12;
    },
    setNight(night: boolean) {
      for (const c of clouds) {
        (c.sprite.material as THREE.SpriteMaterial).color.setHex(night ? 0x64729a : 0xfffaf0);
      }
      birdMat.opacity = night ? 0.12 : 0.55;
      (stars.material as THREE.PointsMaterial).opacity = night ? 0.95 : 0;
    },
  };
}
