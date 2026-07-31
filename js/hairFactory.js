/**
 * hairFactory.js —— 程序化 3D 发型建模
 *
 * 为什么不直接用 .glb？
 *   免费可商用的 3D 发型模型很难凑齐一整套，所以这里用参数曲面在运行时"长"出头发，
 *   开箱即用、体积为零。若你有自己的模型，在 hairstyles.js 里填 modelUrl 即可覆盖。
 *
 * 建模坐标系（与 arScene 约定一致）：
 *   原点  = 头骨中心
 *   +Y    = 头顶      +Z = 面部朝向      +X = 模型自身右侧
 *   尺度  = 头宽 1.0（渲染时整体乘以实际头宽）
 */

import * as THREE from 'three';

/** 头部参考椭球（半径，单位：头宽） */
export const HEAD = { rx: 0.50, ry: 0.63, rz: 0.62 };

/**
 * 把颜色统一成 THREE.Color。
 * 兼容三种写法：数字 0x241d1f、带 # 的字符串 "#241d1f"、不带 # 的 "241d1f"。
 * 这样 hairDatabase.json 里用可读性更好的字符串颜色也能正常工作。
 */
function toColor(c) {
  if (c == null) return new THREE.Color(0x241d1f);
  if (typeof c === 'number') return new THREE.Color(c);
  const s = String(c);
  return new THREE.Color().setStyle(s.startsWith('#') ? s : '#' + s);
}

const DEFAULTS = {
  volume: 1.10,
  frontPhi: 0.98, sidePhi: 1.50, backPhi: 1.86,
  frontLen: 0.0, sideLen: 0.5, backLen: 0.55,
  wave: 0.03, waveFreq: 2.5, curl: 0.004,
  part: 0, partStrength: 0.14, taper: 0.6,
  hangPad: 1.06,     // 垂发相对头部轮廓外扩的比例（避免穿模）
  segU: 88, segV: 46,
  extra: null, layers: null,
};

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 头皮椭球上的点：phi 从头顶量起，u 为方位角（0 = 正前方 +Z） */
function scalpPoint(phi, u, vol, out = new THREE.Vector3()) {
  const s = Math.sin(phi), c = Math.cos(phi);
  return out.set(
    HEAD.rx * vol * s * Math.sin(u),
    HEAD.ry * vol * c,
    HEAD.rz * vol * s * Math.cos(u)
  );
}

/**
 * 把方位角拆成 前 / 侧 / 后 三个平滑权重，
 * 用于在"前额发际线 / 两侧 / 后脑"三组参数之间插值。
 */
function dirWeights(u) {
  const c = Math.cos(u);
  const f = Math.pow(Math.max(0, c), 1.6);
  const b = Math.pow(Math.max(0, -c), 1.6);
  const s = Math.max(0, 1 - f - b);
  const t = f + b + s || 1;
  return { f: f / t, b: b / t, s: s / t };
}

/* ------------------------------------------------------------------ */
/* 主体：参数化发丝曲面                                                 */
/* ------------------------------------------------------------------ */

/**
 * 生成一层头发曲面。
 * 每条"发流"沿 u（绕头一圈）分布，v 方向从头顶出发：
 *   先贴着头皮往下走 → 到发际线/耳侧后离开头皮，垂直下垂。
 */
