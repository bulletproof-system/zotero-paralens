# BabelDOC 后端开发接口

`backend/pyproject.toml` 要求 Python 3.12，并固定 `babeldoc==0.6.4`。`worker.py` 通过 BabelDOC Python API 的 `OpenAITranslator`、`TranslationConfig` 和 `do_translate` 生成单语译文；`mapping_adapter.py` 对照 IL 与实际 PDF 几何导出 `mapping.v1` 草稿。

BabelDOC 上游许可文本及版本化源码入口见[第三方声明](../THIRD_PARTY_NOTICES.md)和[源码分发说明](../docs/source-distribution.md)。Python 间接依赖、模型和字体不属于完整审查清单；XPI 不打包 `.venv`、模型或字体。

## 部署与调用

XPI 包含 `pyproject.toml`、`worker.py`、`mapping_adapter.py`，启动时部署至 `<Zotero profile>/paralens/backend/`。仅替换三个受管文件，不删除 `.venv`、`uv.lock` 或用户数据；不自动安装依赖。

用户明确允许联网与开销后，点击设置页「安装后端」，或显式执行：

```sh
uv sync --project "<Zotero profile>/paralens/backend" --python 3.12
```

设置页「重新安装后端」在已安装状态下也可用，确认后重新部署脚本并执行 `uv sync --reinstall`；重新安装依赖但不删除密钥、附件和作业产物。安装状态检查固定版本及 worker 模块导入，不加载模型或请求翻译。排队／运行任务需先结束或取消，安装期间不启动新翻译。

作业启动使用 `uv run --no-sync --offline`。这些参数限制 uv 的包下载，不阻止 BabelDOC 资源获取或翻译 API 联网。安装和测试的完整说明见[后端设置指南](../docs/backend-setup.md)。

TypeScript 调用接口定义在 `src/backend/contracts.ts`：

```ts
const jobDirectory = await createBabelDocJobDirectory();
const backend = new BabelDocBackend();
const result = await backend.translate(
  {
    sourcePath: absolutePdfPath,
    jobDirectory,
    sourceLanguage: "en",
    targetLanguage: "zh",
    autoRepair: false,
  },
  onProgress,
);
// 输出校验通过并导入译文附件后，使用实际附件 key 绑定映射。
const mapping = bindAttachmentKeys(result.mapping, sourceKey, targetKey);
```

`BabelDocBackend` 默认使用 profile 中的部署目录，也接受开发者显式传入的项目目录。PDF 和项目路径必须为绝对路径，作业目录必须由 `createBabelDocJobDirectory` 创建且为空。提供商、模型和性能参数可由请求覆盖，否则读取非敏感首选项；密钥在执行时从凭据管理器读取。`autoRepair` 只在请求明确为 `true` 时开启。

## 配置和产物

作业位于 `<Zotero profile>/paralens-jobs/job-*`。受限一次性 `config-*` 含密钥，worker 读取后在加载模型和联网前删除；TypeScript 层也在结束时清理。密钥不进入命令行或错误输出。

| 文件                       | 用途                                    |
| -------------------------- | --------------------------------------- |
| `progress.json`            | 原子更新的阶段和总体百分比              |
| `translation-quality.json` | 疑似漏译／补译计数，不含正文或 API 输出 |
| `translated.pdf`           | 发布到固定路径的译文 PDF                |
| `mapping.v1.json`          | 不带 Zotero 附件 key 的映射草稿         |
| `result.json`              | PDF／映射路径和可选部分完成状态         |
| `error.json`               | 失败时的白名单分类，不含原始异常文本    |
| `partial-warning.json`     | 部分结果的安全警告                      |
| `artifact-retention.json`  | 工作／输出目录保留标志                  |
| `cleanup-warning.json`     | 清理失败的安全提示                      |

作业目录可能包含私有 PDF 和 IL；保留文件不代表可以公开上传。

## 检查、补译和请求控制

默认 `autoRepair: false`；字段缺失也视为关闭。英文→中文只检查长英文残留或空白译文，不请求补译，也不改写 IL。检查是启发式检测，不能保证语义正确。

显式开启后，仅对疑似漏译的正文／图注等段落补译。候选使用原始结构，在独立 IL 副本中解析，核验通过才替换现有段落；失败候选不破坏已有译文。每段最多两次，预算 8192／16384 输出 tokens，补译请求设置 60 秒超时；故障停止补译，不进行长时间逐段重试。HTTP 超时不是整个 PDF 的处理时限。

请求并发和起始速率独立限制，正文、回退、重试及补译共享 gate。默认并发 4、QPS 2，范围分别 1–16 和 1–10。SDK 隐式重试关闭，正文空白／截断输出有一次更大预算尝试，连接／服务异常使用有限显式重试；补译阶段禁用嵌套重试。翻译缓存禁用以防不同服务共用结果，重复运行可能再次计费。

## 取消与部分失败

`cancel()` 写入标记；worker 独立监测，进度回调和请求边界也检查取消，阻止新请求。正在处理的网络请求无法保证即时停止，已发送请求仍可能收费。用户取消不发布结果。

疑似漏译、检查／补译异常或部分提供商请求失败时，继续尝试排版可用段落。生成并校验通过的 PDF 返回 `completion: "partial"` 和安全 `warning`；映射异常提供不可高亮的降级映射。完整 API 失败、初始翻译／排版致命错误和主动取消不伪装为成功。

`translation_untranslated` 表示检测到疑似漏译或补译仍未通过，`translation_incomplete` 表示空／截断输出，`translation_quality_failed` 表示检查／补译内部异常。这些分类不暴露正文、提示词或服务端原始错误。

前端对部分结果仍校验固定路径、映射结构及源／译 SHA-256，导入为「部分翻译，需核对」，绑定附件 key 后保存独立的映射 JSON，并标记 `completion: "partial"`。可信段落可打开双语对照，但部分映射不替换已有完整默认对照。已校验 PDF 在映射保存失败时也保留。未生成或校验失败的 PDF 不保证有可打开的译文。

失败／部分完成保留 `babeldoc-*`、`output-*` 工作目录；完整成功清理中间目录，清理失败不覆盖原结果。重新开始只替换任务记录，不删除已有产物。失败和取消记录的删除不涉及这些目录或附件。

## 映射边界

只有 IL 身份、结构及双侧实际 PDF 位置均可核验时才生成 `aligned` 几何。当前适配器包含字符级位置检查、唯一文本回退和唯一栅格匹配；歧义位置为 `uncertain`，不用于高亮。BabelDOC debug IL 不是稳定的跨版本对齐契约，当前映射不保证任意跨页重排、扫描件或复杂版式。

详细协议和坐标见[原生阅读器架构](../docs/native-reader-architecture.md)。

## 开发测试

在仓库根目录执行：

```sh
npm run test:babeldoc
uv run --project backend --no-sync --offline python -m unittest discover -s backend/tests -v
uv run --project backend --no-sync --offline python scripts/offline-translation-smoke.py
```

离线脚本使用合成 PDF 与确定性的替身译文，不请求用户配置的翻译 API；资源未缓存时 BabelDOC 自身仍可能联网。模拟接口、隔离 GUI、现有产物回放和显式真实测试说明见[后端设置指南](../docs/backend-setup.md)。
