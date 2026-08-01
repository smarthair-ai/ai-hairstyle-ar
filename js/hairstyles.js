/**
 * hairstyles.js —— 发型库 + 推荐引擎
 *
 * 每个发型包含三部分：
 *   meta   ：名称、分类、说明
 *   fit    ：对 7 种脸型的适配度（0~1），推荐排序的依据
 *   params ：交给 hairFactory 程序化建模的几何参数（单位：头宽=1）
 *
 * 想换成真实 3D 模型？给某个发型加上 modelUrl 字段即可：
 *   modelUrl: './assets/models/bob.glb'
 * 加载后会自动按包围盒缩放到头部尺寸，再用 modelOffset / modelScale 微调。
 */

/**
 * params 字段说明（都以"头宽 = 1"为单位）
 *  volume    头皮壳膨胀系数，越大越蓬松
 *  frontPhi  前额发际线位置（弧度，从头顶量起，越小发际线越高）
 *  sidePhi   两侧头发覆盖到的角度（≈1.5 到耳朵位置）
 *  backPhi   后脑覆盖到的角度（≈1.85 到后颈）
 *  frontLen  刘海垂下长度（0 = 露额头）
 *  sideLen   两侧头发垂下长度
 *  backLen   脑后头发垂下长度
 *  wave      波浪幅度      waveFreq 波浪频率
 *  curl      小卷曲噪声幅度（羊毛卷/爆炸头）
 *  part      分缝：-1 左偏 / 0 中分或无 / 1 右偏
 *  taper     发梢收拢程度（0 直筒，1 明显收窄）
 *  extra     附加部件：'ponytail' | 'bun' | null
 *  layers    额外层次：[{ lenScale, volume }]
 */

