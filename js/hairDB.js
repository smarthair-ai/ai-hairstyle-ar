/**
 * hairDB.js —— 发型数据库加载器（运行时索引）
 *
 * hairDatabase.json 是发型列表的唯一权威来源（位于 public/models/hair/）。
 * 本模块在页面启动时 fetch 它；若失败（例如本地文件协议 / 离线），
 * 自动回退到 hairstyles.js 内置的 HAIRSTYLES，保证 Demo 永远能跑起来。
 *
 * 想增删发型？只改 hairDatabase.json 即可，无需触碰 JS。
 */

import { HAIRSTYLES } from './hairstyles.js';

let catalog = null;     // 当前生效的发型数组
let source = 'builtin'; // 'json' | 'builtin'，便于调试时确认来源

/**
 * 加载发型数据库。
 * @returns {Promise<Array>} 发型数组
 */
export async function loadHairDB() {
  try {
    const res = await fetch('./public/models/hair/hairDatabase.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json.models || []);
    if (!Array.isArray(list) || list.length === 0) throw new Error('数据库为空');
    catalog = list;
    source = 'json';
    console.info('[hairDB] 已从 hairDatabase.json 加载', list.length, '款发型');
  } catch (e) {
    console.warn('[hairDB] 加载 hairDatabase.json 失败，回退内置发型库：', e?.message || e);
    catalog = HAIRSTYLES;
    source = 'builtin';
  }
  return catalog;
}

export function getStyles() { return catalog || HAIRSTYLES; }
export function getSource() { return source; }

export function getById(id) {
  return getStyles().find(s => s.id === id) || getStyles()[0];
}

/** 兼容旧调用名 */
export function getStyle(id) { return getById(id); }

/** 从数据库推断分类（去重、保持出现顺序） */
export function getCategories() {
  const seen = new Set();
  const out = [];
  for (const s of getStyles()) {
    if (s.category && !seen.has(s.category)) { seen.add(s.category); out.push(s.category); }
  }
  return out;
}

/**
 * 依据脸型给全部发型排序（与 hairstyles.js 旧的 recommend 逻辑一致）。
 * @param {string} shapeKey oval|round|square|oblong|heart|diamond|pear
 * @param {string} filter   all|short|medium|long
 */
export function recommend(shapeKey, filter = 'all') {
  const list = getStyles()
    .filter(s => filter === 'all' || s.category === filter)
    .map(s => {
      const fit = (s.fit && s.fit[shapeKey] != null) ? s.fit[shapeKey] : 0.6;
      return {
        ...s,
        fit,
        score: Math.round(55 + fit * 43),   // 0~1 适配度 → 55~98 分
      };
    });
  list.sort((a, b) => b.score - a.score);
  return list;
}
