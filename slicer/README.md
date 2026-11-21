# OrcaSlicer 原生切片探针

这个探针用官方 Windows x64 便携版 OrcaSlicer `v2.5.0`，将单个 STL 按一组已匹配的机型、工艺和耗材预设切片。输出含切片 3MF、G-code、进程日志以及带哈希的 `report.json`。切片成功时会从 3MF 取出唯一打印板的 G-code，并核对多个 Z 高度上存在实际 XY 挤出走线。报告中的挤出量是代码中检测到的正向 E 轴位移，实际用料和打印质量需要用对应机器复核。

本机访问发布资产时出现 TLS 握手失败，原生 OrcaSlicer 的实际执行待验证。记录见 `evidence/slicing/orca-download.log`。

## 复现

从项目根目录打开 PowerShell。下载脚本只使用 OrcaSlicer 官方发布路径，并按官方资产列表的 SHA-256 校验 ZIP，然后解压到 `slicer/runtime/`。如果已有相同官方 ZIP，可以给 `-Archive` 指定文件路径。

```powershell
$orca = & .\slicer\install-orca.ps1
# 或使用已下载的官方 ZIP
$orca = & .\slicer\install-orca.ps1 -Archive 'E:\OrcaSlicer_Windows_V2.5.0_x64_portable.zip'
```

在 OrcaSlicer 中选择验收机器及喷嘴、对应工艺和 PLA 耗材，导出三个独立的预设 JSON。以下用 `slicer/presets/` 表示这些预设的存放位置。每次探针运行使用新的输出目录。

```powershell
& .\.tools\python\python.exe .\slicer\probe-orca.py `
  --orca $orca --stl .\evidence\cad\model.stl `
  --machine .\slicer\presets\machine.json `
  --process .\slicer\presets\process.json `
  --filament .\slicer\presets\pla.json `
  --output .\evidence\slicing\orca-native
```

出现错误时查看输出目录的 `cli-output.log` 和 `orca.log`。探针只生成本地文件。原生切片结果仍需核对机型、固件和材料，且需完成真机验收。

[官方发行版及资产摘要](https://github.com/OrcaSlicer/OrcaSlicer/releases/expanded_assets/v2.5.0) · [命令行文档](https://github.com/OrcaSlicer/OrcaSlicer/wiki/cli_mode) · [预设导出说明](https://github.com/OrcaSlicer/OrcaSlicer/wiki/import_export#export-preset-bundle) · [AGPL-3.0 许可](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.5.0/LICENSE.txt)
