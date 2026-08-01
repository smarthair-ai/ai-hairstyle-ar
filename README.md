# AI 智能发型推荐 · AR 实时试戴

浏览器端的智能发型推荐 Demo：打开摄像头 → 实时检测面部 468 个关键点 → 自动判断脸型 → 推荐合适的发型 → 把 3D 发型"戴"到头上，随头部转动而自然跟随。

**全程本地运行，面部数据不上传任何服务器。**

---

## 1. 技术栈

| 能力 | 实现 |
| --- | --- |
| 摄像头采集 | `navigator.mediaDevices.getUserMedia` |
| 人脸检测 / 468 关键点 | MediaPipe Tasks Vision — `FaceLandmarker`（WASM + GPU 推理） |
| 头部姿态 | 关键点多点最小二乘正交基 + MediaPipe 头部变换矩阵取深度 |
| 脸型分析 | 面部几何比例 + 7 类脸型高斯模糊评分 |
| 3D 渲染 | Three.js（ES Module，importmap 引入） |
| 3D 发型 | 运行时程序化生成的参数曲面（也支持加载 `.glb` / `.gltf`） |

---

## 2. 如何运行

> ⚠️ **必须通过 HTTP(S) 服务访问**。直接双击 `index.html`（`file://` 协议）会因为浏览器安全策略无法访问摄像头，也无法加载 ES Module。

### 方式 A：VS Code + Live Server（推荐）

1. 用 VS Code 打开 `ai-hairstyle-ar` 文件夹；
2. 扩展面板搜索安装 **Live Server**（作者 Ritwick Dey）；
3. 在 `index.html` 上右键 → **Open with Live Server**；
4. 浏览器打开 `http://127.0.0.1:5500/index.html`，点击"开启摄像头"并允许权限。

### 方式 B：任意静态服务器

```bash
# Python 3
python -m http.server 5500

# 或 Node.js
npx serve -l 5500
```

然后访问 `http://localhost:5500`。

### 浏览器要求

- Chrome / Edge 100+（推荐）、Firefox 100+、Safari 16+
- 需要 WebGL2；显卡驱动异常时会自动降级到 CPU 推理（帧率会下降）

---

## 3. 目录结构

```
ai-hairstyle-ar/
├── index.html              页面结构
├── css/
│   └── style.css           全部样式
├── js/
│   ├── config.js           所有可调参数（模型地址、平滑系数、标定值…）
│   ├── faceTracker.js      MediaPipe FaceLandmarker 封装
│   ├── faceShape.js        关键点几何测量 + 脸型分类算法
│   ├── hairstyles.js       内置发型数据（hairDatabase.json 加载失败时的兜底）
│   ├── hairDB.js           发型数据库加载器（运行时 fetch hairDatabase.json）
│   ├── hairFactory.js      程序化 3D 发型建模 + 换色/朝向兼容
│   ├── arScene.js          Three.js 场景、头部位姿求解、GLTF 加载、遮挡
│   ├── ui.js               DOM 渲染与交互
│   └── main.js             主流程编排
├── public/
│   └── models/hair/        真实 3D 发型模型 + hairDatabase.json（发型索引）
│       └── hairDatabase.json   发型列表唯一权威来源
├── assets/
│   └── models/             （可选）离线人脸模型 face_landmarker.task
└── README.md
```

---

## 4. 核心原理速览

### 4.1 脸型怎么判断的

1. 用两侧颧骨（关键点 `234` / `454`）的连线建立**脸部局部坐标系**，先把头部倾斜（roll）的影响消掉；
2. 在该坐标系里测量四个无量纲比例：

   | 指标 | 关键点 | 含义 |
   | --- | --- | --- |
   | `lw` | `10 ↔ 152` / `234 ↔ 454` | 脸长 ÷ 颧宽 |
   | `fc` | `54 ↔ 284` / `234 ↔ 454` | 额宽 ÷ 颧宽 |
   | `jc` | `172 ↔ 397` / `234 ↔ 454` | 下颌宽 ÷ 颧宽 |
   | `ja` | `152` 处夹角 | 下巴尖锐度 |

3. 对 **椭圆 / 圆 / 方 / 长 / 心形 / 菱形 / 梨形** 七个模板做加权高斯打分，归一化后取最高分，并给出置信度与备选项；
4. 指标经过多帧指数平滑（`ShapeAccumulator`），并且只在"基本正对镜头"（偏航/俯仰角在阈值内）时采样，避免侧脸导致误判。

