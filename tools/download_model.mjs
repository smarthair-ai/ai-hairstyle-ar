/**
 * download_model.mjs —— 一键把 MediaPipe 人脸关键点模型下载到本地（完全离线用）
 *
 * 背景：face_landmarker.task 模型官方只发布在 Google Cloud Storage
 * （https://storage.googleapis.com/...），国内常被墙，且不在任何 npm 包里。
 * 这个脚本在你的机器上运行，自动尝试多个源把模型存到 assets/models/。
 * 下载成功后，网页会优先用本地文件，无需联网、不受墙影响。
 *
 * 运行方式（在项目根目录 ai-hairstyle-ar/ 执行）：
 *   node tools/download_model.mjs
 *
 * 若默认源都被墙，可在下方 SOURCES 数组最前面加入你可达的镜像地址。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets', 'models', 'face_landmarker.task');

// 按顺序尝试；把你能访问的镜像加到最前面即可优先使用。
const SOURCES = [
  // 官方源（国内常被墙，但企业网络 / 代理可能可达）
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  // —— 以下为"尽力而为"的镜像候选，可能 404，按需替换为可靠源 ——
  // GitHub 代理镜像（需仓库确实含该文件）：
  'https://ghproxy.net/https://github.com/google-ai-edge/mediapipe/raw/master/mediapipe/modules/face_landmarker/face_landmarker.task',
  // HuggingFace 中国镜像（若对应仓库存在）：
  'https://hf-mirror.com/google/mediapipe/resolve/main/face_landmarker.task',
];

async function tryDownload(url) {
  process.stdout.write(`  → 尝试: ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  await mkdir(dirname(OUT), { recursive: true });
  const file = createWriteStream(OUT);
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      file.write(chunk);
      if (total) process.stdout.write(`\r     已下载 ${(received / 1e6).toFixed(2)} / ${(total / 1e6).toFixed(2)} MB`);
    }
    await new Promise((res, rej) => file.end((e) => (e ? rej(e) : res())));
  } catch (e) {
    file.destroy();
    throw e;
  }
  return received;
}

async function main() {
  console.log('准备下载 face_landmarker.task →', OUT);
  for (const url of SOURCES) {
    try {
      const size = await tryDownload(url);
      console.log(`\n✅ 下载完成（${(size / 1e6).toFixed(2)} MB）`);
      console.log('   刷新网页即可离线使用，无需再联网下载模型。');
      return;
    } catch (err) {
      console.log(`\n   ✗ 该源失败：${err.message}`);
    }
  }
  console.log('\n❌ 所有源都不可用。可能你的网络也无法直连 Google / 镜像。');
  console.log('   建议：在本机开启可访问 Google 的代理后重试本脚本，');
  console.log('   或手动把 face_landmarker.task 放到 assets/models/ 目录后刷新网页。');
  process.exit(1);
}

main().catch((e) => {
  console.error('下载脚本异常：', e);
  process.exit(1);
});
