/**
 * faceShape.js —— 基于 468 个关键点的脸型几何分析
 *
 * 思路：
 *   1. 先用两侧颧骨连线建立"脸部局部坐标系"，消除头部倾斜(roll)带来的测量误差；
 *   2. 在该坐标系下测量：额宽 / 颧宽 / 下颌宽 / 脸长 / 下巴尖锐度；
 *   3. 把这些无量纲比例喂给 7 种脸型的"高斯模糊评分"，取最高分作为结论。
 *
 * 说明：几何法只是近似，结果用于风格建议而非医学测量，所以我们同时给出置信度和备选脸型。
 */

/* ---- 关键点索引（MediaPipe Face Mesh 468 点规范） ---- */
export const LM = {
  foreheadL: 54,  foreheadR: 284,   // 额角（发际线两侧）
  cheekL: 234,    cheekR: 454,      // 颧骨最宽处（脸部外轮廓）
  jawL: 172,      jawR: 397,        // 下颌线中段
  gonionL: 58,    gonionR: 288,     // 下颌角（腮帮）
  top: 10,        chin: 152,        // 发际线顶点 / 下巴尖
  browMid: 9,     noseTip: 1,
  // 用于位姿估计的左右对称点对
  symPairs: [[234, 454], [127, 356], [93, 323], [58, 288], [172, 397], [143, 372]],
  vertPairs: [[152, 10], [152, 9], [200, 8], [18, 151]],
};

/* ---- 7 种脸型的特征模板 ---- */
// lw = 脸长/颧宽, fc = 额宽/颧宽, jc = 下颌宽/颧宽, ja = 下巴张角(度)
const PROFILES = {
  oval:    { name: '椭圆脸', en: 'Oval',    lw: 1.42, fc: 0.86, jc: 0.78, ja: 118,
             desc: '长宽比协调、下颌线柔和，是公认最百搭的脸型，几乎不挑发型。' },
  round:   { name: '圆脸',   en: 'Round',   lw: 1.16, fc: 0.88, jc: 0.83, ja: 132,
             desc: '脸长与脸宽接近、下颌圆润，适合用纵向线条和高颅顶拉长视觉比例。' },
  square:  { name: '方脸',   en: 'Square',  lw: 1.22, fc: 0.94, jc: 0.95, ja: 128,
             desc: '下颌角明显、轮廓利落，适合用弧线与层次柔化两颊的硬朗感。' },
  oblong:  { name: '长脸',   en: 'Oblong',  lw: 1.64, fc: 0.90, jc: 0.86, ja: 122,
             desc: '面部纵向偏长，适合增加横向蓬松度、搭配刘海缩短额头视觉长度。' },
  heart:   { name: '心形脸', en: 'Heart',   lw: 1.40, fc: 0.97, jc: 0.70, ja: 100,
             desc: '额头较宽、下巴尖俏，重点在于补足下半脸的量感、弱化额头宽度。' },
  diamond: { name: '菱形脸', en: 'Diamond', lw: 1.48, fc: 0.78, jc: 0.72, ja: 108,
             desc: '颧骨最突出、额头与下颌都偏窄，适合在额头与下巴附近增加蓬松度。' },
  pear:    { name: '梨形脸', en: 'Pear',    lw: 1.36, fc: 0.76, jc: 0.97, ja: 126,
             desc: '下颌比额头宽，适合把重心提到头顶与两颊上方，平衡上下轮廓。' },
};

// 各特征的容差（高斯 sigma）：越小 = 该特征越敏感
const SIGMA = { lw: 0.145, fc: 0.075, jc: 0.095, ja: 15 };
// 各脸型对不同特征的关注权重
const WEIGHT = {
  oval:    { lw: 1.0, fc: 0.7, jc: 0.8, ja: 0.5 },
  round:   { lw: 1.4, fc: 0.6, jc: 0.9, ja: 0.9 },
  square:  { lw: 1.0, fc: 0.9, jc: 1.4, ja: 0.9 },
  oblong:  { lw: 1.6, fc: 0.6, jc: 0.6, ja: 0.4 },
  heart:   { lw: 0.8, fc: 1.2, jc: 1.3, ja: 1.0 },
  diamond: { lw: 0.9, fc: 1.3, jc: 1.1, ja: 0.8 },
  pear:    { lw: 0.8, fc: 1.3, jc: 1.3, ja: 0.6 },
};

/* ------------------------------------------------------------------ */
/* 基础向量工具（二维，像素坐标系，y 轴向下）                            */
/* ------------------------------------------------------------------ */
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => { const l = len(a) || 1e-6; return { x: a.x / l, y: a.y / l }; };

