# Zotero PDF 全文翻译与双语悬停对照

> **状态：规划阶段。** 本仓库目前仅引入 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 的脚手架，并迁入项目规划；尚未实现 PDF 翻译、段落映射或悬停高亮。模板自带的 `src/` 示例功能不是本项目功能，请勿将构建出的示例插件视为可用产品。

## 文档

- [实施规划](docs/实施规划.md)：目标、BabelDOC 段落映射、Zotero 阅读器可行性验证、分阶段实现与验收。
- [模板原始说明](doc/TEMPLATE-README.md)：模板的开发/构建说明。`doc/` 为模板文档；本项目新文档统一放 `docs/`。

## 后续方向

1. 验证 BabelDOC 翻译前后能否导出原文/译文段落的稳定对应关系与页面坐标。
2. 验证 Zotero 原生 PDF 阅读器内悬停高亮是否有可靠扩展点；否则使用插件自建双栏视图。
3. 优先由插件启动一次性本地 Python/BabelDOC 子进程，无须常驻翻译服务。
4. 先实现段落级双向对照，再评估句子级对齐。

详见 [实施规划](docs/实施规划.md)。

## 来源与许可

基于 [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（获取时提交 `306d4e2a0959a7b2f5e44bb38169fb25f841dbaf`）；模板文件保留其原有 [AGPL-3.0-or-later 许可](LICENSE)。本地仓库尚未配置 GitHub 远端。`package.json` 的仓库地址中 `REPLACE_ME` 仅用于满足模板构建器的 URL 格式要求，发布前必须换成实际仓库地址；当前生成的更新链接不可使用。
