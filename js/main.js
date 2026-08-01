/**
 * main.js —— 应用主流程
 *
 * 摄像头 → MediaPipe 关键点 → 脸型分析 / 发型推荐 → Three.js AR 渲染
 * 整条链路全部跑在浏览器里，没有任何网络上传。
 */

import { CONFIG, HAIR_COLORS } from './config.js';
import { FaceTracker } from './faceTracker.js';
import { measure, classify, ShapeAccumulator, LM } from './faceShape.js';
import { recommend, getStyle, loadHairDB } from './hairDB.js';
import { ARScene } from './arScene.js';
import * as UI from './ui.js';

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */
const state = {
  running: false,
  stream: null,
  tracker: null,
  ar: null,
  cameraDeviceId: '',   // 用户在下拉里选的具体摄像头；空=系统默认
  cameraList: [],       // 已枚举到的摄像头输入设备
  acc: new ShapeAccumulator(CONFIG.analysis.emaAlpha, CONFIG.analysis.minSamples),

  shapeKey: 'oval',      // 当前判定脸型
  shapeResult: null,
  filter: 'all',
  styleId: 'bob',
  colorHex: HAIR_COLORS[0].hex,
  userPicked: false,     // 用户是否手动选过发型（选过就不再自动切换）

  frame: 0,
  lastPose: null,
  showMesh: false,
  eco: false,

  fps: { last: performance.now(), frames: 0, value: 0 },
};

const video = UI.el('video');
const arCanvas = UI.el('arCanvas');
const overlay = UI.el('overlayCanvas');
const octx = overlay.getContext('2d');

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */
function initUI() {
  // 分类筛选
  UI.el('filterSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    UI.el('filterSeg').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    refreshStyleList();
  });

  // 微调滑块（头部整体对齐：上下/前后/大小）
  ['tuneY', 'tuneZ', 'tuneS'].forEach(id => {
    UI.el(id).addEventListener('input', onTuneChange);
  });

  // 发型位置偏移滑块（X/Y/Z，单位：头宽）—— 真实 3D 模型的手动精调
  ['offsetX', 'offsetY', 'offsetZ'].forEach(id => {
    UI.el(id).addEventListener('input', onOffsetChange);
  });

  UI.el('resetTuneBtn').addEventListener('click', () => {
    UI.el('tuneY').value = 0; UI.el('tuneZ').value = 0; UI.el('tuneS').value = 1;
    UI.el('offsetX').value = 0; UI.el('offsetY').value = 0; UI.el('offsetZ').value = 0;
    onTuneChange();
    onOffsetChange();
  });
  onTuneChange();
  onOffsetChange();

  // 按钮
  UI.el('startBtn').addEventListener('click', start);
  UI.el('retryBtn').addEventListener('click', () => start());   // 重试：直接重新申请摄像头

  // 图片参考大图弹窗的关闭交互
  UI.el('hairImgClose').addEventListener('click', UI.hideHairImage);
  UI.el('hairImgModal').addEventListener('click', (e) => {
    if (e.target === UI.el('hairImgModal')) UI.hideHairImage();
  });
  UI.el('camSelect').addEventListener('change', async (e) => {
    state.cameraDeviceId = e.target.value;
    stop();           // 先停当前流
    await start();    // 用新设备重新开启（模型已加载会复用，不重复下载）
  });
  UI.el('toggleCamBtn').addEventListener('click', () => state.running ? stop() : start());
  UI.el('snapBtn').addEventListener('click', snapshot);

  UI.el('meshChk').addEventListener('change', e => {
    state.showMesh = e.target.checked;
    if (!state.showMesh) octx.clearRect(0, 0, overlay.width, overlay.height);
  });
  UI.el('occChk').addEventListener('change', e => state.ar?.setOcclusion(e.target.checked));
  UI.el('ecoChk').addEventListener('change', e => {
    state.eco = e.target.checked;
    state.ar?.setEco(state.eco);
  });
  // 调试：3D 对齐标记 + 占位测试模型（也可用控制台 window.AR）
  UI.el('debugChk').addEventListener('change', e => state.ar?.setDebug(e.target.checked));
  UI.el('testChk').addEventListener('change', e => state.ar?.setTest(e.target.checked));

  window.addEventListener('resize', () => state.ar?.resize());

  // 先渲染一份（用内置兜底），再异步加载 hairDatabase.json 后刷新
  rerenderSwatches();
  refreshStyleList();

  loadHairDB().then(() => {
    refreshStyleList();
    // 若已开启过摄像头，让当前所选发型按新数据刷新
    if (state.ar) state.ar.setStyle(getStyle(state.styleId), state.colorHex);
  });
}

function rerenderSwatches() {
  UI.renderSwatches(state.colorHex, (hex) => {
    state.colorHex = hex;
    state.ar?.setColor(hex);
    rerenderSwatches();
  });
}