function buildHairSurface(p, lenScale = 1, volScale = 1) {
  const segU = p.segU, segV = p.segV;
  const positions = [], colors = [], uvs = [], indices = [];
  const tmp = new THREE.Vector3(), base = new THREE.Vector3();

  const vol = p.volume * volScale;
  const arcR = ((HEAD.ry + HEAD.rx) / 2) * vol;   // 弧长换算的平均半径

  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2;
    const w = dirWeights(u);

    // --- 分缝造成的左右不对称：只影响前额区域 ---
    const asym = p.part * p.partStrength * Math.sin(u) * w.f;

    const phiEnd = Math.max(0.35,
      w.f * p.frontPhi + w.s * p.sidePhi + w.b * p.backPhi + asym);
    const hang = Math.max(0.001,
      (w.f * p.frontLen + w.s * p.sideLen + w.b * p.backLen) * lenScale
      + Math.abs(asym) * 0.6);

    // 头部在该方位的最大轮廓半径（phi = π/2 处），垂发贴着它往下落
    const silR = Math.hypot(HEAD.rx * vol * Math.sin(u), HEAD.rz * vol * Math.cos(u));

    const arcLen = phiEnd * arcR;
    const total = arcLen + hang;

    scalpPoint(phiEnd, u, vol, base);
    const baseR = Math.hypot(base.x, base.z) || 1e-6;
    const dirX = base.x / baseR, dirZ = base.z / baseR;

    for (let j = 0; j <= segV; j++) {
      const t = j / segV;
      const s = t * total;
      let x, y, z, hangT = 0;

      if (s <= arcLen) {
        // —— 贴头皮段 ——
        scalpPoint(s / arcR, u, vol, tmp);
        x = tmp.x; y = tmp.y; z = tmp.z;
      } else {
        // —— 下垂段 ——
        const d = s - arcLen;
        hangT = Math.min(1, d / hang);

        // 离开头皮后的前 0.18 个单位内，半径过渡到头部轮廓外侧（避免插进脸里）
        const k = Math.min(1, d / 0.18);
        const targetR = silR * p.hangPad;
        let r = baseR + (targetR - baseR) * k;

        // 发梢收拢
        r *= 1 - p.taper * 0.34 * hangT * hangT;

        x = dirX * r; y = base.y - d; z = dirZ * r;
      }

      // —— 波浪 / 卷曲：越靠近发梢越明显 ——
      if (hangT > 0 && (p.wave > 0 || p.curl > 0)) {
        const ang = Math.atan2(z, x);
        let r = Math.hypot(x, z);
        const env = Math.min(1, hangT * 1.6);
        const waveR = Math.sin(t * Math.PI * p.waveFreq + u * 3.1) * p.wave * env;
        const curlR = Math.sin(u * 13.0) * Math.cos(t * 26.0) * p.curl;
        r *= 1 + waveR + curlR;
        // 切向摆动，让发丝不是死板的同心圆
        const swing = Math.cos(t * Math.PI * p.waveFreq * 0.8 + u * 2.3) * p.wave * 0.55 * env;
        x = Math.cos(ang) * r - Math.sin(ang) * swing;
        z = Math.sin(ang) * r + Math.cos(ang) * swing;
        y += Math.sin(u * 5.0 + t * 9.0) * p.wave * 0.35 * env;
      }

      positions.push(x, y, z);
      uvs.push(i / segU, t);
      // 发根偏暗、发梢偏亮，仅靠顶点色就能拉出层次
      const shade = 0.68 + 0.34 * Math.pow(t, 0.8);
      colors.push(shade, shade, shade);
    }
  }

  const rowLen = segV + 1;
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * rowLen + j;
      const b = (i + 1) * rowLen + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 半径可变的管（用于马尾） */