export const HAIRSTYLES = [
  {
    id: 'pixie', name: '俏皮精灵短发', category: 'short', tag: '超短 · 干练',
    desc: '露出耳朵与颈线，视觉上把重心提到头顶，显脸小、显精神。',
    color: 0x2a2226,
    fit: { oval: .92, round: .62, square: .58, oblong: .55, heart: .88, diamond: .74, pear: .70 },
    params: {
      volume: 1.11, frontPhi: 1.00, sidePhi: 1.40, backPhi: 1.78,
      frontLen: 0.14, sideLen: 0.06, backLen: 0.08,
      wave: 0.02, waveFreq: 3, curl: 0.010, part: 1, taper: 0.5,
    },
  },
  {
    id: 'crop', name: '纹理碎盖短发', category: 'short', tag: '男士 · 利落',
    desc: '顶部保留纹理与蓬松度，两侧收短，非常适合修饰偏宽的下颌轮廓。',
    color: 0x201c1e,
    fit: { oval: .90, round: .72, square: .80, oblong: .60, heart: .78, diamond: .76, pear: .82 },
    params: {
      volume: 1.13, frontPhi: 0.95, sidePhi: 1.28, backPhi: 1.70,
      frontLen: 0.16, sideLen: 0.02, backLen: 0.03,
      wave: 0.015, waveFreq: 4, curl: 0.016, part: 0, taper: 0.4,
    },
  },
  {
    id: 'korean', name: '韩式中分微卷', category: 'short', tag: '中分 · 蓬松',
    desc: '中分两侧微微内扣，能把过宽的额头收进来，同时增加颅顶高度。',
    color: 0x352218,
    fit: { oval: .88, round: .80, square: .74, oblong: .70, heart: .70, diamond: .78, pear: .76 },
    params: {
      volume: 1.16, frontPhi: 0.92, sidePhi: 1.46, backPhi: 1.80,
      frontLen: 0.26, sideLen: 0.22, backLen: 0.18,
      wave: 0.045, waveFreq: 3, curl: 0.006, part: 0, taper: 0.55,
    },
  },
  {
    id: 'bob', name: '法式波波头', category: 'medium', tag: '内扣 · 经典',
    desc: '发尾在下颌线附近内扣，用弧线柔化棱角，是方脸的经典解法。',
    color: 0x241d1f,
    fit: { oval: .93, round: .66, square: .86, oblong: .84, heart: .80, diamond: .82, pear: .72 },
    params: {
      volume: 1.10, frontPhi: 0.98, sidePhi: 1.50, backPhi: 1.86,
      frontLen: 0.0, sideLen: 0.50, backLen: 0.56,
      wave: 0.030, waveFreq: 2, curl: 0.004, part: 1, taper: 0.78,
    },
  },
  {
    id: 'bobBangs', name: '齐刘海波波头', category: 'medium', tag: '刘海 · 减龄',
    desc: '厚刘海把额头纵向长度切短，对长脸、宽额头特别友好。',
    color: 0x1f1a1c,
    fit: { oval: .86, round: .58, square: .72, oblong: .92, heart: .90, diamond: .84, pear: .66 },
    params: {
      volume: 1.10, frontPhi: 1.02, sidePhi: 1.50, backPhi: 1.86,
      frontLen: 0.25, sideLen: 0.52, backLen: 0.58,
      wave: 0.022, waveFreq: 2, curl: 0.003, part: 0, taper: 0.72,
    },
  },
  {
    id: 'lob', name: '侧分中长发', category: 'medium', tag: '侧分 · 温柔',
    desc: '三七侧分打破面部对称，斜向线条能显著拉长圆润的脸部轮廓。',
    color: 0x3a2718,
    fit: { oval: .94, round: .90, square: .82, oblong: .74, heart: .82, diamond: .80, pear: .84 },
    params: {
      volume: 1.12, frontPhi: 0.90, sidePhi: 1.52, backPhi: 1.88,
      frontLen: 0.26, sideLen: 0.86, backLen: 0.92,
      wave: 0.055, waveFreq: 2.5, curl: 0.005, part: 1, taper: 0.68,
      partStrength: 0.22,
    },
  },
  {
    id: 'airyShoulder', name: '空气刘海齐肩发', category: 'medium', tag: '空气感 · 甜',
    desc: '轻薄空气刘海若隐若现，既能遮住额头又不显厚重，配合齐肩层次很显软萌。',
    color: 0x4a3220,
    fit: { oval: .90, round: .74, square: .78, oblong: .90, heart: .86, diamond: .86, pear: .74 },
    params: {
      volume: 1.13, frontPhi: 1.00, sidePhi: 1.52, backPhi: 1.88,
      frontLen: 0.24, sideLen: 0.78, backLen: 0.88,
      wave: 0.060, waveFreq: 3, curl: 0.006, part: 0, taper: 0.60,
      layers: [{ lenScale: 0.55, volume: 1.05 }],
    },
  },
  {
    id: 'longStraight', name: '中分长直发', category: 'long', tag: '直发 · 气质',
    desc: '两侧垂顺的直发形成纵向线条，能有效收窄面部横向宽度。',
    color: 0x191517,
    fit: { oval: .92, round: .88, square: .80, oblong: .62, heart: .78, diamond: .76, pear: .86 },
    params: {
      volume: 1.08, frontPhi: 0.88, sidePhi: 1.52, backPhi: 1.90,
      frontLen: 0.0, sideLen: 1.55, backLen: 1.70,
      wave: 0.030, waveFreq: 1.5, curl: 0.003, part: 0, taper: 0.55,
    },
  },
  {
    id: 'longWave', name: '慵懒大波浪', category: 'long', tag: '卷发 · 蓬松',
    desc: '中下段大卷带来横向体积，把过长的脸型比例拉回平衡，也能补足窄下颌的量感。',
    color: 0x5a3a1e,
    fit: { oval: .93, round: .60, square: .84, oblong: .94, heart: .90, diamond: .88, pear: .68 },
    params: {
      volume: 1.15, frontPhi: 0.92, sidePhi: 1.54, backPhi: 1.90,
      frontLen: 0.18, sideLen: 1.45, backLen: 1.62,
      wave: 0.130, waveFreq: 4.5, curl: 0.012, part: 1, taper: 0.42,
      partStrength: 0.16,
    },
  },
  {
    id: 'wolf', name: '层次狼尾', category: 'long', tag: '层次 · 个性',
    desc: '上层蓬松、下层轻薄的强层次结构，能同时兼顾颅顶高度与颈部线条。',
    color: 0x2b2124,
    fit: { oval: .88, round: .84, square: .76, oblong: .78, heart: .82, diamond: .80, pear: .88 },
    params: {
      volume: 1.18, frontPhi: 0.96, sidePhi: 1.46, backPhi: 1.92,
      frontLen: 0.26, sideLen: 0.60, backLen: 1.35,
      wave: 0.080, waveFreq: 4, curl: 0.014, part: 0, taper: 0.72,
      layers: [{ lenScale: 0.40, volume: 1.07 }],
    },
  },
  {
    id: 'ponytail', name: '高马尾', category: 'long', tag: '扎发 · 清爽',
    desc: '把发际线提高、露出完整轮廓，视觉上直接给脸型"减负"，显得干练又年轻。',
    color: 0x1e1a1c,
    fit: { oval: .95, round: .70, square: .64, oblong: .60, heart: .74, diamond: .70, pear: .78 },
    params: {
      volume: 1.06, frontPhi: 0.82, sidePhi: 1.30, backPhi: 1.72,
      frontLen: 0.06, sideLen: 0.05, backLen: 0.06,
      wave: 0.02, waveFreq: 2, curl: 0.003, part: 0, taper: 0.5,
      extra: 'ponytail',
    },
  },
  {
    id: 'bun', name: '慵懒丸子头', category: 'medium', tag: '扎发 · 甜酷',
    desc: '头顶的丸子把视觉高度往上拉，对圆脸和短脸型的比例修饰非常直接。',
    color: 0x241c20,
    fit: { oval: .92, round: .86, square: .70, oblong: .52, heart: .76, diamond: .72, pear: .82 },
    params: {
      volume: 1.06, frontPhi: 0.86, sidePhi: 1.32, backPhi: 1.70,
      frontLen: 0.10, sideLen: 0.12, backLen: 0.08,
      wave: 0.02, waveFreq: 2, curl: 0.004, part: 0, taper: 0.5,
      extra: 'bun',
    },
  },
  {
    id: 'afro', name: '蓬松羊毛卷', category: 'medium', tag: '卷度 · 张扬',
    desc: '球形轮廓在两侧制造强烈体积感，最适合需要"补宽"的窄额头与尖下巴。',
    color: 0x2f2320,
    fit: { oval: .84, round: .48, square: .62, oblong: .90, heart: .86, diamond: .84, pear: .60 },
    params: {
      volume: 1.34, frontPhi: 1.00, sidePhi: 1.58, backPhi: 1.88,
      frontLen: 0.22, sideLen: 0.34, backLen: 0.36,
      wave: 0.055, waveFreq: 5, curl: 0.055, part: 0, taper: 0.15,
      hangPad: 1.20,
    },
  },
  {
    id: 'demo', name: '演示发型(圆锥+圆柱)', category: 'short', tag: '调试 · 占位',
    desc: '用基础几何体拼的最简短发，专供调试：若它能正常显示并贴合头部，说明渲染与对齐链路正常。',
    color: 0x2b2230, simple: true,
    fit: { oval: .7, round: .7, square: .7, oblong: .7, heart: .7, diamond: .7, pear: .7 },
  },
  {
    id: 'twintail', name: '甜美双马尾', category: 'medium', tag: '双马尾 · 减龄',
    desc: '左右两束高扎马尾，自带少女感，能把视觉重心拉向两侧、弱化下颌宽度。',
    color: 0x2a2226,
    fit: { oval: .90, round: .80, square: .74, oblong: .78, heart: .82, diamond: .78, pear: .80 },
    params: {
      volume: 1.18, frontPhi: 0.95, sidePhi: 1.44, backPhi: 1.80,
      frontLen: 0.16, sideLen: 0.18, backLen: 0.16,
      wave: 0.05, waveFreq: 3, curl: 0.006, part: 0, taper: 0.5,
      extra: 'twintail',
    },
  },
  {
    id: 'braid', name: '侧边麻花辫', category: 'long', tag: '编发 · 文艺',
    desc: '两股麻花辫自耳侧垂落，纹理清晰、氛围感强，适合修饰偏宽的颧骨与下颌。',
    color: 0x2f2620,
    fit: { oval: .88, round: .72, square: .78, oblong: .80, heart: .82, diamond: .80, pear: .82 },
    params: {
      volume: 1.06, frontPhi: 0.92, sidePhi: 1.50, backPhi: 1.86,
      frontLen: 0.12, sideLen: 1.10, backLen: 1.30,
      wave: 0.04, waveFreq: 3, curl: 0.008, part: 1, taper: 0.6,
      extra: 'braids',
    },
  },
  {
    id: 'topknot', name: '日系高发髻', category: 'short', tag: '发髻 · 利落',
    desc: '头顶小发髻把高度提到极致，干净利落又显脸小，尤其适合长脸与短脸。',
    color: 0x241c20,
    fit: { oval: .90, round: .84, square: .70, oblong: .58, heart: .78, diamond: .72, pear: .82 },
    params: {
      volume: 1.08, frontPhi: 0.88, sidePhi: 1.36, backPhi: 1.74,
      frontLen: 0.10, sideLen: 0.10, backLen: 0.06,
      wave: 0.02, waveFreq: 2, curl: 0.005, part: 0, taper: 0.5,
      extra: 'topknot',
    },
  },
  {
    id: 'spacebun', name: '甜酷双丸子头', category: 'medium', tag: '双丸子 · 个性',
    desc: '左右两个丸子头，俏皮又有辨识度，能平衡偏长或偏方的脸型比例。',
    color: 0x3a2718,
    fit: { oval: .86, round: .82, square: .68, oblong: .56, heart: .76, diamond: .70, pear: .80 },
    params: {
      volume: 1.10, frontPhi: 0.90, sidePhi: 1.40, backPhi: 1.78,
      frontLen: 0.12, sideLen: 0.20, backLen: 0.14,
      wave: 0.03, waveFreq: 3, curl: 0.008, part: 0, taper: 0.5,
      extra: 'spacebun',
    },
  },
  {
    id: 'hime', name: '公主切姬发式', category: 'medium', tag: '姬发 · 二次元',
    desc: '厚齐刘海 + 两侧一刀切长直发，线条利落、个性鲜明，是二次元氛围感的代表发型。',
    color: 0x2b2124,
    fit: { oval: .82, round: .78, square: .84, oblong: .80, heart: .80, diamond: .82, pear: .84 },
    params: {
      volume: 1.05, frontPhi: 0.98, sidePhi: 1.50, backPhi: 1.84,
      frontLen: 0.26, sideLen: 0.58, backLen: 0.62,
      wave: 0.015, waveFreq: 2, curl: 0.003, part: 0, taper: 0.82,
      layers: [{ lenScale: 0.6, volume: 1.02 }],
    },
  },
  {
    id: 'collarbone', name: '气质锁骨发', category: 'medium', tag: '锁骨发 · 知性',
    desc: '长度刚到锁骨，发尾微内扣，优雅知性又不显拖沓，是百搭的安全牌。',
    color: 0x352218,
    fit: { oval: .92, round: .84, square: .80, oblong: .78, heart: .82, diamond: .80, pear: .84 },
    params: {
      volume: 1.09, frontPhi: 0.96, sidePhi: 1.50, backPhi: 1.86,
      frontLen: 0.12, sideLen: 0.72, backLen: 0.80,
      wave: 0.05, waveFreq: 2.5, curl: 0.005, part: 1, taper: 0.66,
    },
  },
];

/* ------------------------------------------------------------------ */
/* 推荐引擎                                                            */
/* ------------------------------------------------------------------ */

/**
 * 依据脸型给全部发型排序。
 * @param {string} shapeKey oval|round|square|oblong|heart|diamond|pear
 * @param {string} filter   all|short|medium|long
 */
export function recommend(shapeKey, filter = 'all') {
  const list = HAIRSTYLES
    .filter(s => filter === 'all' || s.category === filter)
    .map(s => {
      const fit = (s.fit && s.fit[shapeKey] != null) ? s.fit[shapeKey] : 0.6;
      return {
        ...s,
        fit,
        // 把 0~1 的适配度映射成更好读的 55~98 分
        score: Math.round(55 + fit * 43),
      };
    });
  list.sort((a, b) => b.score - a.score);
  return list;
}

export function getStyle(id) {
  return HAIRSTYLES.find(s => s.id === id) || HAIRSTYLES[0];
}
