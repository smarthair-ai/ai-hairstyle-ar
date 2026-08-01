/**
 * arScene.js —— Three.js AR 场景：头部位姿求解 + 发型渲染
 *
 * ── 位姿是怎么算出来的？ ────────────────────────────────────────────
 * 1. 深度 d：取 MediaPipe 输出的 4x4 头部变换矩阵的平移 z 分量（拿不到时按真实头宽反推）。
 * 2. 把归一化关键点还原成"世界坐标"：用与渲染相机完全相同的投影参数做反投影，
 *    因此无论 d 取值是否精确，3D 结果投影回屏幕后都能和视频严丝合缝。
 * 3. 姿态：用多组左右对称点求平均得到 X 轴，多组上下点求平均得到 Y 轴，
 *    施密特正交化后叉乘出 Z 轴。比单点求解稳定得多。
 * 4. 平滑：位置/缩放做指数平滑，旋转做球面插值（slerp），消除抖动。
 *
 * ── 遮挡 ──────────────────────────────────────────────────────────
 * 场景里放了一个"隐形头颅"（只写深度不写颜色），脑后头发会被深度缓冲裁掉，露出真实视频，
 * 立体感更强。关键点：这个球必须 ≈ 头骨大小（略小于发型），否则会反过来把整个发型吞掉。
 * （旧版本把它放大到 1.9× 头骨，结果包住了全部头发 → 深度测试把头发整片剔掉，啥也看不见。）
 *
 * ── 调试工具 ──────────────────────────────────────────────────────
 *   · window.AR.setDebug(true)  → 显示鼻梁对齐小球 + 坐标轴，肉眼看对齐
 *   · window.AR.setTest(true)   → 用"圆锥+球"占位模型替换发型，先确认管线能渲染/对齐
 *   · window.AR.setOffset(x,y,z)→ 手动微调发型整体偏移（单位：头宽），也可直接在控制台改 window.AR.offset
 *   · window.AR.info()          → 打印当前位姿 / 缩放 / 偏移，方便排查
 */

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { LM } from './faceShape.js';
import { buildHairGroup, buildSimpleHair, applyHairColor, disposeGroup, HEAD } from './hairFactory.js';
import { hairOverlaySVG } from './ui.js';

const DEG = Math.PI / 180;

/** 把发型里的 color（数字 0x241d1f / 字符串 "#241d1f" / "241d1f"）统一成数字 */
function colorToHex(c) {
  if (c == null) return 0x241d1f;
  if (typeof c === 'number') return c;
  const s = String(c);
  return parseInt(s.startsWith('#') ? s.slice(1) : s, 16) || 0x241d1f;
}

