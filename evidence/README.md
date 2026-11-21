# G0 本机验收记录

| 检查 | 结果与证据 |
|---|---|
| 四孔安装板 | 真实 STEP 实体量得 60 × 40 × 5 mm，四个通孔均为 Ø4 mm。X/Y 孔中心距 46/26 mm 来自样件设定。STL、GLB 重读后均为一个闭合网格。 [CAD 核验](cad/verification.json) |
| 参数重建 | 厚度由 5 mm 改为 7 mm，实际重建 STEP、STL 和 GLB，更新哈希并保留原版本。通过越界孔径和目录重复写入回归检查。 [CAD 测试](cad-tests.log) |
| 离线切片 | 采用 OrcaSlicer 衍生的 `three-slicer@0.4.3`，从上面同一 STL 得到 25 层、6,534 段正向挤出。每段轨迹与 G-code 逐项相符。通用配置估算 35 分 38 秒、5.45 g 耗材。 [切片核验](slicing-wasm/verification.json) |
| 一键复跑 | 已从默认 CADSpec 重建并再次切出相同 SHA-256 的 STL、G-code 和分层预览数据。 [命令输出](offline-replay.log) |
| 网页样件 | Chrome 桌面和 360 px 窄屏验证真实 GLB 和分层滑块。第 1 层为 Z 0.20 mm 的密集表层，第 14 层为 Z 2.80 mm 的稀疏填充。HTTP 自检验证了模型与刀路的文件哈希。 [网页自检](preview-http.log) · [桌面三维](../preview/qa/desktop-glb.jpg) · [窄屏刀路](../preview/qa/mobile-360-layer-14.png) |
| 原版 OrcaSlicer | Windows 便携版下载安装遇到网络握手失败。已验证获取与校验脚本的哈希拒绝行为，以及合成多层数据的提取和挤出校验。原生切片待验证。 [下载日志](slicing/orca-download.log) · [原版包装测试](slicing/orca-wrapper-test.log) |
| 设备状态 | OctoPrint 和 Moonraker 通过 9 项本机样例响应测试。实体状态读取等待首台打印机品牌、机型、连接方式和地址。 [探针测试](printer-probe-tests.log) |

切片结果绑定在通用测试配置和样件版本上，目标打印机、固件启动流程及耗材仍待核对。G-code 头部标注了离线用途。
