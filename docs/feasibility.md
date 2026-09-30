# A 阶段可行性验证报告

> 验证日期：2026-09-29；对应 `docs/实施规划.md` 阶段 A。当前结论：A1 样本级通过；A2 的 PDF 解析、IL 快照与排版链路通过，但映射导出仍需适配器；A3 尚未通过技术闸门，原生 Reader hover 只能作为实验路径，默认保留自建双栏 PDF.js 退路。

## 1. 验证环境

| 项目 | 实际值 |
| --- | --- |
| OS | Windows x64 |
| Zotero | 10.0.3 |
| Reader 类型定义 | `zotero-types@4.1.3` |
| BabelDOC | 0.5.20 |
| Python | 3.12.12（uv 解释器） |
| toolkit | `zotero-plugin-toolkit@5.2.0` |

本次 BabelDOC 使用临时虚拟环境和 dummy OpenAI key，仅满足 CLI 参数检查，并指定 `--skip-translation`，没有发起翻译 API 请求。临时环境已清理。

## 2. A1：数字 PDF 与文本层

本地基线样本（不复制进仓库，版权/再分发许可未核实）：

```text
本地 Zotero 附件 PDF（省略个人文件路径；原始论文未纳入仓库）
```

| 检查项 | 结果 |
| --- | --- |
| 文件大小 | 7,513,450 bytes |
| SHA-256 | `568eeb6eec6a7e555566c3a90471c4dfc45f94e7e60bb0fc9841520085c32390` |
| PDF header | `%PDF-1.7` |
| 页数 | 15 |
| 文本层 | 15/15 页可提取文本 |
| 提取文本量 | 88,445 字符（PyMuPDF 1.28.2） |
| Zotero fulltext cache | `.zotero-ft-cache` 存在且可读，约 87 KB |
| 页面结构 | 含 CropBox；样本 PDF 结构包含 Rotate 相关信息 |

文本包含标题、作者和 `Abstract`，确认是数字原生 PDF，适合作为 A1/A2 本机基线。它不是完整 fixture 覆盖集：仓库内尚无可再分发的单栏、多栏、跨页、公式、图注、旋转/裁切样本。

## 3. A2：BabelDOC IL、跟踪与排版

### 3.1 实测命令与结果

对样本第 1–2 页运行：

```text
babeldoc --files <source.pdf> --working-dir .scaffold/feasibility-babeldoc \
  --output .scaffold/feasibility-babeldoc/out --debug --skip-translation \
  --skip-clean --lang-in en --lang-out zh --pages 1-2 \
  --openai --openai-api-key feasibility-dummy --no-dual --no-mono
```

退出码为 `0`；总耗时约 125.93 秒；峰值内存约 1.3 GB；完成 PDF 解析、页面布局、段落解析、样式/公式处理、排版和字体/绘制指令生成。首次运行下载了 doclayout ONNX 模型和字体资源。本次没有生成最终译文附件 PDF，A2 重点是 IL/排版探测；B 阶段必须另测至少一种 PDF 输出模式。

工作目录中的关键输出：

```text
<sample-stem>/
  create_il.debug.json
  detect_scanned_file.json
  paragraph_finder.json
  styles_and_formulas.json
  il_translated.json
  add_debug_information.json
  typsetting.json
  layout_generator.json
  input.pdf
  input.decompressed.pdf
```

关键 JSON 顶层均为 `{"page": [...], "total_pages": 15}`。虽然命令限制了第 1–2 页，快照的 `page` 长度为 2，`total_pages` 仍为 15，不能用 `page.length` 作为文档页数。

### 3.2 字段和对象连续性

| 文件 | 段落对象数 | 非空段落 | 含 debug_id |
| --- | ---: | ---: | ---: |
| `paragraph_finder.json` | 312 | 312 | 50 |
| `il_translated.json` | 312 | 312 | 50 |
| `add_debug_information.json` | 541 | 541 | 50 |
| `typsetting.json` | 542 | 541 | 50 |

`pdf_paragraph` 实际字段包括：`box {x,y,x2,y2}`、`pdf_style`、`pdf_paragraph_composition`、`xobj_id`、`unicode`、`scale`、`optimal_scale`、`vertical`、`first_line_indent`、`debug_id`、`layout_label`、`layout_id`、`render_order`。页面还包含 `mediabox`、`cropbox`、`page_layout`、`pdf_character`、`pdf_figure`、`page_number` 和 `unit`。

同页同数组顺序比较：

- `paragraph_finder` → `il_translated`：312/312 项 ID 和 box 保持一致；因跳过翻译，unicode 无变化。
- `il_translated` → `add_debug_information`：对象数 312→541，只有 286 个配对项同时保持 ID。
- `add_debug_information` → `typsetting`：对象数 541→542，只有 514 个配对项同时保持 ID，只有 216 个 box 完全相同。
- 本次有效段落的 `debug_id` 有 50 个唯一值，`layout_id` 只有 30 个唯一值，不能单独把 layout_id 当唯一键。

结论：可在 ParagraphFinder 后保存原文和原始几何，也可在 Typesetting 后读取目标几何；不能依赖数组索引、layout_id 或最终 PDF 文本反查。debug_id 只能作为 0.5.20 适配器内部关联，不能成为跨版本/跨任务永久 ID。mapping.v1 必须生成任务内 ID，并用源/目标 PDF SHA-256 绑定。内部坐标仍需转换为规划要求的 CropBox 可见区域、左上原点、归一化坐标，并保留旋转元数据。

