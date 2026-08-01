/**
 * hairOverlay.js —— 纯 2D 发型图片叠加层
 *
 * 用 DOM <img> + CSS transform 把发型图片叠到摄像头视频上，
 * 跟随 MediaPipe 468 点实时定位头顶/额头位置。
 *
 * 比 Three.js Sprite 更轻量，更容易加视觉效果：
 *   · 边缘羽化（featherPx / CSS filter）
 *   · 混合模式（mix-blend-mode）
 *   · 透明度动画
 *   · 无需 WebGL 上下文
 *
 * 用法：
 *   const overlay = new HairOverlay(stageEl);
 *   await overlay.setStyle(style);        // 加载发型图片
 *   overlay.updateFromFace(lms, ...);     // 每帧调用
 *   overlay.setOffset(x, y, z);           // 滑块联动
 */

/* ---------- 默认配置（可用 style.sprite 覆盖） ---------- */
const DEFAULTS = Object.freeze({
  // 照片类（有 imageUrl 的真人参考图）
  photo: {
    scale: 2.6,          // 整体大小：相对头宽的倍数
    yOffset: -0.08,      // 竖向偏移（头宽单位）：负=上移，让发顶压在额头上
    pivotX: 0.5,         // 水平锚点
    pivotY: 0.32,        // 竖向锚点：照片顶部(头发)落在额头附近
    opacity: 1.0,
  },
  // SVG 兜底（无照片的程序化款）
  silhouette: {
    scale: 1.6,
    yOffset: 0.0,
    pivotX: 0.5,
    pivotY: 0.48,
    opacity: 1.0,
  },
});

/** MediaPipe 关键点索引（常用） */
const LM = {
  forehead: 10,       // 额头最上沿
  noseTip: 1,         // 鼻尖
  cheekL: 234,        // 左颧骨
  cheekR: 454,        // 右颧骨
  chin: 152,          // 下巴
};

export class HairOverlay {
  /**
   * @param {HTMLElement} stageEl - 舞台容器（.stage），overlay 会作为子元素插入
   */
  constructor(stageEl) {
    this.stage = stageEl;

    /* ---- DOM 结构 ---- */
    this.wrap = document.createElement('div');
    this.wrap.className = 'hair-overlay-wrap';
    this.wrap.innerHTML = '<img class="hair-overlay-img" crossorigin="anonymous" />';
    this.img = this.wrap.querySelector('img');
    stageEl.appendChild(this.wrap);

    /* ---- 状态 ---- */
    this.currentStyle = null;
    this.visible = false;
    this._loaded = false;

    /* ---- 用户微调（单位：头宽像素） ---- */
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;      // 缩放附加系数
    this.scaleMul = 1;     // 整体缩放（来自"整体大小"滑块）

    /* ---- 当前生效配置 ---- */
    this.cfg = { ...DEFAULTS.photo };

    /* ---- 平滑器（避免抖动） ---- */
    this._smooth = { x: 0, y: 0, w: 0, _init: false };
    const SMOOTH_POS = 0.38;
    const SMOOTH_SCALE = 0.28;
    this._alphaPos = SMOOTH_POS;
    this._alphaScale = SMOOTH_SCALE;

    /* ---- 初始样式 ---- */
    this._applyBaseStyles();
  }

  /* ====================== 公共 API ====================== */

  /**
   * 切换发型。
   * @param {Object} style - hairDatabase.json 单条（含 imageUrl / sprite / params 等）
   * @param {string} [svgDataUrl] - 可选：无图片时的 SVG data URL（透明头发轮廓）
   * @returns {Promise<HTMLImageElement>} 加载完成的 img 元素
   */
  async setStyle(style, svgDataUrl) {
    this.currentStyle = style;
    this._loaded = false;
    this.hide();

    const url = style.imageUrl;
    if (!url) {
      // 无图片 URL → 用传入的 SVG data URI（兜底）
      if (svgDataUrl) {
        await this._loadImg(svgDataUrl);
        this.cfg = { ...DEFAULTS.silhouette, ...(style.sprite || {}) };
      }
      return this.img;
    }

    // 有图片 URL → 正常加载
    try {
      await this._loadImg(url);
      const isPhoto = !!style.imageUrl;
      this.cfg = { ...(isPhoto ? DEFAULTS.photo : DEFAULTS.silhouette), ...(style.sprite || {}) };
    } catch (err) {
      console.warn('[HairOverlay] 图片加载失败:', err.message);
      // 回退到 SVG 兜底
      if (svgDataUrl) {
        await this._loadImg(svgDataUrl);
        this.cfg = { ...DEFAULTS.silhouette };
      }
    }
    return this.img;
  }

