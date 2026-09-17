# Allegro PCB support (Parser 1.6.0)

## 支持范围

这是 **Allegro PCB 转换导入**，不是浏览器内的原生二进制解析器。`.brd` 内容签名用于区分 Allegro、旧版 KiCad 和其他工具。原始 BRD 必须经过带 Allegro importer 的 **KiCad 10+** 转换。

| 输入 / 功能 | 当前行为 |
| --- | --- |
| 原生 Allegro `.brd` | 已配置在线服务时自动转换；否则给出明确错误及本地转换方法 |
| 本地工具生成的 ZIP | 浏览器直接解析，无需服务器、网络或云端密钥 |
| PCB 2D、封装、焊盘、走线、过孔、网络 | 使用转换产物中的显式对象；支持 KiCad 10 名称式 net |
| BOM | 从已放置 PCB 封装派生，装配状态未知；不虚构 MPN、厂商或原理图 |
| 3D | 板体及转换后实际存在的模型引用；没有模型引用时明确提示，不用通用盒子冒充实体器件 |
| OrCAD Capture `.dsn/.opj`、独立 Allegro 库 | 保留并报告不支持；PDF 可附作文本/页面证据 |
| `.alg`、IPC-2581、ODB++ | 本次未实现专用解析器 |

KiCad 转换结果不等于完整原生语义：规则、特殊焊盘、覆铜、叠层、模型引用等可能不完整。项目 Fidelity 固定保守标为 partial。原生原理图、内嵌器件 3D 提取和原生网表等价性尚未承诺支持。

## 最快使用：本地转换

1. 安装 KiCad 10 或更新版本，确保该构建包含 Allegro importer，并可执行 `kicad-cli version`。
2. 在仓库目录执行（需要 Python 3，无第三方 Python 依赖）：

   ```sh
   python3 scripts/allegro-convert.py /path/to/design.brd -o design-refir.zip
   ```

   如 KiCad CLI 不在 PATH：

   ```sh
   python3 scripts/allegro-convert.py design.brd -o design-refir.zip --cli /path/to/kicad-cli
   ```

3. 在 Refir 上传 `design-refir.zip`。

输出包保留原始 `.brd`、`board.kicad_pcb`、`refir-allegro.json` 和可用的转换报告。清单记录两个文件的 SHA-256 及转换器版本；缺文件、哈希不一致、路径越界或重复关联都会拒绝导入。哈希证明文件关联和完整性，不证明工程转换正确。工具不覆盖源文件或已有输出 ZIP。

转换器实际调用 KiCad 10 的 `pcb import --format auto`，不用并不存在的 `--format allegro`。KiCad 按二进制签名选择 Allegro importer。

## 在线转换部署

Vercel 不安装 KiCad。需要在**另一个装有 KiCad 10+ 的受控 Linux/Windows/macOS 主机**上运行转换服务；当前代码推送不等于已部署此服务。

1. 在转换主机设置至少 32 字符的随机 `ALLEGRO_CONVERTER_TOKEN`，然后启动：

   ```sh
   python3 scripts/allegro-convert.py --serve 127.0.0.1:8788
   ```

2. 用 HTTPS 反向代理仅暴露 `/convert`，设置请求上限 4 MiB、超时至少 150 秒。服务须以非特权用户运行；通过容器/主机限制 CPU、内存、磁盘、并发和访问范围。Python 服务只允许一次转换，繁忙返回 429，每次转换使用独立临时目录，进程超时 120 秒。
3. 在 Vercel 配置：

   ```dotenv
   ALLEGRO_CONVERTER_URL=https://your-converter.example/convert
   ALLEGRO_CONVERTER_TOKEN=<与转换主机相同的密钥>
   EDA_API_TOKEN=<现有工作区访问密钥，至少24字符>
   ```

   两个转换环境变量只能在服务端使用，不得冠以 `NEXT_PUBLIC_`。
4. 在 Refir 的工作区访问密钥输入框填写 `EDA_API_TOKEN`，上传 BRD 或包含 BRD 的 ZIP。页面将工程数据发送到配置的转换主机，转换后返回浏览器解析。

本地开发可配置 `http://127.0.0.1:8788/convert`；生产环境要求 HTTPS。API 禁止请求方指定目标 URL、禁止重定向，认证通过后才调用转换服务。未配置/认证失败/超时/超限均保留原文件并产生错误，不显示完整解析成功。

在线请求和响应均限 **4 MiB 压缩传输大小**，以留在 Vercel 请求/响应限制内；原始与转换后的单文件上限 50 MiB。超过在线限额时使用本地转换工具，然后直接上传 ZIP。现有浏览器归档和 S-expression 资源上限仍适用，超大 PCB 并非无上限支持。

## 验证记录与边界

- 自动化覆盖：内容检测（Allegro/KiCad/EAGLE/OrCAD）、转换清单和哈希、路径安全、多板 ID、未关联文件排除、PCB 派生 BOM、KiCad 10 名称式网络、旧数字式网络、客户端成功/失败处理、API 认证及大小限制。
- Python 测试用 **stub CLI** 检查命令参数、临时目录及打包哈希；不是原生 Allegro 解析验收。
- 当前开发环境没有 KiCad 可执行程序，用户尚未提供 Allegro 工程样本。因此没有宣称完成真实 BRD → KiCad → Refir 的端到端、PCB 图像或 3D 验收。配置服务后应上传真实样本，对照原生 Allegro 的板框、器件数、层、网络和模型逐项验收。
- KiCad 官方实现依据：[Allegro 内容检测](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pcb_io/allegro/pcb_io_allegro.cpp)、[PCB import CLI](https://github.com/KiCad/kicad-source-mirror/blob/10.0/kicad/cli/command_pcb_import.cpp)。此项目仅调用外部 CLI，不复制或分发 KiCad 解析器源码/二进制。

运行：`npm run test:parser`、`npm run test:allegro-converter`、`npm run lint`、`npm run build:vercel`。