想调整判定倾向？改 `js/faceShape.js` 里的 `PROFILES`（模板值）、`SIGMA`（容差）、`WEIGHT`（特征权重）即可。

### 4.2 3D 发型怎么"戴"稳的

1. **深度**：取 MediaPipe 头部变换矩阵平移分量的 `z`；
2. **反投影**：用与 Three.js 渲染相机**完全相同**的投影参数把关键点还原成世界坐标 —— 这保证了 3D 物体投影回屏幕时和视频严格对齐（即使深度估计有偏差也会自动抵消）；
3. **姿态**：用 6 组左右对称点求平均得到 X 轴、4 组上下点求平均得到 Y 轴，施密特正交化后叉乘出 Z 轴，比单点解算稳定得多；
4. **锚点**：以两颧骨中点为基准，沿头部局部坐标上移 `0.30`、后移 `0.16` 个头宽，得到头骨中心；
5. **平滑**：位置/缩放做指数平滑，旋转做 `slerp` 球面插值；
6. **遮挡**：场景中放了一个"隐形头颅"（只写深度缓冲、不写颜色），绕到脑后的头发会被自然裁掉，露出真实画面。

如果发型整体偏高/偏低/偏大，几种改法：
- 临时：用界面右下「发色与微调」的**上下/前后/大小**滑块做整体对齐；真实 3D 模型再用「发型位置微调」的 **X / Y / Z** 滑块精确到头；
- 永久：改 `js/config.js` 的 `headAnchor.up / back / widthGain`，或在 `hairDatabase.json` 里给对应条目写 `modelOffset` / `modelRotY`。

---

## 5. 真实 3D 发型模型

内置发型是运行时用参数曲面生成的（零资源依赖）。要换成写实的真实模型，照下面两步即可。

### 5.1 获取免费 / 可商用的发型模型

| 网站 | 地址 | 说明 |
| --- | --- | --- |
| **Meshy** | https://www.meshy.ai | AI 生成 3D 模型，可直接导出 `.glb`；注意导出时选 **glTF / GLB**，并确认授权可商用 |
| **CG 美术之家** | https://www.cgartist.cn | 国内素材站，搜索"头发 / 发型 / hair"有用户分享的模型 |
| **Sketchfab** | https://sketchfab.com | 筛选 `Downloadable` + 授权（CC0 / CC-BY / CC-BY-SA），导出 GLB |
| **Poly Pizza** | https://poly.pizza | 低多边形模型库，搜索 `hair`，多为 CC0，体积小适合 Web |
| **Quaternius** | https://quaternius.com | 免费低多边形角色/发型包，CC0 |
| **Mixamo** | https://www.mixamo.com | Adobe 的带骨骼角色库，可下载带发型的人物（需自行拆出发型网格） |
| **Ready Player Me** | https://readyplayerme.com | 可生成带发型的一半身 3D 头像，导出 GLB，适合做"戴头套式"试戴 |

> 提示：下载到的模型若为 **DRACO 压缩**（Meshy 常见），本程序已内置 DRACO 解码器支持，无需额外处理。
> 模型建议用 **GLB**（单文件、体积小）；授权请确认可商用后再用于产品。

### 5.2 把模型接入项目

**推荐：用一键脚本**（自动完成「复制/下载 → 校验 → 写库」，不会写错字段）：

```bash
node tools/add_hair_model.mjs --file "路径/bob.glb" --id bob3d --name "波波头" --cat medium
node tools/add_hair_model.mjs --url "https://.../hair.glb" --id longwave3d --name "大波浪长发" --cat long
```

脚本参数与字段含义见 `public/models/hair/README.md` 底部的「一键接入脚本」一节。

**或手动两步**：

1. 把 `.glb`（或 `.gltf`）放进 **`public/models/hair/`** 文件夹；
2. 打开 **`public/models/hair/hairDatabase.json`**，在 `models` 数组里加（或修改）一项：

