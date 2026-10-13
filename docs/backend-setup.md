# 后端安装、API 配置与测试

## uv 与后端环境

插件启动检查设置中的 uv 绝对路径、进程 `PATH` 和常见安装目录，并执行 `uv --version`。找不到 uv 时禁用翻译，设置页仍可修改路径和重新检测。

启动部署 XPI 中的 `pyproject.toml`、`worker.py`、`mapping_adapter.py` 至 `<Zotero profile>/paralens/backend/`，仅替换受管文件，保留 `.venv`、`uv.lock` 和作业数据。部署不安装 Python 包；设置页检查虚拟环境中的 Python 能否加载固定版本 BabelDOC，并导入 worker 所需模块，而不是仅检查目录存在或包版本元数据；检查不加载模型或发送翻译请求。

用户点击「安装后端」后，使用已检测到的 uv 执行：

```sh
uv sync --project "<Zotero profile>/paralens/backend" --python 3.12
```

设置页始终提供「重新安装后端」。用户确认后重新部署三个受管文件，并执行同一同步命令加 `--reinstall`，重新安装所有 Python 依赖以修复后端加载失败。保留 API Key、PDF、映射附件、已有作业和 `.venv` 目录，不整目录删除。安装期间禁用重复操作和新翻译；有排队／运行任务时需先完成或取消。

设置页的「检测后端」区分环境缺失、包缺失／版本不符／Python 无法启动，以及包已安装但依赖导入失败。0.1.7 相比 0.1.6 增加了完整导入检查；更新后出现不可用提示，并不表示插件删除了原有环境。开启日志保存后点击「检测后端」，可记录 Python 导入失败输出；若 uv 同步成功而导入失败，应检查日志中的缺失模块、DLL／系统运行库或文件权限，避免只反复下载相同依赖。

安装界面显示进度条、百分比和当前阶段。uv 不提供全程下载字节总量，因此百分比按准备、解析／下载、安装和验证阶段估算，进度不回退；后端模块验证通过才显示 100%。安装失败保留最后进度，可直接重试。

项目要求 Python 3.12、`babeldoc==0.6.4`。安装可能下载 Python 和依赖；模型及字体也可能在首次翻译时由 BabelDOC 获取。npm 只构建插件，不能代替 uv 后端安装。

插件启动、打开设置页和执行翻译都不自动 `uv sync`。作业使用绝对路径和参数数组运行：

```text
uv run --project <backend> --no-sync --offline python <backend/worker.py> <job-config-path>
```

`--no-sync --offline` 只限制 uv 更新／下载依赖，不能阻止 BabelDOC 资源获取或翻译 API 联网。缺少 uv、有效虚拟环境或 worker 时拒绝运行，不自动改用其他后端。

## 服务与设置

当前只有 BabelDOC 翻译后端，使用 OpenAI 兼容 Chat Completions。设置页提供 OpenAI、OpenRouter、DeepSeek、OpenCode Zen、OpenCode Go 和自定义兼容接口；预设和默认模型以 `src/backend/providers.ts` 为准，预填值不代表服务可用性或账户授权。

自定义接口需填写 Base URL、模型 ID 和 API Key。远程 URL 必须为 HTTPS，本机 loopback 可使用 HTTP；禁止 URL 内包含凭据、查询参数或片段。完整 `/v1/responses` 输入会在执行时规范为同主机 `/v1`，首选项保留输入值供编辑；这不表示 worker 使用 Responses API。自建 LiteLLM 网关可通过自定义兼容入口接入，插件不安装网关。

### OpenCode Zen / Go

在「翻译 API」选择 OpenCode Zen 或 OpenCode Go，填写模型 ID 和该服务的 API Key。Zen 和 Go 使用不同的凭据条目，互不覆盖；Go 的模型访问还取决于账户订阅。

| 服务         | API Base URL                    |
| ------------ | ------------------------------- |
| OpenCode Zen | `https://opencode.ai/zen/v1`    |
| OpenCode Go  | `https://opencode.ai/zen/go/v1` |

