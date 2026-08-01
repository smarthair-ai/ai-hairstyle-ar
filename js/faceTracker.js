/**
 * faceTracker.js —— MediaPipe FaceLandmarker 封装
 *
 * 职责：
 *   1. 动态加载 tasks-vision 运行时与模型（优先本地、回退 CDN）
 *   2. 对 <video> 逐帧推理，输出 468 个面部关键点 + 头部变换矩阵
 *   3. 自我诊断：记录推理次数 / 命中次数 / 最近错误，供页面与控制台排查
 *   4. 自动降级：GPU 代理长时间检不到脸时，自动用 CPU 代理重建一次
 *
 * 隐私：所有推理都在浏览器的 WASM / WebGL 里完成，视频帧不会离开本机。
 */

import { CONFIG } from './config.js';

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.ready = false;
    this._lastTs = -1;

    /* ---- 诊断计数器（window.FD.stats() 可查看） ---- */
    this.stats = {
      delegate: null,        // 实际生效的推理后端 GPU / CPU
      modelUrl: null,        // 实际加载的模型地址
      attempts: 0,           // 调用 detectForVideo 的次数
      hits: 0,               // 检出人脸的次数
      misses: 0,             // 未检出的次数
      errors: 0,             // 推理抛异常的次数
      lastError: null,       // 最近一次错误信息
      lastFaceCount: 0,      // 最近一帧检出的人脸数
      skippedNoSize: 0,      // 因视频尺寸为 0 被跳过的帧数
      lastHitAt: 0,          // 最近一次检出人脸的时间戳
      firstAttemptAt: 0,
      fallbackDone: false,   // 是否已执行过 GPU→CPU 降级
    };

    this._fileset = null;    // 缓存 FilesetResolver，降级重建时复用
    this._visionNs = null;   // 缓存 tasks-vision 命名空间
    this._rebuilding = false;
  }

  /** 加载运行时与模型。onProgress(text) 用于更新加载文案。 */
  async init(onProgress = () => {}) {
    onProgress('正在加载推理运行时…');

    // 动态 import：避免在用户未开启摄像头前就下载几 MB 的 wasm
    const vision = await import(/* @vite-ignore */ CONFIG.mediapipe.visionBundle);
    const { FilesetResolver, FaceLandmarker } = vision;
    this._visionNs = vision;

    const fileset = await FilesetResolver.forVisionTasks(CONFIG.mediapipe.wasmBase);
    this._fileset = fileset;

    onProgress('正在加载人脸关键点模型…');
    const modelUrl = await this._resolveModelUrl(onProgress);
    this.stats.modelUrl = modelUrl;

    const options = this._buildOptions(modelUrl, CONFIG.mediapipe.delegate);

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options);
      this.stats.delegate = CONFIG.mediapipe.delegate;
    } catch (err) {
      // GPU 代理不可用时降级到 CPU，保证兼容性
      console.warn('[FaceTracker] GPU 代理创建失败，回退 CPU：', err);
      const cpuOpts = this._buildOptions(modelUrl, 'CPU');
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, cpuOpts);
      this.stats.delegate = 'CPU';
      this.stats.fallbackDone = true;
    }

    console.info(
      `[FaceTracker] 初始化完成 · 后端=${this.stats.delegate} · ` +
      `runningMode=${CONFIG.detect.runningMode} · numFaces=${CONFIG.detect.numFaces} · ` +
      `minConf=${CONFIG.detect.minFaceDetectionConfidence}`
    );

    this.ready = true;
    return this;
  }

  /** 组装 FaceLandmarker 参数（集中读 CONFIG.detect，方便统一调参） */
  _buildOptions(modelUrl, delegate) {
    const d = CONFIG.detect;
    return {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: d.runningMode,                 // 必须是 'VIDEO'
      numFaces: d.numFaces,
      outputFaceBlendshapes: false,
      // 输出 4x4 头部变换矩阵：本项目用它拿到稳定的"相机到人脸"距离
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: d.minFaceDetectionConfidence,
      minFacePresenceConfidence: d.minFacePresenceConfidence,
      minTrackingConfidence: d.minTrackingConfidence,
    };
  }

  /**
   * 解析模型地址：本地优先，失败再依次探测远程候选源。
   * 顺序：localModelUrl → modelCandidates[]。第一个可用的地址即被采用。
   * 全部失败则抛出带明细的错误，由上层（main.js）展示给用户。
   * @param {(text:string)=>void} onProgress 加载进度回调
   */
  async _resolveModelUrl(onProgress = () => {}) {
    const sources = [
      { label: '本地', url: CONFIG.mediapipe.localModelUrl },
      ...CONFIG.mediapipe.modelCandidates.map((url, i) => ({ label: `远程候选#${i + 1}`, url })),
    ];

    const tried = [];
    for (const { label, url } of sources) {
      onProgress(`正在探测${label}模型源…`);
      const ok = await this._checkUrl(url);
      tried.push({ label, url, ok });
      if (ok) {
        console.info(`[FaceTracker] 使用${label}模型：`, url);
        return url;
      }
      console.warn(`[FaceTracker] ${label}模型源不可用，跳过：`, url);
    }

    const detail = tried.map(t => `  · ${t.label}: ${t.url}（${t.ok ? 'OK' : '不可用'}）`).join('\n');
    throw new Error(
      '所有模型源都不可用，无法加载人脸检测模型。\n已尝试：\n' + detail +
      '\n\n解决方式（任选其一）：\n' +
      '  1) 运行一键下载脚本把模型放到本地（推荐，完全离线）：\n' +
      '     node tools/download_model.mjs\n' +
      '  2) 手动把 face_landmarker.task 放到 assets/models/ 目录后刷新\n' +
      '  3) 在 js/config.js 的 modelCandidates 数组最前面加入你可达的镜像地址'
    );
  }

  /**
   * 探测某个 URL 是否指向一个真实模型文件（而非 404 页面 / index.html）。
   * 先发 HEAD，不支持 HEAD 的源再退化为 Range GET 取首字节验证。
   */
  async _checkUrl(url) {
    const isReal = (res) => {
      if (!res) return false;
      const status = res.status;
      if (status !== 200 && status !== 206) return false;
      const type = res.headers.get('content-type') || '';
      // 排除“404 返回 index.html”的静态服务器
      return !type.includes('text/html');
    };

    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (isReal(head)) return true;
    } catch (_) { /* 走下面的兜底探测 */ }

    try {
      const range = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      if (isReal(range)) return true;
    } catch (_) { /* 源不可用 */ }

    return false;
  }

  /**
   * 对当前视频帧推理。
   * @param {HTMLVideoElement} video
   * @param {number} timestampMs performance.now()
   * @returns {{landmarks: Array, matrix: Float32Array|null, faceCount: number}|null}
   */
  detect(video, timestampMs) {
    if (!this.ready || !this.landmarker) return null;

    // 视频尺寸为 0（摄像头还没吐出第一帧）时推理必定失败，直接跳过
    if (CONFIG.detect.requireVideoSize && (!video.videoWidth || !video.videoHeight)) {
      this.stats.skippedNoSize++;
      return null;
    }

    // MediaPipe 要求时间戳严格递增
    const ts = timestampMs <= this._lastTs ? this._lastTs + 1 : timestampMs;
    this._lastTs = ts;

    this.stats.attempts++;
    if (!this.stats.firstAttemptAt) this.stats.firstAttemptAt = performance.now();

    let result;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = String(err?.message || err);
      // 只在前几次打印，避免刷屏
      if (this.stats.errors <= 3) console.warn('[FaceTracker] 推理异常：', err);
      return null;
    }

    const faces = result?.faceLandmarks || [];
    this.stats.lastFaceCount = faces.length;

    if (faces.length === 0) {
      this.stats.misses++;
      this._maybeAutoFallback();
      return null;
    }

    // numFaces > 1 时选“最大的那张脸”（离镜头最近，通常就是用户本人）
    let idx = 0;
    if (faces.length > 1) {
      let best = -1;
      for (let i = 0; i < faces.length; i++) {
        const s = this._faceSpan(faces[i]);
        if (s > best) { best = s; idx = i; }
      }
    }

    this.stats.hits++;
    this.stats.lastHitAt = performance.now();

    return {
      landmarks: faces[idx],
      matrix: result.facialTransformationMatrixes?.[idx]?.data ?? null,
      faceCount: faces.length,
    };
  }

  /** 用 234↔454（两侧颧骨）的归一化距离衡量脸的大小 */
  _faceSpan(lms) {
    const a = lms[234], b = lms[454];
    if (!a || !b) return 0;
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /**
   * 降级方案：GPU 后端在某些驱动上会“静默返回 0 张脸”（不报错但永远检不到）。
   * 连续 autoFallbackAfterMs 毫秒没检出人脸就自动用 CPU 后端重建一次。
   */
  _maybeAutoFallback() {
    const s = this.stats;
    if (s.fallbackDone || this._rebuilding) return;
    if (s.hits > 0) return;                       // 曾经成功过就不是后端问题
    if (!s.firstAttemptAt) return;

    const elapsed = performance.now() - s.firstAttemptAt;
    if (elapsed < CONFIG.detect.autoFallbackAfterMs) return;

    s.fallbackDone = true;
    this._rebuilding = true;
    console.warn(
      `[FaceTracker] GPU 后端 ${Math.round(elapsed)}ms 内一张脸都没检出，` +
      '自动降级到 CPU 后端重建…'
    );
    this._rebuildWith('CPU')
      .then(() => console.info('[FaceTracker] 已切换到 CPU 后端'))
      .catch(e => console.error('[FaceTracker] CPU 降级失败：', e))
      .finally(() => { this._rebuilding = false; });
  }

  /** 用指定后端重建 landmarker（保留已解析的模型地址与 fileset） */
  async _rebuildWith(delegate) {
    if (!this._fileset || !this._visionNs || !this.stats.modelUrl) return;
    const { FaceLandmarker } = this._visionNs;
    const opts = this._buildOptions(this.stats.modelUrl, delegate);
    const next = await FaceLandmarker.createFromOptions(this._fileset, opts);
    try { this.landmarker?.close(); } catch (_) {}
    this.landmarker = next;
    this.stats.delegate = delegate;
    this._lastTs = -1;
    this.stats.firstAttemptAt = performance.now();
  }

  /** 手动切换后端（控制台可用：FD.useBackend('CPU')） */
  async useBackend(delegate = 'CPU') {
    this._rebuilding = true;
    try { await this._rebuildWith(delegate); }
    finally { this._rebuilding = false; }
    return this.stats.delegate;
  }

  /** 运行时改检测参数并重建（控制台可用：FD.setConfidence(0.2)） */
  async setConfidence(v = 0.3) {
    CONFIG.detect.minFaceDetectionConfidence = v;
    CONFIG.detect.minFacePresenceConfidence = v;
    CONFIG.detect.minTrackingConfidence = v;
    await this._rebuildWith(this.stats.delegate || 'CPU');
    return v;
  }

  dispose() {
    try { this.landmarker?.close(); } catch (_) {}
    this.landmarker = null;
    this.ready = false;
  }
}
