# doi2pdf

[![zotero target version](https://img.shields.io/badge/Zotero-9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License: AGPL-3.0-or-later](https://img.shields.io/github/license/GOKORURI007/zotero-api-plus)](https://github.com/GOKORURI007/zotero-api-plus/blob/main/LICENSE)

[English](../README.md) | [简体中文](./README-zhCN.md)

一个为 Zotero 本地 API 扩展额外功能的插件。

## 版本与来源

当前本地开发版本为 `0.1.0`。本项目基于
[GOKORURI007/zotero-api-plus](https://github.com/GOKORURI007/zotero-api-plus)
的 `v0.2.1` 版本继续开发。

`package.json` 中的 `repository`、`bugs` 和 `homepage` 暂时保留上游仓库地址。
这些字段用于记录代码来源，也供构建工具生成更新地址；本地开发并不表示已经向
GitHub 发布了本项目。

## 功能特性

- 为 Zotero 本地 API 扩展自定义端点
- 通过 API 使用标识符（DOI、ISBN、PMID 等）向 Zotero 添加项目
- 健康检查端点，用于验证插件状态
- 易于与其他工具和脚本集成

## API 端点

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

### 添加 DOI 并查找全文

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
  "findFullText": true
}
```

`doi` 必填；`collectionKey` 和 `findFullText` 可选，默认会尝试查找全文。

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

### 为已有条目查找全文

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

## 安装

1. 本地开发时，使用 `npm run build` 生成的
   `.scaffold/build/doi2pdf.xpi`；上游发布包可从
   [GitHub Releases](https://github.com/GOKORURI007/zotero-api-plus/releases) 下载。
2. 在 Zotero 中，转到 `工具 > 插件`。
3. 点击齿轮图标，选择 `从文件安装插件...`。
4. 选择下载的 `.xpi` 文件。
5. 重启 Zotero。

## 使用

1. 确保 Zotero 的本地 API 已启用（转到 `编辑 > 首选项 > 高级 > 文件和文件夹 > 显示数据目录`，然后编辑 `prefs.js` 并添加 `user_pref("extensions.zotero.httpServer.enabled", true);`）。
2. 按照上述描述使用 API 端点。

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

构建成功后，标准 XPI 文件位于：

```text
.scaffold/build/doi2pdf.xpi
```

这是可以交给 Zotero 安装的发布包，不要直接把源码目录或
`.scaffold/build/addon` 目录作为插件安装。可以用以下命令确认包内包含
插件入口脚本：

```powershell
tar -tf .scaffold/build/doi2pdf.xpi | Select-String '^(bootstrap.js|manifest.json|content/scripts/doi2pdf.js)$'
```

手动安装本地构建包：

1. 关闭正在运行的 Zotero 开发实例或旧的 doi2pdf 开发安装。
2. 启动 Zotero，转到 `工具 > 插件`。
3. 点击齿轮图标，选择 `从文件安装插件...`。
4. 选择 `.scaffold/build/doi2pdf.xpi`。
5. 按提示重启 Zotero，并在插件列表中确认 `doi2pdf` 已出现。

如果使用 `npm run start` 做热重载，建议在单独的 Zotero profile 中运行；开发
安装记录不应当替代正常的 XPI 安装记录。

### 代码检查

```bash
npm run lint:check
```

## 许可证

AGPL-3.0-or-later

## 贡献

欢迎贡献！请随时提交 Pull Request。
