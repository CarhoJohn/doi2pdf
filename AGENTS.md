# AGENTS.md

本项目插件名称为 doi2pdf，基于上游 zotero-api-plus 进行开发，目标是通过api接口实现传入doi后调用zotero内部的 add item by identifier 功能，获取文献的metadata和pdf并添加到zotero的指定collection中。


## 配置

- zotero的api地址是 `http://localhost:23119`
- zotero的exe地址是 "E:/Programs/Zotero/zotero.exe"
- 测试时文献条目放在 `api测试` 这个collection中
- 测试doi用 `10.1038/s41562-026-02563-9`

## 开发规范

- 每次交互后请你进行头脑风暴，对项目当前状态提供改进建议，包括但不限于：新增功能，功能、流程、代码优化，潜在bug识别与兼容性诊断等
- 不要触碰、改动现有现有zotero数据库文献和其他插件、配置