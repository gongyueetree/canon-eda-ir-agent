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

## API

```text
GET  /api/projects        数据库状态与最近工程
POST /api/projects        保存 Canonical IR Bundle
GET  /api/projects/{id}   读取最新 Bundle
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
