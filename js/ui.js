/**
 * ui.js —— DOM 渲染与交互（不含任何业务算法）
 */

import { HAIR_COLORS } from './config.js';
import { shapeInfo, metricBars } from './faceShape.js';

export const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 发型缩略图：用 SVG 现画一个侧影，零资源依赖                          */
/* ------------------------------------------------------------------ */
export function styleThumb(style) {
  // 真实 3D 模型可能没有 params（仅有 modelUrl），这里按分类给一个通用轮廓
  const p = style.params || categoryFallback(style.category);
  // 兼容数值颜色与字符串颜色（"#241d1f" / "241d1f"）
  const raw = style.color ?? '#241d1f';
  const hair = (typeof raw === 'number')
    ? '#' + raw.toString(16).padStart(6, '0')
    : (String(raw).startsWith('#') ? raw : '#' + raw);
  const hairLight = shade(hair, 1.25);

  const sideLen = p.sideLen ?? 0.4;
  const frontLen = p.frontLen ?? 0;
  const vol = p.volume ?? 1.1;

  const bottom = Math.min(93, 44 + sideLen * 32);           // 发尾高度
  const halfW = 27 + (vol - 1.05) * 26 + Math.min(6, sideLen * 4); // 外轮廓半宽
  const xl = 50 - halfW, xr = 50 + halfW;
  const hairline = 31 + Math.min(14, frontLen * 34);        // 刘海下沿

  const back = `M${xl},50 C${xl - 1},22 38,11 50,11 C62,11 ${xr + 1},22 ${xr},50 L${xr},${bottom} Q50,${bottom + 9} ${xl},${bottom} Z`;
  const cap = `M27,52 C26,24 39,13 50,13 C61,13 74,24 73,52 C73,40 68,${hairline} 50,${hairline} C32,${hairline} 27,40 27,52 Z`;

  let extra = '';
  if (p.extra === 'ponytail') extra += `<ellipse cx="50" cy="86" rx="9" ry="15" fill="${hair}"/><circle cx="50" cy="26" r="7" fill="${hair}"/>`;
  if (p.extra === 'bun') extra += `<circle cx="50" cy="12" r="11" fill="${hair}"/><ellipse cx="50" cy="21" rx="8" ry="3" fill="${hairLight}"/>`;
  if (p.extra === 'twintail') extra += `<circle cx="22" cy="20" r="7" fill="${hair}"/><circle cx="78" cy="20" r="7" fill="${hair}"/>`;
  if (p.extra === 'braids') extra += `<circle cx="24" cy="30" r="6" fill="${hair}"/><circle cx="76" cy="30" r="6" fill="${hair}"/>`;
  if (p.extra === 'topknot') extra += `<circle cx="50" cy="6" r="10" fill="${hair}"/>`;
  if (p.extra === 'spacebun') extra += `<circle cx="34" cy="10" r="8" fill="${hair}"/><circle cx="66" cy="10" r="8" fill="${hair}"/>`;
  if ((p.curl ?? 0) > 0.03) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      extra += `<circle cx="${(50 + Math.cos(a) * (halfW - 2)).toFixed(1)}" cy="${(44 + Math.sin(a) * 24).toFixed(1)}" r="6" fill="${hair}" opacity=".9"/>`;
    }
  }

  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" fill="#f7f8fc"/>
    <path d="${back}" fill="${hair}"/>
    ${extra}
    <rect x="44" y="60" width="12" height="18" rx="4" fill="#eec6ab"/>
    <ellipse cx="50" cy="47" rx="18.5" ry="24" fill="#f7dac3"/>
    <ellipse cx="43" cy="46" rx="1.7" ry="2.1" fill="#8a6b58"/>
    <ellipse cx="57" cy="46" rx="1.7" ry="2.1" fill="#8a6b58"/>
    <path d="M45.5,55 Q50,58 54.5,55" stroke="#d9a488" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <path d="${cap}" fill="${hair}"/>
    <path d="M34,26 Q50,17 66,26" stroke="${hairLight}" stroke-width="2" fill="none" opacity=".55" stroke-linecap="round"/>
  </svg>`;
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
  const b = Math.min(255, Math.round((n & 255) * k));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/** 真实 3D 模型没有 params 时，给缩略图一个按分类的通用轮廓，避免画出奇怪图形 */
function categoryFallback(cat) {
  if (cat === 'long')   return { sideLen: 1.4, frontLen: 0, volume: 1.1, curl: 0 };
  if (cat === 'medium') return { sideLen: 0.6, frontLen: 0.1, volume: 1.1, curl: 0 };
  return { sideLen: 0.1, frontLen: 0.15, volume: 1.1, curl: 0 };   // short
}

/* ------------------------------------------------------------------ */
/* 脸型图标                                                            */
/* ------------------------------------------------------------------ */
const SHAPE_PATH = {
  oval:    '<ellipse cx="24" cy="24" rx="15" ry="21"/>',
  round:   '<ellipse cx="24" cy="24" rx="19" ry="19.5"/>',
  square:  '<rect x="6" y="5" width="36" height="38" rx="8"/>',
  oblong:  '<ellipse cx="24" cy="24" rx="13" ry="22.5"/>',
  heart:   '<path d="M7,16 C7,6 15,3 24,3 C33,3 41,6 41,16 C41,31 31,45 24,45 C17,45 7,31 7,16 Z"/>',
  diamond: '<path d="M24,3 L42,24 L24,45 L6,24 Z"/>',
  pear:    '<path d="M15,10 C15,3 33,3 33,10 C40,20 43,45 24,45 C5,45 8,20 15,10 Z"/>',
};

export function shapeIconSVG(key) {
  return `<svg viewBox="0 0 48 48" width="36" height="36" fill="none"
    stroke="#7c5cf7" stroke-width="2.4" stroke-linejoin="round">
    ${SHAPE_PATH[key] || SHAPE_PATH.oval}
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* 各区块渲染                                                          */
/* ------------------------------------------------------------------ */

