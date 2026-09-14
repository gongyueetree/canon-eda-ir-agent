# CANON · EDA Canonical IR Agent

CANON 是一个只读、确定性的 EDA 工程解析 Agent。它在浏览器中安全摄取 KiCad、Altium、嘉立创EDA / EasyEDA 文件，生成统一、版本化并可追溯到源对象的 Canonical IR。

当前 MVP 输出：

- Project IR
- Schematic IR
- PCB IR
- Part IR
- Net IR（Schematic Logical / PCB Physical 分域）
- Constraint / Library 占位与来源记录
- Source Asset Inventory、Source Map、Parse Diagnostics
- Fidelity / Completeness Report
- Part ↔ Footprint、Pin ↔ Pad、Logical Net ↔ PCB Net 链接

## 在线查看器

解析完成后可直接在浏览器中查看：

- **原理图**：按文档/Sheet 切换，显示 Symbol、Pin、Wire、Junction、Label，并可按网络高亮。
- **PCB 2D**：显示板框、Footprint、Pad、Track、Via，支持图层显隐、网络高亮与缩放。
- **PCB 3D**：使用 Three.js/WebGL 从闭合 Edge.Cuts 生成可旋转、缩放的板体，显示按源尺寸绘制的焊盘和钻孔。
- **BOM**：按 Value、Footprint、MPN 和装配状态合并，支持搜索、过滤与 CSV 下载。
- **Netlist**：显示逻辑/物理网络、具体 Endpoint 和跨文档链接，支持搜索、展开与 CSV 下载。

3D 页面是基于 Canonical PCB IR 的板级几何预览，不加载或渲染 STEP/WRL 实体模型。KiCad 与 EasyEDA Standard 的已规范化几何可直接显示；JLCEDA Pro 显示当前已映射 Record。Altium 二进制 SchDoc/PcbDoc 目前仍是 CFB 结构级摄取，页面会明确显示不可视原因，不会伪造器件或连线。生产级 Altium 在线查看需要完整的版本化 CFB Record Adapter，或由 Altium 导出 IPC-2581 / ODB++ / Gerber、BOM、Netlist 等开放交换数据。

## 真实能力边界

| 格式 | 当前能力 | 说明 |
| --- | --- | --- |
| KiCad 5–9+ | 语义解析 | Legacy `.pro` / `.sch` 与现代 `.kicad_pro` / `.kicad_sch` / `.kicad_pcb`；器件、Pin、Wire、Junction、Label、PCB Layer、Footprint、Pad、Track、Via、Zone、Board Outline、板宽/板高/板厚、显式 Net |
| EasyEDA 标准版 | 结构解析 | JSON / 多文档、受限深度遍历、转义 Shape 扫描、显式结构化器件字段、Unknown Shape 保留 |
| JLCEDA / EasyEDA Pro | 流式摄取 | JSONL 逐行解析、异常行与未知 Record 保留；完整 Shape 连通性仍是后续阶段 |
| Altium | 安全摄取 | `.PrjPcb` ASCII 元数据；SchDoc/PcbDoc/Lib 的 CFB/OLE 签名检查、Hash 与 Opaque Record 保留。MVP 不声称完整解析专有 Record |

核心解析不调用 LLM，不执行工程内脚本、宏、插件或 Output Job；不会自动访问全局库或公网，也不会修改或写回源工程。

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm ci
npm run dev
```

打开 `http://localhost:3000`。未设置数据库时应用运行在“本地只读模式”，解析、浏览与 JSON 导出仍可使用。

## PostgreSQL / Neon

复制 `.env.example` 为 `.env.local`，设置：

```bash
DATABASE_URL=postgresql://user:password@host.neon.tech/database?sslmode=require
```

首次访问 `/api/projects` 时会幂等创建以下最小生产表：

- `eda_projects`
- `eda_parse_jobs`
- `eda_ir_bundles`

同一 SQL 也位于 `migrations/0001_eda_parser.sql`。生产环境应在部署流程中先执行 Migration，并在 API 前增加租户鉴权策略；当前 MVP 使用 OpenAI Sites 身份邮箱或 `local-demo` 作为租户键。

