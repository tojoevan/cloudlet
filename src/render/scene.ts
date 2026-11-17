import * as THREE from 'three';
import { getPalette, getScheme } from './palette';
import { createBackdrop, type Backdrop } from './backdrop';
import { Weather, type WeatherKind } from './weather';
import { createFrameOverlay, type FrameOverlay } from './frame';

/**
 * 从天空基色派生渐变用的上/下两色：
 *  - 下方更亮：往白色提亮（高明度）
 *  - 上方更蓝：压低红、抬升蓝，色相偏冷
 * 两份都在线性空间里算（ColorManagement 下 Color 内部即线性），
 * 最后在着色器里统一转回 sRGB，保证和其它材质观感一致。
 */
function skyBottom(hex: number, night: boolean): THREE.Color {
  const c = new THREE.Color(hex);
  // 白天只提亮一点点：提太多会把渐变洗成灰白（粉彩最容易死在这里）
  c.lerp(new THREE.Color(0xffffff), night ? 0.1 : 0.1);
  return c;
}
function skyTop(hex: number, night: boolean): THREE.Color {
  const c = new THREE.Color(hex);
  const r = Math.max(0, c.r * 0.74);
  const g = c.g * 0.9;
  const b = Math.min(1, c.b * 1.14 + 0.05);
  c.setRGB(r, g, b);
  if (night) c.lerp(new THREE.Color(0x20284a), 0.35);
  return c;
}

/**
 * 一天里的光色脚本。只有"白天/夜晚"两档时，画面永远是同一个蓝调；
 * 加上清晨的暖橘、黄昏的粉紫，同一座岛在一天里就有三种气质——
 * 这是陪伴类游戏最廉价、也最有效的氛围来源。
 *   k    : 向 tint 靠拢的强度
 *   sun  : 主光强度倍率
 *   hemi : 环境光强度倍率
 */
interface TimeStop {
  h: number;
  tint: number;
  k: number;
  sun: number;
  hemi: number;
}
const TIME_STOPS: TimeStop[] = [
  { h: 0,    tint: 0x46578f, k: 0.58, sun: 0.58, hemi: 0.80 },
  { h: 5.2,  tint: 0x4a5686, k: 0.56, sun: 0.60, hemi: 0.82 },
  { h: 6.4,  tint: 0xffa064, k: 0.52, sun: 0.48, hemi: 0.58 },
  { h: 8,    tint: 0xfff0dc, k: 0.14, sun: 0.98, hemi: 0.94 },
  { h: 12,   tint: 0xffffff, k: 0.00, sun: 1.15, hemi: 1.00 },
  { h: 16.5, tint: 0xfff2d8, k: 0.10, sun: 1.05, hemi: 0.96 },
  { h: 18.4, tint: 0xff9a5c, k: 0.50, sun: 0.62, hemi: 0.70 },
  { h: 19.8, tint: 0x6b5a92, k: 0.54, sun: 0.52, hemi: 0.68 },
  { h: 21.5, tint: 0x46578f, k: 0.58, sun: 0.60, hemi: 0.82 },
  { h: 24,   tint: 0x46578f, k: 0.58, sun: 0.58, hemi: 0.80 },
];

const ISO_PITCH = Math.PI / 6; // 30°：更接近“看一个微缩模型”，能看见岩壁厚度
const MIN_ZOOM = 0.4; // 竖屏要装下主岛+两座拓荒小岛，允许更远
const MAX_ZOOM = 2.6;

/** 每帧性能快照，由 render() 在绘制后填充，供主循环采样展示（性能监控浮层用） */
export interface PerfSnapshot {
  /** draw calls：每帧渲染调用次数 */
  calls: number;
  /** 三角面数 */
  triangles: number;
  /** 已上传 GPU 的几何体数量 */
  geometries: number;
  /** 已上传 GPU 的纹理数量 */
  textures: number;
  /** JS 堆占用字节（仅 Chromium 系可用，其余为 0） */
  jsHeap: number;
}
/**
 * 「近景」判定阈值：缩放超过这个值算贴近小岛（能看清居民），
 * 此时居民才自动闲聊、也能点开说话；缩小拉远看全岛时居民只是小点，不说话。
 */
const NEAR_ZOOM = 1.3;
/** 多久没操作就进入待机环绕 */
const IDLE_MS = 30_000;
/** 环绕角速度（rad/s），一圈约三分钟，慢到不晕 */
const IDLE_SPIN = 0.035;
/** 触控板双指捏合（wheel+ctrlKey）缩放灵敏度，越小越慢 */
const PINCH_SENS = 0.0003;
/** 触屏双指捏合的阻尼，越小越跟手但更慢（0.22→0.15） */
const TOUCH_PINCH_DAMP = 0.15;
/**
 * 触控板双指上下滑 / 鼠标滚轮的缩放灵敏度，越小越慢。
 * 必须按 deltaY 成比例缩放：触控板每次事件 deltaY 很小但事件极密（每秒几十次），
 * 若用「每个事件固定 ×1.08」的档位制，总缩放量会被事件数量放大——一次轻扫就
 * 瞬间撞到缩放上下限，这正是「触控板缩放太灵敏」的根源。改成按 deltaY 累计后，
 * 一次手势的总缩放量只跟滑动距离有关，与事件数量无关。
 */
const WHEEL_SENS = 0.0006;
/**
 * 专注/展示模式的「最佳缩放」：把整座岛框进视野、留出天空余量的舒适比例。
 * 比默认 1.0 略拉远，旋转时既看得到全貌又不会空旷。
 */