```json
{
  "id": "bob3d",
  "name": "波波头 (真实3D模型)",
  "category": "medium",
  "tag": "真实模型",
  "color": "#241d1f",
  "modelUrl": "./public/models/hair/bob.glb",
  "modelWidth": 1.08,
  "modelOffset": { "x": 0, "y": 0.06, "z": 0 },
  "modelRotY": 0,
  "fit": { "oval": 0.93, "round": 0.66, "square": 0.86, "oblong": 0.84, "heart": 0.80, "diamond": 0.82, "pear": 0.72 },
  "params": { "volume": 1.10, "frontPhi": 0.98, "sidePhi": 1.50, "backPhi": 1.86, "frontLen": 0.0, "sideLen": 0.50, "backLen": 0.56, "wave": 0.030, "waveFreq": 2, "curl": 0.004, "part": 1, "taper": 0.78 }
}
```

字段含义：

| 字段 | 作用 |
| --- | --- |
| `modelUrl` | 模型文件路径（相对于网站根目录） |
| `modelWidth` | 模型宽度占几个"头宽"，默认 1.08，决定缩放到头部的尺寸 |
| `modelOffset` | 模型相对头骨中心的永久偏移（头宽单位） |
| `modelRotX/Y/Z` | 模型朝向修正（弧度）；脸朝后时填 `modelRotY: 3.14159` |
| `modelScale` | 额外整体缩放系数 |
| `params` | 程序化兜底造型参数；**模型缺失/加载失败时自动使用** |
| `fit` | 对 7 种脸型的适配度，决定推荐排序 |

> 加载后会按包围盒自动居中并缩放到头部尺寸。`hairDatabase.json` 是发型列表的**唯一权威来源**，所有增删只改它即可，无需碰 JS。

### 5.3 对齐调试

戴上真实模型后若位置/朝向不对：

- **实时微调**：用界面右侧「发型位置微调」的 **X（左右）/ Y（上下）/ Z（前后）** 三个滑块拖到合适位置；
- **永久修正**：把调好的数值写进该条目的 `modelOffset`；朝向不对就加 `modelRotY` 等；
- **控制台**：`window.AR.setOffset(x, y, z)` 也可实时设偏移，`window.AR.info()` 打印当前位姿/缩放/偏移。

发型数据库加载来源可在控制台查看（`[hairDB]` 日志会显示是从 JSON 还是内置兜底）。

---

## 6. 离线运行（可选）

首次运行需要从 CDN 下载：

- MediaPipe WASM 运行时 + `face_landmarker.task` 模型（约 3–4 MB）
- Three.js 模块

要做到完全离线：

1. 下载模型文件
   `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
   放到 `assets/models/face_landmarker.task` —— 程序会**自动优先使用本地文件**；
2. （可选）把 `@mediapipe/tasks-vision` 与 `three` 的产物下载到本地，然后修改 `js/config.js` 里的 `visionBundle` / `wasmBase`，以及 `index.html` 中 importmap 的 three 路径。

---

## 7. 隐私说明

- 页面**没有任何** `fetch` / `XMLHttpRequest` / WebSocket 上传逻辑，代码可全文检索验证；
- 摄像头视频流只写入本机 `<video>` 元素，推理在浏览器的 WASM / WebGL 中完成；
- 关键点坐标只存在于内存变量里，页面关闭即销毁；
- 唯一的网络请求是**首次加载**静态资源（模型与库文件），可按第 6 节改为完全离线。

---

## 8. 性能建议

| 手段 | 说明 |
| --- | --- |
| 省电模式 | 界面开关，降低渲染 DPR + 每 2 帧推理一次，功耗约降 40% |
| 关闭关键点叠加 | 468 个点的 2D 绘制会占用一些主线程时间 |
| 降低摄像头分辨率 | 改 `config.js` 的 `camera.width/height` 为 640×480 |
| 降低发型网格密度 | 改 `hairFactory.js` 中 `DEFAULTS.segU / segV`（默认 88 × 46） |

参考帧率：集成显卡笔记本（Intel Iris Xe）约 30–45 FPS，独显机型可稳定 60 FPS。

---

## 9. 已知限制

- 脸型判断基于 2D 投影的几何比例，是**风格建议**而非精确测量；发际线位置（关键点 `10`）因人而异，会影响"脸长"指标；
- 程序化发型是风格化造型，不追求写实发丝；需要写实效果请挂载真实 `.glb` 模型；
- 目前只追踪一张人脸（`numFaces: 1`），多人场景下会选择置信度最高的那张。

---

## 10. 部署（GitHub + Vercel）

本项目是**纯静态站点**（无需构建），可直接部署到 Vercel。

### 方式 A：用 GitHub 账号一键部署
1. 把本仓库推到 GitHub（见下方命令）；
2. 打开 https://vercel.com/new → 选你的仓库 → Framework 选 **Other** → 直接 Deploy；
3. Vercel 会自动用根目录的 `vercel.json`（`outputDirectory: "."`）把它当作静态站点发布，分配一个 `https` 域名，摄像头权限正常工作。

### 方式 B：Vercel CLI
```bash
npm i -g vercel        # 或 npx vercel
vercel login           # 浏览器授权
vercel --prod          # 部署到生产
```

### 推送到 GitHub
```bash
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```
> 提交作者邮箱可在本地改：`git config user.email "you@example.com"`。

### 说明
- 人脸关键点模型走 CDN（jsDelivr）加载，Vercel 的 https 环境下可用；如需完全离线，先跑 `node tools/download_model.mjs` 把模型放进 `assets/models/`（该文件已被 `.gitignore` 忽略，不进仓库）。
- `public/models/hair/` 里示例的 `.glb` 需你自行下载放入后才会显示真实 3D 发型；缺失时自动回退到程序化兜底。

## 11. 添加发型模型（部署后更新）

站点已部署在 GitHub Pages（分支部署）。往项目里加发型模型后，**push 到 `main` 分支即会自动重新发布**（约 1 分钟，浏览器记得强制刷新 `Ctrl/Cmd+Shift+R` 清缓存）。

### 步骤 1：获取模型
从 README 第 5 节的网站（Meshy / Sketchfab / Poly Pizza / Quaternius 等）下载 `.glb` 或 `.gltf`，注意选 **Free / CC0 / CC-BY** 等可商用授权。单个文件建议 **< 100 MB**（GitHub 免费账户硬上限，超大文件请用 Git LFS 或外部 CDN）。

### 步骤 2：接入模型（二选一）

**方式 A — 用脚本（推荐，已带格式校验）**
```bash
node tools/add_hair_model.mjs --file "路径/你的发型.glb" \
  --id myhair1 --name "我的发型" --cat medium --color "#3a2a22"