## 部署到 Vercel

1. 将仓库导入 Vercel。
2. 在 Project Settings → Environment Variables 设置 `DATABASE_URL`。
3. Vercel 会读取 `vercel.json` 并执行 `npm run build:vercel`。
4. 部署后访问 `/api/projects`；返回 `configured: true` 即数据库连接成功。

Vercel 构建输出经过 `next build` 验证。应用同时保留 vinext/Sites 构建，用于 Cloudflare Worker 兼容部署：

```bash
npm run build          # vinext / Sites
npm run build:vercel   # Next.js / Vercel
```

## 安全摄取限制

- 压缩包最大 75 MB，解压后最大 200 MB；单文件最大 50 MB。
- 最多 5,000 个 ZIP Entry；单项与总体压缩比最大 200:1。
- 拒绝绝对路径、`..`、Windows 盘符、Symlink、加密 ZIP。
- 嵌套压缩包只作为 Opaque 附件保留，不继续解压。
- S-expression 最大深度 256，最大 2,000,000 Token。
- EasyEDA 对象遍历最大深度 32、最大 250,000 节点。
- 上传工程由浏览器解析；只有用户点击“保存 Bundle”时才把规范化 IR 发送至自己的数据库 API。

## 确定性连通性

KiCad 原理图使用坐标图构建 Net：

1. Wire endpoint、Pin anchor、Label anchor 和 Junction 进入图。
2. Wire endpoint 相接或落在另一个 Segment 上时连接。
3. 显式 Junction 可连接两个 Segment 内部交叉点。
4. 两条 Wire 仅在内部交叉且没有 Junction 时不连接。
5. No Connect 坐标不会被输出为普通 Net endpoint。
6. 同一连通分量的多个标签会产生诊断，不会静默覆盖。

PCB 只使用源文件显式 Net ID 建立 Physical Net。跨文档 Net Link 必须存在 RefDes + Pin/Pad Number 证据；只有名称相同的链接最多标为 `probable`。

Net IR 的 `endpoints` 与 `segmentIds` 保存具体对象 ID，而不只是计数。界面可展开每条网络，查看 Symbol Pin、Label、Pad、Track、Via、Zone 以及跨文档链接。PCB IR 根据顶层及 Footprint 内的 `Edge.Cuts` 计算外接尺寸、边界框、板厚与闭合状态；开放板框只报告外接尺寸并产生诊断，不猜测面积或周长。

## IR 保存与下游使用

解析完成后，左侧 `IR DOMAINS` 可直接切换 Project、Schematic、PCB、Part 和 Net IR。每个领域页面都支持复制或下载独立 JSON；`IR JSON` 页还提供：

- 完整 Canonical Bundle JSON
- 包含五类独立 IR、完整 Bundle 与读取示例的 ZIP 数据包
- 数据库保存后的完整 Bundle API 与分领域 API

独立文件采用统一信封结构：`schema`、`schemaVersion`、`irType`、Bundle/Project 元数据、`entityCount` 和 `data`。Net IR 的 `data` 同时包含 `nets` 与 `crossDocumentLinks`，便于下游系统解析网络端点及原理图到 PCB 的链接。

下载不依赖数据库。配置 `DATABASE_URL` 并点击“保存 Bundle”后，可通过 API 集成到 PLM、BOM、DFM、审查和搜索服务。

## API

```text
GET  /api/projects        数据库状态与最近工程
POST /api/projects        保存 Canonical IR Bundle
GET  /api/projects/{id}   读取最新 Bundle
GET  /api/projects/{id}?domain=project    读取 Project IR
GET  /api/projects/{id}?domain=schematic  读取 Schematic IR
GET  /api/projects/{id}?domain=pcb        读取 PCB IR
GET  /api/projects/{id}?domain=part       读取 Part IR
GET  /api/projects/{id}?domain=net        读取 Net IR 与 Cross-document Links
```

完整规格中的 Source Package API、任务队列、取消/重试、事件流、对象存储、Diff 和 Adapter Registry 是后续生产阶段，不在此 Web MVP 中伪装实现。