function onTuneChange() {
  const y = parseFloat(UI.el('tuneY').value);
  const z = parseFloat(UI.el('tuneZ').value);
  const s = parseFloat(UI.el('tuneS').value);
  document.querySelector('[data-for=tuneY]').textContent = y.toFixed(2);
  document.querySelector('[data-for=tuneZ]').textContent = z.toFixed(2);
  document.querySelector('[data-for=tuneS]').textContent = s.toFixed(2);
  state.ar?.setAdjust({ y, z, scale: s });
}

/** 发型位置偏移（X/Y/Z，单位：头宽）—— 真实 3D 模型对齐用 */
function onOffsetChange() {
  const x = parseFloat(UI.el('offsetX').value);
  const y = parseFloat(UI.el('offsetY').value);
  const z = parseFloat(UI.el('offsetZ').value);
  document.querySelector('[data-for=offsetX]').textContent = x.toFixed(2);
  document.querySelector('[data-for=offsetY]').textContent = y.toFixed(2);
  document.querySelector('[data-for=offsetZ]').textContent = z.toFixed(2);
  state.ar?.setOffset(x, y, z);
}

/** 按当前脸型 + 筛选条件刷新发型卡片 */
function refreshStyleList() {
  const list = recommend(state.shapeKey, state.filter);
  UI.renderStyleGrid(list, state.styleId, pickStyle);
}

async function pickStyle(id, byUser = true) {
  if (byUser) state.userPicked = true;
  state.styleId = id;
  refreshStyleList();
  const style = getStyle(id);
  // 统一交由 ARScene 呈现：sprite 模式加载图片精灵；3d 模式加载模型。
  // 推荐逻辑（recommend + 脸型筛选）完全不变，这里只负责"把选中发型画出来"。
  if (state.ar) await state.ar.setStyle(style, state.colorHex);
}

/* ------------------------------------------------------------------ */
/* 摄像头启停                                                          */
/* ------------------------------------------------------------------ */
async function start() {
  if (state.running) return;
  UI.showCover('loadingCover', '正在请求摄像头权限…');

  // 0) 安全上下文 / 能力前置检查
  if (!navigator.mediaDevices?.getUserMedia) {
    const diag = cameraDiagnostic();
    UI.showCover('errorCover',
      '当前环境无法访问摄像头：' + diag.reason + '（必须通过 http://localhost 或 https 打开，不能双击 HTML 用 file:// 访问）');
    renderDiag(diag);
    return;
  }

  // 1) 摄像头（带约束降级 + 可选指定设备）
  try {
    state.stream = await openCamera(state.cameraDeviceId);
  } catch (err) {
    console.error('[摄像头]', err);
    const diag = cameraDiagnostic();
    UI.showCover('errorCover', humanizeCameraError(err));
    renderDiag(diag);
    return;
  }

  video.srcObject = state.stream;
  await new Promise((res) => {
    if (video.readyState >= 2) return res();
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    video.onloadedmetadata = fin;
    setTimeout(fin, 3000);   // 兜底：极端情况下 metadata 不触发也不卡死 start
  });
  await video.play().catch(() => {});

  // 授权后 enumerateDevices 才能拿到真实设备名，填充下拉供切换
  await refreshCameraList();

  const vw = video.videoWidth || CONFIG.camera.width;
  const vh = video.videoHeight || CONFIG.camera.height;

  // 让舞台的宽高比与摄像头一致 → object-fit:cover 不会裁切，AR 才能严格对齐
  UI.el('stage').style.aspectRatio = `${vw} / ${vh}`;
  overlay.width = vw; overlay.height = vh;

  // 2) Three.js 场景
  if (!state.ar) {
    state.ar = new ARScene(arCanvas);
    state.ar.setOcclusion(UI.el('occChk').checked);
    state.ar.setEco(state.eco);
    state.ar.installGlobalDebug();   // 暴露 window.AR，便于控制台实时微调/调试
    state.ar.setDebug(UI.el('debugChk').checked);
    state.ar.setTest(UI.el('testChk').checked);
    onTuneChange();
  }
  state.ar.setVideoSize(vw, vh);
  await state.ar.setStyle(getStyle(state.styleId), state.colorHex);

  // 3) 人脸检测模型
  if (!state.tracker) {
    try {
      state.tracker = await new FaceTracker().init(txt => UI.showCover('loadingCover', txt));
    } catch (err) {
      console.error('[人脸检测模型加载失败]', err);
      UI.el('errorText').innerHTML = String(err?.message || err)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/\n/g, '<br>');
      UI.showCover('errorCover');
      return;
    }
  }

  UI.showCover(null);
  UI.setHud('正在寻找人脸…');
  UI.el('toggleCamBtn').textContent = '关闭摄像头';
  UI.el('toggleCamBtn').disabled = false;
  UI.el('snapBtn').disabled = false;

  state.acc.reset();
  state.running = true;
  state.frame = 0;
  requestAnimationFrame(loop);
}