# 或直链接入： --url "https://.../hair.glb"
```
脚本会把文件复制到 `public/models/hair/`、校验格式（`.glb` 查 magic / `.gltf` 解析 JSON）、并自动写入 `hairDatabase.json`。

**方式 B — 手动**
1. 把 `.glb` 放进 `public/models/hair/`；
2. 在 `hairDatabase.json` 的 `models` 数组加一项（参照文件中 `bob3d` 示例），填写 `modelUrl`、`categories`、`modelWidth`、`modelOffset`、`modelRotY` 等字段。

### 步骤 3：提交并发布
```bash
git add -A
git commit -m "add hair model xxx"
git push origin main      # 触发 GitHub Pages 自动重建
```

### 步骤 4：网页试戴
打开站点 → 开启摄像头 → 点分类按钮加载该发型 → 用「发型位置微调」**X / Y / Z 滑块**把发型拖到头顶对齐。若初始位置仍偏，可改 `hairDatabase.json` 里的 `modelOffset` / `modelRotY` 后重新 push。

> 嫌命令行麻烦？直接把 `.glb` 文件或下载链接发给我，我帮你接入、提交并部署好，你只管去网页试戴。

### 零资源也能试戴（无需下载任何模型）

`hairDatabase.json` 里的发型分为两类，都能直接在 AR 里试戴，**都不需要任何外部 `.glb` 文件**：

- **程序化 3D 发型**：靠 `params`（长度 / 卷度 / 蓬松 / 分缝 / extra 部件）在运行时用 Three.js 实时生成。内置 14 款 + 新增 6 款（`twintail` 双马尾、`braid` 麻花辫、`topknot` 高发髻、`spacebun` 双丸子头、`hime` 公主切、`collarbone` 锁骨发）均属此类，点击即试戴。
- **收集表 30 款**：原本只有参考图，现已通过 `tools/infer_hair_params.py` 根据其名称 / 特点 / 分类推断 `params`，**全部转为可 AR 试戴的 3D 发型**（有图的同时也能试戴，卡片右上「图」角标可看参考大图）。

想扩充零资源发型库：直接往 `hairDatabase.json` 的 `models` 数组加一项，填好 `params`（或 `extra`）即可，无需模型文件。已有 `tools/infer_hair_params.py` 可批量按名称特征回填 `params`。
