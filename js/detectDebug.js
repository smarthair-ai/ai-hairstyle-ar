/**
 * detectDebug.js —— 人脸检测调试可视化
 *
 * 在 overlayCanvas 上画出：
 *   · 人脸检测框（绿=检出 / 红=未检出）
 *   · 额头锚点（2D 发型精灵挂载点）与颧骨基线（头宽测量线）
 *   · 实时状态文字：后端 / 命中率 / 检出脸数 / 最近错误
 *
 * 目的：让"到底有没有在检测"这件事肉眼可见，而不是只能猜。
 */

import { CONFIG } from './config.js';

/** 与 hairOverlay 保持一致的关键点索引 */
const LM = {
  forehead: 10,
  cheekL: 234,
  cheekR: 454,
  chin: 152,
};

/**
 * 绘制检测调试层。
 * @param {CanvasRenderingContext2D} ctx  overlayCanvas 的 2D 上下文
 * @param {Array|null} landmarks          检出的关键点（null = 本帧没检到）
 * @param {Object} stats                  FaceTracker.stats
 */
export function drawDetectDebug(ctx, landmarks, stats) {
  if (!ctx) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (!w || !h) return;

  const hit = !!landmarks;
  const mirror = CONFIG.camera.mirror;

  /* ---------- 人脸框 + 锚点（跟随镜像） ---------- */
  if (hit) {
    ctx.save();
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }

    // 包围盒
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const bx = minX * w, by = minY * h;
    const bw = (maxX - minX) * w, bh = (maxY - minY) * h;

    ctx.strokeStyle = 'rgba(34,197,94,.95)';
    ctx.lineWidth = Math.max(2, w * 0.0025);
    ctx.strokeRect(bx, by, bw, bh);

    // 四角加粗，更醒目
    const c = Math.min(bw, bh) * 0.16;
    ctx.lineWidth = Math.max(3, w * 0.004);
    ctx.beginPath();
    ctx.moveTo(bx, by + c); ctx.lineTo(bx, by); ctx.lineTo(bx + c, by);
    ctx.moveTo(bx + bw - c, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + c);
    ctx.moveTo(bx, by + bh - c); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + c, by + bh);
    ctx.moveTo(bx + bw - c, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - c);
    ctx.stroke();

    // 颧骨基线（头宽测量依据）
    const cL = landmarks[LM.cheekL], cR = landmarks[LM.cheekR];
    if (cL && cR) {
      ctx.strokeStyle = 'rgba(56,189,248,.95)';
      ctx.lineWidth = Math.max(2, w * 0.003);
      ctx.beginPath();
      ctx.moveTo(cL.x * w, cL.y * h);
      ctx.lineTo(cR.x * w, cR.y * h);
      ctx.stroke();
    }

    // 额头锚点（发型精灵挂载位置）
    const ft = landmarks[LM.forehead];
    if (ft) {
      const r = Math.max(4, w * 0.006);
      ctx.fillStyle = 'rgba(236,72,153,.95)';
      ctx.beginPath();
      ctx.arc(ft.x * w, ft.y * h, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  } else {
    // 未检出：画一个红色虚线取景框，提示"正在找脸"
    ctx.save();
    ctx.strokeStyle = 'rgba(239,68,68,.85)';
    ctx.lineWidth = Math.max(2, w * 0.003);
    ctx.setLineDash([w * 0.02, w * 0.014]);
    const m = Math.min(w, h) * 0.18;
    ctx.strokeRect(m, m * 0.7, w - m * 2, h - m * 1.5);
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* ---------- 状态文字（不镜像，保证可读） ---------- */
  const total = stats.hits + stats.misses;
  const rate = total ? Math.round((stats.hits / total) * 100) : 0;
  const lines = [
    hit ? '● 检测中：已锁定人脸' : '○ 未检出人脸',
    `后端 ${stats.delegate || '-'} · 模型 ${stats.modelUrl ? '已加载' : '未加载'}`,
    `推理 ${stats.attempts} 帧 · 命中 ${stats.hits} · 命中率 ${rate}%`,
    `本帧检出 ${stats.lastFaceCount} 张脸 · 阈值 ${CONFIG.detect.minFaceDetectionConfidence}`,
  ];
  if (stats.skippedNoSize) lines.push(`跳过(视频尺寸为0) ${stats.skippedNoSize} 帧`);
  if (stats.errors) lines.push(`推理异常 ${stats.errors} 次：${trim(stats.lastError, 46)}`);

  const fs = Math.max(13, Math.round(w * 0.017));
  const pad = Math.round(fs * 0.6);
  const lh = Math.round(fs * 1.45);
  ctx.save();
  ctx.font = `${fs}px ui-monospace,"SF Mono",Consolas,"Microsoft YaHei",monospace`;
  let boxW = 0;
  for (const t of lines) boxW = Math.max(boxW, ctx.measureText(t).width);
  ctx.fillStyle = 'rgba(15,23,42,.72)';
  roundRect(ctx, pad, pad, boxW + pad * 2, lines.length * lh + pad, Math.round(fs * 0.5));
  ctx.fill();
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = i === 0
      ? (hit ? 'rgba(74,222,128,1)' : 'rgba(248,113,113,1)')
      : 'rgba(226,232,240,.94)';
    ctx.fillText(lines[i], pad * 2, pad + lh * (i + 1) - lh * 0.28);
  }
  ctx.restore();
}

function trim(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