export class ARScene {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);   // 透明：摄像头画面（DOM <video>）作为背景
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.render.fovY, 16 / 9, 0.1, 5000);

    this._setupLights();
    this._setupEnv();

    /* 头部锚点：位置/朝向/缩放（缩放 = 实际头宽）。所有东西都挂它下面，跟着头动。 */
    this.anchor = new THREE.Group();
    this.anchor.visible = false;
    this.scene.add(this.anchor);

    /* 隐形头颅：只写深度，制造遮挡。尺寸 ≈ 头骨（略小于发型），否则会吞掉头发。 */
    const occGeo = new THREE.SphereGeometry(1, 32, 24);
    this.occluder = new THREE.Mesh(occGeo, new THREE.MeshBasicMaterial({ colorWrite: false }));
    // HEAD 是半径；这里用略小于"发型内表面"的比例，让前侧头发露出来、脑后头发被挡住
    this.occluder.scale.set(HEAD.rx * 0.96, HEAD.ry * 0.96, HEAD.rz * 0.95);
    this.occluder.position.set(0, 0, -0.01);
    this.occluder.renderOrder = -1;
    this.anchor.add(this.occluder);

    /* 微调容器：用户滑块作用在这里，单位仍是"头宽" */
    this.tune = new THREE.Group();
    this.anchor.add(this.tune);

    /* 占位测试模型（圆锥+球）：用于确认渲染管线与对齐是否正常 */
    this.placeholder = this._buildPlaceholder();
    this.placeholder.visible = false;
    this.anchor.add(this.placeholder);

    /* 调试可视化：鼻梁对齐小球 + 坐标轴 */
    this.debugGroup = this._buildDebug();
    this.debugGroup.visible = false;
    this.anchor.add(this.debugGroup);

    /* ---------------- 2D 精灵模式（Sprite） ---------------- *
     * 类抖音特效：精灵始终面向相机（billboard），只跟随头部"位置/缩放"，
     * 不继承 anchor 的旋转 → 侧脸时仅平移、略有偏差（HUD 会提示）。
     * spriteGroup 与 anchor 是兄弟节点：anchor 负责 3D（旋转+缩放），
     * spriteGroup 只复制 anchor 的"位置 + 缩放"，丢弃旋转。 */
    this.spriteGroup = new THREE.Group();
    this.spriteGroup.visible = false;
    this.scene.add(this.spriteGroup);

    this.spriteTune = null;     // 用户微调容器（X/Y/Z + 大小）
    this.sprite = null;         // THREE.Sprite
    this.spriteTex = null;
    this.spriteIsPhoto = false; // 是否真人照片（照片自带颜色，不染色）
    this.spriteYOffset = 0;     // 该发型相对头骨中心的竖向偏移（头宽单位）
    this._spriteBaseScale = CONFIG.sprite?.silhouetteScale ?? 1.5;

    // 对齐参考框（测试/调试用）：青色圆角矩形 + 十字 + 发际线，帮助把贴图对到头上
    this.alignHelper = this._buildAlignHelper();
    this.alignHelper.visible = false;
    this.spriteGroup.add(this.alignHelper);

    this._spriteActive = false;

    this.hairGroup = null;
    this.currentStyle = null;

    /* 手动偏移（头宽单位），供控制台 / 滑块之外的精调 */
    this.offset = new THREE.Vector3(0, 0, 0);

    this.debugOn = false;
    this.testOn = false;

    /* 平滑状态 */
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = 0;
    this._inited = false;
    this._lastSeen = 0;

    /* 复用的临时对象，避免每帧 GC */
    this._tmp = {
      v: new THREE.Vector3(), e1: new THREE.Vector3(), e2: new THREE.Vector3(),
      e3: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(),
      m: new THREE.Matrix4(), q: new THREE.Quaternion(),
      mat: new THREE.Matrix4(), tv: new THREE.Vector3(), ts: new THREE.Vector3(),
      off: new THREE.Vector3(),
    };

    this.videoW = 1280; this.videoH = 720;
    this.eco = false;
    this._cw = 0; this._ch = 0;     // 记录画布尺寸，render 时自动校正
  }

  /* ---------------- 灯光 / 环境 ---------------- */
  _setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0b5, 1.15));

    const key = new THREE.DirectionalLight(0xfff4ea, 1.55);
    key.position.set(0.6, 1.0, 1.2);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.6);
    fill.position.set(-1.0, 0.2, 0.8);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(0, 0.6, -1.4);
    this.scene.add(rim);
  }

  /** 用一张渐变画布生成环境贴图，成本极低但能让 PBR 材质"活"起来 */
  _setupEnv() {
    try {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 64;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0.0, '#ffffff');
      g.addColorStop(0.45, '#dfe6f5');
      g.addColorStop(0.75, '#8b8f9e');
      g.addColorStop(1.0, '#3a3d47');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 32, 64);

      const tex = new THREE.CanvasTexture(c);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromEquirectangular(tex).texture;
      pmrem.dispose();
      tex.dispose();
    } catch (e) {
      console.warn('[ARScene] 环境贴图生成失败（不影响使用）', e);
    }
  }

  /* ---------------- 调试 / 占位模型 ---------------- */

  /** 占位测试模型：一个亮色的圆锥 + 球，明显到一眼能看出"渲染/对齐是否工作" */
  _buildPlaceholder() {
    const grp = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xff2d9b, roughness: 0.5, metalness: 0.0,
      emissive: 0x5a0033, emissiveIntensity: 0.4,
    });
    // 球体：代表"头"（方便看它在头上对不对）
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 18), mat);
    ball.position.set(0, 0, 0);
    grp.add(ball);
    // 圆锥：尖朝上，代表"头发体量"
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.0, 28), mat);
    cone.position.set(0, 0.55, 0);
    grp.add(cone);
    grp.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 2; } });
    return grp;
  }

  /** 调试可视化：鼻梁处一个亮绿球（看它是否落在鼻子上）+ 坐标轴（看朝向对不对） */
  _buildDebug() {
    const grp = new THREE.Group();

    // 鼻梁对齐点（头骨中心为原点，+Z 朝面部）：稍微探出头骨/遮挡球前方，确保不被深度剔除
    const nosePos = new THREE.Vector3(0, -0.06 * HEAD.ry, HEAD.rz * 1.08);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    );
    dot.position.copy(nosePos);
    grp.add(dot);

    // 坐标轴：X 红(右) Y 绿(上) Z 蓝(朝向镜头)
    const axes = new THREE.AxesHelper(0.5);
    grp.add(axes);

    // 一条从鼻梁点指向"头顶"的参考线，帮助判断上下偏移
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      nosePos.clone(),
      nosePos.clone().add(new THREE.Vector3(0, HEAD.ry * 1.4, 0)),
    ]);
    grp.add(new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00ff88 })));

    grp.traverse(o => { if (o.isMesh || o.isLine) o.frustumCulled = false; });
    return grp;
  }

  setDebug(on) {
    this.debugOn = !!on;
    this.debugGroup.visible = this.debugOn && this.anchor.visible;
  }

  /** 测试模式：用占位模型替换发型，先确认"渲染+对齐"这条链路本身正常 */
  setTest(on) {
    this.testOn = !!on;
    this._applyVisibility();
  }

  /** 统一切换 精灵 / 3D 头发 / 占位 / 调试的可见性（受 test / debug 模式影响） */
  _applyVisibility() {
    if (this._spriteActive) {
      const showHair = !this.testOn;
      if (this.sprite) this.sprite.visible = showHair && this.spriteGroup.visible;
      // 测试 / 调试时显示"对齐参考框"，帮助把贴图对到头上
      this.alignHelper.visible = this.spriteGroup.visible && (this.testOn || this.debugOn);
      // 3D 相关全部隐藏
      this.placeholder.visible = false;
      this.debugGroup.visible = false;
      if (this.hairGroup) this.hairGroup.visible = false;
    } else {
      const showHair = !this.testOn;
      if (this.hairGroup) this.hairGroup.visible = showHair;
      this.placeholder.visible = this.testOn && this.anchor.visible;
      this.debugGroup.visible = this.debugOn && this.anchor.visible;
      this.spriteGroup.visible = false;
      this.alignHelper.visible = false;
    }
  }

  /** 手动微调发型整体偏移（单位：头宽）。可在控制台调用，也可直接改 this.offset */
  setOffset(x = 0, y = 0, z = 0) {
    this.offset.set(x, y, z);
    if (typeof x === 'object') this.offset.copy(x); // 允许传 Vector3
  }

  /* ---------------- 尺寸 ---------------- */
  setVideoSize(w, h) {
    this.videoW = w; this.videoH = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this._cw = w; this._ch = h;
    const dpr = Math.min(window.devicePixelRatio || 1,
      this.eco ? CONFIG.render.ecoPixelRatio : CONFIG.render.maxPixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
  }

  setEco(on) { this.eco = on; this.resize(); }

  /* ---------------- 发型 ---------------- */

  /** 当前是否用 2D 精灵呈现：默认 sprite 模式；3d 模式下没有模型文件的款也回退到精灵 */
  _useSprite(style) {
    if (CONFIG.render.mode === 'sprite') return true;
    return !style.modelUrl;
  }

  /**
   * 切换发型。
   *  - sprite 模式：用 THREE.Sprite 加载发型图片（真人照片优先，否则用透明头发 SVG 兜底）。
   *  - 3d 模式：modelUrl(glTF) > simple(圆锥+圆柱) > 程序化参数曲面。
   */
  async setStyle(style, colorHex) {
    // 清掉旧内容
    this._clearSprite();
    if (this.hairGroup) {
      this.tune.remove(this.hairGroup);
      disposeGroup(this.hairGroup);
      this.hairGroup = null;
    }
    this.currentStyle = style;

    this._spriteActive = this._useSprite(style);
    if (this._spriteActive) {
      try {
        await this._buildSprite(style);
      } catch (err) {
        console.warn('[ARScene] 精灵构建失败，回退到程序化 3D：', err);
        this._spriteActive = false;
        this.hairGroup = buildHairGroup(style);
        this.tune.add(this.hairGroup);
      }
    } else {
      let group;
      try {
        if (style.modelUrl) group = await this._loadGLTF(style);
        else if (style.simple) group = buildSimpleHair(style);
        else group = buildHairGroup(style);
      } catch (err) {
        console.warn('[ARScene] 发型构建失败，回退到程序化发型：', err);
        group = buildHairGroup(style);
      }
      this.hairGroup = group;
      this.tune.add(group);
    }

    if (colorHex != null) this.setColor(colorHex);
    this._applyVisibility();
    return this.sprite || this.hairGroup;
  }

  /* ---------------- 2D 精灵 ---------------- */

  /** 是否使用真人照片作为贴图（照片自带颜色，不染色；SVG 兜底则是单色，可换发色） */
  async _buildSprite(style) {
    const tex = await this._spriteTexture(style);
    this.spriteIsPhoto = !!style.imageUrl;

    const cfg = style.sprite || {};
    const isPhoto = this.spriteIsPhoto;
    const scale = cfg.scale ?? (isPhoto ? CONFIG.sprite.photoScale : CONFIG.sprite.silhouetteScale);
    this.spriteYOffset = cfg.yOffset ?? (isPhoto ? CONFIG.sprite.photoYOffset : CONFIG.sprite.silhouetteYOffset);
    const pivX = cfg.pivotX ?? CONFIG.sprite.pivotX;
    const pivY = cfg.pivotY ?? (isPhoto ? CONFIG.sprite.photoPivotY : CONFIG.sprite.silhouettePivotY);
    const opacity = cfg.opacity ?? CONFIG.sprite.opacity;

    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, opacity,
    });
    // 仅对 SVG 兜底（单色头发）应用发色；真人照片保持原色
    if (!isPhoto) mat.color = new THREE.Color(colorToHex(style.color));

    const sp = new THREE.Sprite(mat);
    sp.center.set(pivX, pivY);     // 锚点：贴图以哪一点"贴"在头部位置（照片一般偏下，让头发落在头顶）
    sp.renderOrder = 10;
    this._spriteBaseScale = scale;
    this.spriteTex = tex;
    this.sprite = sp;

    this.spriteTune = new THREE.Group();
    this.spriteTune.add(sp);
    this.spriteGroup.add(this.spriteTune);

    this._applySpriteScale(tex);
  }

  /** 根据纹理尺寸 + 基准缩放，设置精灵的实际宽高（保持图片比例） */
  _applySpriteScale(tex) {
    if (!this.sprite) return;
    const img = tex && tex.image;
    const w = img?.width || 512, h = img?.height || 512;
    const aspect = w / h || 1;            // 宽/高
    const s = this._spriteBaseScale;
    this.sprite.scale.set(s, s / aspect, 1);
  }

  /** 加载精灵贴图：真人照片走 TextureLoader；无照片则用透明头发 SVG 光栅化 */
  async _spriteTexture(style) {
    if (style.imageUrl) {
      const loader = new THREE.TextureLoader();
      return await new Promise((res, rej) => {
        loader.load(style.imageUrl, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          t.generateMipmaps = false;
          res(t);
        }, undefined, rej);
      });
    }
    // 无照片：用透明、仅头发的 SVG（已把脸部挖空）光栅化成贴图
    const svg = hairOverlaySVG(style);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    const tex = await new Promise((res, rej) => {
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width || 512; c.height = img.height || 512;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.generateMipmaps = false;
        res(t);
      };
      img.onerror = () => rej(new Error('SVG 光栅化失败'));
      img.src = dataUrl;
    });
    return tex;
  }

  _clearSprite() {
    if (this.spriteTune) {
      this.spriteGroup.remove(this.spriteTune);
      this.spriteTune = null;
    }
    if (this.sprite) {
      if (this.sprite.material) this.sprite.material.dispose();
      this.sprite = null;
    }
    if (this.spriteTex) { this.spriteTex.dispose(); this.spriteTex = null; }
  }

  /** 对齐参考框：青色圆角矩形（贴图范围）+ 十字（中心）+ 粉色发际线，帮助把贴图对到头上 */
  _buildAlignHelper() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(34,211,238,0.9)';
    ctx.lineWidth = 6;
    const r = 22, m = 20, s = 256 - m * 2;
    ctx.beginPath();
    ctx.moveTo(m + r, m);
    ctx.arcTo(m + s, m, m + s, m + s, r);
    ctx.arcTo(m + s, m + s, m, m + s, r);
    ctx.arcTo(m, m + s, m, m, r);
    ctx.arcTo(m, m, m + s, m, r);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(128, 44); ctx.lineTo(128, 212);
    ctx.moveTo(44, 128); ctx.lineTo(212, 128);
    ctx.stroke();
    // 发际线：提示头发应落到的高度（贴图锚点上移一点，让发际线压在额头）
    ctx.strokeStyle = 'rgba(236,72,153,0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(64, 96); ctx.lineTo(192, 96);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(2.6, 2.6, 1);
    sp.center.set(0.5, 0.35);
    sp.renderOrder = 20;
    return sp;
  }

  /** 加载 .glb / .gltf 并归一化到"头宽 = 1"的坐标系
   *  兼容：未压缩 / DRACO 压缩（Meshy 等工具常导出 DRACO）模型；
   *        通过 modelRotX/Y/Z 修正来源不同的朝向；收集材质以便统一换色。
   */
  async _loadGLTF(style) {
    const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/loaders/DRACOLoader.js'),
    ]);

    const loader = new GLTFLoader();
    try {
      // DRACO 解码器走 jsDelivr 上的 three 官方副本，离线时静默跳过（仅影响压缩模型）
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
      loader.setDRACOLoader(draco);
    } catch (_) { /* 无 DRACO 也能加载未压缩模型 */ }

    const gltf = await loader.loadAsync(style.modelUrl);
    const root = gltf.scene;

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const targetWidth = style.modelWidth ?? 1.08;
    const s = (style.modelScale ?? 1) * (targetWidth / (size.x || 1));

    const wrap = new THREE.Group();
    root.position.sub(center);
    root.scale.setScalar(s);
    root.position.multiplyScalar(s);
    // 朝向修正：不同来源的模型朝向约定不同。约定 → +Y 头顶，+Z 面部前方。
    if (style.modelRotX) root.rotation.x = style.modelRotX;
    if (style.modelRotY) root.rotation.y = style.modelRotY;
    if (style.modelRotZ) root.rotation.z = style.modelRotZ;
    wrap.add(root);

    // 模型整体附加偏移（依旧以"头宽"为单位），再叠加用户实时滑块的 offset
    const off = style.modelOffset ?? { x: 0, y: 0.06, z: 0 };
    wrap.position.set(off.x || 0, off.y || 0, off.z || 0);

    // 收集材质，便于 setColor 统一换色；双面渲染避免法线朝内时穿帮
    const materials = [];
    const seen = new Set();
    wrap.traverse(o => {
      if (o.isMesh) {
        o.frustumCulled = false;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(m => {
          if (!m) return;
          m.side = THREE.DoubleSide;
          if (!seen.has(m)) { seen.add(m); m.userData.shade = 1; materials.push(m); }
        });
      }
    });
    wrap.userData.materials = materials;
    return wrap;
  }

  setColor(hex) {
    // 2D 精灵且为 SVG 兜底（单色头发）时，按发色染色；真人照片保持原色
    if (this._spriteActive && this.sprite && !this.spriteIsPhoto) {
      this.sprite.material.color.set(hex);
      return;
    }
    if (this.hairGroup) applyHairColor(this.hairGroup, hex);
  }

  /** 用户微调：dy/dz 单位为头宽，s 为整体缩放系数（UI 滑块用） */
  setAdjust({ y = 0, z = 0, scale = 1 }) {
    this.tune.position.set(0, y, z);
    this.tune.scale.setScalar(scale);
  }

  setOcclusion(on) { this.occluder.visible = on; }

  /* ---------------- 位姿求解 ---------------- */

  /**
   * @param {Array} lms   归一化关键点
   * @param {Float32Array|null} matrix MediaPipe 头部变换矩阵（列主序 16 元素）
   */
  updateFromFace(lms, matrix) {
    const vw = this.videoW, vh = this.videoH;
    const mirror = CONFIG.camera.mirror;
    const halfH = Math.tan(CONFIG.render.fovY * DEG / 2);
    const aspect = vw / vh;

    /* --- 1. 相机到人脸的距离 --- */
    let d = 0;
    if (matrix && matrix.length >= 16) {
      d = Math.abs(matrix[14]);   // 列主序：平移在索引 12,13,14，取 z 当深度
    }
    if (!(d > 1e-3)) {
      const dx = (lms[LM.cheekR].x - lms[LM.cheekL].x) * vw;
      const dy = (lms[LM.cheekR].y - lms[LM.cheekL].y) * vh;
      const wpx = Math.hypot(dx, dy) || 1;
      d = (15 * vh) / (2 * halfH * wpx);   // 兜底：假设真实头宽 ≈ 15（自洽即可）
    }

    const worldPerPx = (2 * d * halfH) / vh;

    /* --- 2. 关键点 → 世界坐标 --- */
    const P = (i) => {
      const l = lms[i];
      const nx = mirror ? (1 - l.x) : l.x;
      const X = (nx * 2 - 1) * d * halfH * aspect;
      const Y = (1 - l.y * 2) * d * halfH;
      const Z = -(d + l.z * vw * worldPerPx);
      return new THREE.Vector3(X, Y, Z);
    };

    /* --- 3. 姿态：多点平均 + 正交化 --- */
    const e1 = this._tmp.e1.set(0, 0, 0);
    for (const [a, b] of LM.symPairs) {
      const Pa = P(a), Pb = P(b);
      if (mirror) e1.add(Pa.sub(Pb)); else e1.add(Pb.sub(Pa));
    }
    e1.normalize();

    const e2 = this._tmp.e2.set(0, 0, 0);
    for (const [low, high] of LM.vertPairs) e2.add(P(high).sub(P(low)));
    e2.normalize();

    e2.addScaledVector(e1, -e1.dot(e2)).normalize();
    const e3 = this._tmp.e3.crossVectors(e1, e2).normalize();

    const basis = this._tmp.m.makeBasis(e1, e2, e3);
    const q = this._tmp.q.setFromRotationMatrix(basis);

    /* --- 4. 头宽与锚点 --- */
    const cl = P(LM.cheekL), cr = P(LM.cheekR);
    const headW = cl.distanceTo(cr) * CONFIG.headAnchor.widthGain;

    const anchorPos = cl.add(cr).multiplyScalar(0.5);              // 两颧骨中点
    anchorPos.addScaledVector(e2, CONFIG.headAnchor.up * headW);   // 上移
    anchorPos.addScaledVector(e3, -CONFIG.headAnchor.back * headW); // 后移 → 头骨中心

    /* --- 5. 平滑 --- */
    const S = CONFIG.smoothing;
    if (!this._inited) {
      this._pos.copy(anchorPos);
      this._quat.copy(q);
      this._scale = headW;
      this._inited = true;
    } else {
      this._pos.lerp(anchorPos, S.position);
      this._quat.slerp(q, S.rotation);
      this._scale += (headW - this._scale) * S.scale;
    }

    this.anchor.position.copy(this._pos);
    // 手动偏移（头宽单位 → 世界单位，随头部缩放）
    this.anchor.position.addScaledVector(this._tmp.off.copy(this.offset), this._scale);
    this.anchor.quaternion.copy(this._quat);
    this.anchor.scale.setScalar(this._scale);
    this.anchor.visible = true;
    this._lastSeen = performance.now();

    // 2D 精灵：只跟随"位置 + 缩放"，不继承旋转（billboard，侧脸仅平移）
    if (this._spriteActive && this.spriteGroup) {
      this.spriteGroup.position.copy(this.anchor.position);
      this.spriteGroup.scale.setScalar(this._scale);
      this.spriteGroup.visible = true;
      if (this.spriteTune) {
        this.spriteTune.position.set(
          this.offset.x + this.tune.position.x,
          this.offset.y + this.tune.position.y + this.spriteYOffset,
          this.offset.z + this.tune.position.z
        );
        this.spriteTune.scale.setScalar(this.tune.scale);
      }
    }

    this._applyVisibility();

    /* --- 6. 欧拉角，供"是否正对镜头"判断 --- */
    const euler = new THREE.Euler().setFromQuaternion(this._quat, 'YXZ');
    return {
      yawDeg: euler.y / DEG,
      pitchDeg: euler.x / DEG,
      rollDeg: euler.z / DEG,
      headWidth: headW,
      distance: d,
    };
  }

  /** 没检测到人脸：短暂延迟后隐藏，避免闪烁 */
  onFaceLost() {
    if (performance.now() - this._lastSeen > CONFIG.smoothing.lostDelayMs) {
      this.anchor.visible = false;
      this.spriteGroup.visible = false;
      this._inited = false;
      this._applyVisibility();
    }
  }

  render() {
    // 画布尺寸若被布局变化改变（例如首次拿到视频尺寸前为 0），自动校正
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width && (Math.abs(rect.width - this._cw) > 1 || Math.abs(rect.height - this._ch) > 1)) {
      this.resize();
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** 把调试接口挂到 window.AR，方便在控制台实时微调（见文件头注释） */
  installGlobalDebug() {
    const self = this;
    window.AR = {
      get scene() { return self.scene; },
      get camera() { return self.camera; },
      get renderer() { return self.renderer; },
      get anchor() { return self.anchor; },
      offset: self.offset,
      setOffset(x, y, z) {
        if (typeof x === 'object') self.offset.copy(x);
        else self.offset.set(x || 0, y || 0, z || 0);
        console.log('[AR] 偏移已设为', self.offset.toArray().map(n => +n.toFixed(4)));
      },
      setDebug(on) { self.setDebug(on); console.log('[AR] 调试标记 =', !!on); },
      setTest(on) { self.setTest(on); console.log('[AR] 测试模型 =', !!on); },
      setOcclusion(on) { self.setOcclusion(on); console.log('[AR] 头部遮挡 =', !!on); },
      info() {
        console.log('[AR] 状态：', {
          mode: self._spriteActive ? 'sprite(2D)' : '3d',
          anchorVisible: self.anchor.visible,
          spriteVisible: self.spriteGroup.visible,
          pos: self.anchor.position.toArray().map(n => +n.toFixed(2)),
          scale: +self._scale.toFixed(3),
          offset: self.offset.toArray().map(n => +n.toFixed(4)),
          spriteYOffset: +self.spriteYOffset.toFixed(3),
          test: self.testOn, debug: self.debugOn,
          hasHair: !!self.hairGroup, hasSprite: !!self.sprite,
        });
      },
    };
    return window.AR;
  }

  dispose() {
    disposeGroup(this.hairGroup);
    this.renderer.dispose();
  }
}
