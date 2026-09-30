# ParaLens — Zotero PDF 全文翻译与双语悬停对照

> **状态：技术原型阶段。** 仓库已有统一段落映射协议和原生 Zotero Reader/PDF.js 临时高亮适配器原型；已加入 uv 启动检查和翻译 API 设置原型；现可在 Zotero 条目/PDF 附件右键菜单手动翻译、导入译文并打开原生 Reader；Zotero 10.0.3 隔离实机测试已通过真实 PDF 右键菜单、译文附件导入和双向悬停；另用用户授权的已保存 API Key 分别对单页双段和两页合成 PDF 完成真实试译：两页译文的中文文字、2 条逐页映射与离线 Zotero Reader 的跨页双向悬停均已验证，已人工查看两页排版预览。Zotero 7–9、复杂论文版式和完整语言质量仍待验收。模板自带的 `src/` 示例功能不是本项目功能。

## 使用与验证

先运行 `npm install`、`npm run build` 构建插件；在 Zotero 的 ParaLens 设置中选择 BabelDOC，检测 uv，并在尚未安装时点击「安装后端」。设置翻译 API、模型和语言后，选中 PDF 附件，右键「ParaLens：翻译 PDF」并确认可能产生的费用。翻译完成后译文作为 Zotero 附件导入，可使用原生 Reader 双向悬停对照；进行中的任务可在右键菜单选择「ParaLens：取消正在运行的翻译」。取消可能要等当前 API 请求结束，该请求仍可能计费。

## 文档

- [实施规划](docs/实施规划.md)：目标、BabelDOC 段落映射、Zotero 阅读器可行性验证、分阶段实现与验收。
- [uv 环境与翻译 API](docs/backend-setup.md)：uv 检查、BabelDOC 虚拟环境安装、提供商预设与 LiteLLM 评估。
- [模板原始说明](doc/TEMPLATE-README.md)：模板的开发/构建说明。`doc/` 为模板文档；本项目新文档统一放 `docs/`。

## 后续方向

1. 默认 BabelDOC，后端输出统一 `mapping.v1`；先验证翻译前后能否导出原文/译文段落及页面坐标。
2. 面向 Zotero 7–10，通过原生 Reader 内的 PDF.js 实现双向悬停；逐版本验证私有接口兼容，暂不自建阅读器。
3. 优先由插件启动一次性本地 Python/BabelDOC 子进程，无须常驻翻译服务。
4. 先实现段落级双向对照，再评估句子级对齐。

详见 [实施规划](docs/实施规划.md)和[跨后端映射与原生 Reader 设计](docs/native-reader-architecture.md)。

## 来源与许可

基于 [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（获取时提交 `306d4e2a0959a7b2f5e44bb38169fb25f841dbaf`）；模板文件保留其原有 [AGPL-3.0-or-later 许可](LICENSE)。本地仓库尚未配置 GitHub 远端。`package.json` 的仓库地址中 `REPLACE_ME` 仅用于满足模板构建器的 URL 格式要求，发布前必须换成实际仓库地址；当前生成的更新链接不可使用。
