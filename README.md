# AI 3D 打印工作台

项目保存在 `E:\AI-3D-Print`。双击 `启动工作台.cmd` 即可打开文字、拍照与图片工作台，从输入运行到建模、DFM 检查、离线切片和历史归档。 [打开本机工作台](http://127.0.0.1:4790/) · [运行与验收说明](workbench/README.md)

完整架构和设备适配见 [实施架构](docs/architecture.md) 与 [设备支持表](docs/device-support.md)。V4.0 Demo 的参考用法见 [V4.0 对照](docs/v4-reference.md)。下方保留早期独立探针和 [G0 样件验收记录](evidence/README.md)。

## 复跑 CAD 样件

在 PowerShell 中运行以下命令。默认规格为 60 × 40 × 5 mm、四个 Ø4 mm 通孔，X/Y 方向的孔中心距取 46/26 mm，已在规格文件中标为样件假设。尺寸来自命令所读的 CADSpec。

```powershell
Set-Location E:\AI-3D-Print
.\tools\run-cad.ps1
```

脚本生成新目录 `evidence/replays/cad-*`，其中保留输入、校验报告和 STEP、STL、GLB。校验会重新读入实际文件，测量外形、孔径、孔位、深度和体积，并检查网格闭合和法线方向。可复制 [样件规格](cad-worker/fixtures/mounting-plate.json) 后调整数值，使用 `-Spec` 指向新文件。指定 `-Output` 时，请使用新目录。

依赖由 [uv.lock](uv.lock) 锁定。运行时位于 `.tools/python`，可用 `.\tools\run-cad.ps1 -Install` 恢复依赖。安装使用 Python 3.12 x64、uv 和锁定的清华 PyPI 镜像。只运行已安装的样件不需要访问网络或模型账号。

[Compose 示例](compose.yaml) 覆盖 G0 建模探针。装有 Docker 的环境可运行 `docker compose run --build --rm cad-probe`，输出至 `evidence/replays/cad-compose`。重跑可覆盖容器的 `--out` 参数并使用新目录。当前电脑未安装 Docker，实测入口为上面的 PowerShell 脚本。

## 三维预览和离线切片

打开 [本机样件工作台](http://127.0.0.1:4783/)。如服务已停止，在项目目录运行 `node .\preview\server.mjs`。三维标签页加载样件的 GLB 和核验报告，支持旋转与缩放。分层刀路标签页使用同一模型切片的挤出数据，逐层显示刀路。预览端口可用进程环境变量 `CAD_PREVIEW_PORT` 修改。

运行 `.\tools\run-offline.ps1` 可从 CADSpec 重新生成并切片，结果写入 `evidence/replays/offline-*`。离线切片使用锁定的 OrcaSlicer 衍生 WASM 引擎，产物保留输入 STL 的 SHA-256、层数据、机型配置假设、时间和耗材估算。生成的 G-code 用于验证刀路，目标设备兼容性待核验。原版桌面 CLI 的安装与探针见 [原版 OrcaSlicer 路径](slicer/README.md)。

## 只读打印机探针

取得设备类型及服务地址后，任选适用命令。无需 API 密钥的同网设备可省略 `--prompt-key`。密钥在本机终端输入，保存的 JSON 不含密钥或地址。

```powershell
& .\.tools\python\python.exe -B .\printer-gateway\probe.py octoprint --url 'http://打印机的局域网地址' --prompt-key --output .\evidence\octoprint-status.json
& .\.tools\python\python.exe -B .\printer-gateway\probe.py moonraker --url 'http://打印机的局域网地址:7125' --prompt-key --output .\evidence\moonraker-status.json
```

探针采用固定状态接口读取设备与任务字段。设备离线、权限有误或数据无法识别时会报告错误或未知状态。项目尚无实体设备回读。探针测试使用明确标记的本机样例响应。

## 自检

```powershell
& .\.venv\Scripts\python.exe -B -m unittest discover -s .\tests -v
& .\.tools\python\python.exe -B -m unittest discover -s .\printer-gateway -v
node .\preview\verify-preview.mjs
```

网页自检在预览服务运行时执行，会核对浏览器下载入口提供的五个文件的哈希，以及 G-code 与分层数据的对应关系。