/** 脸型分析卡 */
export function renderShapeCard(result, metrics) {
  if (!result) {
    el('shapeName').textContent = '--';
    el('shapeConf').textContent = '等待检测';
    return;
  }
  const info = shapeInfo(result.best);
  el('shapeIcon').innerHTML = shapeIconSVG(result.best);
  el('shapeName').textContent = `${info.name} · ${info.en}`;
  el('shapeDesc').textContent = info.desc;
  el('shapeConf').textContent = `置信度 ${(result.confidence * 100).toFixed(0)}%`;

  el('metrics').innerHTML = metricBars(metrics).map(b => `
    <div class="metric">
      <div class="metric-top"><span>${b.label}</span><b>${b.text}</b></div>
      <div class="bar"><i style="width:${(b.pct * 100).toFixed(1)}%"></i></div>
    </div>`).join('');

  el('altList').innerHTML = result.ranked.slice(1, 5)
    .map(r => `<span class="alt-item">${r.name} ${(r.score * 100).toFixed(0)}%</span>`).join('');
}

function escapeHtml(t) {
  return String(t ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 发型列表（图片优先，含特点 + 打理难度标签；不可 3D 试戴的标「参考图」） */
export function renderStyleGrid(list, activeId, onPick) {
  const grid = el('styleGrid');
  grid.innerHTML = list.map((s, i) => {
    const thumb = s.imageUrl
      ? `<img class="photo" src="${s.imageUrl}" alt="${escapeHtml(s.name)}" loading="lazy">`
      : styleThumb(s);
    const feats = (s.features || []).slice(0, 2)
      .map(f => `<span class="tag">${escapeHtml(f)}</span>`).join('');
    const diff = s.difficulty
      ? `<span class="diff diff-${s.difficultyLevel || 'unknown'}">${escapeHtml(s.difficulty)}</span>`
      : '';
    // 有 3D 模型 / 程序化参数 / 演示发型 → 可 AR 试戴；只有参考图则标「参考图」
    const tryon = s.modelUrl || s.params || s.simple;
    const no3d = tryon ? '' : '<span class="no3d">参考图</span>';
    const imgBtn = s.imageUrl ? `<span class="img-view" title="查看参考图" data-id="${s.id}">图</span>` : '';
    const score = (s.score != null) ? s.score : '';
    return `<button class="style-card ${s.id === activeId ? 'active' : ''}" data-id="${s.id}" type="button">
      <span class="score ${i < 3 ? 'hot' : ''}">${score}</span>
      ${no3d}${imgBtn}
      <div class="thumb">${thumb}</div>
      <span class="name">${escapeHtml(s.name)}</span>
      <div class="feats">${feats}</div>
      <div class="diff-row">${diff}</div>
    </button>`;
  }).join('');

  grid.querySelectorAll('.style-card').forEach(btn => {
    btn.addEventListener('click', () => onPick(btn.dataset.id));
  });
  // 「图」角标：单独查看参考大图，不触发试戴
  grid.querySelectorAll('.img-view').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const st = list.find(x => x.id === b.dataset.id);
      if (st) showHairImage(st);
    });
  });
}

