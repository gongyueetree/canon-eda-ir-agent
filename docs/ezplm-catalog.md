# ezPLM 开源工程目录 → Canonical IR

## 使用

1. 部署时配置已有的 `EDA_API_TOKEN`（至少 24 字符）、`EDA_WORKSPACE_ID`，以及新的 `EZPLM_CATALOG_API_BASE`，后者必须为实际部署的 HTTPS `/api/v1` 基址。
2. 在顶部填写 EDAIR 工作区密钥，进入左侧“开源工程库”，使用 ezPLM 手机号/邮箱和密码连接账号。目录接口使用用户 Bearer 授权，**不能使用 BOM 接口的 EZPLM_API_KEY 替代**。本功能不调用平台 AI，不需要 AI 工作空间权限。
3. 按分类/子分类选择，或搜索名称与描述。每页 20 项，“加载更多”保留筛选并使用原样游标；不一次下载全部目录或所有工程。
4. 点击工程，在同页详情选择源链接，点击“提取 IR”。支持直接 ZIP、当前解析器支持的单个工程文件、公开 GitHub 仓库根 URL。GitHub 根 URL 会解析默认分支提交 SHA，再下载固定 SHA 的 ZIP。
5. 若原理图和 PCB 是独立源链接，可以勾选多份；优先使用包含项目库及 3D 的完整 ZIP。所选源文件不能同名。
6. 完成后自动进入现有解析工作台，查看原理图、PCB、BOM、器件资产、诊断，导出各类 IR，或配置数据库后保存 Bundle。

## 接口边界

依据上传的 `hardwired-architect-api.md`（2026-10-09）：

- GET `/catalog/categories` → 分类数组，ID 是 UUID 或 `uncategorized`。
- GET `/catalog/projects` → `data` + `meta.nextCursor / hasMore`。
- GET `/catalog/projects/{projectId}/ecad` → `sourceLinks / ecadUrl / altiumUrl / bomId / hasNetlist`。

**ecadUrl / altiumUrl 是查看器地址；hasNetlist 是标志，不是正文。** 本实现不抓取或猜测查看器内部的非文档接口。只有资料页/预览地址的项目显示预览链接，禁用直接提取；用户可从来源站点取得 ZIP 后使用“补充源文件并提取”，继续保留与目录项目的关联。要让所有 4000+ 项目均支持一键提取，平台必须为这些项目提供可下载的源工程链接；目录数量本身无法证明源文件覆盖率。

需要登录的私有 GitHub 仓库、需要额外鉴权的文件站点、无扩展名下载接口、Git LFS 内容和子模块不会被自动补齐；可上传完整工程 ZIP。没有伪造下载 API，也没有把项目描述调用 AI 后当成真实 IR。

## 服务端配置与文件下载

新增同源 API：

- GET / POST / DELETE `/api/catalog/session`：状态、登录、断开。
- GET `/api/catalog/categories`
- GET `/api/catalog/projects`
- GET `/api/catalog/projects/{id}/ecad`
- POST `/api/catalog/projects/{id}/download`，body 为 `{ "sourceIndex": 0 }`。

全部接口沿用现有 EDAIR 工作区鉴权。服务端固定 API 基址；下载时重新读取该项目的来源列表，仅接受来源序号，不接受任意下载 URL。外部文件下载不转发 ezPLM Bearer。

GitHub / api.github.com / codeload.github.com / raw.githubusercontent.com 已在下载允许列表。其它源文件存储域名必须在服务端 `EZPLM_CATALOG_DOWNLOAD_HOSTS` 中逐个列出（不含协议、路径、端口、通配符）；重定向到的域名也需要获准。该配置属于管理员信任边界，禁止加入内网、环回或用户可控制 DNS 的域名。

下载使用流式响应，单份最多 75 MiB；浏览器多来源下载合计最多 150 MiB；解压后的限制继续由已有 `filesToInputAssets` 执行。连接中断、HTML 登录页、文件过大、拒绝的下载域名均明确报错；不会将部分下载标记为成功。服务端不长期保存原包，浏览器仅为当前查看/器件资产提取保留源文件内存。

## 授权保存与刷新

密码仅转发到固定 ezPLM 登录接口，不持久化。两种 token 用 AES-256-GCM 加密后保存在 HttpOnly、SameSite=Strict cookie（HTTPS 时 Secure），有效期最多 8 小时，绑定 API 基址及 EDAIR 工作区。加密密钥由已有 `EDA_API_TOKEN` 派生；换密钥会使已有连接失效。token 不进入 JSON 响应、IR、localStorage、提示词或下载请求。

遇到 401 最多刷新一次并更新两种 token，403/429 不刷新。浏览器目录请求串行化，有 Web Locks 时跨标签页串行；服务端同实例合并刷新。多实例部署中来自不支持 Web Locks 的多个标签页/外部客户端的刷新竞争仍可能要求重新连接；如需大规模多用户 SSO，应改用平台授权代理或共享会话/刷新锁。当前沿用 EDAIR 既有单工作区模型，并非完整多租户 SSO。

## 来源追溯

Bundle / Project IR 的 `project.settings.catalogSource` 保存 provider、projectId、bomId、项目名称、导入时间、导入方式，以及各输入文件 SHA-256。下载来源 URL 去除查询参数和片段，避免保存签名凭据；GitHub 根仓库快照另存精确 revision。projectId 与 bomId 始终独立。来源只在成功解析出原理图或 PCB 后附加，不把无几何资料标记为已提取。

## 验证

`node --import tsx --test tests/catalog.test.ts tests/catalog-ui.test.tsx` 覆盖鉴权、cookie、刷新合并、游标、域名/重定向/大小限制、GitHub revision，以及模拟目录下载 → 真实 KiCad fixture 解析。UI 覆盖分类分页、预览链接降级和提取回调。

这些测试使用契约级模拟响应与合成工程。当前未获得生产 API 基址及有效登录授权，**尚未实测生产 4000+ 目录、实际签名下载地址与源文件完整率**。上线验收需用真实账号至少选择一个 KiCad ZIP、一个 AD 工程、一个仅含 viewer 的项目，确认分类计数、来源可下载、IR 与预览能正确对应。