function stop() {
  state.running = false;
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
  video.srcObject = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (state.ar) { state.ar.anchor.visible = false; state.ar.render(); }
  UI.hideHud();
  UI.showCover('stageCover');
  UI.el('toggleCamBtn').textContent = '开启摄像头';
  UI.el('snapBtn').disabled = true;
}

function humanizeCameraError(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError')
    return '摄像头权限被拒绝。请点击地址栏左侧的图标允许摄像头访问后重试。注意：必须通过 http://localhost 或 https 打开页面。';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError')
    return '没有找到可用的摄像头设备。';
  if (n === 'NotReadableError')
    return '摄像头被其它程序占用（比如会议软件），请关闭后重试。';
  if (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError')
    return '所选摄像头不满足请求参数（已尝试降级仍失败），请换其它摄像头或检查设备。';
  return err?.message || '摄像头启动失败。';
}

/* ------------------------------------------------------------------ */
/* 摄像头打开 / 设备枚举 / 环境诊断                                     */
/* ------------------------------------------------------------------ */

/**
 * 打开摄像头：带三层约束降级，最大化兼容性。
 *  - 指定了 deviceId 时先用 exact 约束锁定该设备；
 *  - 失败则退到"理想分辨率 + 理想朝向"的普通约束；
 *  - 再失败则退到裸 { video: true }（任何可用摄像头均可）。
 * facingMode 用 ideal 而非强制，避免某些设备因不满足而 OverconstrainedError。
 */
async function openCamera(deviceId) {
  const make = (extra = {}) => ({
    audio: false,
    video: {
      width: { ideal: CONFIG.camera.width },
      height: { ideal: CONFIG.camera.height },
      facingMode: { ideal: CONFIG.camera.facingMode },
      ...extra,
    },
  });
  const tries = [];
  if (deviceId) tries.push(make({ deviceId: { exact: deviceId } }));
  tries.push(make());
  tries.push({ audio: false, video: true });

  for (const constraints of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn('[摄像头] 约束失败，自动降级重试：', e?.name || e);
    }
  }
  throw new Error('所有摄像头约束都失败了，可能是没有可用设备或被其它程序占用。');
}

/** 授权成功后枚举摄像头，填充页面下拉框 */
async function refreshCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.cameraList = devices.filter(d => d.kind === 'videoinput');
    UI.renderCameraList(state.cameraList, state.cameraDeviceId);
  } catch (_) { /* 不影响主流程 */ }
}

/** 收集环境信息，帮助用户自查打不开的原因 */
function cameraDiagnostic() {
  const secure = window.isSecureContext === true;
  const hasMd = !!navigator.mediaDevices?.getUserMedia;
  let reason = '请检查：① 浏览器是否允许摄像头权限；② 摄像头是否被会议/其它软件占用；③ 是否插好。';
  if (!secure) reason = '页面不是安全上下文——必须用 http://localhost 或 https 打开，不能双击 HTML 用 file:// 访问。';
  else if (!hasMd) reason = '浏览器未暴露 mediaDevices API（过旧或非安全上下文）。';
  return {
    reason,
    protocol: location.protocol,
    secureContext: secure,
    hasMediaDevices: hasMd,
    deviceCount: state.cameraList?.length ?? 0,
    ua: navigator.userAgent,
  };
}