const SHOWCASE_ZOOM = 1.0;

export interface PointerHit {
  object: THREE.Object3D;
  point: THREE.Vector3;
}

/**
 * 正交等距视图。逻辑上是「看向 target 的一台固定俯角相机」，
 * 相机本身不动，动的是 target / 距离 / yaw。
 */
export class SceneView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;

  private frustum = 16;
  private target = new THREE.Vector3(0, 0, 0);
  private dist = 40;
  private yaw = Math.PI * 0.25;
  /** 键盘旋转的目标角度，靠插值趋近，转起来才不会瞬跳 */
  private targetYaw = Math.PI * 0.25;
  private zoom = 1.14;
  /** 开场演出：用墙钟时间推进，避免逐帧 dt 被 clamp 后慢设备上拖得过长 */
  private introStart = 0;
  private introFrom = 1;
  private introTo = 1;
  private static readonly INTRO_SEC = 3.2;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private fill!: THREE.DirectionalLight;
  private isNight = false;
  /** 当前时段（0~24，含分钟）。setSky 被配色方案/重建触发时会据此重新叠色温 */
  private hour = 12;
  private quality: 'low' | 'standard' | 'high' = 'standard';
  /** 最近一帧的性能快照（render 后刷新），主循环读取它做采样与告警 */
  perf: PerfSnapshot = { calls: 0, triangles: 0, geometries: 0, textures: 0, jsHeap: 0 };

  private drag: { x: number; y: number; mode: 'pan' | 'orbit' } | null = null;
  /** 双指状态：距离用于捏合，中点位移用于横转纵缩 */
  private pinch = { active: false, dist: 0, cx: 0, cy: 0 };
  private readonly canvas: HTMLCanvasElement;
  private powerSave = false;
  private lastInteraction = performance.now();
  private idle = false;
  /** 展示模式：进入即持续环绕旋转（不受 30s 待机计时限制），手动操作即退出 */
  private showcase = false;
  /** 岛屿内容的世界包围盒（由外部设置，用于「最佳视图」动态贴合） */
  private fitBox: THREE.Box3 | null = null;
  /** 渐变天穹：大球壳 + 自定义着色器，下亮上蓝、带轻微倾斜与顶部柔光 */
  private sky!: THREE.Mesh;
  /** 移轴后处理：先把场景渲进 RT，再用全屏 pass 做上下模糊带 + 轻饱和 + 暗角 */
  private rt: THREE.WebGLRenderTarget | null = null;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.ShaderMaterial | null = null;
  /** ?post=0 时绕过整趟后处理（排查用） */
  private postEnabled = new URLSearchParams(location.search).get('post') !== '0';
  /** 远景背板（远山 + 云海），不随换岛重建 */
  private backdrop!: Backdrop;
  private weather = new Weather();
  /** 前景枝叶遮幅：一层贴在镜头前的虚化剪影，制造景深 */
  private frameOverlay: FrameOverlay | null = null;
  /** 当前天气会影响光照：雨天压暗、整体偏冷 */
  private weatherKind: WeatherKind = 'clear';
  private skyMat!: THREE.ShaderMaterial;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
    // 渐变天穹：大球壳包住整个场景，BackSide 朝内，不参与深度/光照/雾
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uBottom: { value: new THREE.Color(0xffffff) },
        uTop: { value: new THREE.Color(0x88bbff) },
        uTilt: { value: new THREE.Vector3(0.35, 0, 1).normalize() },
        uTiltAmt: { value: 0.18 },
        uGlow: { value: new THREE.Color(0xffffff) },
        uGlowDir: { value: new THREE.Vector3(0.15, 0.9, 0.25).normalize() },
        uGlowAmt: { value: 0.07 },
        uSunDir: { value: new THREE.Vector3(-0.52, 0.55, 0.52).normalize() },
        uSunColor: { value: new THREE.Color(0xffe6bd) },
        uHaze: { value: new THREE.Color(0xffd7b0) },
        uCloud: { value: new THREE.Color(0xfffaf0) },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uBottom;
        uniform vec3 uTop;
        uniform vec3 uTilt;
        uniform float uTiltAmt;
        uniform vec3 uGlow;
        uniform vec3 uGlowDir;
        uniform float uGlowAmt;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uHaze;
        uniform vec3 uCloud;
        uniform float uTime;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += vnoise(p) * a;
            p = p * 2.03 + vec2(17.1, 9.2);
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          // 上蓝下暖的竖直渐变，叠加一点水平倾斜让等色线略斜
          float grad = d.y + uTiltAmt * dot(d.xz, normalize(uTilt.xz + vec2(1e-5)));
          float t = clamp((grad + 1.0) * 0.5, 0.0, 1.0);
          vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, pow(t, 0.72)));
          // 地平线暖霭：让天空的底边不是一条死蓝，而是有日出后的空气感
          float haze = exp(-max(d.y + 0.02, 0.0) * 7.0);
          col = mix(col, uHaze, haze * 0.18);
          // 顶部柔光扩散（圆形晕开感）
          float g = pow(max(dot(d, normalize(uGlowDir)), 0.0), 3.0);
          col = mix(col, uGlow, g * uGlowAmt);
          // 太阳：一个很亮的核 + 大范围暖晕。位移与主光方向一致。
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          col += uSunColor * pow(sd, 240.0) * 1.1;
          col += uSunColor * pow(sd, 8.0) * 0.10;
          // 高空卷云：投影到云平面做 fbm，靠地平线淡出，避免糊住岛体
          vec2 cuv = d.xz / (max(d.y, 0.04) + 0.42);
          float cl = fbm(cuv * 1.35 + vec2(uTime * 0.004, uTime * 0.0015));
          cl = smoothstep(0.54, 0.78, cl) * smoothstep(0.02, 0.2, d.y);
          col = mix(col, uCloud, cl * 0.26);
          // 注意：这里不要再做 sRGB 编码。
          // 场景是渲进 RenderTarget 再由移轴后处理统一转sRGB的，
          // 天穹若自己再编码一次，就会变成“双重 gamma”——夜景被抬成灰蓝、
          // 白天则整体发白，正是之前颜色不讨喜的根因。
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    // 天空与雾色随色系走，由 setSky 统一设置
    // 雾必须落在岛体之外：正交相机离岛约 40~50 单位，雾近界若设在 30，
    // 整座岛会被雾压成灰蓝色（表现为"颜色暗淡、体积全失"）。
    // 远景层的淡化已由顶点色自己做（backdrop 关掉 fog），这里只留极远处柔化。
    this.scene.fog = new THREE.Fog(0xffffff, 90, 170);
    this.backdrop = createBackdrop();
    this.scene.add(this.backdrop.group);
    this.scene.add(this.weather.group);

    // 前景遮幅挂在相机下，跟着镜头走；相机本身也要进场景图才会渲染子节点
    this.frameOverlay = createFrameOverlay();
    this.frameOverlay.mesh.visible = new URLSearchParams(location.search).get('frame') === '1';
    this.camera.add(this.frameOverlay.mesh);
    this.scene.add(this.camera);
    this.setupPost();

    this.setSky(false);

    this.setupLights();
    this.bindInput();
    this.resize();
    this.updateCamera();
  }

  /**
   * 天空与雾色：白天取 palette.sky、夜间取 palette.skyNight，
   * 并派生渐变天穹的上下两色与顶部柔光。切色系（applyScheme）和
   * 昼夜切换都走这里，避免各处硬编码颜色。
   */
  setSky(night: boolean): void {
    this.isNight = night;
    const p = getPalette();
    const tint = this.timeLook(this.hour).tint;
    // 夜空不做推导：skyBottom 会往白色提亮 14%，再经 sRGB 编码后就变成发白的灰紫，
    // 这正是"夜里颜色不讨喜"的来源。这里直接给一组饱和的靛蓝。
    const bottom = night ? new THREE.Color(0x18213f) : skyBottom(p.sky, false);
    const top = night ? new THREE.Color(0x0a1026) : skyTop(p.sky, false);
    const glow = bottom.clone().lerp(new THREE.Color(0xffffff), night ? 0.03 : 0.10);
    // 天气改变天色：雨天压成灰蓝天，雪天偏冷白，樱花天留一点粉
    const w = this.weatherKind;
    if (w === 'rain') {
      const gray = new THREE.Color(0x9aabbd);
      bottom.lerp(gray, 0.62);
      top.lerp(gray, 0.7);
      glow.lerp(gray, 0.5);
    } else if (w === 'snow') {
      const cold = new THREE.Color(0xd3dee8);
      bottom.lerp(cold, 0.4);
      top.lerp(cold, 0.3);
    } else if (w === 'sakura') {
      const pink = new THREE.Color(0xf6d9e2);
      bottom.lerp(pink, 0.16);
    }
    if (this.skyMat) {
      const u = this.skyMat.uniforms;
      u.uBottom.value.copy(bottom);
      u.uTop.value.copy(top);
      u.uGlow.value.copy(glow);
      // 太阳位置随时段降低：黄昏的太阳更贴地平线，光晕也更大更暖
      const sunHeight = night ? 0.62 : 0.38 + Math.sin(((this.hour - 6) / 12) * Math.PI) * 0.18;
      (u.uSunDir.value as THREE.Vector3).set(night ? -0.38 : -0.52, Math.max(0.14, sunHeight), night ? 0.34 : 0.52).normalize();
      (u.uSunColor.value as THREE.Color)
        .setHex(night ? 0xdbe6ff : 0xffe9c2)
        .lerp(tint, night ? 0.1 : 0.18);
      const haze = new THREE.Color(night ? 0x2b3a63 : 0xffcfa4);
      if (this.weatherKind === 'rain') haze.lerp(new THREE.Color(0x9aabbd), 0.6);
      (u.uHaze.value as THREE.Color).copy(haze);
      (u.uCloud.value as THREE.Color)
        .setHex(night ? 0x53618a : 0xfff8ea)
        .lerp(tint, night ? 0.25 : 0.08);
    }
    // 雾色取下方亮色，远处地形自然融进地平线天空
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(bottom);
    // 纯色兜底（天穹意外未覆盖时）
    this.scene.background = bottom.clone();
    this.backdrop?.setNight(night);
    this.tintAndLights();
  }

  /**
   * 移轴（tilt-shift）后处理。
   * 微缩模型的观感有一半来自「只有中间一条是清楚的」——这是摄影里的浅景深，
   * 在正交等距画面上用上下两条模糊带模拟，效果非常廉价但极有效。
   * 顺带在同一趟 pass 里做轻微提饱和与暗角，避免再开一次全屏开销。
   */
  private setupPost(): void {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    this.rt = new THREE.WebGLRenderTarget(size.x || 1, size.y || 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      // 场景先渲进离屏 RT，默认没有 MSAA；专注模式缓慢旋转时，
      // 草叶/屋檐/岩壁的边缘会持续“爬行”，看起来像模型在闪。
      // 4x MSAA 是这一层最直接、最有效的修复。
      samples: window.innerWidth <= 640 ? 2 : 4,
    });
    // 深度纹理：给后处理做插画式轮廓线（只描物体剪影，不做全屏线框）
    this.rt.depthTexture = new THREE.DepthTexture(size.x || 1, size.y || 1);
    this.rt.depthTexture.format = THREE.DepthFormat;
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        tDepth: { value: this.rt.depthTexture },
        uTexel: { value: new THREE.Vector2(1 / (size.x || 1), 1 / (size.y || 1)) },
        uInk: { value: 0.16 },
        uBlur: { value: 3.0 },
        uBand: { value: 0.28 },
        uSat: { value: 1.16 },
        uExposure: { value: 1.06 },
        uBlurAmt: { value: 4.0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2 uTexel;
        uniform float uInk;
        uniform float uBlur;
        uniform float uBand;
        uniform float uSat;
        uniform float uExposure;
        uniform float uBlurAmt;
        uniform float uTime;
        varying vec2 vUv;

        float h21(vec2 p) {
          p = fract(p * vec2(443.897, 441.423));
          p += dot(p, p + 19.19);
          return fract((p.x + p.y) * p.x);
        }

        /**
         * 高光柔化：只压 0.72 以上的部分，中低亮度原样保留。
         *
         * 为什么不用 ACES：ACES 会把高亮处的色相拉向白，粉彩天空会被压成灰绿色。
         * 这套画风的关键是"柔和但不发灰"，所以只做高光的肩部压缩，
         * 既避免亮部死死撞上 1.0，又不牺牲中间调的饱和度。
         */
        vec3 rolloff(vec3 x) {
          vec3 over = max(x - 0.9, 0.0);
          return min(x, vec3(0.9)) + over / (1.0 + over * 3.0);
        }

        void main() {
          // 距画面竖直中心的距离：中间清楚，上下渐糊
          float d = abs(vUv.y - 0.5) * 2.0;
          float blurAmt = smoothstep(1.0 - uBand, 1.0, d) * uBlurAmt;

          vec3 c = texture2D(tDiffuse, vUv).rgb;
          // 只在极高光做肩部压缩，中间调保持原样（保留粉彩天空的色相）
          c = rolloff(c * uExposure);

          // —— 插画式轮廓 ——
          // 只取深度断层做 1px 描边：天空不着墨，物体之间只留最外轮廓。
          // 这一笔把“干净的 3D 渲染”往“画出来的模型”推了一大步。
          float d0 = texture2D(tDepth, vUv).x;
          float dr = texture2D(tDepth, vUv + vec2(uTexel.x * 1.4, 0.0)).x;
          float dl = texture2D(tDepth, vUv - vec2(uTexel.x * 1.4, 0.0)).x;
          float du = texture2D(tDepth, vUv + vec2(0.0, uTexel.y * 1.4)).x;
          float dd = texture2D(tDepth, vUv - vec2(0.0, uTexel.y * 1.4)).x;
          float edge = abs(d0 - dr) + abs(d0 - dl) + abs(d0 - du) + abs(d0 - dd);
          edge = smoothstep(0.0025, 0.02, edge);
          // 天空背景不描边
          edge *= step(0.0001, 1.0 - d0);
          c = mix(c, c * 0.58 + vec3(0.015, 0.025, 0.035), edge * uInk * 2.2);
          if (blurAmt > 0.001) {
            vec3 acc = c;
            float wsum = 1.0;
            // 9 点高斯（十字 + 对角），够用且便宜
            for (int i = 1; i <= 4; i++) {
              float w = 1.0 / float(i + 1);
              float o = blurAmt * float(i);
              acc += texture2D(tDiffuse, vUv + vec2(uTexel.x * o, 0.0)).rgb * w;
              acc += texture2D(tDiffuse, vUv - vec2(uTexel.x * o, 0.0)).rgb * w;
              acc += texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y * o)).rgb * w;
              acc += texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y * o)).rgb * w;
              wsum += w * 4.0;
            }
            c = acc / wsum;
          }

          // 轻微提饱和：低多边形画面容易发灰
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, uSat);
          // 柔和 S 曲线：低模最怕“灰而平”，一点对比就能把体积推出来
          c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
          // 分离色调：暗部往青蓝压、亮部往蜜黄提。
          // 这是影视调色的经典手法，能给“平涂低多边形”补上一层统一的调子。
          vec3 shadowTint = vec3(0.92, 1.0, 1.06);
          vec3 highTint = vec3(1.055, 1.02, 0.955);
          c *= mix(shadowTint, highTint, smoothstep(0.2, 0.84, l));
          // 极轻暗角 + 细颗粒：把“干净的 3D 渲染”往“画出来的照片”推半步
          vec2 p = vUv - 0.5;
          c *= 1.0 - dot(p, p) * 0.26;
          float grain = (h21(vUv * 1024.0 + fract(uTime * 0.37)) - 0.5) * 0.018;
          c += grain;
          // 关键：RT 里存的是线性值，自定义 ShaderMaterial 不会自动做 sRGB 编码，
          // 少了这一步整幅画面会明显发暗（草色直接掉成深绿）。
          c = pow(max(c, 0.0), vec3(1.0 / 2.2));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  /** 视口变化时同步 RT 尺寸 */
  private syncPostSize(): void {
    if (!this.rt || !this.postMat) return;
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    if (size.x === 0 || size.y === 0) return;
    if (this.rt.width === size.x && this.rt.height === size.y) return;
    this.rt.setSize(size.x, size.y);
    if (this.rt.depthTexture) {
      this.rt.depthTexture.image.width = size.x;
      this.rt.depthTexture.image.height = size.y;
      this.rt.depthTexture.needsUpdate = true;
    }
    (this.postMat.uniforms.uTexel.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
  }

  /** 在关键帧之间插值出当前时刻的色温与光照强度 */
  private timeLook(hour: number): { k: number; sun: number; hemi: number; tint: THREE.Color } {
    const stops = TIME_STOPS;
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (hour >= stops[i].h && hour <= stops[i + 1].h) {
        a = stops[i];
        b = stops[i + 1];
        break;
      }
    }
    const span = Math.max(0.001, b.h - a.h);
    const t = Math.min(1, Math.max(0, (hour - a.h) / span));
    return {
      k: a.k + (b.k - a.k) * t,
      sun: a.sun + (b.sun - a.sun) * t,
      hemi: a.hemi + (b.hemi - a.hemi) * t,
      tint: new THREE.Color(a.tint).lerp(new THREE.Color(b.tint), t),
    };
  }

  /**
   * 把时段色温叠到天穹/雾/背景色与三盏灯上。
   * 由 setSky 末尾调用，因此「切配色方案」「换岛重建」之后也不会把时段光色冲掉——
   * 之前 applyHour 只管一次，配色初始化随后 setSky 一覆盖，黄昏就变回正午了。
   */
  private tintAndLights(): void {
    if (!this.sun) return; // 构造期灯光还没建好
    const { k, sun, hemi, tint } = this.timeLook(this.hour);
    const u = this.skyMat?.uniforms;
    if (u) {
      u.uBottom.value.lerp(tint, Math.min(0.88, k * 0.9));
      u.uTop.value.lerp(tint, Math.min(0.92, k * 1.0));
      u.uGlow.value.lerp(tint, Math.min(0.8, k * 0.6));
      const bottom = u.uBottom.value;
      if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(bottom);
      this.scene.background = (bottom as THREE.Color).clone();
    }
    // 前景枝叶：白天暗绿、夜里更深、黄昏偏暖。
    // 不染色的话它是一团白，看起来像云而不是叶子。
    if (this.frameOverlay) {
      const leaf = new THREE.Color(0x3c6b3a);
      if (this.isNight) leaf.setHex(0x16222e);
      else if (k > 0.25) leaf.lerp(new THREE.Color(0x5a6a2e), 0.55);
      this.frameOverlay.setColor(leaf);
    }
    const light = getScheme().light;
    if (this.isNight) {
      // 夜里用"冷月光 + 暖补光"的冷暖对比，比整片紫灰高级得多：
      // 主光是淡蓝月光，补光模拟窗灯/路灯的暖色溢光。
      this.sun.color.set(0xaebdff);
      this.hemi.color.set(0x7f95cc);
      this.hemi.groundColor.set(0x3f4f70);
      this.fill.color.set(0xffb877);
      this.fill.intensity = 0.42;
    } else {
      this.sun.color.copy(new THREE.Color(0xffe3b4).lerp(tint, k * 0.72));
      this.hemi.color.set(0xc4e2ff);
      this.hemi.groundColor.set(0x98b06e);
      // 白天补光偏冷，从背侧打，给低多边形一道冷色轮廓
      this.fill.color.set(0xbcd6ff);
      this.fill.intensity = light.fill * hemi * 1.25;
    }
    // 天气对光照的修正：雨天压暗并偏冷，雪天略提亮，樱花天略加暖
    const w = this.weatherKind;
    const dim = w === 'rain' ? 0.66 : w === 'snow' ? 1.06 : w === 'sakura' ? 1.02 : 1;
    this.sun.intensity = light.sun * sun * dim;
    this.hemi.intensity = light.hemi * hemi * (w === 'rain' ? 1.08 : 1);
    if (w === 'rain') {
      this.hemi.color.lerp(new THREE.Color(0xb9c6d8), 0.55);
      this.sun.color.lerp(new THREE.Color(0xcfd8e6), 0.5);
    }
  }

  /** 按时段套用光色：算出昼夜后用 setSky 重构基础天穹，色温由 tintAndLights 叠加 */
  applyHour(hour: number): void {
    this.hour = hour;
    // 用小时而不是光照阈值判定昼夜：阈值会在晨昏附近抖动，
    // 导致「该换夜空却还在用白天基调 + 色温 lerp」，天空因此发灰。
    this.setSky(hour >= 19 || hour < 6);
  }

  private setupLights(): void {
    // 强度取当前色系的 light 参数：越明亮的色系给越弱的光，避免过曝洗白。
    const light = getScheme().light;
    // 下半球的 groundColor 决定背光面亮度，给足才不会死黑。
    // 草绿的地面反弹光能把树冠底部和屋檐下染成暖绿色，这是盆景感的关键。
    const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x9cae72, light.hemi);
    this.scene.add(hemi);
    this.hemi = hemi;

    // 主光从左上前方低角度斜射：影子被拉长、方向一眼可读。
    // 之前太阳几乎在头顶，投影全缩在物体脚下，画面因此像没有光照的示意图。
    const sun = new THREE.DirectionalLight(0xfff1d6, light.sun);
    sun.position.set(-7.5, 8, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 15;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 2.5;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // 冷色补光从右后方来，负责把背光面的轮廓“托”出来，避免死黑
    const fill = new THREE.DirectionalLight(0xbcd6ff, light.fill);
    fill.position.set(10, 6, -5);
    this.scene.add(fill);
    this.fill = fill;

    // 正面暖补光：只负责把岩壁/屋檐的暗部从死黑里拉回来，不投影、不抢主光
    const front = new THREE.DirectionalLight(0xffd9b0, 0.34);
    front.position.set(0, 5, 14);
    this.scene.add(front);

    this.scene.userData.sun = sun;
    this.scene.userData.hemi = hemi;
  }

  /** 切换色系后重设光照强度与天空色（不重建场景几何体） */
  applyScheme(): void {
    const light = getScheme().light;
    if (this.hemi) this.hemi.intensity = light.hemi;
    if (this.fill) this.fill.intensity = light.fill;
    if (this.sun) this.sun.intensity = light.sun;
    this.setSky(this.isNight);
  }

  /** 任何手动操作都推迟待机环绕，并退出展示模式（把镜头交还给玩家） */
  private poke(): void {
    this.lastInteraction = performance.now();
    this.idle = false;
    this.showcase = false;
  }

  /**
   * 待机环绕：没人操作时镜头缓慢转圈，游戏变成一块动态壁纸。
   * 这正是「放在一旁陪伴」想要的形态。
   */
  /** 切换天气（雨/雪/樱花/晴） */
  setWeather(kind: WeatherKind): void {
    this.weatherKind = kind;
    this.weather.set(kind);
    // 立刻重算一次光照，否则雨要等到下一分钟才「变天」
    this.setSky(this.isNight);
  }

  update(dt: number): void {
    this.backdrop?.update(dt);
    if (this.skyMat) this.skyMat.uniforms.uTime.value += dt;
    if (this.postMat) this.postMat.uniforms.uTime.value += dt;
    this.weather.update(dt);
    // 开场演出：3.2 秒内把镜头从远处推近，并缓慢环绕，像一个"抵达"的镜头
    if (this.introStart > 0) {
      const elapsed = (performance.now() - this.introStart) / 1000;
      if (elapsed < SceneView.INTRO_SEC) {
        const t = elapsed / SceneView.INTRO_SEC;
        const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
        this.setZoom(this.introFrom + (this.introTo - this.introFrom) * e);
        this.yaw += dt * 0.06;
        this.targetYaw = this.yaw;
        this.updateCamera();
        return;
      }
      // 收尾：精确回到目标缩放，避免帧率抖动留下半程
      this.introStart = 0;
      this.setZoom(this.introTo);
      this.updateCamera();
    }
    this.easeYaw(dt);
    const now = performance.now();
    // 展示模式：进入即持续环绕，不被 30s 待机计时卡住
    if (this.showcase) {
      this.idle = true;
      this.yaw += dt * IDLE_SPIN;
      this.targetYaw = this.yaw;
      this.updateCamera();
      return;
    }
    if (now - this.lastInteraction < IDLE_MS) {
      if (this.idle) this.idle = false;
      return;
    }
    this.idle = true;
    this.yaw += dt * IDLE_SPIN;
    this.targetYaw = this.yaw;
    this.updateCamera();
  }

  get isIdle(): boolean {
    return this.idle;
  }

  private bindInput(): void {
    const c = this.canvas;
    // 关键：禁用浏览器原生双指缩放/平移，否则手机上手势会被系统抢走，
    // 我们的 touchmove 缩放逻辑根本不会执行（改系数也“没反应”）
    c.style.touchAction = 'none';
    c.style.userSelect = 'none';

    c.addEventListener('pointerdown', (e) => {
      this.poke();
      this.activePointers.add(e.pointerId);
      // 双指交给 touch 分支处理捏合，不再参与平移
      if (e.pointerType === 'touch' && this.activePointers.size >= 2) return;
      this.drag = {
        x: e.clientX,
        y: e.clientY,
        mode: e.button === 2 || e.shiftKey ? 'orbit' : 'pan',
      };
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // 捕获失败不影响拖拽本身，忽略即可
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;

      if (this.drag.mode === 'orbit') {
        this.yaw -= dx * 0.006;
        this.targetYaw = this.yaw; // 拖拽是直接的，别让插值往回拉
      } else {
        this.panBy(dx, dy);
      }
      this.updateCamera();
    });

    // 用 Set 按 id 跟踪，任何一路指针异常中断都不会让计数泄漏——
    // 一旦泄漏，移动端双指之后就再也点不动了
    const end = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.drag) {
        this.drag = null;
        try {
          if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
        } catch {
          // 已经释放过了
        }
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('lostpointercapture', (e) => {
      this.activePointers.delete(e.pointerId);
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.poke();
        if (e.ctrlKey) {
          // 触控板双指捏合：deltaY 很小且事件密集。用指数衰减做平滑、
          // 极缓的缩放——系数越小越慢。Mac 上“双指放大缩小”走的就是这条。
          this.setZoom(this.zoom * Math.exp(-e.deltaY * PINCH_SENS));
        } else {
          // 触控板双指上下滑 / 鼠标滚轮：按 deltaY 成比例缩放
          // deltaMode 归一化：Firefox 用「行」(1) 或「页」(2)，需换算成像素
          // 才能与 Chrome/Safari 的像素模式(deltaMode=0)手感一致。
          // 33 ≈ 100/3，即 Firefox 一格(3 行)与 Chrome 一格(100px)等价。
          let dy = e.deltaY;
          if (e.deltaMode === 1) dy *= 33;
          else if (e.deltaMode === 2) dy *= 100;
          this.setZoom(this.zoom * Math.exp(-dy * WHEEL_SENS));
        }
      },
      { passive: false },
    );

    // 双指：整体横滑 = 旋转，整体纵滑 = 缩放，捏合同样缩放。
    // 手机上没有右键，这是触屏转视角的主入口。
    c.addEventListener('touchstart', (e) => {
      this.poke();
      if (e.touches.length === 2) {
        e.preventDefault();
        this.pinch.active = true;
        this.pinch.dist = touchDist(e.touches);
        const m = touchMid(e.touches);
        this.pinch.cx = m.x;
        this.pinch.cy = m.y;
        this.drag = null;
      }
    }, { passive: false });
    c.addEventListener('touchmove', (e) => {
      if (!this.pinch.active || e.touches.length !== 2) return;
      e.preventDefault();

      // 整体位移：横向转视角，纵向调远近
      const m = touchMid(e.touches);
      const dx = m.x - this.pinch.cx;
      const dy = m.y - this.pinch.cy;
      this.pinch.cx = m.x;
      this.pinch.cy = m.y;

      this.yaw -= dx * 0.006; // 与右键拖拽同一套手感
      this.targetYaw = this.yaw;

      // 捏合与纵滑都映射到缩放，但只要「真正捏合」（两指间距在变）就只用捏合，
      // 否则两者会同时作用、缩放速度翻倍显得飞快。
      const d = touchDist(e.touches);
      let pinched = false;
      if (this.pinch.dist > 0) {
        const ratio = d / this.pinch.dist;
        if (Math.abs(ratio - 1) > 1e-4) {
          pinched = true;
          this.setZoom(this.zoom * (1 + (ratio - 1) * TOUCH_PINCH_DAMP));
        }
      }
      if (!pinched) this.setZoom(this.zoom * (1 - dy * 0.0004)); // 上滑放大，下滑缩小
      this.pinch.dist = d;

      this.updateCamera();
    }, { passive: false });
    c.addEventListener('touchend', (e) => {
      this.pinch.active = false;
      // 兜底：某些浏览器在触摸结束时不一定派发 pointerup
      if (e.touches.length === 0) this.activePointers.clear();
    });
  }

  private readonly activePointers = new Set<number>();

  /**
   * 按屏幕位移平移视角，内容跟手。
   * 屏幕右方向在水平面的投影是 (cos yaw, 0, -sin yaw)，
   * 屏幕上方向的投影是 (-sin yaw, 0, -cos yaw)。
   * 竖直位移要除以 sin(pitch) 放大——等距视角下竖直方向被压缩了。
   *
   * 这两组之前写反了（sin/cos 互换），默认 45° 时 cos=sin 所以看不出来，
   * 一旦旋转视角拖动方向就会偏，某些角度甚至完全相反。
   */
  private panBy(dx: number, dy: number): void {
    const k = this.frustum / (this.zoom * this.canvas.clientHeight);
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const sp = Math.sin(ISO_PITCH);

    // 手往右 → 内容往右 → target 往左；手往下 → 内容往下 → target 往屏幕上方
    this.target.x += -dx * k * cos - ((dy * k) / sp) * sin;
    this.target.z += dx * k * sin - ((dy * k) / sp) * cos;
    this.clampTarget();
  }

  private clampTarget(): void {
    const r = 14;
    const len = Math.hypot(this.target.x, this.target.z);
    if (len > r) {
      this.target.x = (this.target.x / len) * r;
      this.target.z = (this.target.z / len) * r;
    }
  }

  /** 播放开场镜头：从拉远视角推近到当前适配视角 */
  playIntro(): void {
    this.introFrom = Math.min(this.zoom * 0.55, 0.6);
    this.introTo = this.zoom;
    this.introStart = performance.now();
    this.setZoom(this.introFrom);
  }

  setZoom(z: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    this.updateCamera();
  }

  /** 按给定弧度转视角。键盘 Q/E 与设置里的按钮都走这里，转过程是插值的。 */
  rotateBy(rad: number): void {
    this.poke(); // 手动转了就别再自动环绕，否则会打架
    this.targetYaw += rad;
  }

  /** 设置用于「最佳视图」贴合的岛屿包围盒（由 World 提供，排除天上的云） */
  setFitBox(box: THREE.Box3): void {
    this.fitBox = box;
  }

  /**
   * 根据给定世界包围盒，算出「岛屿刚好最大填满屏幕、不裁切」的缩放。
   * 原理：正交投影下 NDC 与 zoom 成正比，所以把盒子角点投到 zoom=1 的
   * 相机、取最大 NDC 跨度，再缩放使跨度 = (1 - margin) 即可。
   */
  fitZoom(box: THREE.Box3, margin = 0.06): number {
    const c = box.getCenter(new THREE.Vector3());
    const savedYaw = this.yaw;
    const savedTarget = this.target.clone();
    const savedZoom = this.zoom;
    this.target.set(c.x, 0, c.z); // 与 startShowcase 的对心一致（岛屿水平中心≈原点）
    this.zoom = 1;
    const v = new THREE.Vector3();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z])
          corners.push(new THREE.Vector3(x, y, z));
    // 采样一整圈 yaw、取最大投影跨度：保证自转时「任意角度」都不裁切，
    // 从而缩放与「当前朝向 / 云朵移动」无关，每次回到最佳视角都稳定一致。
    const STEPS = 24;
    let maxExt = 0;
    for (let i = 0; i < STEPS; i++) {
      this.yaw = (i / STEPS) * Math.PI * 2;
      this.updateCamera();
      this.camera.updateMatrixWorld(true);
      let ext = 0;
      for (const p of corners) {
        v.copy(p).project(this.camera);
        ext = Math.max(ext, Math.abs(v.x), Math.abs(v.y));
      }
      if (ext > maxExt) maxExt = ext;
    }
    // 在当前贴合基础上累计放大 15%×15% ≈ 32%，岛屿更饱满
    const zoom = (maxExt > 0 ? (1 - margin) / maxExt : SHOWCASE_ZOOM) * 1.3225;
    this.yaw = savedYaw;
    this.target.copy(savedTarget);
    this.zoom = savedZoom;
    this.updateCamera();
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  }

  /**
   * 进入展示模式：镜头回到岛心、调到「岛屿刚好最大显示、不遮挡」的最佳缩放，
   * 并立即开始缓慢环绕旋转。用于「专注」等想把小岛当动态壁纸陪伴的场景。
   * 手动操作会经 poke() 自动退出。
   */
  startShowcase(zoom?: number): void {
    this.target.set(0, 0, 0); // 回到岛心，旋转才绕中心转
    const z = zoom ?? (this.fitBox ? this.fitZoom(this.fitBox) : SHOWCASE_ZOOM);
    this.setZoom(z);
    this.showcase = true;
    this.idle = true;
  }

  /** 退出展示模式，回到玩家可自由操控的常规状态 */
  stopShowcase(): void {
    this.showcase = false;
  }

  get isShowcase(): boolean {
    return this.showcase;
  }

  /** 键盘旋转插值到目标角度 */
  private easeYaw(dt: number): void {
    const diff = this.targetYaw - this.yaw;
    if (Math.abs(diff) < 1e-4) return;
    this.yaw += diff * Math.min(1, dt * 9);
    this.updateCamera();
  }

  focus(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.updateCamera();
  }

  private updateCamera(): void {
    const cp = Math.cos(ISO_PITCH);
    const sp = Math.sin(ISO_PITCH);
    this.camera.position.set(
      this.target.x + this.dist * cp * Math.sin(this.yaw),
      this.target.y + this.dist * sp,
      this.target.z + this.dist * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 画质分档：
   * - low      ：省电，像素比 1、关阴影（移动端/弱机）
   * - standard ：默认，像素比按设备、1024 柔和阴影
   * - high     ：2048 阴影（桌面高质量，配合后续后期效果）
   * 改变阴影贴图尺寸后要 dispose 旧 shadow map，否则不会重建。
   */
  /** 移轴开关：省电模式或低画质时关掉，省一次全屏 pass */
  setTilt(on: boolean): void {
    // 低画质仍走这一趟 post（只是不做模糊）：ACES 与调色都在这里，
    // 关掉整趟会让低画质档的色调与标准档不一致。
    if (this.postMat) this.postMat.uniforms.uBlurAmt.value = on ? 3.0 : 0;
  }

  setQuality(q: 'low' | 'standard' | 'high'): void {
    this.quality = q;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (q === 'low') {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
      return;
    }
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = true;
    this.sun.castShadow = true;
    const size = q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  get qualityLevel(): 'low' | 'standard' | 'high' {
    return this.quality;
  }

  /** 旧接口：省电模式映射到 low 画质 */
  setPowerSave(on: boolean): void {
    this.powerSave = on;
    this.setQuality(on ? 'low' : 'standard');
  }

  get isPowerSave(): boolean {
    return this.powerSave;
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    // 竖屏时拉开视野，保证整座岛进得来。
    // 留一圈余量让天空和云露出来，画面更透气。
    this.frustum = aspect < 1 ? 26 : 21;
    this.camera.left = (-this.frustum * aspect) / 2;
    this.camera.right = (this.frustum * aspect) / 2;
    this.camera.top = this.frustum / 2;
    this.frameOverlay?.setSize(this.camera.right - this.camera.left, this.camera.top - this.camera.bottom);
    this.camera.bottom = -this.frustum / 2;
    this.camera.updateProjectionMatrix();
    // 竖屏：只把主岛装进首屏。拓荒小岛交给底部的“主岛/三叶/风铃”切换，
    // 否则三座岛一起塞进 390px 宽，主岛会小到看不清、卫星岛还会被裁掉。
    if (aspect < 0.85) {
      this.zoom = 0.56;
      this.target.set(0, 0, 0);
      this.updateCamera();
    }
  }

  /** 是否处于「近景」：缩放足够大、能看清居民时才算 */
  isNearView(): boolean {
    return this.zoom >= NEAR_ZOOM;
  }

  pick(clientX: number, clientY: number, targets: THREE.Object3D[]): PointerHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(targets, true);
    if (hits.length === 0) return null;
    return { object: hits[0].object, point: hits[0].point };
  }

  render(): void {
    let info: THREE.WebGLInfo;
    if (this.postEnabled && this.rt && this.postMat) {
      this.syncPostSize();
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.rt);
      this.renderer.render(this.scene, this.camera);
      // 必须在后处理之前抓统计：后处理那趟只有 1 个 quad，
      // 会把 autoReset 后的真实数值覆盖成 calls=1 / tris=2。
      info = this.renderer.info;
      const snapshot = {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      };
      this.renderer.setRenderTarget(prev);
      this.renderer.render(this.postScene, this.postCam);
      this.perf = { ...snapshot, jsHeap: this.perf.jsHeap };
      return;
    }
    this.renderer.render(this.scene, this.camera);
    // 绘制后立刻抓 renderer.info：autoReset 默认开启，统计的就是本帧数据
    info = this.renderer.info;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.perf = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      jsHeap: mem?.usedJSHeapSize ?? 0,
    };
  }
}

function touchDist(t: TouchList): number {
  const a = t[0];
  const b = t[1];
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMid(t: TouchList): { x: number; y: number } {
  const a = t[0];
  const b = t[1];
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}
