# CANON 与 Hardware Knowledge Mining 融合报告

## 结论

复用 CANON 的“源文件 → Canonical IR”作为知识挖掘方案的标准化工程层。在其上增加独立、版本化的知识产物，不创建第二套 EDA parser，不修改源设计。PDF 作为另一类证据输入，与原理图逻辑网络严格分开。

## 原有代码分析

- lib/eda/kicad.ts：S-expression/Legacy 解析、几何连通性、PCB 显式 Pad-Net。已有确定性解析基础，但不等同于 KiCad 原生网表导出。
- lib/eda/parse.ts：适配器调度、资产指纹、跨文档链接、完整性报告，是融合入口。
- lib/eda/types.ts：Part/Pin/Net/PCB/SourceRef 已足以承载工程层；新增 PDF 证据字段保持旧 Bundle 可读。
- components/EdaViewers.tsx：原理图、PCB、BOM、网络查看器直接保留。
- lib/database.ts：原有项目/Bundle 存储复用，并修正 ID 的工作区隔离、事务写入。
- 原 API 允许伪造租户头和匿名 local-demo 写入；新版本改为服务端固定工作区与 Bearer 密钥，默认拒绝云端读写。
- 发现现代 KiCad 符号局部 Y 轴未翻转，会让竖向管脚偏离实际导线；新增符号专用坐标转换，不改 PCB/Legacy 坐标路径。

## 本轮已实现

1. Canonical IR → EngineeringGraph；优先原理图逻辑域，只有缺少逻辑管脚时才使用 PCB 物理域。两域不重复叠加。
2. IC 位号/管脚数量启发式 Anchor Detection，MCU 按管脚语义分组。
3. 有边界的外围器件搜索：公共电源/地不继续扩展、另一核心 IC/连接器作为边界、保留评分理由与待确认状态。
4. 成员/角色/端口审核；编辑后重算端口；批准前检查待确认项、连接证据和人工确认。
5. 保存原始候选、可编辑审核快照、乐观锁 revision；只有 APPROVED 能变为 PUBLISHED。编辑已批准/已发布内容会退回候选。
6. 发布查询 API，仅返回当前工作区已发布功能块。
7. PDF.js 实际文字提取、页码、文字框、SHA256、位号候选；扫描型文档提示 OCR_REQUIRED。不会生成 PDF netlist。
8. CLI 按项目批量处理、原文件内容寻址保存、完成标记、哈希/版本缓存、错误日志、独立进程超时。
9. AD9837/TPS5430/STM32 合成解析 fixture，及 CI。

## 尚未达到的原方案范围

这是一轮可运行的融合增量，不是上传方案全部 Phase 0–6 的完成声明：

- PDF 矢量图形/符号/管脚识别与连线重建、扫描 OCR 未实现。
- Datasheet 引脚表、公式、参数条件、布局规则、IC Knowledge Pack 未实现。
- Anchor 分类是启发式；不声称识别所有 IC。通用 N-hop 之外增加了语义分组、共享轨道停止、排他性及距离因素，但尚无数据手册模板匹配。
- 层级 Sheet、Bus、镜像、多单元/替代符号仍有解析限制；新增诊断，相关工程的候选禁止批准。
- 聚类、拓扑同构、Template/Variant、仿真与 ProtoPCB Materialize 未实现。
- 没有 Redis/BullMQ/MinIO 或分布式调度服务；CLI 是本轮批处理执行入口。
- 前端可审核已解析 Bundle；数据库保存的是 IR/知识，原始文件长期存储仅由 CLI 提供。
- 共享访问密钥不区分不同审核人；审计记录标识工作区和 revision，不伪造个人身份。

## 验证边界

24 项解析/知识测试、2 项渲染/API 测试已运行通过；Vercel 和原 vinext 构建已通过。三种合成输入首次完成、二次命中缓存。
没有用户真实 Golden-100 / 3000 项目，因此不能声称 99% 连接准确率或 90% 功能块准确率。当前环境没有用户数据库配置，未验证真实 Neon 写入。云浏览器拒绝访问本地预览，未完成真实浏览器交互验收；构建与服务器渲染测试不能替代该验收。

## 下一步验收

先接入 10–20 个真实项目（尤其旋转/多页/多单元符号），用 KiCad CLI 导出的网表做对照。优先补齐原生网表校验与层级实例，再扩大到 Golden-100。PDF 的网络恢复应单独验收，通过后才进入同一工程图谱。