/** 把诊断信息写到错误页的 <pre> 里 */
function renderDiag(diag) {
  const box = UI.el('diagText');
  if (!box) return;
  box.textContent =
    `当前地址： ${location.href}\n` +
    `协议：      ${diag.protocol}\n` +
    `安全上下文：${diag.secureContext ? '是（localhost / https）' : '否（摄像头被禁用）'}\n` +
    `mediaDevices：${diag.hasMediaDevices ? '可用' : '不可用'}\n` +
    `检测到摄像头：${diag.deviceCount} 个\n` +
    `浏览器：    ${diag.ua}`;
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */
function loop(now) {
  if (!state.running) return;
  requestAnimationFrame(loop);

  if (video.readyState < 2) return;
  state.frame++;

  // 省电模式下跳帧推理，中间帧继续用上一次的位姿（平滑器会补足过渡）
  const doDetect = !state.eco || (state.frame % CONFIG.perf.ecoDetectInterval === 0);

  if (doDetect) {
    const res = state.tracker?.detect(video, now);
    if (res) {
      state.lastPose = state.ar.updateFromFace(res.landmarks, res.matrix);
      handleAnalysis(res.landmarks);
      if (state.showMesh) drawLandmarks(res.landmarks);
      else if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
      // 正面/侧脸 提示：根据偏航角更新角标（侧脸时 2D 贴图会有偏差）
      if (state.lastPose) UI.setFaceMode(state.lastPose.yawDeg);
    } else {
      state.ar.onFaceLost();
      UI.setHud('没有检测到人脸，请正对摄像头');
      UI.setFaceMode(null);          // 丢失人脸：隐藏正/侧脸角标
      if (octx) octx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  state.ar.render();
  tickFps(now);
}

function tickFps(now) {
  const f = state.fps;
  f.frames++;
  if (now - f.last >= 500) {
    f.value = Math.round((f.frames * 1000) / (now - f.last));
    f.frames = 0; f.last = now;
    UI.el('fpsBadge').textContent = `${f.value} FPS`;
  }
}

/* ------------------------------------------------------------------ */
/* 脸型分析节流与结论更新                                               */
/* ------------------------------------------------------------------ */
function handleAnalysis(lms) {
  const pose = state.lastPose;
  const frontal = pose &&
    Math.abs(pose.yawDeg) <= CONFIG.analysis.maxYawDeg &&
    Math.abs(pose.pitchDeg) <= CONFIG.analysis.maxPitchDeg;

  if (!frontal) {
    UI.setHud('请正对镜头，以便更准确地分析脸型');
    return;
  }

  if (state.frame % CONFIG.analysis.sampleEvery === 0) {
    const m = measure(lms, video.videoWidth, video.videoHeight);
    state.acc.push(m);
  }

  if (!state.acc.stable) {
    const p = Math.min(99, Math.round(state.acc.count / state.acc.minSamples * 100));
    UI.setHud(`正在分析脸型… ${p}%`);
    return;
  }

  // 每 ~0.5s 更新一次结论，避免频繁重排 DOM
  if (state.frame % 15 !== 0) return;

  const m = state.acc.metrics;
  const result = classify(m);
  state.shapeResult = result;
  UI.renderShapeCard(result, m);
  UI.setHud(`识别结果：${result.ranked[0].name}`, true);

  if (result.best !== state.shapeKey) {
    state.shapeKey = result.best;
    const list = recommend(state.shapeKey, state.filter);
    // 用户没手动选过 → 自动切到匹配度最高的发型
    if (!state.userPicked && list.length && list[0].id !== state.styleId) {
      pickStyle(list[0].id, false);
    } else {
      refreshStyleList();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 关键点可视化                                                        */
/* ------------------------------------------------------------------ */
function drawLandmarks(lms) {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  octx.save();
  if (CONFIG.camera.mirror) { octx.translate(w, 0); octx.scale(-1, 1); }

  // 468 个点
  octx.fillStyle = 'rgba(124,92,247,0.55)';
  for (let i = 0; i < lms.length; i++) {
    const p = lms[i];
    octx.fillRect(p.x * w - 1, p.y * h - 1, 2, 2);
  }

  // 参与脸型计算的测量线
  const line = (a, b, color) => {
    octx.strokeStyle = color; octx.lineWidth = 2.5; octx.beginPath();
    octx.moveTo(lms[a].x * w, lms[a].y * h);
    octx.lineTo(lms[b].x * w, lms[b].y * h);
    octx.stroke();
  };
  line(LM.foreheadL, LM.foreheadR, 'rgba(236,72,153,.95)');
  line(LM.cheekL, LM.cheekR, 'rgba(56,189,248,.95)');
  line(LM.jawL, LM.jawR, 'rgba(250,204,21,.95)');
  line(LM.top, LM.chin, 'rgba(34,197,94,.95)');

  octx.restore();
}

/* ------------------------------------------------------------------ */
/* 拍照                                                                */
/* ------------------------------------------------------------------ */
function snapshot() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // 1) 视频（镜像）
  ctx.save();
  if (CONFIG.camera.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();

  // 2) 立刻重绘一次 3D 层再取图，避免读到已被清空的缓冲
  state.ar.render();
  ctx.drawImage(arCanvas, 0, 0, w, h);

  // 3) 水印
  const style = getStyle(state.styleId);
  const shape = state.shapeResult ? state.shapeResult.ranked[0].name : '未识别';
  ctx.font = `${Math.round(h * 0.030)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  const text = `${shape} · ${style.name}`;
  const tw = ctx.measureText(text).width;
  const pad = Math.round(h * 0.018);
  ctx.fillRect(pad, h - pad - Math.round(h * 0.052), tw + pad * 2, Math.round(h * 0.052));
  ctx.fillStyle = '#fff';
  ctx.fillText(text, pad * 2, h - pad - Math.round(h * 0.016));

  const a = document.createElement('a');
  a.download = `hairstyle-${style.id}-${Date.now()}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

/* ------------------------------------------------------------------ */
initUI();
