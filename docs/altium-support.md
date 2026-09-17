# Altium Designer 原生导入（部分支持）

Parser 1.5.2：已接入 Models/Data 和 ComponentBodies6，按模型 ID 提取内嵌 zlib STEP 并关联到封装，支持绝对位置、旋转、底面投影和一器件多模型。浏览器沿用 STEP Worker 转换，同一模型仅转换一次。每个模型解压限制 32 MiB、累计限制 150 MiB。必须重新导入源 PcbDoc；保存的旧 IR 不含新模型引用。

Nano_Debug 实测：20 个 STEP 文件全部转换成功，53 个器件共有 54 个模型实例（J1 两个），模型放置后顶点/包围盒有限值检查通过。未对每一个模型进行 AD 原生渲染的像素级对照。

直接上传含 `.PrjPcb`、`.SchDoc`、`.PcbDoc` 的 ZIP。CFB 解析在本地运行，不运行 AD，不访问原文件中的绝对路径、数据库链接或全局库。无需 AD 授权服务。单个 CFB 容器限制 64 MiB。

支持的原理图记录：器件及当前显示模式/单元、文本引脚、器件字段、厂商和 MPN、导线、连接点、网络名称、矩形、线段、多段线、椭圆和圆弧。引脚连接位置包含引脚长度，使用源记录的绝对位置，AD 的 Y 向上坐标转为 IR 的 Y 向下坐标。文本暂用统一字号；电源目前保留名称与连接点，未完整绘制源电源样式。

支持的 PCB 记录：Components6、Nets6、Pads6、Tracks6、Vias6、Board6。网络使用显式 Net ID；板框圆弧采样近似。原理图与 PCB 唯一同位号匹配后补充封装字段。库容器依旧只做安全摄取。

未完整支持：二进制引脚变体、跨页端口/总线/线束、部分文本布局和图元、覆铜、圆弧走线、特殊焊盘、完整叠层、盲埋孔层范围、规则与非 STEP/外链 3D 模型装配。不能用于生产签核或替代 AD/ERC/DRC。诊断和 fidelity 必须保持 partial，缺失模型不能标为加载成功。

验证样本：用户 Nano_Debug AD 工程，53 个原理图器件、201 个有效引脚、161 条导线；53 个 PCB 封装、209 个焊盘、1497 条直线走线、56 个过孔、50 个 PCB 网络。用户工程不纳入仓库。自动测试使用合成 CFB 文档覆盖归属索引、显示模式过滤、引脚端点、网络连接与损坏记录回退。

格式参考：KiCad 的公开 Altium 导入器，`eeschema/sch_io/altium/altium_parser_sch.cpp` 与 `pcbnew/pcb_io/altium/altium_parser_pcb.cpp`（https://github.com/KiCad/kicad-source-mirror）。本实现独立使用 TypeScript 编写。CFB 容器读取使用 SheetJS `cfb`。
