# 项目结构概览

`doi2pdf` 是一个 Zotero 插件，主要使用 TypeScript 和 JavaScript 开发，为 Zotero 的本地 API 扩展了 DOI 元数据和 PDF 相关功能。其结构清晰，分为插件核心文件、源代码、文档、测试以及各种配置文件。

## 顶层文件

- `.env.example`: 环境变量示例文件。
- `.gitattributes`: Git 属性配置。
- `.gitignore`: Git 忽略文件配置。
- `.prettierignore`: Prettier 格式化工具忽略文件。
- `eslint.config.mjs`: ESLint 配置，用于代码风格检查。
- `LICENSE`: 项目许可证文件。
- `package-lock.json`: npm 包锁定文件，确保依赖版本一致性。
- `package.json`: 项目的元数据和依赖管理文件。
- `README.md`: 项目主 README 文档。
- `tsconfig.json`: TypeScript 编译配置文件。
- `zotero-plugin.config.ts`: Zotero 插件构建和打包的特定配置。

## 目录结构

### `.github/`

包含 GitHub 相关的配置和工作流。

- `workflows/`: GitHub Actions 的 CI/CD 和自动化工作流定义。
  - `ci.yml`: 持续集成工作流。
  - `issue-bot.yml`: Issue 机器人工作流。
  - `release.yml`: 发布工作流。
- `dependabot.yml`: Dependabot 配置，用于自动化依赖更新。
- `renovate.json`: Renovate 配置，用于自动化依赖更新。

### `.vscode/`

包含 Visual Studio Code 编辑器的项目特定配置。

- `extensions.json`: 推荐的 VSCode 扩展。
- `launch.json`: 调试配置。
- `settings.json`: VSCode 工作区设置。
- `toolkit.code-snippets`: 自定义代码片段。

### `addon/`

包含 Zotero 插件的核心运行时文件。这些文件在插件打包后会直接加载到 Zotero 中。

- `bootstrap.js`: 插件的启动脚本。
- `manifest.json`: 插件的清单文件，定义插件的元数据和入口点。
- `prefs.js`: 插件的偏好设置定义。
- `content/`: 插件的用户界面（UI）内容。
  - `icons/`: 插件使用的图标文件。
    - `favicon.png`
    - `favicon@0.5x.png`
  - `preferences.xhtml`: 插件偏好设置的界面文件。
  - `zoteroPane.css`: Zotero 面板的样式表。
- `locale/`: 插件的本地化（国际化）文件。
  - `en-US/`: 英文语言包。
    - `addon.ftl`
    - `mainWindow.ftl`
    - `preferences.ftl`
  - `zh-CN/`: 简体中文语言包。
    - `addon.ftl`
    - `mainWindow.ftl`
    - `preferences.ftl`

### `doc/`

包含项目的文档。

- `README-frFR.md`: 法语版的 README 文档。
- `README-zhCN.md`: 中文版的 README 文档。

### `src/`

项目的 TypeScript 源代码目录。

- `utils/`: 存放通用的工具函数或辅助代码。
  - `locale.ts`: 本地化相关的工具函数。
  - `prefs.ts`: 偏好设置相关的工具函数。
  - `window.ts`: 窗口操作相关的工具函数。
  - `ztoolkit.ts`: Zotero 工具包相关的函数。
- `addon.ts`: 插件主逻辑的 TypeScript 实现，包含 API 端点定义。
  - `Plus` 端点: 健康检查端点
  - `AddItemEndpoint`: 通过标识符添加项目的端点
  - `GetSelectedCollectionEndpoint`: 获取当前选中集合的端点
- `hooks.ts`: 包含钩子（hooks）相关的逻辑，处理插件启动和窗口加载等事件。
- `index.ts`: 项目的入口文件，初始化插件实例。

### `test/`

包含项目的测试文件。

- `startup.test.ts`: 插件启动相关的测试。
- `tsconfig.json`: 测试环境的 TypeScript 配置文件。

### `typings/`

包含项目的 TypeScript 类型定义文件。

- `global.d.ts`: 全局类型定义。
- `i10n.d.ts`: 国际化相关的类型定义。
- `prefs.d.ts`: 偏好设置相关的类型定义。
