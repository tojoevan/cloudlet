import * as THREE from 'three';

/**
 * 前景遮幅：贴在镜头前的一层枝叶剪影。
 *
 * 为什么这一层值得单独做：等距视角下所有东西都在同一个焦平面，
 * 画面会像"缩略图/示意图"而不是"一张照片"。在前景压几片虚化的叶子，
 * 配合已有的移轴模糊，立刻产生"摄影机在灌木后面拍"的纵深。
 *
 * 实现：一张带 alpha 的 canvas 贴图贴在一个贴着镜头的平面上，
 * 只画在画面四角，中间留空。1 次绘制，零美术资源。
 */
function frameCanvas(size = 512): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;

  let s = 20261117;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  /** 一片有尖端的叶子：椭圆化太软，会读成云 */
  const leaf = (cx: number, cy: number, r: number, rot: number) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(1, 0.42);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.62, -r * 0.05, 0, r);
    ctx.quadraticCurveTo(-r * 0.62, -r * 0.05, 0, -r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fill();
    // 叶脉：细而淡，给剪影一点内部结构
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(1, r * 0.03);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.9);
    ctx.lineTo(0, r * 0.9);
    ctx.stroke();
    ctx.restore();
  };

  // 左下、右下两簇（画在下缘外侧，只露出叶尖）
  for (let i = 0; i < 14; i++) {
    leaf(rnd() * size * 0.34, size * (0.86 + rnd() * 0.3), size * (0.1 + rnd() * 0.16), rnd() * Math.PI);
  }
  for (let i = 0; i < 12; i++) {
    leaf(size - rnd() * size * 0.32, size * (0.9 + rnd() * 0.28), size * (0.09 + rnd() * 0.14), rnd() * Math.PI);
  }
  // 上方两角少量，避免画面太"封"
  for (let i = 0; i < 6; i++) {
    leaf(rnd() * size * 0.22, rnd() * size * 0.16 - size * 0.02, size * (0.08 + rnd() * 0.1), rnd() * Math.PI);
  }
  for (let i = 0; i < 5; i++) {
    leaf(size - rnd() * size * 0.2, rnd() * size * 0.14 - size * 0.02, size * (0.07 + rnd() * 0.09), rnd() * Math.PI);
  }
  return c;
}

export interface FrameOverlay {
  mesh: THREE.Mesh;
  setSize(width: number, height: number): void;
  setColor(color: THREE.Color): void;
}

export function createFrameOverlay(): FrameOverlay {
  const tex = new THREE.CanvasTexture(frameCanvas());
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  // 贴在镜头前：正交相机下 z 越靠近 near 越大画幅，这里取固定偏移
  mesh.position.z = -1;
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  return {
    mesh,
    setSize(w: number, h: number) {
      mesh.scale.set(w, h, 1);
    },
    setColor(color: THREE.Color) {
      mat.color.copy(color);
    },
  };
}
