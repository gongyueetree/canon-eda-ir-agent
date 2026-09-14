# 部署融合版

沿用本仓库的 Next.js/Vercel 配置，不需要新建仓库，不会自动部署 Sites。

1. Vercel 导入本仓库，Root Directory 保持根目录。已有项目等待 main 自动构建即可。
2. 设置服务端变量 `DATABASE_URL`（Neon/PostgreSQL HTTP 兼容连接）、`EDA_API_TOKEN`（至少 24 字符的随机密钥）、`EDA_WORKSPACE_ID=gongyueetree`。
3. 运行 migrations/0001_eda_parser.sql 和 0002_hardware_knowledge.sql。当前代码首次访问也会幂等建表；生产建议提前迁移。
4. 重新部署。在页面顶部“工作区访问密钥”输入同一 EDA_API_TOKEN。密钥只保存在当前页面内存，不写入 LocalStorage；刷新后需要重新输入。
5. 打开合成示例或上传真实工程，选择“知识挖掘 / 审核”，保存候选，处理待确认成员，勾选证据确认，再批准和发布。

## 行为变化

旧的 x-eda-tenant / oai-authenticated-user-email 请求头不再作为身份依据。未配置密钥时，云端读写拒绝访问；本地解析/导出仍可用。这是单工作区共享访问密钥方案，并非企业级多用户登录/角色权限系统。
旧记录仍留在原有数据库表。历史使用 local-demo 或邮箱租户的记录不会自动转移；请由数据库管理员核对归属后迁移，或重新导入 Bundle。

## 3000 工程批处理

不要把 3000 个工程合并成一次浏览器上传。准备 manifest.json：

```json
[
  {"path":"/data/references/design-a"},
  {"path":"/data/references/design-b.zip","conversionSource":"ALTIUM","conversionTool":"你的转换工具","conversionVersion":"版本","originalFileHash":"原文件 SHA256"}
]
```

```bash
npm ci
npm run mine:batch -- manifest.json outputs/mining
```

每个目录/ZIP 是独立项目。顺序启动独立 Node 子进程，堆限制 1536 MB、单项目 180 秒，失败后继续，状态落盘。再次执行同一命令会跳过已完成且版本/内容未变化的项目。输出目录不要位于输入项目目录内部。

输出包含 `raw/` 内容寻址原文件、raw-manifest.json、bundle.json、knowledge.json、complete.json、batch-status.json。不要删除 raw/，它是审核证据的原始文件来源。此 CLI 不执行工程脚本，不自动上传文件或调用 LLM。

将单个 bundle.json 上传到网页即可浏览、挖掘和入库。也可以带 Authorization Bearer 请求 POST /api/knowledge/mine；大于 3.5 MB 的 Bundle 暂时只支持本地导出。Vercel 不运行持续队列；批处理进程运行在本地机器或独立服务器。没有配置自动 Cron 或付费后台任务。

## 数据与资源

浏览器上传的原始文件留在本机；保存候选会保存 Canonical Bundle、候选与审核快照，不会将原始 ZIP/PDF 二进制保存到数据库。需要长期保留原文件时使用 CLI 的 raw/ 并备份。对象存储上传和分布式队列尚未实现。

PDF 限制：30 MB、100 页、100000 文本对象、60 秒。PDF.js Worker 由 npm postinstall 复制到 public/，同源加载，不依赖 CDN。
