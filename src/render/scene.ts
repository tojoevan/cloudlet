import * as THREE from 'three';
import { getPalette, getScheme } from './palette';
import { createBackdrop, type Backdrop } from './backdrop';

/**
 * 从天空基色派生渐变用的上/下两色：
 *  - 下方更亮：往白色提亮（高明度）
 *  - 上方更蓝：压低红、抬升蓝，色相偏冷
 * 两份都在线性空间里算（ColorManagement 下 Color 内部即线性），
 * 最后在着色器里统一转回 sRGB，保证和其它材质观感一致。
 */
function skyBottom(hex: number, night: boolean): THREE.Color {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(0xffffff), night ? 0.14 : 0.32);
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

const ISO_PITCH = Math.atan(1 / Math.SQRT2); // 真等距 35.26°
const MIN_ZOOM = 0.55;
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
const SHOWCASE_ZOOM = 0.92;

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
  private zoom = 1;
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
  private tiltOn = true;
  /** 远景背板（远山 + 云海），不随换岛重建 */
  private backdrop!: Backdrop;
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
        uGlowAmt: { value: 0.35 },
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
        varying vec3 vDir;

        void main() {
          vec3 d = normalize(vDir);
          // 上蓝下亮的竖直渐变，叠加一点水平倾斜让等色线略斜
          float grad = d.y + uTiltAmt * dot(d.xz, normalize(uTilt.xz + vec2(1e-5)));
          float t = clamp((grad + 1.0) * 0.5, 0.0, 1.0);
          vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, t));
          // 顶部柔光扩散（圆形晕开感）
          float g = pow(max(dot(d, normalize(uGlowDir)), 0.0), 3.0);
          col = mix(col, uGlow, g * uGlowAmt);
          // 注意：这里不要再做 sRGB 编码。
          // 场景是渲进 RenderTarget 再由移轴后处理统一转sRGB的，
          // 天穹若自己再编码一次，就会变成"双重 gamma"——夜景被抬成灰蓝、
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
    // 夜空不做推导：skyBottom 会往白色提亮 14%，再经 sRGB 编码后就变成发白的灰紫，
    // 这正是"夜里颜色不讨喜"的来源。这里直接给一组饱和的靛蓝。
    const bottom = night ? new THREE.Color(0x18213f) : skyBottom(p.sky, false);
    const top = night ? new THREE.Color(0x0a1026) : skyTop(p.sky, false);
    const glow = bottom.clone().lerp(new THREE.Color(0xffffff), night ? 0.03 : 0.3);
    if (this.skyMat) {
      this.skyMat.uniforms.uBottom.value.copy(bottom);
      this.skyMat.uniforms.uTop.value.copy(top);
      this.skyMat.uniforms.uGlow.value.copy(glow);
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
    });
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uTexel: { value: new THREE.Vector2(1 / (size.x || 1), 1 / (size.y || 1)) },
        uBlur: { value: 3.0 },
        uBand: { value: 0.28 },
        uSat: { value: 1.06 },
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
        uniform vec2 uTexel;
        uniform float uBlur;
        uniform float uBand;
        uniform float uSat;
        varying vec2 vUv;

        void main() {
          // 距画面竖直中心的距离：中间清楚，上下渐糊
          float d = abs(vUv.y - 0.5) * 2.0;
          float blurAmt = smoothstep(1.0 - uBand, 1.0, d) * uBlur;

          vec3 c = texture2D(tDiffuse, vUv).rgb;
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
          // 分离色调：暗部往冷蓝压、亮部往暖黄提。
          // 这是影视调色的经典手法，能给"平涂低多边形"补上一层统一的调子。
          vec3 shadowTint = vec3(0.93, 0.97, 1.07);
          vec3 highTint = vec3(1.06, 1.015, 0.95);
          c *= mix(shadowTint, highTint, smoothstep(0.22, 0.86, l));
          // 极轻暗角
          vec2 p = vUv - 0.5;
          c *= 1.0 - dot(p, p) * 0.22;
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
    const light = getScheme().light;
    if (this.isNight) {
      // 夜里用"冷月光 + 暖补光"的冷暖对比，比整片紫灰高级得多：
      // 主光是淡蓝月光，补光模拟窗灯/路灯的暖色溢光。
      this.sun.color.set(0xb9c8ff);
      this.hemi.color.set(0x9fb4e8);
      this.hemi.groundColor.set(0x5a6b8c);
      this.fill.color.set(0xffb877);
      this.fill.intensity = 0.34;
    } else {
      this.sun.color.copy(new THREE.Color(0xfff8ec).lerp(tint, k * 0.8));
      this.hemi.color.set(0xeef6ff);
      this.hemi.groundColor.set(0xd6f0c8);
      // 白天补光偏暖、从背侧打，相当于给低多边形加一道暖轮廓光
      this.fill.color.set(0xffe6c4);
      this.fill.intensity = light.fill * hemi * 1.15;
    }
    this.sun.intensity = light.sun * sun;
    this.hemi.intensity = light.hemi * hemi;
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
    const hemi = new THREE.HemisphereLight(0xeef6ff, 0xd6f0c8, light.hemi);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xfff8ec, light.sun);
    sun.position.set(9, 16, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const s = 16;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0012;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // 补光压一点阴影，避免背光面死黑
    const fill = new THREE.DirectionalLight(0xdcefff, light.fill);
    fill.position.set(-8, 6, -6);
    this.scene.add(fill);
    this.fill = fill;

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
  update(dt: number): void {
    this.backdrop?.update(dt);
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
    this.tiltOn = on;
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
    this.camera.bottom = -this.frustum / 2;
    this.camera.updateProjectionMatrix();
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
    if (this.tiltOn && this.rt && this.postMat) {
      this.syncPostSize();
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.rt);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(prev);
      this.renderer.render(this.postScene, this.postCam);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    // 绘制后立刻抓 renderer.info：autoReset 默认开启，统计的就是本帧数据
    const info = this.renderer.info;
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
