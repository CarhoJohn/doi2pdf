# PNAS 专用 Chrome 验证记录与目录方案

日期：2026-10-06。Windows；本机安装的 Chrome 154.0.8037.95。
DOI：`10.1073/pnas.2515233123`。
先运行独立 Chrome 验证脚本，随后把兜底接入 0.1.4，并在独立 Zotero 数据目录中验证。
未写入日常 Zotero 文献库。

## 结果

最初使用独立 profile 和 `--remote-debugging-port=0` 启动 Chrome。
正文曾加载成功，但 PDF 随后返回验证页；用户手动操作和新标签页访问正文也持续触发验证。
这个会话不能作为稳定可用的证据，测试结束后已关闭。

该窗口实测 `navigator.webdriver` 为 `true`。
[MDN 文档](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver)
说明 Chrome 的端口 0 调试参数会设置此属性。

之后使用另一份全新 profile 和非零调试端口，对照窗口实测该属性为 `false`。
没有注入脚本覆盖该属性，也没有复制日常浏览器 profile 或 Cookie。
这个窗口取得了正文、匹配的 DOI 元数据以及 `cf_clearance` Cookie。
官网的 `citation_pdf_url` 指向 `/doi/pdf/10.1073/pnas.2515233123`，
实际文件下载使用相同地址加 `?download=true`。
这些对照同时改变了端口和 profile，不能证明端口是访问差异的唯一原因。

附加到既有 Chrome 的 Playwright 下载事件未可靠报告首次下载完成，
检查后发现 PDF 已经写入 Chrome 默认下载目录。核对文件名称、创建时间与 PDF 文件头后，
仅将本次测试生成的文件迁移到 E 盘验证目录。
随后显式指定 E 盘下载路径，使用原生 CDP 下载事件和实际文件校验完成以下两次验证：

| 场景                                 | 文章阶段（秒） | 全流程（秒） | PDF 字节数 | 结果           |
| ------------------------------------ | -------------: | -----------: | ---------: | -------------- |
| 已打开的专用 Chrome 会话             |          2.433 |        3.214 |    994,517 | 下载并校验成功 |
| 关闭 Chrome 后重启，复用同一 profile |          3.124 |        3.297 |    994,517 | 下载并校验成功 |

时间从验证脚本开始计算，包括 CDP 连接、文章访问、下载和文件校验，
不含 Chrome 进程启动或 Zotero 入库。两次均使用 20 秒总观察预算。
两份 PDF 的文件头均为 `%PDF-1.4`，SHA-256 均为
`76ea798b0ca8f000874fdccf9ada9c8131aad78dd9309587523f116670c88cd8`。

重启前后 profile 文件保留；部分 Cookie 仍存在，但重启后的导航前没有 `cf_clearance`。
因此，持久化 profile 不等于所有 Cookie 或验证状态都会跨重启保留。
本机成功结果也不能保证其他网络或 Chrome 版本一定成功。

## 开发与分发后的目录

当前验证 profile 位于项目的忽略目录：
`E:\Project\AI\doi2pdf\.scaffold\pnas-chrome-validation\chrome-profile-nonzero`。
PDF、脚本和不含 Cookie 值的 JSON 报告也位于同一验证根目录。

按用户最终决定，0.1.4 的运行目录在插件实际执行下载时从
`Zotero.DataDirectory.dir` 读取。根目录为 `<Zotero 数据目录>/doi2pdf`，
Chrome 的配置和缓存位于 `chrome_profile`；任务文件位于 `downloads` 的独立子目录。
开发测试使用独立 Zotero 实例的数据目录，不读取日常 Zotero 文献库。

XPI 通常是压缩包，插件代码目录不适合作为可写 profile 的位置。
前期独立脚本使用 `.scaffold`；插件安装后按当前 Zotero 实例的数据目录解析路径，
不硬编码开发机器路径。插件升级保留 profile，任务完成后只清理自己的下载目录。
PNAS Chrome/CDP 流程已接入 `add-doi` 和 `find-fulltext`。

## 0.1.4 真实插件验证

在 Zotero 10.0.5 中运行实际构建代码，插件通过 Gecko Subprocess 启动系统 Chrome，
并通过 Gecko WebSocket 使用原生 CDP 下载 PDF。不依赖 Node 或 Playwright。
Zotero 系统权限窗口的 WebSocket 可能发送 `null` Origin；Chrome 仅允许本地
Zotero 窗口和这个 Origin，不使用任意 Origin 通配符。

在两个不同的独立数据目录中调用已注册的 `add-doi` 端点类，使用预先创建的测试父条目，
并让原生下载返回无结果，以确定性触发 PNAS 兜底。最新一轮结果为：

- 文章请求 3.420 秒，PDF 下载和校验 3.410 秒，备用阶段总计 7.386 秒；
  包括浏览器关闭和附件入库的端点调用耗时 8.334 秒。
- 实际 profile 在当前测试实例的 `<数据目录>/doi2pdf/chrome_profile`，
  两个实例分别使用自己的目录，没有复用上一个实例的绝对路径。
- PDF 保存为 Zotero `storage/<附件 key>/article.pdf`，994,515 字节，文件头有效，
  父条目 ID 正确。不同轮次 PDF 字节数略有变化，不以此前文件大小作为成功条件。
- 重复请求返回 `existing`，复用同一附件，父条目仅有一个 PDF。
- 本次任务的暂存目录清理完成，Chrome profile 保留。
- 在仅用于测试的 Chrome 参数中模拟 PNAS DNS 不可达，真实任务在 20.018 秒返回
  `PNAS_TIMEOUT`，父条目没有新增附件，暂存目录清空，未残留专用 Chrome 根进程。
  恢复正式构建后，同一 profile 再次下载成功，端点耗时 4.826 秒。
- 离线回归覆盖原生与出版社竞争、并发 profile、DOI 不匹配、HTML 伪 PDF、
  20 秒超时、启动晚到、缺少 Chrome 和插件停止，共 22 项通过。

真实端点类调用记录位于 `.scaffold/pnas-plugin-validation/result3.json`。
超时和恢复记录为同目录的 `timeout-result.json`、`recovery-result.json`。
正式 XPI 已核验为 0.1.4，不包含测试 DNS 参数、验证脚本或开发数据目录。
其他操作系统未进行真实运行验证。

## 本地证据

- 原生 CDP 验证脚本：`.scaffold/pnas-chrome-validation/probe-native-cdp.mjs`。
- 成功记录：同目录的 `native-cdp-first-result.json`、`native-cdp-cold-result.json`。
- 首次文件迁移记录：同目录的 `first-download.json`。
- 报告只保存 Cookie 名称，不包含 Cookie 值、API key 或日常 Chrome 数据。
