import * as THREE from 'three';
import { matOwn } from '../mat';
import { getPalette } from '../palette';

/**
 * 农田地块的程序化土壤贴图。
 *
 * 参考同类农场游戏的常见做法：深棕底 + **整齐的平行垄沟** + 零星土块/裂纹。
 * 现在地块是一整块纯棕平涂，在画面里占比又大，是"看起来廉价"最明显的一处。
 * 贴图用 canvas 生成，仍然零美术资源。
 */
function soilCanvas(size = 128, seed = 20261117): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // 底色：暖棕
  ctx.fillStyle = '#b98b60';
  ctx.fillRect(0, 0, size, size);

  // 大块深浅斑：让土面有翻耕过的层次
  for (let i = 0; i < 18; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = size * (0.1 + rnd() * 0.2);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = rnd() > 0.5;
    g.addColorStop(0, dark ? 'rgba(120,84,52,0.35)' : 'rgba(212,168,116,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // 平行垄沟：沿 x 方向一条条压深，边缘略起伏
  const rows = 7;
  for (let i = 0; i < rows; i++) {
    const y = (i + 0.5) * (size / rows);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(110,76,46,0.55)';
    ctx.lineWidth = size * 0.035;
    for (let x = 0; x <= size; x += 4) {
      const yy = y + Math.sin((x / size) * Math.PI * 2 + i) * size * 0.006;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
    // 垄脊高光
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(226,186,140,0.28)';
    ctx.lineWidth = size * 0.02;
    ctx.moveTo(0, y - size * 0.035);
    ctx.lineTo(size, y - size * 0.035);
    ctx.stroke();
  }

  // 零星土块
  for (let i = 0; i < 40; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 1 + rnd() * 2.4;
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(96,66,40,0.5)' : 'rgba(232,200,158,0.45)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  return c;
}

const cache = new Map<number, THREE.MeshStandardMaterial>();

/** 地块材质（按底色缓存，切换配色方案时会重建） */
export function soilMaterial(): THREE.MeshStandardMaterial {
  const base = getPalette().tilled;
  const hit = cache.get(base);
  if (hit) return hit;
  const tex = new THREE.CanvasTexture(soilCanvas());
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // ExtrudeGeometry 的顶盖 UV 直接取形状坐标（约 -0.46~0.46），偏移半格即可铺满
  tex.offset.set(0.5, 0.5);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = matOwn(0xffffff, { map: tex });
  cache.set(base, m);
  return m;
}
