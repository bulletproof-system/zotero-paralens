# BabelDOC 后端（开发接入）

固定 `babeldoc==0.5.20`、Python 3.12。`worker.py` 使用 BabelDOC `OpenAITranslator`、`TranslationConfig`、`do_translate` 生成**单语**译文；debug IL 的翻译前、中、排版后快照经 `mapping_adapter.py` 变为不带 Zotero 附件 key 的 `mapping.v1` 草稿。源/译 PDF 分别计算 SHA-256，译文附件导入后再调用 `bindAttachmentKeys` 绑定。

## 初始化（须由用户明确允许下载、联网费用与资源开销）

```sh
uv sync --project "<Zotero profile>/paralens/backend" --python 3.12
```

模型和字体的首次加载可能另外联网；`uv run --no-sync --offline` 只控制 uv 的依赖获取，**不能**阻断 BabelDOC 或翻译 API 的网络调用。设置页保存提供商、模型、API Key，并检测 uv。右键单击 Zotero 中的单个 PDF 附件（或仅有一个 PDF 的文献条目），选择「ParaLens：翻译 PDF」，确认 API 可能收费后运行；成功时译文导入 Zotero 并打开原文/译文的原生 Reader。若要重新打开，右键原文选择「打开双语对照」。后端亦可由开发者直接调用：

```ts
const jobDirectory = await createBabelDocJobDirectory();
const backend = new BabelDocBackend(); // 默认使用已部署在 Zotero profile 的后端
const result = await backend.translate({
  sourcePath: absolutePdfPath, jobDirectory,
  sourceLanguage: "en", targetLanguage: "zh",
}, onProgress);
// 校验、导入译文 PDF 后调用 bindAttachmentKeys(result.mapping, sourceKey, targetKey)
```

插件 XPI 包含 `pyproject.toml`、`worker.py`、`mapping_adapter.py`。插件启动时将它们部署到 `PathUtils.profileDir/paralens/backend/`（Windows 通常为 `%APPDATA%\Zotero\Zotero\Profiles\<profile>\paralens\backend\`），设置页展示当前实际路径。重新启动/升级只替换这三个受管脚本文件，保留 `.venv/` 与 `uv.lock`；卸载不会自动删除用户 profile 内数据。**只安装后端脚本，不自动安装 Python、BabelDOC 或模型**：用户同意联网/开销后，用上面的 `uv sync` 在该路径创建 `.venv/`。开发者也可显式传入本仓库 `backend/` 作为 `BabelDocBackend` 第一个参数。菜单、附件导入和 Reader 调用已接通；离线单页 PDF 使用本地替身译文实测成功（1 条可对齐映射），现已使用用户授权的已保存 API Key 完成单页双段与两页合成 PDF 的实际试译（两页结果 2 条逐页段落映射均可用）；复杂论文尚待验证。不自动运行 `uv sync`，也不在失败时改用其他后端。

作业位于 Zotero profile 下 `paralens-jobs/job-*`；含只在运行期间存在的私有 `config-*`（API Key）、`progress.json`、`translated.pdf`、`mapping.v1.json`、`result.json`；失败时留 `error.json`，不放错误异常原文/密钥。退出/失败均删除临时配置文件和 BabelDOC debug 工作目录；原 PDF 不改写。`cancel()` 在活动作业目录写入取消标记；仅在进度回调时生效，尚不保证即时中断网络请求。

映射是**保守**的：只有 IL 段落身份/数量未改变，且原文、译文整段文本能分别在最终 PDF 中定位时才给 `aligned` 与 quads；其余记 `uncertain`，不允许 Reader 高亮。BabelDOC 的 debug IL 不提供稳定的跨页段落对齐 API；跨页合并/布局变化、OCR、反复的相同文本都可能失配，需要人工样本验证。本机已用实际安装的 BabelDOC 和用户授权 API 完成隔离 Zotero 的真实单页与两页合成 PDF 翻译，并离线回放双向悬停；该验证不覆盖实际论文的复杂版式。

离线回归：`python -m unittest discover -s backend/tests -v`；`npm run test:babeldoc`；`npx tsc --noEmit`。

为避免不同提供商/URL 共用 BabelDOC 默认翻译缓存（缓存键没有 API Base URL），本插件明确禁用该缓存；重复翻译可能再次收费，点击翻译前仍需确认。
## 验证翻译效果

构建插件：`npm run build`（生成 `.scaffold/build/para-lens.xpi`）。现可通过右键 PDF 明确触发真实 API 翻译，开始前会确认可能产生费用；无需在命令行输入密钥。

只验证本地排版/导出而不调用真实 API 时，在已安装 BabelDOC 0.5.20 的环境运行：

```sh
uv run --project "<Zotero profile>/paralens/backend" --no-sync --offline python scripts/offline-translation-smoke.py
```

脚本生成单页英文 PDF、使用确定性的本地替身译文，并输出一页译文 PDF、PNG 预览与段落映射摘要到 `.scaffold/offline-effect/`。这不是用户配置的提供商/API 质量测试；首次运行时 BabelDOC 自有资源仍可能联网下载。本地 API 脚本支持 `--two-paragraphs --repeat 2`：断言两条独立段落映射在原文/译文中不重叠，两次作业都发起新请求，并用 Zotero PDF.js 验证两条中文译文。如本机已安装 Zotero，可在上面的命令末尾追加 `--zotero-omni "C:\Program Files\Zotero\app\omni.ja"`，用 Zotero 内置 PDF.js 验证译文的文本层。中文在试验 PDF 中可视。早期本地替身译文的字体曾使 PyMuPDF `get_text()` 返回替换字符；真实两页试译的译文已用 PyMuPDF 和 Zotero Reader 文本层检查为中文，渲染预览可视，仍未覆盖实际 Zotero GUI 中的复制/搜索行为及跨版本悬停。
同样可用 `scripts/local-api-translation-smoke.py --repeat 2 --zotero-omni "C:\Program Files\Zotero\app\omni.ja"` 测试实际 OpenAI SDK→本机临时 API→BabelDOC→译文 PDF→Zotero PDF.js 文本层的调用链。它只用 `127.0.0.1` 和虚构密钥，不读取 Zotero 已保存的真实 API Key；成功输出包含请求数量和对齐段落数，不代表真实服务质量或 Zotero GUI 交互已通过。
