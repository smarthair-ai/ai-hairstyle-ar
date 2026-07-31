/**
 * faceTracker.js —— MediaPipe FaceLandmarker 封装
 *
 * 职责：
 *   1. 动态加载 tasks-vision 运行时与模型（优先本地、回退 CDN）
 *   2. 对 <video> 逐帧推理，输出 468 个面部关键点 + 头部变换矩阵
 *
 * 隐私：所有推理都在浏览器的 WASM / WebGL 里完成，视频帧不会离开本机。
 */

import { CONFIG } from './config.js';

export class FaceTracker {
  constructor() {
    this.landmarker = null;
    this.ready = false;
    this._lastTs = -1;
  }

  /** 加载运行时与模型。onProgress(text) 用于更新加载文案。 */
  async init(onProgress = () => {}) {
    onProgress('正在加载推理运行时…');

    // 动态 import：避免在用户未开启摄像头前就下载几 MB 的 wasm
    const vision = await import(/* @vite-ignore */ CONFIG.mediapipe.visionBundle);
    const { FilesetResolver, FaceLandmarker } = vision;

    const fileset = await FilesetResolver.forVisionTasks(CONFIG.mediapipe.wasmBase);

    onProgress('正在加载人脸关键点模型…');
    const modelUrl = await this._resolveModelUrl(onProgress);

    const baseOptions = { modelAssetPath: modelUrl, delegate: CONFIG.mediapipe.delegate };
    const options = {
      baseOptions,
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      // 输出 4x4 头部变换矩阵：本项目用它拿到稳定的"相机到人脸"距离
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options);
    } catch (err) {
      // GPU 代理不可用时降级到 CPU，保证兼容性
      console.warn('[FaceTracker] GPU 代理创建失败，回退 CPU：', err);
      options.baseOptions = { modelAssetPath: modelUrl, delegate: 'CPU' };
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options);
    }

    this.ready = true;
    return this;
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
   * @returns {{landmarks: Array, matrix: Float32Array|null}|null}
   */
  detect(video, timestampMs) {
    if (!this.ready || !this.landmarker) return null;
    // MediaPipe 要求时间戳严格递增
    const ts = timestampMs <= this._lastTs ? this._lastTs + 1 : timestampMs;
    this._lastTs = ts;

    let result;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      console.warn('[FaceTracker] 推理异常：', err);
      return null;
    }
    if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) return null;

    return {
      landmarks: result.faceLandmarks[0],
      matrix: result.facialTransformationMatrixes?.[0]?.data ?? null,
    };
  }

  dispose() {
    try { this.landmarker?.close(); } catch (_) {}
    this.landmarker = null;
    this.ready = false;
  }
}
