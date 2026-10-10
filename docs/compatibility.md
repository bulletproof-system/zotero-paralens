# 兼容性与支持边界

ParaLens 为技术原型。Windows / Zotero 10.0.3 是本机隔离 GUI 测试环境；Zotero 7–9 及其他平台没有完整实机兼容性验收。安装清单声明 `strict_min_version: 6.999`、`strict_max_version: 10.*`，这一安装范围不等于各版本均具备验证过的阅读器行为。

## 运行环境

| 项目              | 当前配置                                             |
| ----------------- | ---------------------------------------------------- |
| JavaScript 工具链 | Node.js ≥ 22.13，npm；版本约束见 `package.json`      |
| Python worker     | Python ≥ 3.12、< 3.13，通过 uv 安装和运行            |
| 翻译后端          | BabelDOC 0.6.4，模型和字体由后端按需获取             |
| 阅读界面          | 两个 Zotero 原生 Reader，使用其内置 PDF.js           |
| 翻译接口          | OpenAI 兼容 Chat Completions；用户自行配置服务与权限 |

依赖版本以 `package.json`、`package-lock.json` 和 `backend/pyproject.toml` 为准，不以文档中的样本结果替代实际环境检查。

## PDF 与映射

- 支持路径为具有可用文本层的数字 PDF；扫描件和无文本层 PDF 不属于完整支持范围，不提供 OCR。
- 映射需要 IL 身份和最终 PDF 几何同时可核验。文字重复、对象重排、跨页合并、公式及复杂版式可能产生 `uncertain` 记录。
- 协议允许两侧页号不同和多页引用，但当前适配器按源页面和对应目标页面生成映射，不能保证任意跨页重排后的对齐。
- 图片对照仅覆盖可核验文字或可唯一匹配的栅格区域；重复、改变内容、越界或无唯一匹配的图片以及纯矢量图不强行配对。
- 高亮表示位置对应，不表示译文语义、术语、公式或引用正确；重要内容需人工核对。
- 疑似漏译检查是英文→中文的启发式检测，不是完整语言质量评估。保留部分译文也不意味着全部正文完成翻译。

## 阅读器能力检查

`src/reader/nativeOverlay.ts` 检查 Reader iframe、`PDFViewerApplication` 和页面 viewport。能力缺失时报告不支持，不用猜测坐标或自建阅读器替代。

缩放、旋转、页面绘制、跨页导航、点击锁定和同步滚动由隔离测试及回放脚本覆盖；测试用例覆盖不等于全部文档和 Zotero 版本通过兼容性认证。窗口排列受系统窗口管理器约束，实际跨设备同步还取决于 Zotero 文件同步和下载状态。

## 测试与判定

- `test/*.test.cjs`：队列、配置、后端边界、映射、几何及错误脱敏的 Node 单元测试。
- `backend/tests/`：worker、请求控制、检查／补译、取消、部分产物和映射适配器的 Python 测试。
- `test/*.test.ts`：设置页、凭据、任务窗口及双 Reader 的 Zotero 集成测试。
- `scripts/gui-smoke-isolated.mjs`：独立 profile 中的模拟 API 测试；真实 API 和现有产物回放均为显式选项。

复现步骤见[后端设置指南](backend-setup.md)。测试输出反映实际运行结果，文档不承诺固定用例数量、耗时或对齐覆盖率。
