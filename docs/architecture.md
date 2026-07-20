# Canonical EDA IR 架构

## 分层

```text
Raw Source
  ├─ immutable bytes / SHA-256 / archive manifest
  └─ security intake result
        ↓
Source Model
  ├─ KiCad S-expression AST + Source Span
  ├─ EasyEDA JSON / JSONL object tree + raw Shape
  └─ Altium project metadata / opaque CFB asset
        ↓
Canonical IR 1.0.0
  ├─ Project / Document Graph
  ├─ Schematic / Sheet / Symbol Unit
  ├─ PCB / Layer / Footprint / Pad / Track / Via / Zone
  ├─ Part / raw manufacturer & MPN fields
  ├─ Schematic Logical Net / PCB Physical Net
  └─ Source Map / Diagnostic / Fidelity
```

Raw Source、Source Model 与 Canonical IR 不共用身份。持久化实体使用稳定 Hash 派生 ID；缺少 Native UUID 时不会冒充 `native_stable`。

## 解析边界

- Wire 是几何，Net 是连通分量。
- Sheet Definition 和 Sheet Instance、Symbol Definition 和 Unit Instance、Part 和 Footprint Instance 分离。
- Schematic Logical Net 与 PCB Physical Net 分离。
- 同名 Net 不是确定性跨文档证据。
- Unknown Object 进入 Opaque Extension，并计入 Fidelity。
- 数值保留源 Token 字符串，Canonical 坐标明确单位 `mm`。

## MVP 数据库存储

Web MVP 将完整 Bundle 保存为 JSONB，同时把 Project 与 Parse Job 摘要建立关系索引。这种方式适合小项目和首版查询。大型生产工程应按主规格拆成 JSONL/Arrow + 对象存储 + PostgreSQL 邻接索引，避免把百万级几何复制到单个 JSONB。

## 生产扩展点

- Adapter Registry：格式、版本、验证日期、能力矩阵与已知缺口。
- Worker：无网、只读 Source Mount、CPU/内存/文件/时间上限。
- Storage：原始文件、Source AST、Canonical Bundle 分目录并内容寻址。
- Jobs：可取消、重试、Replay、Adapter 升级后 Reparse。
- Validation：Schema、Connectivity、Cross-document、Geometry、Variant。
- Events：`eda.parse.*` 与 `eda.ir.ready` 的版本化事件。
