import * as THREE from 'three';
import { PALETTE } from './palette';

const ISO_PITCH = Math.atan(1 / Math.SQRT2); // 真等距 35.26°
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.6;
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
    this.scene.background = new THREE.Color(PALETTE.sky);
    this.scene.fog = new THREE.Fog(PALETTE.sky, 42, 96);

    this.setupLights();
    this.bindInput();
    this.resize();
    this.updateCamera();
  }

  private setupLights(): void {
    // 数值偏大是故意的：Lambert 材质会乘上光照系数，
    // 按「看起来舒服」反推的强度就是这么高
    // 下半球的 groundColor 决定背光面亮度，给足才不会死黑
    const hemi = new THREE.HemisphereLight(0xe8f6ff, 0xd2f0c4, 1.0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff8ec, 1.45);
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

    // 补光压一点阴影，避免背光面死黑
    const fill = new THREE.DirectionalLight(0xdcefff, 0.55);
    fill.position.set(-8, 6, -6);
    this.scene.add(fill);

    this.scene.userData.sun = sun;
    this.scene.userData.hemi = hemi;
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
          // 普通鼠标滚轮：每格一个明确档位
          this.setZoom(this.zoom * (e.deltaY > 0 ? 0.92 : 1.08));
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

  setPowerSave(on: boolean): void {
    this.powerSave = on;
    this.renderer.setPixelRatio(on ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !on;
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
    this.renderer.render(this.scene, this.camera);
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
