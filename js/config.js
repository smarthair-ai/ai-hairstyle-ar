/**
 * config.js —— 全局可调参数
 * 所有"魔法数字"集中在这里，方便你后续调整效果。
 */

export const CONFIG = {

  /* ---------- MediaPipe 人脸关键点检测 ---------- */
  mediapipe: {
    // tasks-vision 的 ESM 入口（0.10.x，jsDelivr 在国内一般可访问）
    visionBundle: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    // WASM 运行时目录（jsDelivr）
    wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',

    // ① 本地模型：优先使用，可完全离线。把 face_landmarker.task 放进 assets/models/ 即可。
    localModelUrl: './assets/models/face_landmarker.task',

    // ② 远程候选源：按数组顺序逐个探测，第一个可用的就被采用。
    //
    // ⚠️ 重要事实（已实测核实）：face_landmarker.task 模型【不在】任何 npm 包内，
    //    官方只发布在 Google Cloud Storage（国内常被墙）。所以下面这些"镜像"大多会 404，
    //    真正能在国内稳定兜底的只有"本地文件"(见 ①)。
    //    如果你找到了可访问的镜像地址，直接把它加到这个数组【最前面】就会自动生效。
    modelCandidates: [
      // 社区常提的 jsDelivr 路径 —— 实测 404（该 npm 包的 wasm/ 目录只有 4 个 WASM 文件，不含 .task），会自动跳过
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm/face_landmarker.task',
      // 官方源（国内常被墙，但企业网络 / 代理可能可达）
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    ],

    // GPU 推理更快；某些老显卡/驱动异常时会自动降级到 CPU
    delegate: 'GPU',
  },

  /* ---------- 摄像头 ---------- */
  camera: {
    width: 1280,
    height: 720,
    facingMode: 'user',
    mirror: true,     // 画面镜像（照镜子效果）。若改为 false，CSS 里的 transform 也要同步去掉
    deviceId: '',     // 留空=系统默认；也可在页面下拉里选择具体摄像头
  },

  /* ---------- 渲染 ---------- */
  render: {
    fovY: 50,             // 虚拟相机垂直视场角（度）。位姿求解与它自洽，可自由调整
    maxPixelRatio: 1.75,  // 限制 DPR，避免 4K 屏上过度绘制
    ecoPixelRatio: 1.0,   // 省电模式下的 DPR
    mode: 'sprite',       // 发型呈现方式：'sprite'(2D 图片精灵，默认) | '3d'(真实/程序化 3D 模型)
  },

  /* ---------- 2D 精灵（Sprite）参数 ----------
   * 单位均为"头宽"：1 = 一个头骨宽度。精灵挂在 spriteGroup 下，
   * spriteGroup 的缩放 = 实际头宽，所以下面的 scale 直接以头宽为基准。
   * 照片类（真人参考图）通常更"满"，需要更大 scale + 更偏下的锚点；
   * SVG 兜底（仅头发、透明）按头形轮廓，更接近真实头宽。 */
  sprite: {
    pivotX: 0.5,                 // 贴图锚点水平位置（0=左,1=右）
    // —— 真人照片（imageUrl）——
    photoScale: 2.6,             // 整体缩放：让照片里的头 ≈ 用户头宽
    photoYOffset: 0.55,          // 相对头骨中心上移（让发顶压在头顶）
    photoPivotY: 0.34,           // 锚点竖向（0=图底,1=图顶）：取中下偏上，照片顶部(头发)落在头顶上方
    // —— SVG 兜底（无照片）——
    silhouetteScale: 1.5,        // 透明头发轮廓的缩放
    silhouetteYOffset: 0.12,
    silhouettePivotY: 0.5,       // 头形轮廓已基本居中，锚点取中
    opacity: 1.0,                // 整体不透明度（0~1）
  },

  /* ---------- 时序平滑（越小越稳、越大越跟手） ---------- */
  smoothing: {
    position: 0.42,
    rotation: 0.45,
    scale: 0.25,
    lostDelayMs: 320,     // 丢失人脸多久后隐藏发型
  },

  /* ---------- 头部锚点标定（单位：头宽） ---------- */
  // 以两侧颧骨中点为原点，向上/向后偏移得到"头骨中心"
  headAnchor: {
    up: 0.30,
    back: 0.16,
    widthGain: 1.02,      // 关键点 234↔454 的距离 → 头宽的换算系数
  },

  /* ---------- 脸型分析 ---------- */
  analysis: {
    sampleEvery: 3,       // 每 N 帧采样一次
    emaAlpha: 0.12,       // 指标指数平滑系数
    minSamples: 20,       // 至少累积多少次采样才输出结论
    maxYawDeg: 18,        // 偏航角超过此值认为"没正对镜头"，跳过采样
    maxPitchDeg: 20,
  },

  /* ---------- 性能 ---------- */
  perf: {
    ecoDetectInterval: 2, // 省电模式：每 N 帧才推理一次（中间帧沿用上一次位姿并继续平滑）
  },
};

/** 可选发色 */
export const HAIR_COLORS = [
  { name: '自然黑',   hex: 0x1c1a1f },
  { name: '深棕',     hex: 0x3b2519 },
  { name: '栗棕',     hex: 0x6b3c22 },
  { name: '亚麻棕',   hex: 0x8d6236 },
  { name: '奶茶金',   hex: 0xb8895a },
  { name: '浅金',     hex: 0xd9b370 },
  { name: '玫瑰粉',   hex: 0xc76a8a },
  { name: '雾霾蓝',   hex: 0x4a5f8a },
  { name: '青灰',     hex: 0x6f7a80 },
  { name: '酒红',     hex: 0x7a1f2b },
];