仅支持官方列在 Chat Completions 端点的模型（例如 `glm-5.3-flash`），不默认选择模型。只支持 Responses 或 Messages 的模型暂不能通过当前 BabelDOC worker 使用；请根据 OpenCode 官方的 [Zen](https://opencode.ai/docs/zen/)／[Go](https://opencode.ai/docs/go/) 模型端点表选择。

后端为每个翻译任务生成独立的随机会话 ID，自动附带 `x-opencode-session`、`x-opencode-session-id`、`x-opencode-client: paralens` 和 `User-Agent: ParaLens/<插件版本>`。会话 ID 在正文、重试和补译请求之间保持一致；新任务（包括手动重新开始）使用新 ID，不包含配置目录、文件名或文档信息。无需用户填写请求头。

其中 `x-opencode-session` 用于满足 OpenCode 的会话路由要求；缺少它可能返回 `400 MissingSessionID`，参见 [上游问题 #47763](https://github.com/anomalyco/opencode/issues/47763) 和 [客户端请求头实现](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/model-request.ts)。请求头作为 SDK 默认值设置，避免 BabelDOC 的逐请求 `extra_headers` 覆盖它们。只对 HTTPS 的官方主机及上述两个 Base URL 生效；自定义入口使用同样的官方地址时也会附带，其他服务不附带。请求头不会代替有效密钥、订阅或模型授权。

| 设置                 | 默认值与范围 | 作用                                         |
| -------------------- | ------------ | -------------------------------------------- |
| 翻译并发数           | 4，范围 1–16 | 单份 PDF 中同时执行的 API 请求               |
| 每秒请求上限         | 2，范围 1–10 | 正文、回退、重试及可选补译共用的请求起始速率 |
| 自动补译疑似漏译段落 | 关闭         | 显式开启后允许额外补译请求                   |
| 同步滚动             | 关闭         | 阅读器中的可选交互，不影响翻译               |

翻译选项入队时保存快照，只影响新任务；重新开始沿用原任务选项。缺少 `autoRepair` 的队列记录按关闭处理。并发和 QPS 独立受限，但不承诺倍速；解析、模型响应、排版和映射都会影响耗时。

## 日志保存

设置页提供「保存日志到插件文件夹」开关，默认关闭，勾选后立即生效，无需点击「保存设置」。日志位于 `<Zotero profile>/paralens/logs/paralens-YYYY-MM-DD.log`，与可写后端目录同属插件的 `paralens` 文件夹；按 UTC 日期分文件，设置页显示实际绝对路径。

日志包括插件启动、uv 安装输出，以及以下翻译诊断：

- 作业编号和诊断目录、BabelDOC 版本、服务／模型、API 主机、语言、并发、QPS 和自动补译开关。
- 阶段名称、阶段完成数量、总体百分比；阶段切换和总体进度每增加约 5% 时记录，进程结束后再读取最后一次进度。
- 后端进程编号、可执行文件路径、退出事件、退出码和耗时；异常退出与启动失败分别记录。
- 失败代码、后端阶段、Python／BabelDOC 运行版本、异常类型及异常原因链；每个异常最多记录 8 个调用位置（Python 文件名、函数名、行号），文件读写异常附带数值形式的 `errno`／`winerror`。
- 缺失 `error.json`／`result.json` 的情况，以及前端结果校验步骤。旧版后端没有新增字段时仍可读取原有诊断。

日志不写入 API Key、作业配置、文档正文、异常原始消息、调用栈源码／局部变量或翻译 worker 的原始输出。调用位置用于定位代码错误，不是包含异常全文的原始 traceback。日志含本机目录和 API 主机，分享前可按需遮盖。关闭开关后停止追加，已有日志保留，按需手动清理。日志写入失败不会阻止安装或翻译。

## 凭据与费用

API Key 按 provider 保存在 Gecko 登录管理器，不存于普通插件首选项。设置页不显示已保存密钥；输入留空不覆盖，可删除当前服务的密钥。保存设置不发送翻译请求。

执行时从登录管理器读取密钥，写入受限的一次性作业配置。worker 在加载模型和发起网络请求前读取并删除该配置，插件在作业结束后也执行清理。密钥不进入命令行、队列、映射或错误消息。

PDF 解析和排版在本机，待译文本发送给配置的服务。翻译和重新开始均需确认费用；已发送请求可能在取消后继续处理并计费。禁用共享翻译缓存，重复翻译可能再次调用 API。

## 队列、进度与取消

多选 PDF 只确认一次费用，按入队顺序串行处理；同一原文的排队／运行任务去重。翻译失败不阻止后续任务；队列持久化失败则停止启动后续任务。队列位于 `<Zotero profile>/paralens/translation-queue.json`，恢复记录不自动重新发起计费请求。

窗口显示阶段、百分比及安全错误码，失败保留最后进度；排版后还需建立映射和导入附件，最终提交前不显示完整完成。后端检测、安装和翻译在 Windows 使用隐藏进程。

取消为协作式：插件写入标记，worker 独立监测并检查取消状态，阻止新请求；无法保证正在处理的网络请求立即停止。取消结果不导入，也不覆盖现有映射；导入阶段不提供取消。

失败或取消记录可点击「删除任务」移除，只删除队列行，不删除附件／作业产物，也不调用 API。保存失败保留原记录。运行、排队、完整完成、部分完成和中断记录不通过该按钮删除。

## 扫描 PDF 与早期解析错误

`DetectScannedFile` 位于正文翻译之前。BabelDOC 在这里抛出 `ScannedPDFError` 时，插件显示 `pdf_scanned` 并提示使用带可用文本层的原始 PDF；不会通过关闭扫描检测来跳过当前不支持的 OCR。其他扫描检测异常仍可能来自图片、页面尺寸或 PDF 结构，应结合 `error.json` 中的 `backendStage` 和 `exceptionType` 排查。不能仅凭此阶段失败就断定翻译 API 或模型不可用。

## 译文检查与部分产物

英文→中文默认只检测长英文残留或空白译文，不额外请求补译、不改写段落；短名称、引用、缩写和公式不因含英文就判定漏译。这是疑似漏译检测，不是语义正确性保证。

只有 `autoRepair: true` 才补译。候选从原始结构准备，在独立副本中解析和核验，通过后替换已有译文，保留公式／样式标记。每段最多尝试两次，补译预算为 8192／16384 输出 tokens；请求设置 60 秒超时，故障时停止补译。HTTP 超时不是整份 PDF 的总时限。

正文请求的输出预算至少为 8192；空白或截断时追加一次更大预算尝试。请求控制还包含有限的连接／服务错误重试，补译阶段禁用嵌套重试。重试与补译可能增加费用。针对代码识别的 DeepSeek 模型，在未显式配置思考参数时设置 `thinking.type=disabled`；不向其他模型发送特有参数。

疑似漏译、检查／补译异常、部分 API 失败或映射不可用时，继续尝试排版并保留可用 PDF。校验通过的部分结果以「部分翻译，需核对」导入，同时保存独立映射 JSON；有可信段落则可打开对应双语对照，仍需人工核对，不覆盖已有完整默认对照；全部 API 失败、主动取消以及初始翻译／排版的致命错误不伪装为成功。

安全分类包括 `translation_untranslated`、`translation_incomplete`、`translation_quality_failed`、`api_auth`、`api_rate_limit`、`mapping_failed` 等。`translation-quality.json` 记录计数，不存正文、提示词或 API 返回文本。

失败或部分完成保留 `babeldoc-*`、`output-*` 目录及 `artifact-retention.json`。完整成功清理中间目录；清理失败记录安全的 `cleanup-warning.json`，不掩盖原结果。若未生成 PDF，只能保留已产生的中间文件。作业可能含私有文档，勿直接上传；磁盘空间由用户管理。

## 离线与模拟 API 测试

在仓库根目录使用已安装 BabelDOC 0.6.4 的环境运行：

```sh
uv run --project backend --no-sync --offline python -m unittest discover -s backend/tests -v
uv run --project backend --no-sync --offline python scripts/offline-translation-smoke.py
uv run --project backend --no-sync --offline python scripts/local-api-translation-smoke.py --two-paragraphs --repeat 2
```

离线脚本生成合成 PDF、固定替身译文、预览和映射；模型／字体若未缓存仍可能由 BabelDOC 下载。模拟 API 脚本只使用 loopback 和虚构密钥，不读取用户 API Key。二者不评估真实翻译服务的语义质量。

## 隔离 Zotero GUI

`npm test` 的脚手架会清空其 `.scaffold/test/`，不要在共享工作目录或真实 profile 中直接运行。隔离运行器创建新目录、临时 profile 和数据目录，禁用脚手架的全局 Zotero 终止命令，使用 `-no-remote`，不需关闭日常 Zotero。

```powershell
$env:PARALENS_TEST_VENV = 'C:\path\to\installed\.venv'
# 仅当 Zotero 不在默认安装位置时指定：
# $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = 'C:\path\to\zotero.exe'
npm run test:gui:isolated
```

默认目录为 `.scaffold/paralens-gui-smoke-<随机值>/`。依赖环境通过目录链接复用，链接不强制只读；进程结束保留隔离目录供检查。默认使用合成 PDF、一次性测试凭据和 localhost 模拟接口，不读取真实 profile 的密钥。

已有生成产物可通过以下显式模式回放：

```powershell
$env:PARALENS_REPLAY_SOURCE = '<仓库 .scaffold 内的合成原文 PDF>'
$env:PARALENS_REPLAY_PDF = '<译文 PDF>'
$env:PARALENS_REPLAY_MAPPING = '<mapping.v1.json>'
node scripts/gui-smoke-isolated.mjs --replay-artifact
```

复杂文档使用独立系统临时目录：

```powershell
& '<已安装 venv>/Scripts/python.exe' scripts/replay-translation-artifacts.py --job '<已停止作业目录>'
$env:PARALENS_REPLAY_DIRECTORY = '<脚本输出的 REPLAY_DIRECTORY>'
node scripts/gui-smoke-isolated.mjs --replay-complex
```

回放使用已有产物，不调用翻译 API；检查附件摘要、映射重载、实际高亮几何及页面导航。可另用 `scripts/complex-local-translation-smoke.py --source '<PDF>'` 进行 loopback 模拟翻译压力测试，该模式禁止非 loopback 连接。

## 显式真实 API 测试

真实测试可能收费，并向服务发送文档内容，只能在用户授权后运行。设置 `PARALENS_TEST_VENV` 与 `PARALENS_REAL_API_SOURCE_PROFILE` 后使用 `--real-api`；复杂 PDF 另需 `PARALENS_COMPLEX_SOURCE`、`PARALENS_COMPLEX_EXPECTED_PAGES`，使用 `--real-complex`。

这些模式将所需凭据复制到隔离 profile，结束清理副本，不修改日常 Zotero 库。不得将凭据、私有原文、IL 或产物加入 fixtures。`scripts/audit-translation-artifacts.py` 对指定 IL／PDF／映射只读检查并输出计数，不输出正文或凭据。任何真实样本结果都不能代替其他文档和服务的独立验收。