### 3.3 translate tracking

BabelDOC 0.5.20 的 `ILTranslator.translate()` 在 `debug=True` 或显式 `working_dir` 时写出 `translate_tracking.json`。源码确认顶层结构为：

```json
{"cross_page":[{"paragraph":[...]}],"cross_column":[{"paragraph":[...]}],"page":[{"paragraph":[...]}]}
```

paragraph tracking 字段包括 `input`、`output`、`pdf_unicode`、`llm_translate_trackers`、`placeholders`、`multi_paragraph_id`、`multi_paragraph_index`、`original_placeholders` 和 `removed_hallucinated_placeholders`。本次没有该文件，是因为 `--skip-translation` 跳过了 ILTranslator；不是该实现不存在。跨页/跨栏结构已完成源码核验，但真实翻译运行时仍需使用 mock translator 进行验证，禁止用真实密钥做未经批准的实验。

### 3.4 hook、清理和许可证

建议适配器 hook：ParagraphFinder 后分配任务内 ID并快照原文；StylesAndFormulas 后保留公式/样式占位；ILTranslator 后读取 tracking 和译文；Typesetting 后读取目标段落/字符几何；保存 PDF 前输出 mapping.v1。

`TranslationConfig` 实际行为：指定 `working_dir` 时文件直接写入该目录；`skip_clean=True` 保留调试目录；`cleanup_temp_files()` 会清理 part 目录，自动创建的临时工作目录还会被递归删除。因此 worker 必须在排版完成后原子写出 mapping，不得依赖清理后的 debug JSON。

安装包元数据声明许可证表达式 `AGPL-3.0`，项目地址为 BabelDOC 官方仓库。复用/嵌入前需审查完整许可证、依赖许可证和分发方式；MVP 更适合把 BabelDOC 作为用户本机可安装的外部 worker，而不是直接打进 XPI。

## 4. A3：Zotero Reader 悬停注入

`zotero-types@4.1.3` 公开了 `Zotero.Reader.registerEventListener()`，事件主要是工具栏、选区弹窗、侧栏 annotation header 和 context menu；Reader 内部类型还暴露 `_iframeWindow`、`_internalReader` 以及 `PDFView._iframeWindow.PDFViewerApplication`。但未发现公开的逐段 pointer hover、overlay 生命周期、page/viewport 变化或 Reader unload 扩展点。原生 DOM 支持 `pointermove` 不等于 Zotero Reader 提供稳定 hover 契约。

`npm run start` 已成功构建、安装临时插件并显示 `Server Ready!`；`npm test` 在模板测试等待 `addon.data.initialized` 时超时，尚未得到可重复的 Reader pointer/overlay 证据。因此 A3 未通过，不能宣称原生 Reader hover 可行。下一步应做仅诊断的 toolbar 原型，监听 `_iframeWindow`/PDF.js DOM 的 pointer、scroll、zoom、rotate，并验证切标签和卸载清理；如果无法稳定通过，按规划转向自建双栏 PDF.js 视图，禁止用永久注释替代 hover。

## 5. 阶段 A 结论

| 任务 | 结论 | 闸门 |
| --- | --- | --- |
| A1 | 数字 PDF 文本层验证通过；fixture 覆盖集未完成 | 部分通过 |
| A2 | 解析/IL/排版快照通过；需 mock translator + 适配器输出 mapping | 部分通过 |
| A3 | 公开接口不足，原型未完成，测试初始化超时 | 未通过/待验证 |

下一步：先以 mock translator 验证 tracking 运行时结构；再锁定 BabelDOC 0.5.20 适配器并完成任务内 ID、原/译几何和坐标归一化；补齐开放许可/合成 fixture；隔离模板示例并修复测试初始化超时，再做 Reader 诊断原型。当前没有创建翻译服务、没有保存 API 密钥，也没有修改原始 Zotero PDF。

## 2026-09-29 产品策略更新

产品目标明确为 Zotero 7–10 **原生 Reader + 内置 PDF.js**，不将自建双栏阅读器作为默认退路。前端映射协议独立于翻译后端，默认 BabelDOC、允许替换；详见 `docs/native-reader-architecture.md`。本报告 A3 中“可退向自建阅读视图”是此前风险评估，不再是当前产品选择；A3 实测未通过的事实不变，必须完成逐版本验证，失败版本禁用悬停。

## 2026-09-29 后续启动与设置页验证

已停止执行不兼容的模板 `examples.ts` 示例注册，改为 ParaLens 最小启动流程：启动检查 uv，缺少 uv 时仅禁用翻译并保留设置页。`src/modules/examples.ts` 仍保留为模板参考，但被 `tsconfig.json` 排除于应用类型检查和运行入口。使用 Zotero 10.0.3 临时测试 profile 验证：启动状态、设置页打开/保存，以及 Gecko 凭据管理器使用一次性虚拟密钥的读写/删除；共 4 项集成测试通过。翻译 worker、原生 Reader 的逐段高亮和 Zotero 7–9 兼容验证仍未完成。
