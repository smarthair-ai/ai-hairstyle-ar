/**
 * add_hair_model.mjs —— 一键把真实 3D 发型模型接入项目
 *
 * 用途
 * ----
 * 你从 Meshy / Sketchfab / Poly Pizza / CG美术之家 等网站下载到一个 .glb（或 .gltf）
 * 模型后，用本脚本：
 *   1) 把模型文件放进  public/models/hair/   （支持本地文件 or 直接给下载 URL）
 *   2) 自动校验它是合法的 glTF（.glb 校验 magic，.gltf 校验可解析 JSON）
 *   3) 自动往  public/models/hair/hairDatabase.json  里追加/更新一条记录
 *   4) 打印后续在网页里用 X/Y/Z 滑块对齐的说明
 *
 * 模型缺失时网页会自动回退到程序化兜底发型，不会报错；对齐请用网页里的滑块或改
 * hairDatabase.json 里的 modelOffset / modelRotY / modelWidth。
 *
 * 运行方式（在 ai-hairstyle-ar/ 根目录执行）
 * ----
 *   # 从本地文件接入
 *   node tools/add_hair_model.mjs --file "D:/下载/bob.glb" --id bob3d --name "波波头" --cat medium
 *
 *   # 直接从下载链接接入（脚本负责下载）
 *   node tools/add_hair_model.mjs --url "https://example.com/hair.glb" --id longwave3d --name "大波浪长发" --cat long --color "#3a2a22"
 *
 * 参数
 * ----
 *   --file <path>      本地模型文件路径（与 --url 二选一）
 *   --url  <url>       模型下载直链（与 --file 二选一）
 *   --id   <id>        唯一 id，必填，例如 bob3d（与已有 id 重复则覆盖更新）
 *   --name <name>      显示名，必填，例如 "波波头"
 *   --cat  <cats>      分类：short / medium / long，可逗号分隔，例如 "medium,long"
 *   --color <hex>      发色，例如 "#241d1f"（仅用于回退程序化发型时的颜色）
 *   --width <num>      模型宽度（以「头宽」为单位，默认 1.08；偏大就调小）
 *   --rotY <deg>       绕 Y 轴初始旋转角度（度，默认 0；模型朝向不对就调它）
 *   --ox/--oy/--oz     初始偏移（头宽单位，默认 0,0.06,0）
 *   --tag  <str>       标签文案，例如 "真实模型"
 *   --desc <str>       描述
 */

import { createWriteStream } from 'node:fs';
import { open, mkdir, copyFile, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HAIR_DIR = join(__dirname, '..', 'public', 'models', 'hair');
const DB_PATH = join(HAIR_DIR, 'hairDatabase.json');

// —— 不同分类的程序化兜底参数（模型缺失时用它画一个近似发型）——
const GENERIC_PARAMS = {
  short: { volume: 1.1, frontPhi: 1.0, sidePhi: 1.4, backPhi: 1.78, frontLen: 0.14, sideLen: 0.06, backLen: 0.08, wave: 0.02, waveFreq: 2, curl: 0.004, part: 1, taper: 0.8 },
  medium:{ volume: 1.12, frontPhi: 0.98, sidePhi: 1.5, backPhi: 1.86, frontLen: 0.3, sideLen: 0.4, backLen: 0.5, wave: 0.03, waveFreq: 2, curl: 0.004, part: 1, taper: 0.78 },
  long:  { volume: 1.15, frontPhi: 0.96, sidePhi: 1.55, backPhi: 1.9, frontLen: 0.6, sideLen: 0.9, backLen: 1.1, wave: 0.05, waveFreq: 3, curl: 0.006, part: 1, taper: 0.7 },
};
const FACE_SHAPES = ['oval', 'round', 'square', 'oblong', 'heart', 'diamond', 'pear'];
const NEUTRAL_FIT = Object.fromEntries(FACE_SHAPES.map((s) => [s, 0.8]));

// —— 极简参数解析 ——
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    opt[key] = val;
  }
}
const need = (k) => { if (opt[k] === undefined) { console.error(`✗ 缺少必填参数 --${k}`); process.exit(1); } };

need('id');
need('name');
if (!opt.file && !opt.url) { console.error('✗ 必须提供 --file 或 --url 之一'); process.exit(1); }
if (opt.file && opt.url) { console.error('✗ --file 与 --url 只能选一个'); process.exit(1); }

const id = String(opt.id).trim();
const name = String(opt.name).trim();
const cats = (opt.cat ? String(opt.cat) : 'medium').split(',').map((s) => s.trim()).filter(Boolean);
const color = opt.color ? String(opt.color) : '#241d1f';
const width = opt.width ? parseFloat(opt.width) : 1.08;
const rotYdeg = opt.rotY ? parseFloat(opt.rotY) : 0;
const ox = opt.ox ? parseFloat(opt.ox) : 0;
const oy = opt.oy ? parseFloat(opt.oy) : 0.06;
const oz = opt.oz ? parseFloat(opt.oz) : 0;
const tag = opt.tag ? String(opt.tag) : '真实模型';
const desc = opt.desc ? String(opt.desc) : `真实 3D 模型（${name}）。模型缺失时自动回退到程序化兜底发型。`;