/** 图片参考大图弹窗（用于仅有参考图、无 3D 模型的发型） */
export function showHairImage(style) {
  el('hairImgEl').src = style.imageUrl || '';
  el('hairImgEl').alt = style.name || '';
  el('hairImgName').textContent = style.name || '';
  el('hairImgDesc').textContent = style.description || '';
  const tags = [
    ...((style.features || []).map(f => `<span class="tag">${escapeHtml(f)}</span>`)),
    ...((style.suitableFaceShapes || []).map(f => `<span class="tag">适合${escapeHtml(f)}</span>`)),
    (style.difficulty
      ? `<span class="diff diff-${style.difficultyLevel || 'unknown'}">打理难度：${escapeHtml(style.difficulty)}</span>`
      : ''),
  ];
  el('hairImgTags').innerHTML = tags.join('');
  el('hairImgModal').classList.remove('hidden');
}
export function hideHairImage() { el('hairImgModal').classList.add('hidden'); }

/** 发色色板 */
export function renderSwatches(activeHex, onPick) {
  const box = el('swatches');
  box.innerHTML = HAIR_COLORS.map(c => {
    const hex = '#' + c.hex.toString(16).padStart(6, '0');
    return `<span class="swatch ${c.hex === activeHex ? 'active' : ''}"
      data-hex="${c.hex}" title="${c.name}" style="background:${hex}"></span>`;
  }).join('');
  box.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', () => onPick(parseInt(sw.dataset.hex, 10)));
  });
}

/** 画面内提示（内容没变就不动 DOM，避免每帧重排） */
let _hudText = null;
export function setHud(text, ok = false) {
  if (text === _hudText) return;
  _hudText = text;
  const hud = el('hud'), pill = el('hudStatus');
  hud.classList.remove('hidden');
  pill.textContent = text;
  pill.classList.toggle('ok', ok);
}
export function hideHud() { el('hud').classList.add('hidden'); }

/** 遮罩层控制 */
export function showCover(which, text) {
  ['stageCover', 'loadingCover', 'errorCover'].forEach(id => el(id).classList.add('hidden'));
  if (!which) return;
  el(which).classList.remove('hidden');
  if (which === 'loadingCover' && text) el('loadingText').textContent = text;
  if (which === 'errorCover' && text) el('errorText').textContent = text;
}

/** 渲染摄像头下拉（授权后 enumerateDevices 才能拿到真实设备名） */
export function renderCameraList(list, activeId) {
  const sel = el('camSelect');
  if (!sel) return;
  const prev = activeId || sel.value || '';
  sel.innerHTML = '<option value="">系统默认摄像头</option>' +
    list.map((d, i) => {
      const v = d.deviceId || '';
      const label = d.label || `摄像头 ${i + 1}`;
      return `<option value="${v}" ${v && v === prev ? 'selected' : ''}>${label}</option>`;
    }).join('');
}
