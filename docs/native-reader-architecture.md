# 跨后端映射与原生 Zotero Reader 设计

> 2026-09-29 决策：计划覆盖 Zotero 7、8、9、10；默认翻译后端为 BabelDOC；阅读界面使用 Zotero 原生 Reader + 其内置 PDF.js。不再以自建 PDF.js 阅读器作为产品后备方案。**这是目标，不是已经通过的兼容性声明。**

## 1. 分层和边界

1. `TranslationBackend`（`src/backend/contracts.ts`）：选择 `babeldoc` 为默认后端。后续后端只实现翻译与导出不含 Zotero 附件 key 的 `UnboundMappingV1` 草稿。插件在译文导入 Zotero 后绑定两侧附件 key、验证并持久化 `MappingV1`，不向 Reader 暴露内部 IL、tracking 或 `debug_id`；后端 worker、uv 运行器及 IL→mapping 草稿适配器已实现开发原型，现已通过真实 BabelDOC 对单页 PDF 的离线替身译文试验，并实现 Zotero 右键入口、附件导入和原生 Reader 打开；已在隔离 Zotero 10.0.3 GUI 中验证本机模拟 API 的完整流程及实际双向悬停；用户授权的真实 API 已完成单页双段试译和中文 PDF 文本层验证。其余版本仍需实测。
2. `MappingV1`（`src/mapping/types.ts`、`mapping.v1.schema.json`）：前端统一消费 `source/target` 附件 key + SHA-256 + 页数、任务内 segment ID、状态、置信度、两侧各自页号和多行 quads、后端 provenance。一个 segment 可跨多页；仅 `aligned` 且双侧有几何的记录能用于悬停。更换后端只需导出相同草稿协议，由前端统一绑定 Zotero 附件 key。
3. `NativeReaderOverlay`（`src/reader/nativeOverlay.ts`）：使用 Reader 实例中 PDF.js iframe 的 `PDFViewerApplication.pdfViewer.getPageView(pageIndex)` 与 page viewport；使用 `convertToPdfPoint` / `convertToViewportPoint` 完成鼠标命中和高亮绘制。不创建 Zotero annotation。已接入右键翻译与双 Reader 流程；在 Zotero 10.0.3 隔离 GUI 中验证过双向悬停；7–9、缩放/旋转等仍待版本实测。

### 坐标规范

`pageIndex` 为 0 基；每个 quad 由四个 `[x,y]` 点组成。x/y 坐标范围 0–1，以**未旋转的 PDF 可见 CropBox/viewBox 为基准**，左上为原点。即 PDF 空间坐标转换为 `x = (pdfX - cropLeft) / cropWidth`、`y = (cropTop - pdfY) / cropHeight`。翻译后 PDF 必须使用自己的 CropBox/viewBox 转换，不能假设与原文同页或同尺寸。前端将规范化点还原到 PDF 坐标后，使用当前 PDF.js viewport 处理页面旋转、CropBox 偏移、缩放、DOM CSS scale。按行/字符导出真实 quads，不能用整段的单个包围盒遮盖图表。

### 双向交互

同一映射中的 `source` / `target` 均可命中，`NativeReaderPair` 将两侧 Reader 的悬停事件转发给另一侧。两侧附件 key 不匹配则拒绝绑定；消费映射前还必须验证 schema、源/译文件哈希与页数。两个 Reader 标签一般不能同时看见；要同时显示原文和译文，应验证 Zotero 原生分屏/独立 Reader 窗口的版本能力，不能假设现有的两个标签就是并排双栏。未通过该 UI 测试前不承诺同时双向可见。

## 2. Zotero 7–10 兼容方式

使用 Zotero 插件生命周期管理 `registerEventListener('renderToolbar')`/Reader 实例和资源释放；隔离私有结构访问于 `src/reader/nativeOverlay.ts`，不向其它层传播 `_internalReader._primaryView._iframeWindow` 等。每个版本必须检查 iframe、`PDFViewerApplication`、`pdfViewer.getPageView`、`viewport` 和 eventBus；不符合能力闸门就禁用本版本原生悬停，报告兼容错误，**不退化为错误位置的高亮**。

至少逐版本做以下实测（目前只有 Zotero 10.0.3 已通过隔离 GUI 试译与 hover 测试）：

| 版本 | 启动/安装 | Reader iframe | pointer 命中 | 缩放/旋转/CropBox | 滚动/切标签 | 卸载清理 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 未确认 |
| 8 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 未确认 |
| 9 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 | 未确认 |
| 10 | 10.0.3 已测 | 已测 | 双向已测 | 待测 | 待测 | 插件卸载未测 | 单页双段测试通过 |

必须验证工具栏/Reader 生命周期注入的时机：Reader 可能尚未加载 PDF.js iframe，需等待 `initializedPromise`、重新 attach 或重试；关闭标签、Reader 窗口与插件 shutdown 均需 `detach()`。兼容性逐版本跑真实样本回归，不以 TypeScript 类型存在代替实机验证。自建阅读器不是当前计划目标；某版本无法可靠注入则明确标记该版本暂不支持悬停，而非悄悄切换实现。

## 3. 尚需完成

- 使用假翻译器完成 BabelDOC 真实追踪结构与 IL ID 的运行时验证；验证已有本机 worker、BabelDOC adapter 与映射草稿的真实样本输出；对跨页/重排等情况继续 fail closed。
- 将版本化的 `MappingV1` 与 Zotero 附件导入/哈希失效验证连接起来；译文附件、哈希校验与原生 Reader 适配器已通过隔离 Zotero 的单页双段端到端测试；更复杂论文仍需验收。
- 接入 Zotero Reader 生命周期和并排显示模式；针对 7–10 的 PDF.js 差异单独做能力探测、真实事件测试和自动/人工回归。原生 Reader 内 PDF.js 私有接口不是 Zotero 提供的稳定公开契约。