/**
 * 从归一化关键点计算原始几何指标。
 * @param {Array<{x:number,y:number,z:number}>} lms 归一化关键点（0~1）
 * @param {number} w 视频像素宽
 * @param {number} h 视频像素高
 */
export function measure(lms, w, h) {
  const P = (i) => ({ x: lms[i].x * w, y: lms[i].y * h });

  // 1) 建立脸部局部坐标系：X 轴 = 两颧骨连线，Y 轴 = 其法线（指向头顶）
  const axisX = norm(sub(P(LM.cheekR), P(LM.cheekL)));
  const axisY = { x: axisX.y, y: -axisX.x }; // 屏幕 y 向下，故取此法线为"向上"

  const widthOf = (a, b) => Math.abs(dot(sub(P(a), P(b)), axisX));
  const heightOf = (a, b) => Math.abs(dot(sub(P(a), P(b)), axisY));

  const cheekW    = widthOf(LM.cheekR, LM.cheekL);
  const foreheadW = widthOf(LM.foreheadR, LM.foreheadL);
  const jawW      = widthOf(LM.jawR, LM.jawL);
  const gonionW   = widthOf(LM.gonionR, LM.gonionL);
  const faceLen   = heightOf(LM.top, LM.chin);

  // 2) 下巴张角：以下巴尖为顶点，两条下颌线的夹角。越小＝下巴越尖
  const c = P(LM.chin);
  const v1 = norm(sub(P(LM.jawL), c));
  const v2 = norm(sub(P(LM.jawR), c));
  const jawAngle = Math.acos(Math.max(-1, Math.min(1, dot(v1, v2)))) * 180 / Math.PI;

  const safe = cheekW || 1e-6;
  return {
    cheekW, foreheadW, jawW, gonionW, faceLen, jawAngle,
    lw: faceLen / safe,       // 长宽比
    fc: foreheadW / safe,     // 额宽 / 颧宽
    jc: jawW / safe,          // 下颌宽 / 颧宽
    gc: gonionW / safe,       // 下颌角宽 / 颧宽
    ja: jawAngle,
  };
}

/**
 * 根据比例指标给 7 种脸型打分。
 * @returns {{best:string, confidence:number, ranked:Array<{key,name,score}>}}
 */
export function classify(m) {
  const raw = [];
  for (const key of Object.keys(PROFILES)) {
    const p = PROFILES[key], wgt = WEIGHT[key];
    let logScore = 0;
    for (const f of ['lw', 'fc', 'jc', 'ja']) {
      const d = (m[f] - p[f]) / SIGMA[f];
      logScore += -0.5 * d * d * wgt[f];   // 加权高斯的对数似然
    }
    raw.push({ key, name: p.name, score: Math.exp(logScore) });
  }
  const total = raw.reduce((s, r) => s + r.score, 0) || 1;
  raw.forEach(r => { r.score = r.score / total; });
  raw.sort((a, b) => b.score - a.score);

  return {
    best: raw[0].key,
    confidence: raw[0].score,
    ranked: raw,
  };
}

/** 取脸型的展示信息 */
export function shapeInfo(key) {
  return PROFILES[key] || PROFILES.oval;
}

/** 供 UI 展示的比例条（把比例映射到 0~1 的进度） */
export function metricBars(m) {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  return [
    { label: '脸长 / 脸宽',   value: m.lw, text: m.lw.toFixed(2),
      pct: clamp01((m.lw - 1.0) / 0.9) },
    { label: '额宽 / 颧宽',   value: m.fc, text: m.fc.toFixed(2),
      pct: clamp01((m.fc - 0.60) / 0.55) },
    { label: '下颌宽 / 颧宽', value: m.jc, text: m.jc.toFixed(2),
      pct: clamp01((m.jc - 0.55) / 0.60) },
    { label: '下巴尖锐度',    value: m.ja, text: `${m.ja.toFixed(0)}°`,
      pct: clamp01((150 - m.ja) / 70) },
  ];
}

/* ------------------------------------------------------------------ */
/* 指标的时序累积器：多帧指数平滑，避免结论来回跳                        */
/* ------------------------------------------------------------------ */
export class ShapeAccumulator {
  constructor(alpha = 0.12, minSamples = 20) {
    this.alpha = alpha;
    this.minSamples = minSamples;
    this.count = 0;
    this.m = null;
  }
  reset() { this.count = 0; this.m = null; }

  push(metrics) {
    if (!this.m) {
      this.m = { ...metrics };
    } else {
      const a = this.alpha;
      for (const k of Object.keys(this.m)) {
        if (typeof metrics[k] === 'number') this.m[k] = this.m[k] * (1 - a) + metrics[k] * a;
      }
    }
    this.count++;
    return this.m;
  }

  get stable() { return this.count >= this.minSamples; }
  get metrics() { return this.m; }
}
