# 映射与原生 Zotero Reader 架构

ParaLens 使用两个 Zotero 原生 Reader 并排展示原文和译文，复用各自内置的 PDF.js。高亮是页面内的临时 overlay，不创建 Zotero 永久注释，也不使用自建 PDF.js 阅读器。

## 接口边界

- `src/backend/contracts.ts` 定义 `TranslationBackend` 与未绑定的映射草稿。
- `src/mapping/types.ts`、`validation.ts` 和 `mapping.v1.schema.json` 定义并检查统一前端协议。
- `src/mapping/store.ts` 保存和读取 Zotero 映射附件、核验文档摘要；Reader 不消费 BabelDOC IL 或内部 `debug_id`。
- `src/reader/nativeOverlay.ts` 封装 PDF.js iframe、页面 viewport、事件监听及高亮释放。
- `src/reader/windowLayout.ts` 排列两个原生窗口；窗口管理器拒绝移动／缩放时保留窗口并提示限制。

## 文字与图片的可信几何

`backend/mapping_adapter.py` 读取翻译前、翻译后和排版后的 IL，并对照原文和译文的实际 PDF 文本层。

段落只有在结构、唯一身份及双侧几何均可核验时才为 `aligned`。字符定位使用实际 PDF 字符及连续行／字体 span，长段落要求至少 98% 字符覆盖；完整文本定位回退也要求唯一匹配。不能以包围盒、前缀、段落数组序号或相同页号单独作为可信对齐依据。对象变化或重复位置的歧义记录保留为 `uncertain`。

图内短文字使用实际字符匹配；栅格图像使用原／译 PDF 的图片内容和位置唯一性匹配。重复图、改变内容、越界图片、纯矢量图及无可核验文本层的图内文字不强行配对。

适配器的正常映射 `adapterVersion` 为 `3`；对齐不可用的降级映射只有不可高亮记录。协议定义的多页能力不等于适配器保证任意跨页重排。

## 坐标约定

- `pageIndex` 是从 0 开始的 PDF 页号。
- 每个 quad 是四个 `[x, y]` 点；坐标范围为 0–1。
- 坐标基于未旋转 PDF 的可见 CropBox／viewBox，原点在左上角。归一化计算为 `x = (pdfX - cropLeft) / cropWidth`、`y = (cropTop - pdfY) / cropHeight`。
- 原文和译文分别使用自己的页面尺寸与裁切范围，不能共用 viewport。
- 命中与绘制通过 `convertToPdfPoint`／`convertToViewportPoint` 换算；缩放、旋转和重绘使用当前 viewport，不复用屏幕像素位置。

## 双向交互

悬停可信文字或图片区域时，两侧显示对应高亮；需要时导航到对侧页面。命中有重叠时优先文字，并避免外层大图遮挡内嵌小图。

点击段落锁定两侧高亮；再次点击同一段落、按 `Esc` 或使用解除锁定按钮可解锁。临时远端高亮和本地悬停状态独立处理。

同步滚动默认关闭。开启后优先使用可信段落锚点，无映射区域按页面进度近似定位；该近似不是文本对齐。程序滚动具有回声抑制，避免两个 Reader 循环驱动。

## 生命周期与兼容性

适配器检查 Reader iframe、`PDFViewerApplication.pdfViewer.getPageView` 和 viewport 等能力。PDF.js 内部对象不是稳定的公开 Zotero 契约；能力缺失时明确报告兼容性问题，不产生猜测高亮。

关闭窗口或插件关闭时执行 `detach()`，清除 overlay、监听器及同步状态。兼容范围见[兼容性说明](compatibility.md)，不以 TypeScript 类型存在代替实机测试。

## 附件与任务

原文、译文 PDF 和映射 JSON 使用 Zotero 附件 key 与 SHA-256 绑定。映射作为存储附件与译文归属同一文献；独立 PDF 对应的映射是同库独立附件。读取优先寻找映射附件；仅存于 profile 的有效映射在读取时迁移为附件。跨设备需同步并下载三类附件，不能绕过 Zotero 同步设置或下载状态。

重译需确认费用，完整成功结果可成为默认对照；已有译文附件保留。部分完成的 PDF 供人工核对，不替换已有默认对照。重新开始完整处理，不提供断点续译。

`TranslationQueue.removeTask` 只删除失败或取消记录，持久化成功后再移除界面行。删除与其他保存串行，不删除附件或本机作业产物，也不发起 API 请求。

## 测试入口

隔离 GUI 使用合成 PDF 和本机模拟接口。已有产物可通过 `scripts/replay-translation-artifacts.py` 和 `scripts/gui-smoke-isolated.mjs` 回放，不重新翻译；真实 API 测试必须显式启用。操作见[后端设置指南](backend-setup.md)。
