# 发型模型文件夹（public/models/hair/）

把你的 **.glb / .gltf** 发型模型放在这个文件夹里，然后在同目录的
**`hairDatabase.json`** 中登记一项（填 `modelUrl` 指向文件）即可被网页加载。

## 命名与路径约定

- 推荐文件名尽量用英文、无空格，例如 `bob.glb`、`long_wave.glb`、`ponytail.glb`。
- `hairDatabase.json` 里的 `modelUrl` 用**相对于网站根目录**的路径，例如：
  `"./public/models/hair/bob.glb"`。
- 模型**缺失或加载失败**时，程序会自动回退到该条目里写的 `params`（程序化发型），
  所以即使还没下载模型，界面也能正常显示。

## 模型朝向约定（很重要）

加载后程序会按包围盒把模型居中并缩放到"头宽 = 1"。你的模型最好满足：

- **+Y = 头顶**，**+Z = 面部正前方**，**原点 ≈ 头骨中心**。
- 如果朝向不对（比如脸朝后、或上下颠倒），在 `hairDatabase.json` 里给该条目加：
  `"modelRotY": 3.14159`（绕 Y 转 180°）、或 `"modelRotX"` / `"modelRotZ"` 微调。
- 如果整体位置偏了，用界面右下「发型位置微调」的 **X / Y / Z** 滑块实时拖，
  或在该条目写 `"modelOffset": { "x": 0, "y": 0.06, "z": 0 }` 做永久修正。

## 一键接入脚本（推荐）

手写 `hairDatabase.json` 容易出错，项目中已提供 `tools/add_hair_model.mjs`，
自动完成「复制/下载 → 校验 → 写库」：

```bash
# 从本地文件接入
node tools/add_hair_model.mjs --file "路径/bob.glb" --id bob3d --name "波波头" --cat medium

# 直接从下载直链接入（脚本负责下载）
node tools/add_hair_model.mjs --url "https://.../hair.glb" --id longwave3d --name "大波浪长发" --cat long --color "#3a2a22"
```

常用参数：`--id`（必填，唯一）、`--name`（必填）、`--cat`（short/medium/long，可逗号分隔）、
`--color`（兜底发色）、`--width`（以头宽为单位，默认 1.08）、`--rotY`（绕 Y 角度，度）、
`--ox/--oy/--oz`（初始偏移）。脚本会自动避开同名覆盖（文件名加 `-v2`），
并把一条完整条目追加进 `hairDatabase.json`。校验失败（非合法 glTF）会报错退出，不污染数据库。

接入后到网页 `http://localhost:5500` 刷新，用 X/Y/Z 滑块把发型对齐到头顶即可。

## 去哪里找免费模型

见项目根目录 `README.md` 第 5 节「获取真实 3D 发型模型」的网站清单。
下载到的模型建议先确认是**可商用授权**（CC0 / CC-BY 等），再放进本项目。
