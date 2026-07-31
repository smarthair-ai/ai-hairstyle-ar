# assets/models 说明

这个目录用来存放两类文件（**发型模型是可选的，人脸模型建议放一份**）：

## 1. 离线人脸检测模型（强烈建议）

⚠️ **重要事实**：`face_landmarker.task` 模型官方**只发布在 Google Cloud Storage**
（`https://storage.googleapis.com/mediapipe-models/...`），它**不在**任何 npm 包里
（网上常说的 `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm/face_landmarker.task`
实测是 404，因为该 npm 包的 wasm/ 目录只有 4 个 WASM 运行时文件）。
国内访问 Google 常被墙，所以网页"自动从 CDN 下载模型"这一步很可能失败。

**最稳的做法：把模型放到本地，完全离线运行。**

### 方式 A：一键下载（推荐，不用手动找文件）
在项目根目录执行（用项目自带的 Node 即可）：

```bash
node tools/download_model.mjs
```

脚本会尝试多个源把 `face_landmarker.task` 下载到本目录。
下载成功后刷新网页，程序会优先用本地文件，不再联网。

### 方式 B：手动放置
从任意可访问的源拿到 `face_landmarker.task`，保存为：

```
assets/models/face_landmarker.task
```

### 加载优先级（见 js/faceTracker.js）
1. 本地 `./assets/models/face_landmarker.task`（HEAD 探测，存在即用，可完全离线）
2. `js/config.js` 里 `modelCandidates` 数组中的远程候选源（按顺序尝试，第一个可用即用）
3. 全部失败 → 弹出明确错误，提示运行上面的下载脚本

> 如果你找到了国内可访问的镜像地址，把它加到 `config.js` 的 `modelCandidates`
> 数组**最前面**即可自动生效，无需改其它代码。

## 2. 你自己的 3D 发型模型（.glb / .gltf，可选）

把模型放进本目录，然后在 `js/hairstyles.js` 对应发型上加：

```js
modelUrl: './assets/models/你的模型.glb',
modelWidth: 1.08,                      // 模型宽度 ÷ 头宽
modelOffset: { x: 0, y: 0.06, z: 0 },  // 单位：头宽
```

模型朝向约定：**+Y 朝头顶，+Z 朝面部正前方，原点位于头骨中心**。
程序会按包围盒自动居中和缩放，再叠加上面的偏移量。
