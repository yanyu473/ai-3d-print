# OrcaSlicer 衍生 WASM 切片探针

这是 G0 的离线替代探针。它用 `three-slicer@0.4.3` 在 Node 内运行 OrcaSlicer 衍生的模型切片内核。原版 OrcaSlicer CLI、具体机型配置和设备联调单独验收。

切片输入来自本项目 CAD 探针产出的 `model.stl`。脚本要求同目录存在 `verification.json`，重新核对 STL 的 SHA-256、二进制 STL 格式及模型尺寸。输出包括 G-code、层高与路径段统计、切片参数快照、时间及耗材估算。脚本交叉检查每层的 G-code 挤出动作、层高和所有线性移动坐标。

`toolpath-preview.json` 绑定 G-code 的 SHA-256，按层记录实际挤出线段的 XY 起终点，单位为 mm。验证报告也记录预览文件的 SHA-256。项目样件是 60 × 40 × 5 mm 四孔安装板，已验证产出 25 层和 6,534 段挤出路径。

预设为便于重放的通用离线条件，幅面 220 × 220 × 250 mm，层高 0.20 mm，0.40 mm 喷嘴及 PLA 估算密度。该预设没有目标机型、固件和启动/归零宏，生成的 `toolpath.gcode` 仅供离线检查。设备适配及耗材实际用量需要另行验证。

## 重放

在 `E:\AI-3D-Print` 中运行。需要 Python 3.12 和 Node 24。

```powershell
# 本地引擎已存在时可跳过第一条命令。
& .\.tools\python\python.exe .\slicer-wasm\provision.py --registry https://registry.npmmirror.com
node .\slicer-wasm\probe.mjs .\evidence\cad .\evidence\slicing-wasm-replay
```

## 来源与许可

- npm 镜像通过 HTTPS 下载固定的 0.4.3 tarball。提取前按 SHA-512 校验。该完整性值上的 ECDSA 签名已使用 npm 公共注册表的公钥验证，见 [npm 公钥](https://registry.npmjs.org/-/npm/v1/keys)和 [签名规范](https://docs.npmjs.com/about-registry-signatures/)。
- 发布元数据标记上游提交 `70e03a8a54786d4215776b36ce4e70caa076e213`。运行的是发布包内的 headless 入口，需要随包保留 `engine` 的 WASM 文件，无需安装浏览器查看器。 [上游提交](https://github.com/kimgh06/Three_Slicer/commit/70e03a8a54786d4215776b36ce4e70caa076e213)
- 切片器发布包保留自身 `LICENSE.txt` 和 `THIRD-PARTY-NOTICES.md`。上游声明 `AGPL-3.0-or-later`。后续网络部署或对外分发前，需按拟使用方式审核条款。 [切片引擎仓库](https://github.com/kimgh06/Three_Slicer)
