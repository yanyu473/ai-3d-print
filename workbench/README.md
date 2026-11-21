# 本机 3D 打印工作台

Windows 上双击项目根目录的 `启动工作台.cmd`。已启动时可直接打开 [工作台](http://127.0.0.1:4790/)。运行时、建模依赖和切片引擎已放在 E 盘项目内。工作台仅使用本机地址，照片、原始描述和产物在本机处理。

## 三种输入

| 入口 | 适用内容 | 产物 |
|---|---|---|
| 文字 | 加强角码、电子盒底座、四孔安装板、矩形板、圆柱和垫圈。输入毫米尺寸，例如 `加强角码，长 48 mm，宽 38 mm，高 36 mm，壁厚 4 mm，孔径 5 mm`。 | 可复核的尺寸规格、STEP、STL、GLB |
| 拍照 | 允许浏览器使用本机摄像头，正对一件薄片拍摄，或者选用已拍的 JPEG、PNG 或 WebP。 | 由照片像素生成的 STL、GLB |
| 图片 | 上传带明显前景、均匀背景或透明背景的单件正面轮廓。支持 JPEG、PNG、WebP，限 10 MB。 | 由图片像素生成的 STL、GLB |

照片与图片都须填写实测宽度及希望生成的厚度。工作台从像素提取可见外轮廓及通孔，按宽度换算比例，然后等厚拉伸。背景干净、轮廓留边充分、拍摄角度垂直时更容易取得正确轮廓。复杂曲面、物体背面和透视校正未覆盖。文字在本机将支持的描述解析为参数化 CAD，未提供的可选孔径和孔距会在参数报告中注明模板来源。

三维视窗下方的样件库可打开加强角码、电子盒底座和环形垫圈。样件卡由实际 GLB 渲染。角码的两组安装孔分别穿过底板和立板，内部有一条三角加强筋。盒体有开顶内腔，四根螺丝柱的导孔保留孔底。选择「剖切」可拖动高度看内部，关闭后恢复完整视图。

加强角码、电子盒底座、环形垫圈分别生成 180、100、30 层离线刀路。复验还对角码的高度和孔径、盒体的柱径和孔径做了重建，并核对新旧文件。 [工作台截图](../evidence/workbench/specimen-studio.png) · [盒体剖切](../evidence/workbench/specimen-tray-section.png) · [立体样件验收](../evidence/workbench/structural-pipeline.log) · [浏览器记录](../evidence/workbench/specimen-visual.log)

## 结构选项

打开角码或电子盒样件，在右侧「结构选项」组合实际 CAD 特征。角码支持无筋、中央单筋或双筋，底板和立板各自支持无孔、两孔或四孔。电子盒支持单仓、双仓或三仓，可独立切换四角螺丝柱和侧壁出线口。调整尺寸后，工作台会检查安装孔是否碰到板边和加强筋，以及隔板是否碰到螺丝柱。

「预览结构」生成可旋转、可剖切的临时三维模型。确认后点击「应用并重建」，工作台将为新结构重新执行 DFM 检查和切片并归档。「恢复参数」会回到当前归档版本，「上一版」可在新版本中打开来源项目。 [双筋四孔预览](../evidence/workbench/variants-bracket.png) · [三仓出线口预览](../evidence/workbench/variants-tray.png) · [浏览器验收](../evidence/workbench/variants-browser.log)

按样件默认尺寸验收了角码的 27 种和电子盒的 12 种组合。每种配置均核验 STEP 和闭合网格，并达到通用预设的离线切片条件。双筋四孔角码及三仓出线盒分别生成 180 层和 100 层刀路。 [结构验收记录](../evidence/workbench/variants-geometry.log) · [浏览器重建与返回上一版记录](../evidence/workbench/variants-rebuild-browser.log)

## 制造检查与归档

每次提交创建项目，并依次建模、DFM 检查和离线切片。DFM 核对模型哈希、模型尺寸、基底、闭合性、体积、刻意支持的拉伸厚度和可测孔边距。阻断项目保留输入、模型和报告，不生成 G-code。完整自交、任意局部壁厚、支撑、公差及真机兼容性会显示为未检查。

选中模型后，右侧显示该模型支持的独立参数。平板、圆柱和垫圈支持即时几何预览，照片网格可即时缩放。角码和盒体还可调整高度、壁厚和孔径。工作台应用修改后复检、切片和归档新版本。照片版本保留原图字节和新的尺寸参数。

切片默认使用通用 PLA 预设，幅面 220 × 220 × 250 mm，喷嘴 0.4 mm，层高 0.20 mm，填充率 15%。重建可选择 0.08–0.30 mm 层高和 0–100% 填充率。配置与模型、制造检查报告及 G-code 一起归档，页面可逐层查看实际挤出路线。待打印机确定后需要换成匹配机型、喷嘴和固件的配置再进行真机验收。

历史记录位于 `E:\AI-3D-Print\data\workbench\<项目 ID>`。每个目录保留原始输入、工艺配置、模型和参数、检查报告、切片和处理日志。重启工作台可继续查看和下载，历史项目可以载入输入后生成新版本。

## 复验

在项目根目录运行下列命令。集成测试建立独立测试目录并用本机测试端口，避免写入正式历史。

```powershell
& .\.tools\node.exe --test .\workbench\tests\test-workbench.mjs
$env:OPENBLAS_NUM_THREADS = '1'
& .\.venv\Scripts\python.exe -B -m unittest discover -s .\workbench\tests -p 'test_*.py' -v
```

集成测试使用本地 JPEG 和 PNG 样件检验两个影像通道，核对三种输入的模型、DFM、切片及下载哈希，并覆盖薄件阻断、尺寸调整后生成新版本和重启后找回历史。 [集成测试日志](../evidence/workbench/api-integration.log) · [几何与检查测试](../evidence/workbench/python-tests.log)

本机浏览器验收覆盖桌面和 390 px 窄屏。四孔板独立修改长度与孔径后导出了新 STL，更改层高为 0.25 mm、填充率为 25% 后生成了 20 层 G-code。「上一版」可回到原尺寸与工艺。相机入口用模拟视频流核验抓拍和切片，PNG 上传测试将透明区域建成了两个通孔。 [桌面截图](../evidence/workbench/studio-desktop.png) · [实时调整截图](../evidence/workbench/studio-live-resize.png) · [窄屏截图](../evidence/workbench/studio-mobile.png) · [浏览器验收](../evidence/workbench/studio-browser.log) · [端到端验收](../evidence/workbench/studio-pipeline.log)

## 参考来源

- V4.0 Demo 提供工作台布局、参数编辑、历史及分层滑块的交互参考。 [V4.0 对照记录](../docs/v4-reference.md)
- CAD 采用现有 build123d 环境。参考 Text-to-CAD 上游的结构化参数和几何生成思路。 [Text-to-CAD](https://github.com/earthtojake/text-to-cad) · [build123d](https://github.com/gumyr/build123d)
- 照片处理采用图像分割与轮廓生成思路，本地实现依赖 Pillow、NumPy、SciPy 和 trimesh。 [OpenCV 轮廓文档](https://docs.opencv.org/4.x/d4/d73/tutorial_py_contours_begin.html) · [摄像头接口规范](https://www.w3.org/TR/mediacapture-streams/)
- 切片继续使用已锁定的 OrcaSlicer 衍生 WASM。 [上游仓库](https://github.com/kimgh06/Three_Slicer) · [切片依赖与许可](../slicer-wasm/README.md)
- 本机 Node 运行时为 v24.22.3，复制自本机已安装的 Codex 运行环境，已核对文件哈希与 Windows 签名。 [Node.js 许可](../.tools/LICENSE-Node.js.txt)