// 校验分类合法性
const VALID_CATS = ['short', 'medium', 'long'];
for (const c of cats) if (!VALID_CATS.includes(c)) { console.error(`✗ 未知分类 "${c}"，只能是 ${VALID_CATS.join(' / ')}`); process.exit(1); }
const primaryCat = cats[0];

async function ensureDir() { await mkdir(HAIR_DIR, { recursive: true }); }

async function resolveTargetName() {
  // 根据来源决定文件名
  let base;
  if (opt.file) base = basename(opt.file);
  else base = basename(new URL(opt.url).pathname) || `${id}.glb`;
  if (!/\.(glb|gltf)$/i.test(base)) base = `${id}.glb`;
  return base;
}

async function download(url, dest) {
  process.stdout.write(`  → 下载: ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  // 用 pipeline 自动处理背压与结束，避免手动 end 回调的坑
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    received += chunk.length;
    if (total) process.stdout.write(`\r     已下载 ${(received / 1e6).toFixed(2)} / ${(total / 1e6).toFixed(2)} MB`);
  });
  await pipeline(src, createWriteStream(dest));
  if (total) process.stdout.write('\n');
  return received;
}

async function validate(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.glb') {
    const buf = Buffer.alloc(4);
    const fd = await open(path, 'r');
    try { await fd.read(buf, 0, 4, 0); } finally { await fd.close(); }
    const magic = buf.readUInt32LE(0);
    if (magic !== 0x46546c67) throw new Error('不是合法的 .glb（magic 应为 glTF）');
    return 'glb';
  }
  if (ext === '.gltf') {
    const txt = await readFile(path, 'utf8');
    const json = JSON.parse(txt); // 解析失败会抛错
    const buffers = json.buffers || [];
    const external = buffers.filter((b) => b.uri && !b.uri.startsWith('data:'));
    if (external.length) {
      console.warn('  ⚠ 该 .gltf 引用了外部资源（.bin / 贴图），请手动把配套文件也放进 public/models/hair/，否则网页加载会缺资源。');
    }
    return 'gltf';
  }
  throw new Error(`不支持的扩展名：${ext}（只支持 .glb / .gltf）`);
}

async function main() {
  await ensureDir();
  const targetName = await resolveTargetName();
  const dest = join(HAIR_DIR, targetName);

  // 避免覆盖已有同名文件
  let finalName = targetName;
  try { await stat(dest); finalName = targetName.replace(/(\.[a-z0-9]+)$/i, `-v2$1`); }
  catch { /* 文件不存在，直接用原名 */ }
  const finalDest = join(HAIR_DIR, finalName);

  console.log(`接入发型：'${name}' (id=${id}, 分类=${cats.join('/')})`);
  if (opt.file) {
    console.log(`  → 复制本地文件: ${opt.file}`);
    await copyFile(opt.file, finalDest);
  } else {
    await download(opt.url, finalDest);
  }

  const kind = await validate(finalDest);
  console.log(`  ✓ 校验通过（${kind}）`);

  // 读取 / 初始化数据库
  let db;
  try { db = JSON.parse(await readFile(DB_PATH, 'utf8')); }
  catch { db = { version: 1, note: '发型数据库：真实模型与程序化发型索引', categories: [], models: [] }; }
  if (!Array.isArray(db.models)) db.models = [];

  const modelUrl = `./public/models/hair/${finalName}`;
  const entry = {
    id,
    name,
    category: primaryCat,
    tag,
    desc,
    color,
    modelUrl,
    modelWidth: width,
    modelOffset: { x: ox, y: oy, z: oz },
    modelRotY: rotYdeg,
    fit: { ...NEUTRAL_FIT },
    params: { ...(GENERIC_PARAMS[primaryCat] || GENERIC_PARAMS.medium) },
  };

  const idx = db.models.findIndex((m) => m.id === id);
  if (idx >= 0) { db.models[idx] = entry; console.log(`  ✓ 已更新已有记录 id=${id}`); }
  else { db.models.push(entry); console.log(`  ✓ 已新增记录 id=${id}`); }

  await writeFile(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf8');

  console.log('\n—— 完成 ——');
  console.log(`  模型文件: public/models/hair/${finalName}`);
  console.log(`  数据库条目已写入: public/models/hair/hairDatabase.json`);
  console.log('\n下一步对齐（在浏览器 http://localhost:5500 ）：');
  console.log('  1) 刷新页面，点分类按钮找到并加载该发型。');
  console.log('  2) 用「发型位置微调」卡片的 X / Y / Z 滑块把发型拖到头顶。');
  console.log('  3) 若整体偏大/偏小，调小/调大 modelWidth（在 hairDatabase.json 里，或我们可加滑块）。');
  console.log('  4) 若模型朝向歪了，改 modelRotY（度）。');
  console.log('  例：node 工具里加 --width 0.95 --rotY 180 可一次设好默认值。');
}

main().catch((e) => { console.error('✗ 失败：', e?.message || e); process.exit(1); });