## 验证

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build:vercel
```

演示工程包含显式 Junction 和一个无 Junction 的 Wire Cross。当前预期结果是 2 个器件、2 个 Footprint、4 个 Schematic Logical Net（包括两个匿名独立分量）、2 个 PCB Physical Net，以及 2 条由 Pin/Pad 证据验证的跨文档 Net Link。

## 后续优先级

1. KiCad hierarchy / sheet instance、Bus、Hidden Power Pin 与完整库快照。
2. EasyEDA Standard Shape 语义矩阵与 Pro 项目 Manifest。
3. 受限 Altium CFB FAT/DIFAT/Stream Reader 与版本化 Record Parser。
4. 对象存储、任务队列、增量解析、Replay、Semantic Diff、多租户鉴权与审计。
5. 独立 Worker 沙箱、资源配额、公开/合成 Golden Fixtures、Fuzz 与大工程 Benchmark。

V1 始终保持 `read_only`。在通过严格 Round-trip Test 之前，不应声称可以无损写回任何源格式。


---

## 新增：硬件知识挖掘融合版

本仓库现在在原有 Canonical IR 上增加**知识挖掘 / 审核**工作台：核心 IC、管脚功能分组、候选功能块、成员/端口边界、源证据、批准与发布。可以继续查看原有原理图、PCB、BOM 和 Netlist。

上传 `.pdf` 时会实际提取文字、页码、坐标和位号候选；**尚不恢复 PDF 电路连接**。原有 `.json` 输入也可导入 Canonical Bundle，包括批处理输出。

**部署变化：必须新增服务端 EDA_API_TOKEN（至少 24 字符）和 EDA_WORKSPACE_ID。旧文档中匿名 local-demo 与用户指定租户头的做法已废止。** 未配置密钥的网页仍可本地解析与导出，但不能访问数据库。打开页面后在顶部输入工作区密钥，再保存/审核。

- [融合分析与能力边界](docs/MERGE_REPORT.md)
- [Vercel 配置与 3000 工程批处理](docs/DEPLOYMENT.md)
- [数据模型](docs/DATA_MODEL.md)
- [挖掘算法](docs/MINING_ALGORITHM.md)
- [API](docs/API.md)
- [验证与真实工程验收](docs/TESTING.md)

```bash
npm run mine:batch -- fixtures/mining/manifest.json outputs/mining
```

三个例子为合成解析测试，不是真实厂商参考设计。没有接入用户 3000 个工程，也不声称完成 Golden-100 验收。


### 1.2.0 查看器与审核修复

更新部署后请重新导入原始 KiCad 工程（ZIP 或文件集）。旧的已保存 Bundle 没有子页框、符号图形、焊盘旋转和钻孔数据，不能通过刷新自动补全。

- 原理图保留层级子页框和接口名称，可打开已导入的对应子页；现代 KiCad 嵌入库的矩形、折线、圆、圆弧及引脚线段参与绘制。层级电气连接、多单元与镜像连接限制仍由诊断报告，未据此放开知识发布。
- PCB 按毫米比例显示焊盘、过孔和走线，保留焊盘方向和钻孔，并显示源封装丝印/制造层基本图形；可切换位号和焊盘文字。
- 3D 使用真实板框生成板体，支持旋转、缩放和重置。未加载 STEP/WRL 器件实体，不绘制猜测的器件方块。未闭合/不支持的板框显示错误。覆铜、自定义焊盘与完整器件模型尚未完整呈现，不应据此验收制造尺寸。
- 核心 IC 明确标示为固定纳入；其他成员可修改。修改即时更新成员和端口，切换功能块或结果页签会保留草稿，导出包含草稿；无效输入会显示错误并阻止导出/提交。刷新浏览器或离开工程前请导出或提交草稿。
- “保存候选到知识库”保存原始候选后保留本地修改，再以“保存修改”提交当前功能块。云端审核仍需要已配置的数据库和访问密钥；连接证据不足时不能批准。

回归测试含成员选择、切换功能块后保留修改、导出修改结果、层级子页几何、旋转焊盘和圆弧。尚未使用用户截图所对应的 OpenScope 源工程进行浏览器/WebGL 视觉验收。