  /** 每帧调用：根据 MediaPipe 关键点更新位置/大小 */
  updateFromFace(landmarks, pose, videoW, videoH) {
    if (!this._loaded || !this.visible) return null;

    const rect = this.stage.getBoundingClientRect();
    const sw = rect.width || videoW;
    const sh = rect.height || videoH;

    /* --- 关键点 → 舞台像素坐标 --- */
    const ft = landmarks[LM.forehead];       // 额头上沿
    const cL = landmarks[LM.cheekL];
    const cR = landmarks[LM.cheekR];

    // 头宽（像素）
    const dx = (cR.x - cL.x) * sw;
    const dy = (cR.y - cL.y) * sh;
    const headW = Math.max(60, Math.hypot(dx, dy));

    // 额头位置（镜像后）
    let fx = ft.x * sw;
    let fy = ft.y * sh;
    // mirror（与 CONFIG.camera.mirror 保持一致）
    fx = sw - fx;

    /* --- 平滑 --- */
    if (!this._smooth._init) {
      this._smooth.x = fx;
      this._smooth.y = fy;
      this._smooth.w = headW;
      this._smooth._init = true;
    } else {
      this._smooth.x += (fx - this._smooth.x) * this._alphaPos;
      this._smooth.y += (fy - this._smooth.y) * this._alphaPos;
      this._smooth.w += (headW - this._smooth.w) * this._alphaScale;
    }
    const sx = this._smooth.x, sy = this._smooth.y, sW = this._smooth.w;

    /* --- 计算显示尺寸 --- */
    const imgW = this.img.naturalWidth || 512;
    const imgH = this.img.naturalHeight || 512;
    const aspect = imgW / Math.max(1, imgH);

    const baseSize = sW * this.cfg.scale * this.scaleMul * (1 + this.offsetZ * 0.5);
    const dW = Math.max(40, baseSize);
    const dH = dW / Math.max(0.3, aspect);

    /* --- 偏移（头宽单位 → 像素）--- */
    const ox = this.offsetX * sW;
    const oy = this.offsetY * sW;
    const yOff = this.cfg.yOffset * sW;

    /* --- 最终位置 --- */
    const left = sx + ox - dW * this.cfg.pivotX;
    const top = sy + oy + yOff - dH * this.cfg.pivotY;

    /* --- 应用 CSS transform --- */
    this.wrap.style.left = `${left}px`;
    this.wrap.style.top = `${top}px`;
    this.wrap.style.width = `${dW}px`;
    this.wrap.style.height = `${dH}px`;
    this.wrap.style.opacity = this.cfg.opacity;

    return { left, top, dW, dH, headW: sW, fx: sx, fy: sy };
  }

  /** 设置 X/Y/Z 偏移（单位：头宽） */
  setOffset(x = 0, y = 0, z = 0) {
    this.offsetX = x;
    this.offsetY = y;
    this.offsetZ = z;
  }

  /** 设置整体缩放系数 */
  setScale(s = 1) {
    this.scaleMul = s;
  }

  /** 设置不透明度 */
  setOpacity(opacity = 1) {
    this.cfg.opacity = Math.max(0, Math.min(1, opacity));
    if (this.wrap) this.wrap.style.opacity = this.cfg.opacity;
  }

  show() {
    this.visible = true;
    this.wrap.style.display = '';
  }

  hide() {
    this.visible = false;
    this.wrap.style.display = 'none';
  }

  /** 重置平滑器（切换人脸时调用） */
  resetSmooth() {
    this._smooth._init = false;
  }

  dispose() {
    this.wrap.remove();
  }

  /* ====================== 内部方法 ====================== */

  _applyBaseStyles() {
    Object.assign(this.wrap.style, {
      position: 'absolute',
      pointerEvents: 'none',
      zIndex: '10',
      display: 'none',       // 初始隐藏，setStyle 后显示
      overflow: 'hidden',
      transition: 'opacity 0.18s ease',
    });
    Object.assign(this.img.style, {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      display: 'block',
    });
  }

  _loadImg(src) {
    return new Promise((res, rej) => {
      this.img.onload = () => {
        this._loaded = true;
        this.show();
        res(this.img);
      };
      this.img.onerror = () => rej(new Error(`[HairOverlay] 图片加载失败: ${src}`));
      this.img.src = src;
    });
  }
}