function taperedTube(curve, radiusFn, tubularSeg = 42, radialSeg = 12) {
  const frames = curve.computeFrenetFrames(tubularSeg, false);
  const positions = [], normals = [], colors = [], uvs = [], indices = [];

  for (let i = 0; i <= tubularSeg; i++) {
    const t = i / tubularSeg;
    const P = curve.getPointAt(t);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = radiusFn(t);
    for (let j = 0; j <= radialSeg; j++) {
      const v = (j / radialSeg) * Math.PI * 2;
      const sn = Math.sin(v), cs = -Math.cos(v);
      const nx = cs * N.x + sn * B.x, ny = cs * N.y + sn * B.y, nz = cs * N.z + sn * B.z;
      positions.push(P.x + r * nx, P.y + r * ny, P.z + r * nz);
      normals.push(nx, ny, nz);
      uvs.push(t, j / radialSeg);
      const shade = 0.72 + 0.3 * t;
      colors.push(shade, shade, shade);
    }
  }
  for (let i = 1; i <= tubularSeg; i++) {
    for (let j = 1; j <= radialSeg; j++) {
      const a = (radialSeg + 1) * (i - 1) + (j - 1);
      const b = (radialSeg + 1) * i + (j - 1);
      const c = (radialSeg + 1) * i + j;
      const d = (radialSeg + 1) * (i - 1) + j;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/** 给几何体补一个全 1 的顶点色，保证材质 vertexColors 统一开启 */
function ensureVertexColor(geo, shade = 0.92) {
  if (geo.getAttribute('color')) return geo;
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3).fill(shade);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/** 头发材质 */
function hairMaterial(colorHex) {
  const mat = new THREE.MeshStandardMaterial({
    color: toColor(colorHex),
    roughness: 0.42,
    metalness: 0.06,
    side: THREE.DoubleSide,
    vertexColors: true,
    envMapIntensity: 1.0,
  });
  mat.userData.baseColor = colorHex;
  return mat;
}

/* ------------------------------------------------------------------ */
/* 对外：构建一整个发型                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {object} style hairstyles.js 中的一项
 * @returns {THREE.Group} 归一化头部空间中的发型，userData.materials 便于换色
 */
export function buildHairGroup(style) {
  const p = { ...DEFAULTS, ...(style.params || {}) };
  const group = new THREE.Group();
  group.name = `hair_${style.id}`;
  const materials = [];

  // 主体
  const mainMat = hairMaterial(style.color ?? 0x241d1f);
  const main = new THREE.Mesh(buildHairSurface(p), mainMat);
  main.frustumCulled = false;
  group.add(main);
  materials.push(mainMat);

  // 额外层次（狼尾、齐肩层次感）
  if (Array.isArray(p.layers)) {
    for (const L of p.layers) {
      const mat = hairMaterial(style.color ?? 0x241d1f);
      mat.userData.shade = 0.9;
      const mesh = new THREE.Mesh(
        buildHairSurface({ ...p, segU: Math.round(p.segU * 0.7), segV: Math.round(p.segV * 0.7) },
          L.lenScale ?? 0.5, L.volume ?? 1.05),
        mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      materials.push(mat);
    }
  }

  // 马尾
  if (p.extra === 'ponytail') {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.50, -0.30),
      new THREE.Vector3(0, 0.36, -0.68),
      new THREE.Vector3(0.02, 0.00, -0.80),
      new THREE.Vector3(-0.02, -0.45, -0.74),
      new THREE.Vector3(0, -0.90, -0.55),
    ]);
    const mat = hairMaterial(style.color ?? 0x1e1a1c);
    const tail = new THREE.Mesh(
      taperedTube(curve, (t) => 0.145 * (1 - 0.72 * t * t) + 0.012, 48, 14), mat);
    tail.frustumCulled = false;
    group.add(tail);
    materials.push(mat);

    // 发根扎起来的小鼓包
    const knotMat = hairMaterial(style.color ?? 0x1e1a1c);
    const knot = new THREE.Mesh(ensureVertexColor(new THREE.SphereGeometry(0.13, 20, 14)), knotMat);
    knot.position.set(0, 0.50, -0.32);
    group.add(knot);
    materials.push(knotMat);
  }

  // 丸子头
  if (p.extra === 'bun') {
    const mat = hairMaterial(style.color ?? 0x241c20);
    const bun = new THREE.Mesh(ensureVertexColor(new THREE.SphereGeometry(0.25, 26, 18)), mat);
    bun.scale.set(1.0, 0.86, 0.94);
    bun.position.set(0, 0.62, -0.20);
    group.add(bun);
    materials.push(mat);

    const bandMat = hairMaterial(style.color ?? 0x241c20);
    const band = new THREE.Mesh(ensureVertexColor(new THREE.TorusGeometry(0.15, 0.035, 10, 24)), bandMat);
    band.rotation.x = Math.PI / 2;
    band.position.set(0, 0.46, -0.16);
    group.add(band);
    materials.push(bandMat);
  }

  group.userData.materials = materials;
  return group;
}

/** 换发色：保持每个 mesh 自身的明暗关系 */
export function applyHairColor(group, hex) {
  const list = group?.userData?.materials || [];
  for (const m of list) {
    const shade = m.userData.shade ?? 1;
    const c = new THREE.Color(hex);
    c.multiplyScalar(shade);
    m.color.copy(c);
    m.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* 极简演示发型：用"圆柱 + 圆锥"拼一个短发                              */
/* 用途：① 作为一眼能看懂的"已知可显示"造型；② 当你怀疑程序化曲面     */
/*       有问题时，可先在 UI 里选「演示发型」或开测试模型定位问题。      */
/* 坐标系与程序化发型一致：头骨中心为原点，+Y 头顶，+Z 面部朝向。        */
/* ------------------------------------------------------------------ */
export function buildSimpleHair(style) {
  const group = new THREE.Group();
  group.name = `hair_demo_${style?.id || 'simple'}`;
  const materials = [];

  const mat = hairMaterial(style?.color ?? 0x241d1f);
  materials.push(mat);

  // 1) 头顶发块：一个略收口圆柱，盖住上半头
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(HEAD.rx * 1.04, HEAD.rx * 1.10, HEAD.ry * 0.95, 28, 1, false),
    mat
  );
  cap.position.set(0, HEAD.ry * 0.34, 0);
  cap.scale.z = HEAD.rz / HEAD.rx;        // 压扁成头形（前后略扁）
  cap.frustumCulled = false;
  group.add(cap);

  // 2) 后脑勺补一块，让背面也像头发
  const back = new THREE.Mesh(
    new THREE.SphereGeometry(HEAD.rx * 1.06, 24, 16, 0, Math.PI * 2, Math.PI * 0.32, Math.PI * 0.55),
    mat
  );
  back.position.set(0, HEAD.ry * 0.05, -HEAD.rz * 0.18);
  back.scale.set(1, 1, HEAD.rz / HEAD.rx);
  back.frustumCulled = false;
  group.add(back);

  // 3) 一圈短"发刺"（圆锥）围在发际线，强化"头发"观感
  const spikes = 22;
  for (let i = 0; i < spikes; i++) {
    const u = (i / spikes) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.22, 8), mat);
    const x = Math.sin(u) * HEAD.rx * 1.02;
    const z = Math.cos(u) * HEAD.rz * 1.02;
    spike.position.set(x, HEAD.ry * 0.02, z);
    // 朝外并略微向下
    const out = new THREE.Vector3(x, -0.25, z).normalize();
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
    spike.frustumCulled = false;
    group.add(spike);
  }

  group.userData.materials = materials;
  return group;
}

/** 释放显存 */
export function disposeGroup(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
      else o.material?.dispose?.();
    }
  });
}
