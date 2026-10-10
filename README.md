# doi2pdf

[![zotero target version](https://img.shields.io/badge/Zotero-9%20%7C%2010.0.1-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/GOKORURI007/zotero-api-plus)](https://github.com/GOKORURI007/zotero-api-plus/blob/main/LICENSE)

一个为 Zotero 本地 API 扩展额外功能的插件。

## 版本与来源

当前本地开发版本为 `0.1.4`。本项目基于
[GOKORURI007/zotero-api-plus](https://github.com/GOKORURI007/zotero-api-plus)
的 `v0.2.1` 版本继续开发。

插件清单兼容 Zotero 9 及 Zotero 10.0.x（包括 10.0.1）。

## 功能特性

- 为 Zotero 本地 API 扩展自定义端点
- 通过 API 使用标识符（DOI、ISBN、PMID 等）向 Zotero 添加项目
- 在 Zotero 设置中配置 DOI 项目的目标 Collection；不存在时首次使用会自动创建
- 健康检查端点，用于验证插件状态
- 易于与其他工具和脚本集成

## API 端点

在实测的 Zotero 10.0.5 中，POST 接口继承 Zotero 本地 API 的写入认证要求。
先 GET `/api/plus`，读取响应头 `Zotero-Server-ID`；再通过 Zotero 原生
`POST /api/local/authorize`（JSON：`{"appName":"你的应用名"}`）获取 API key。
后续 POST 请求携带 `Zotero-Server-ID` 和 `Zotero-API-Key` 请求头。
选择一次性授权时，key 在一次写入请求中消耗；选择始终允许时可以复用。
插件遵循当前 Zotero 的认证规则；浏览器 User-Agent 请求还可能被原生服务拒绝。

### 健康检查

```
GET /api/plus
```

返回一个简单消息，指示 API 正在运行。

#### 响应

```
Zotero Local API Plus is running.
```

### 通过标识符添加项目

```
POST /api/plus/add-item-by-id
Content-Type: application/json
```

使用 DOI、ISBN、PMID 等标识符将项目添加到 Zotero。

#### 请求体

```json
{
  "identifier": "10.1038/nature12373", // 必填：DOI、ISBN、PMID 等
  "collectionKey": "ABC123" // 可选：要添加项目的集合键
}
```

#### 响应

```json
{
  "status": "success",
  "addedCount": 1,
  "titles": ["文章标题"]
}
```

### 获取当前选中的集合

```
GET /api/plus/selected-collection
```

返回 Zotero 中当前选中的集合信息。

#### 响应

```json
{
  "name": "我的集合",
  "key": "ABC123"
}
```

#### 错误响应

```
No Collection selected.
```

### 添加 DOI 并查找全文 (新增功能)

```
POST /api/plus/add-doi
Content-Type: application/json
```

该接口复用 Zotero 内部的 Add Item by Identifier 能力，并按 DOI 复用已有条目。

#### 请求体

```json
{
  "doi": "10.1038/s41562-026-02563-9",
  "collectionKey": "ABC123",
  "findFullText": true,
  "shortTitle": "Custom short title"
}
```

`doi` 必填；`collectionKey`、`findFullText` 和 `shortTitle` 可选，默认会尝试查找全文。
仅当 `shortTitle` 显式传入且为非空字符串时，插件才会将其写入并覆盖条目的
Short Title；未传入或传入空字符串时不会改动该字段。
未传入 collectionKey 时，项目会保存到插件设置中的目标 Collection；如果该
Collection 不存在，插件会在首次添加时自动创建。设置值支持使用
父级/子级表示嵌套 Collection。

`add-doi` 先保存或复用元数据，再单独获取 PDF。对于 Nature 文献，常规
获取提前失败时立即启动官网备用下载；常规获取开始后 8 秒仍未成功时也会
启动备用下载。备用流程由插件直接调用系统 curl：Windows 使用系统目录中的
`curl.exe`，其他系统在 PATH 中查找 `curl`。不经过 shell，不需要外部脚本。
同一次下载使用独立的临时 Cookie 文件访问文章页和正文 PDF，
优先使用官网正文 PDF 下载按钮，兼容提前发布文章的 `_reference.pdf`；
没有正文下载按钮时才使用 `citation_pdf_url` 元数据。
整个备用流程的超时为 20 秒。8 秒从父条目确定后开始计时，不包含元数据查询
时间，也不表示整个 API 请求必须在 8 秒内返回。

PNAS 主刊（`10.1073/pnas.*`）沿用相同的触发条件，并改用已安装的 Google
Chrome 获取官网文章和正文 PDF。插件通过本地 CDP 连接操作独立浏览器，不需要
Node、Playwright 或额外下载浏览器。它使用非零调试端口，不启用 headless，
不修改网页中的浏览器标记；可能会显示专用 Chrome 窗口。
先核对官网元数据中的 DOI，再访问 `citation_pdf_url` 对应的 `/doi/pdf/` 地址，
通过 Chrome 原生下载事件确认文件完成，并校验 PDF 文件头。
整个 PNAS 备用任务的 20 秒预算包含等待其他 PNAS 任务、Chrome 启动及下载。
不同条目共用一个专用 profile，任务串行运行；同一条目继续共享全文任务。
PNAS Nexus 使用不同平台，本版本未加入其出版社专用兜底。

运行数据目录在插件运行时从 `Zotero.DataDirectory.dir` 读取，即 Zotero 设置中的
数据目录；构建和 XPI 中不包含开发机器的数据路径。目录结构为：

```text
<Zotero 数据目录>/doi2pdf/
  chrome_profile/       Chrome 配置、Cookie 和缓存，跨任务与插件升级保留
  downloads/            各下载任务的独立暂存目录，完成或失败后清理
```

原生下载、Nature curl 和 PNAS Chrome 的暂存文件均使用该目录。
每次任务只清理自己的下载目录；不会删除 Chrome profile、文献数据库或已有附件。
修改 Zotero 数据目录并重启后，新任务会使用新的路径，旧目录不自动迁移或删除。
插件的设置项继续由 Zotero 的偏好设置系统管理；Chrome 自身的配置位于上述 profile。

两条下载路线先保存临时文件，再统一导入附件；即使常规路线晚到，也只保存一份
PDF。并发的同一 DOI 导入会共享元数据创建任务，同一条目的全文请求也会共享
下载任务。已有可访问的 PDF 会直接复用，网页快照和丢失的文件不算成功。
官网访问仍需要当前网络具备相应的开放获取或机构访问权限。

也可以提供 Zotero 所在电脑上已有的 PDF，直接跳过网络全文查找：

```json
{
  "doi": "10.1038/s42256-026-01281-1",
  "collectionKey": "ABC12345",
  "pdfPath": "E:/Downloads/s42256-026-01281-1.pdf",
  "findFullText": false
}
```

`pdfPath` 必须是本机可读的绝对路径，文件会复制到 Zotero 附件存储，原文件
不会删除。显式提供 `pdfPath` 时，无论 `findFullText` 的值是什么，均优先导入
该文件；文件校验失败时返回错误。有效 PDF 文件头只能证明文件类型，手动提供
文件时仍需确保内容对应所填 DOI。

#### 响应

```json
{
  "status": "success",
  "itemID": 123,
  "itemKey": "ABC12345",
  "created": true,
  "fullText": {
    "status": "found",
    "attachmentID": 456,
    "attachmentKey": "XYZ12345"
  }
}
```

全文不可用时，`fullText.status` 为 `not_found`，元数据条目仍会保留。

下载异常或备用流程超时时为 `failed`，原因位于 `fullText.message`。外层
`status: "success"` 只表示元数据处理成功。成功结果的 `fullText.source` 会标明
`existing`、`native`、`nature`、`pnas` 或 `local`；自动获取结果还包含 `attempts` 诊断。
Nature 或 PNAS 下载成功时，`fullText.timings` 包含 `articleMs`、`pdfMs` 和 `totalMs`，
均以毫秒表示；总时间包括进程启动、网页解析和文件校验，不包含附件入库。
系统缺少 curl、curl 返回错误或下载超时时，保留元数据条目并报告失败原因。
PNAS 未安装 Chrome 时返回 `fullText.code: "CHROME_NOT_FOUND"`；检测到验证页且
20 秒内未完成时返回 `NEEDS_BROWSER_ACCESS`，其他超时为 `PNAS_TIMEOUT`。
profile 被占用或启动失败也会保留元数据并报告原因；浏览器方式不保证绕过网站验证。
临时下载使用上述 `downloads` 下的独立 `doi2pdf-*` 目录，导入后或失败后清理；仍在
运行的晚到下载在结束后清理，绝不会再次导入附件。超时会终止本次任务启动的
curl 或 Chrome 子进程；任务 Cookie 文件清理，Chrome profile 中的会话保留。

### 向已有条目导入 PDF

```
POST /api/plus/import-pdf
Content-Type: application/json
```

```json
{
  "itemKey": "ABC12345",
  "expectedDOI": "10.1038/s42256-026-01281-1",
  "pdfPath": "E:/Downloads/s42256-026-01281-1.pdf"
}
```

三个字段均必填。接口只在用户库中查找指定父条目，绝不会创建新的文献条目。
条目不存在或已删除时返回 `ITEM_NOT_FOUND`；父条目 DOI 不匹配时返回
`DOI_MISMATCH`；路径或文件无效时返回 `INVALID_PDF`。已有可访问的 PDF 时
返回已有附件，不覆盖它。导入成功返回 `itemID`、`itemKey` 和包含附件 ID/key
的 `fullText`。本接口不改动父条目的元数据或收藏夹。

### 为已有条目查找全文 (新增功能)

```
POST /api/plus/find-fulltext
Content-Type: application/json
```

```json
{
  "itemKey": "ABC12345",
  "methods": ["doi", "url", "oa", "custom"]
}
```

`methods` 可选；省略时使用 Zotero 默认的全文解析顺序。

Nature 和 PNAS 主刊文献也会使用上述 8 秒触发、20 秒超时的官网备用路线。
`methods` 仅控制常规 Zotero 解析器，不会禁用出版社备用路线。

## 安装

1. 本地开发时，使用 `npm run build` 生成的
   `.scaffold/build/doi2pdf-v<version>.xpi`；发布包可从
   [GitHub Releases](https://github.com/CarhoJohn/doi2pdf/releases) 下载。
2. 在 Zotero 中，转到 `工具 > 插件`。
3. 点击齿轮图标，选择 `从文件安装插件...`。
4. 选择下载的 `.xpi` 文件。
5. 重启 Zotero。

## 使用

1. 确保 Zotero 的本地 API 已启用（转到 `编辑 > 首选项 > 高级 > 文件和文件夹 > 显示数据目录`，然后编辑 `prefs.js` 并添加 `user_pref("extensions.zotero.httpServer.enabled", true);`）。
2. 在 Zotero 设置中的 doi2pdf 页面设置目标 Collection，默认值为 doi2pdf。
3. 按照上述描述使用 API 端点。请求中显式提供 collectionKey 时，会覆盖插件设置。

## 开发

项目结构见 [structure](structure.md)。

### 先决条件

- Node.js 18+
- npm

### 设置

```bash
npm install
npm run start
```

### 构建

```bash
npm run build
```

构建成功后，版本化的 XPI 文件位于：

```text
.scaffold/build/doi2pdf-v<version>.xpi
```

例如，当前版本的文件名为 `doi2pdf-v0.1.4.xpi`。文件名即为构建版本；也可以
读取 `.scaffold/build/addon/manifest.json` 的 `version` 字段确认。

这是可以交给 Zotero 安装的发布包，不要直接把源码目录或
`.scaffold/build/addon` 目录作为插件安装。可以用以下命令确认包内包含
插件入口脚本：

```powershell
tar -tf .scaffold/build/doi2pdf-v0.1.4.xpi | Select-String '^(bootstrap.js|manifest.json|content/scripts/doi2pdf.js)$'
```

手动安装本地构建包：

1. 关闭正在运行的 Zotero 开发实例或旧的 doi2pdf 开发安装。
2. 启动 Zotero，转到 `工具 > 插件`。
3. 点击齿轮图标，选择 `从文件安装插件...`。
4. 选择 `.scaffold/build/doi2pdf-v<version>.xpi`。
5. 按提示重启 Zotero，并在插件列表中确认 `doi2pdf` 已出现。

如果使用 `npm run start` 做热重载，建议在单独的 Zotero profile 中运行；开发
安装记录不应当替代正常的 XPI 安装记录。

### 代码检查

```bash
npm run lint:check
```

离线回归测试（不会启动 Zotero 或修改文献库）：

```bash
npm run test:unit
```

## 许可证

AGPL-3.0-or-later

## 贡献

欢迎贡献！请随时提交 Pull Request。
