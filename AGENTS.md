# AGENTS.md

本项目插件名称为 doi2pdf，基于上游 zotero-api-plus 进行开发，目标是通过api接口实现传入doi后调用zotero内部的 add item by identifier 功能，获取文献的metadata和pdf并添加到zotero的指定collection中。

## 配置

- zotero的地址是 `http://localhost:23119`
- 测试时文献条目放在 `api测试` 这个collection中
- 测试doi用 `10.1038/s41562-026-02563-9`
