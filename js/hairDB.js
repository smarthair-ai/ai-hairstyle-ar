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

/** 从数据库推断分类（去重、保持出现顺序），兼容 categories 数组与旧单值 category */
export function getCategories() {
  const seen = new Set();
  const out = [];
  for (const s of getStyles()) {
    const cats = s.categories || (s.category ? [s.category] : []);
    for (const c of cats) {
      if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
  }
  return out;
}

/**
 * 依据脸型给全部发型排序 / 筛选。
 * - 发型带 suitableFaceShapes（中文脸型数组）：识别到的脸型命中即匹配，
 *   且脸型列表越专一（越短）匹配度越高。
 * - 旧发型仅有 fit 对象：沿用 0~1 适配度 → 55~98 分。
 * - 未识别脸型：全部给中等分，便于一览。
 * @param {string} shapeKey oval|round|square|oblong|heart|diamond|pear
 * @param {string} filter   all|short|medium|long
 */
const SHAPE_CN = {
  oval: '鹅蛋脸', round: '圆脸', square: '方脸',
  oblong: '长脸', heart: '心形脸', diamond: '菱形脸', pear: '梨形脸',
};

export function recommend(shapeKey, filter = 'all') {
  const cn = shapeKey ? (SHAPE_CN[shapeKey] || shapeKey) : null;
  const list = getStyles()
    .filter(s => {
      if (filter !== 'all') {
        const cats = s.categories || (s.category ? [s.category] : []);
        if (!cats.includes(filter)) return false;
      }
      return true;
    })
    .map(s => {
      const shapes = s.suitableFaceShapes;
      let match;
      if (cn && shapes && shapes.length) {
        match = shapes.includes(cn) ? 100 - (shapes.length - 1) * 6 : 0;
      } else if (cn && s.fit && typeof s.fit === 'object' && s.fit[shapeKey] != null) {
        match = 55 + s.fit[shapeKey] * 43;            // 旧条目 fit 兜底
      } else if (cn) {
        match = 0;
      } else {
        match = 60;                                    // 未识别脸型：中等展示
      }
      return { ...s, match, score: Math.round(match) };
    });
  list.sort((a, b) => (cn ? b.match - a.match : b.score - a.score));
  return list;
}
