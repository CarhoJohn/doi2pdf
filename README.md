# doi2pdf

[![zotero target version](https://img.shields.io/badge/Zotero-9%20%7C%2010.0.x-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/CarhoJohn/doi2pdf)](LICENSE)

**把 DOI 变成 Zotero 中的文献条目和 PDF 附件。**

doi2pdf 通过 Zotero 本地 API
接收 DOI，获取文献信息、下载 PDF，并保存到指定收藏夹（Collection），方便与Agent、脚本、文献管理工具等集成。

## 目录

- [主要功能](#主要功能)
- [安装](#安装)
- [快速使用](#快速使用)
- [API 参考](#api-参考)
- [开发](#开发)
- [项目来源与许可证](#项目来源与许可证)
- [原理与实现细节](#原理与实现细节)

## 主要功能

- **自动下载 PDF**：添加 DOI 时默认查找全文，并保存为 Zotero 附件；也可以为已有条目补充 PDF。
- **补充出版社下载路线**：Nature 系列和 PNAS 主刊支持官网备用下载；Cell 系列识别后直接使用官网浏览器下载，支持先保存父条目再导入 PDF。
- **减少重复导入**：按 DOI 复用已有条目，已有可访问的 PDF 时直接复用附件。
- **指定保存位置**：在插件设置中选择默认收藏夹，支持 `父级/子级` 路径；也可在请求中指定收藏夹。
- **导入本地 PDF**：将本机已有文件复制为附件，保留原文件。

简单来说，插件先通过 Zotero 获取文献信息，再尝试下载全文；找不到 PDF 时仍保留
文献条目。下载依赖当前网络的开放获取或机构访问权限。

PNAS 和 Cell 官网下载需要已安装 Google Chrome。Cell 使用最小化的专用窗口，启动瞬间仍可能短暂显示。

## 快速使用

### 1. 安装插件

1. 从 [GitHub Releases](https://github.com/CarhoJohn/doi2pdf/releases) 下载 `.xpi` 文件。
2. 在 Zotero 中打开 `工具 > 插件`，点击齿轮图标，选择 `从文件安装插件...`。

### 2. 启用本地 API 并设置收藏夹

- 启用 Zotero 本地 API：在 `设置 > 高级` 中打开API，一般是 `http://localhost:23119`
- 在 Zotero 设置的 doi2pdf 页面填写目标收藏夹，默认是 `doi2pdf`。
  填写 `父级/子级` 可保存到嵌套收藏夹；不存在的收藏夹会在首次使用时创建。
- Chrome 可执行文件路径默认留空，插件会自动查找。Windows 先检查注册表中的
  `App Paths\chrome.exe`，再检查 Program Files、Program Files (x86) 和当前用户
  LocalAppData 下的 `Google\Chrome\Application\chrome.exe`。
  自定义安装或便携版可填写 `chrome.exe` 的完整路径，PNAS 和 Cell 共用此设置。
  填写的路径无效时返回 `CHROME_NOT_FOUND`；清空即可恢复自动查找，下次下载时生效。

### 3. 添加 DOI 并下载 PDF

先完成下方的[接口授权](#接口授权)，再用脚本或 API 工具发送请求。
首次获取写入授权时，Zotero 会弹窗提示，请按提示选择允许方式。
只需提供 DOI，插件就会尝试下载 PDF：

```http
POST http://localhost:23119/api/plus/add-doi
Content-Type: application/json
Zotero-Server-ID: <健康检查响应头中的值>
Zotero-API-Key: <授权获得的 key>

{
  "doi": "10.1038/s41562-026-02563-9"
}
```

条目会保存到插件设置的收藏夹；传入 `collectionKey` 可指定其他收藏夹。
只想获取文献信息时，增加 `"findFullText": false`。

### 3. 查看下载结果

响应中的 `itemKey` 是文献条目的标识，`fullText.status` 表示 PDF 结果：

| 值          | 含义                                      |
| ----------- | ----------------------------------------- |
| `found`     | PDF 已可用，响应包含附件 ID 和 key        |
| `not_found` | 未找到 PDF，文献条目已保留                |
| `failed`    | 下载或导入失败，原因见 `fullText.message` |
| `skipped`   | 请求关闭了全文查找，且未提供本地 PDF      |

外层 `status: "success"` 表示文献条目处理成功，PDF 是否成功请看 `fullText`。
需要补充全文或导入本地文件时，见下方 [API 参考](#api-参考)。

## API 参考

所有接口均以 `http://localhost:23119` 为基础地址。POST 请求使用 JSON，
并携带当前 Zotero 要求的认证头。

| 方法 | 路径                            | 用途                   |
| ---- | ------------------------------- | ---------------------- |
| POST | `/api/plus/add-doi`             | 添加 DOI 并获取 PDF    |
| POST | `/api/plus/find-fulltext`       | 为已有条目查找 PDF     |
| POST | `/api/plus/import-pdf`          | 向已有条目导入本地 PDF |
| GET  | `/api/plus`                     | 检查插件是否运行       |
| GET  | `/api/plus/selected-collection` | 获取当前选中的收藏夹   |

### 接口授权

**POST 接口继承 Zotero 本地 API 的写入认证要求。** 在实测的 Zotero 10.0.5 中，
首次没有授权 key 时，调用方需要先请求 Zotero 的
`POST /api/local/authorize` 获取写入授权。操作流程如下：

1. **准备就绪**：启动 Zotero，确认本地 API 已启用且 doi2pdf 插件已安装。
2. **识别当前 Zotero**：调用方先 GET `/api/plus`，读取响应头中的
   `Zotero-Server-ID`，用于后续写入请求。
3. **首次请求授权**：没有可用 key 时，调用方向 `POST /api/local/authorize`
   提交应用名称（`appName`），Zotero 会弹出写入授权提示。
4. **在 Zotero 中确认**：核对弹窗中的应用名称，选择“允许”或“始终允许”。“允许”对应一次写入；“始终允许”获得的 key 可以用于后续请求。选择拒绝则不会获得写入授权。

### 添加 DOI 并获取 PDF

`POST /api/plus/add-doi`

```json
{
  "doi": "10.1038/s41562-026-02563-9",
  "collectionKey": "doi2pdf",
  "findFullText": true,
  "shortTitle": "Custom short title"
}
```

| 字段            | 必填 | 说明                                                                                                                                                         |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doi`           | 是   | DOI 或可解析的 DOI URL                                                                                                                                       |
| `collectionKey` | 否   | 目标收藏夹的 key；省略时使用插件设置                                                                                                                         |
| `findFullText`  | 否   | 是否查找全文，默认 `true`                                                                                                                                    |
| `shortTitle`    | 否   | 非空字符串会覆盖 Short Title；省略或空字符串不改动                                                                                                           |
| `methods`       | 否   | Zotero 常规全文解析方法的字符串数组；省略或空数组时使用默认顺序                                                                                              |
| `pdfPath`       | 否   | 本机可读的 PDF 绝对路径；提供时文件会复制到 Zotero 附件存储，跳过网络查找，原文件保留。文件校验失败时返回错误。手动提供文件时，请确保 PDF 内容对应所填 DOI。 |

响应示例（省略条目摘要等字段）：

```json
{
  "status": "success",
  "itemID": 123,
  "itemKey": "ABC12345",
  "created": true,
  "fullText": {
    "status": "found",
    "source": "nature",
    "attachmentID": 456,
    "attachmentKey": "XYZ12345"
  }
}
```

`created` 表示是否新建文献条目；完整下载状态见[查看下载结果](#3-查看下载结果)。

### 为已有条目查找 PDF (待优化)

`POST /api/plus/find-fulltext`

```json
{
  "itemKey": "ABC12345",
  "methods": ["doi", "url", "oa", "custom"]
}
```

`itemKey` 必填，指向用户库中的文献条目；`methods` 可选，省略或空数组时使用
Zotero 默认全文解析顺序。响应包含 `item` 和 `fullText`。
Nature 和 PNAS 主刊也会尝试出版社备用下载；Cell 系列直接使用浏览器下载。
`methods` 仅控制常规解析器，对 Cell 路线无效。

### 向已有条目导入本地 PDF

`POST /api/plus/import-pdf`

```json
{
  "itemKey": "ABC12345",
  "expectedDOI": "10.1038/s41562-026-02563-9",
  "pdfPath": "E:/Downloads/s41562-026-02563-9_reference.pdf"
}
```

三个字段均必填。接口只查找用户库中的指定条目，不创建新条目，也不改动父条目的
元数据或收藏夹。已有可访问的 PDF 时返回已有附件。

| 错误码           | 含义                                 |
| ---------------- | ------------------------------------ |
| `ITEM_NOT_FOUND` | 条目不存在、已删除或不是文献条目     |
| `DOI_MISMATCH`   | 父条目的 DOI 与 `expectedDOI` 不匹配 |
| `INVALID_PDF`    | 路径或 PDF 文件无效                  |

成功响应包含 `itemID`、`itemKey`，以及带附件 ID/key 的 `fullText`。

### 其他接口

- **健康检查**：GET `/api/plus`，返回 `Zotero Local API Plus is running.`。
- **当前收藏夹**：GET `/api/plus/selected-collection`，
  返回 `{"name": "我的集合", "key": "ABC12345"}`；
  未选中时返回 `No Collection selected.`。

---

## 开发

项目结构见 [structure.md](structure.md)。开发环境需要 Node.js 18+ 和 npm。

```bash
npm install
npm run start
```

热重载开发建议使用单独的 Zotero profile。构建安装包：

```bash
npm run build
```

XPI 位于 `.scaffold/build/doi2pdf-v<version>.xpi`；版本也可从 `.scaffold/build/addon/manifest.json` 确认。
按上面的[安装步骤](#安装)安装 XPI，安装前关闭正在运行的开发实例或旧的开发安装。

依赖通过 npm 别名隔离：`@typescript/native` 提供 TypeScript 7 的 `tsc`，
`typescript` 指向 `@typescript/typescript6`，为 ESLint 提供兼容的编译器 API。
不要将这两个别名直接替换为单一的 TypeScript 7 依赖。

PDF 流程的单元测试使用 Node.js 内置测试运行器和内存中的 Zotero、文件、网络替身，
不访问真实文献库，不需要启动 Zotero 或 Chrome：

```bash
npm ci
npm run test:unit
```

CI 会独立运行这组测试。Git 仅收录 `test/pdf.unit.test.mjs`；`test/` 下的浏览器
profile、Cookie、PDF、日志和实测产物继续忽略。增加测试文件时应在 `.gitignore`
中逐个开放，避免将本地运行数据提交到仓库。测试文件不会打包进 XPI。

## 原理与实现细节

### 文献创建与 PDF 获取

`add-doi` 使用 Zotero 内置标识符翻译器保存或复用元数据，再单独获取 PDF。
并发的同一 DOI 导入共享元数据创建任务，同一条目的
全文请求也共享下载任务。已有可访问的 PDF 直接复用；网页快照和丢失的文件不算成功。

常规下载和出版社备用路线都先保存临时文件，再统一校验和导入。
即使常规下载晚到，也只保存一份 PDF，晚到文件在任务结束后清理。

### 备用下载的触发与超时

对支持的 Nature 和 PNAS 主刊条目，常规获取提前失败或未找到 PDF 时立即启动
备用路线；常规获取开始后 8 秒仍未成功时，也启动备用路线。
8 秒等待发生在父条目确定后的全文阶段，不包含元数据查询时间。
Nature / PNAS 备用任务的预算为 30 秒。Cell 在父条目完成后直接下载，
跳过通用 PDF 查找和 8 秒等待，浏览器任务预算为 60 秒。
这些预算均不包含父条目元数据查询和附件入库时间，不能视为整个 API 请求的耗时上限。

### Nature 官网下载

插件直接调用系统 curl，不经过 shell，也不需要外部脚本：
Windows 使用系统目录中的 `curl.exe`，其他系统在 PATH 中查找 `curl`。
同一次任务使用独立的临时 Cookie 文件访问 DOI 对应的文章页和 PDF。

核对文章页 DOI 后，优先读取官网正文 PDF 下载按钮，没有按钮时才使用
`citation_pdf_url` 元数据。提前发布文章的正文链接可能以 `_reference.pdf` 结尾，
而元数据中的 `.pdf` 地址可能返回 HTML；插件使用网页提供的实际链接。
PDF 链接需要符合允许的 HTTPS 出版社域名，并校验下载文件的 PDF 文件头。

### PNAS 官网下载

PNAS 主刊（`10.1073/pnas.*`）通过已安装的 Google Chrome 下载。
插件使用独立 profile 和本地 CDP 连接，不需要 Node、Playwright 或额外下载浏览器。
Chrome 使用非零调试端口，保持有头模式并最小化窗口，不修改网页中的浏览器标记。

插件先核对官网元数据的 DOI 和 `citation_pdf_url`，再访问对应的 `/doi/pdf/`
下载地址，与 Cell 共用响应流下载函数：在响应头阶段拦截浏览器已认证的 PDF，
分块读取到流结束后校验 PDF 文件头，不依赖下载事件、PDF 查看器或保存对话框。
HTTP 访问错误直接返回诊断；网站验证响应继续交给浏览器处理，直到下载成功或预算到期。
不同条目共用一个专用 profile，任务串行运行；30 秒预算包含排队、Chrome 启动和下载。
PNAS Nexus 使用不同平台，本版本没有其出版社专用备用路线。

### Cell 系列官网下载

插件从父条目的 ISSN、期刊名称 / 别名和 Cell 官网路径匹配本地期刊名录，
覆盖 65 种期刊和 107 个 ISSN。缺少 ISSN 且本地字段未匹配时，按完整 DOI
查询 Crossref 元数据；DOI 的前缀、后缀和期刊缩写不参与 Cell 判断。

PII 从条目 URL 或 Crossref 的出版社链接中提取，构造 cell.com 正文和 PDF 地址，
不访问 Linking Hub 或 ScienceDirect 下载页面。匹配的元数据缺少 PII 时查询最多 5 秒，
失败会保留父条目并返回下载诊断。
同一任务复用 Crossref 查询结果；已经查询但未返回 PII 时不重复请求。

Cell 使用与 PNAS 共用的持久化专用 Chrome profile，任务串行执行。
浏览器保持有头模式，通过 CDP 显式最小化窗口和创建后台标签。
启动参数无法保证完全隐藏启动窗口；下载过程中不使用 PDF 查看器或保存对话框。
官网页面 DOI、期刊路径及 PII 通过校验后，直接读取浏览器已认证的 PDF 响应流，
收到流结束信号并校验 PDF 文件头后，再复用附件导入流程。
60 秒预算包含排队、PII 查询、浏览器启动和文件下载。

本轮实际验证的下载文章为 iScience 和 Neuron，其他期刊仍取决于页面兼容性和访问权限。

### 下载诊断

成功结果的 `fullText.source` 表示 PDF 来源：

| 来源       | 含义               |
| ---------- | ------------------ |
| `existing` | 已有附件           |
| `native`   | Zotero 常规下载    |
| `nature`   | Nature 官网下载    |
| `pnas`     | PNAS 官网下载      |
| `cell`     | Cell 系列官网下载  |
| `local`    | 手动提供的本地 PDF |

自动获取结果还包含 `attempts` 诊断。Nature、PNAS 或 Cell 下载成功时，
`fullText.timings` 提供 `articleMs`、`pdfMs` 和 `totalMs`，单位为毫秒；
总时间包含启动、网页解析和文件校验；浏览器路线还包含排队，不包含附件入库。

下载异常时保留元数据，并通过 `fullText.message` 报告原因。
Nature、PNAS 或 Cell 官网路线启动后，任务结束会在 Zotero 右下角显示 `doi2pdf` 提示：
绿色 `✔` 表示 PDF 已保存，红色 `❌` 表示失败，并显示文献名、DOI 和简短原因。
成功提示约 3 秒后关闭，失败提示约 5 秒后关闭；点击结果文字可打开 DOI 页面。
已有 PDF 或常规路线直接成功时，不额外显示备用路线提示。
系统缺少 curl、Chrome 启动失败或 profile 被占用，都可能导致备用下载失败。
浏览器路线常见错误码：

| 错误码                 | 含义                           |
| ---------------------- | ------------------------------ |
| `CHROME_NOT_FOUND`     | 未找到已安装的 Google Chrome   |
| `NEEDS_BROWSER_ACCESS` | 网站验证未在相应任务预算内完成 |
| `PNAS_TIMEOUT`         | 其他 PNAS 备用任务超时         |
| `PNAS_PDF_UNAVAILABLE` | PNAS 返回 PDF 访问错误状态     |
| `CELL_TIMEOUT`         | Cell 浏览器任务超时            |
| `PII_NOT_FOUND`        | 已识别 Cell，但没有文章 PII    |
| `JOURNAL_MISMATCH`     | 期刊证据不一致                 |
| `PII_MISMATCH`         | 出版社提供的文章标识不一致     |
| `CELL_PDF_UNAVAILABLE` | Cell 返回 PDF 访问错误状态     |

浏览器下载仍受网站验证和访问权限限制。超时会终止本次任务启动的 curl 或 Chrome 子进程。

### 运行数据与清理

运行数据目录从 `Zotero.DataDirectory.dir` 读取，即 Zotero 设置中的数据目录。
构建产物和 XPI 不包含开发机器的数据路径：

```text
<Zotero 数据目录>/doi2pdf/
  chrome_profile/       Chrome 配置、Cookie 和缓存，跨任务与插件升级保留
  downloads/            各任务的独立暂存目录，完成或失败后清理
```

常规下载、Nature curl、PNAS 和 Cell Chrome 都在 `downloads` 下使用独立的
`doi2pdf-*` 目录。任务只清理自己的暂存文件和临时 Cookie，不删除文献数据库、
已有附件或 Chrome profile；profile 中的会话保留。

修改 Zotero 数据目录并重启后，新任务使用新路径，旧目录不自动迁移或删除。
插件设置由 Zotero 的偏好设置系统管理，Chrome 配置保存在上述 profile 中。

## 项目来源与许可证

本项目基于 [GOKORURI007/zotero-api-plus](https://github.com/GOKORURI007/zotero-api-plus)
的 `v0.2.1` 继续开发，使用 [AGPL-3.0-or-later](LICENSE) 许可证。
欢迎通过 Issue 和 Pull Request 反馈问题或贡献改进。
