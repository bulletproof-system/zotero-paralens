# uv 环境与翻译 API 选择（2026-09-29）

## uv 启动检查与作业环境

插件启动时会查找自定义绝对路径、进程 `PATH` 及 uv 常见安装目录，并以参数数组执行 `uv --version` 验证。找不到 uv 时**只禁用翻译**，仍允许打开设置页、修正路径并重新检测；不因缺少 uv 导致整个插件无法加载。本机 uv 可运行；Zotero 10.0.3 隔离测试已验证后端安装、PDF 翻译与双向悬停，真实 API 试译结果见下文。

后端项目 `backend/pyproject.toml` 固定 Python 3.12 与 `babeldoc==0.6.4`。用户明确授权首次联网安装后，可在任何工作目录执行（将占位符换成设置页显示的绝对路径）：

```sh
uv sync --project "<Zotero profile>/paralens/backend" --python 3.12
```

已存在可用译文时，右键再次翻译会先明确提示将再次调用可能计费的 API、新译文成为默认对照、原译文附件仍保留；拒绝确认不会发起作业。确认重译后，新译文附件标题包含 UTC 时间以区别旧附件；旧的映射文件将由新结果覆盖，不会自动删除用户的旧附件。如果旧映射已损坏，同样要求明确确认后才允许覆盖。

翻译进行时可从 PDF 附件右键菜单选择「ParaLens：取消正在运行的翻译」。取消为协作式：插件写入取消标记并等待 worker 退出，不导入已取消作业的结果，也不覆盖已有映射；正在处理的 API 请求不一定能立即中止，已发送的请求仍可能计费。取消入口仅在作业可取消时出现，导入译文阶段不提供取消。

设置页的「翻译后端」当前仅列出已实现的 BabelDOC；通过虚拟环境中的 Python 检查 `babeldoc==0.6.4` 是否真实可用，而非仅检查 `.venv` 是否存在。未安装或安装不完整时显示「安装后端」，点击后使用已检测到的 uv 执行同一 `uv sync` 命令（可能联网下载 Python 与依赖），安装中会禁用重复点击。npm 用于构建 Zotero 插件，不能替代 Python 后端所需的 uv。安装会在该 Zotero profile 的 `paralens/backend/.venv/` 生成虚拟环境；开发仓库的 `backend/.venv/` 被 Git 忽略。插件启动只将 XPI 内固定的三个脚本/配置文件部署到 `PathUtils.profileDir/paralens/backend/`，设置页显示实际目录。**插件启动、打开设置页与作业运行都不自动执行 `uv sync`**，以免用户不知情时联网下载依赖、模型或字体。`runUVWorker` 只接受绝对路径、可信后端目录下的 worker 脚本、作业配置文件路径；运行命令是：

```text
uv run --project <backend> --no-sync --offline python <backend/worker.py> <job-config-path>
```

`--no-sync --offline` 保证作业不更新依赖/不从 uv 下载包。缺少 uv、`.venv/pyvenv.cfg` 或 worker 时明确拒绝作业。已实现 `backend/worker.py`、IL→mapping.v1 草稿适配器和插件侧 `BabelDocBackend`（见 `backend/README.md`），后端脚本已打包并在插件启动时部署；现已加入 PDF 右键翻译入口、Zotero 译文附件导入及原生 Reader 打开流程；已对一页 PDF 使用真实 BabelDOC/PDF 流程与本地替身译文完成离线试译，**已在隔离 Zotero 10.0.3 用本机模拟 API 验证双向悬停，并以用户授权的真实 API 试译单页双段合成 PDF**。worker 通过 BabelDOC 固定版 Python API 调用翻译器，不向 BabelDOC CLI 参数传 API Key。

在 Windows 上如果 BabelDOC 的临时 PDF 文件句柄尚未释放，worker 会分别重试清理两个临时目录；清理失败不会掩盖翻译失败或丢弃已成功生成的译文，而会在作业目录写入不含密钥/正文/路径的 `cleanup-warning.json`。如遇该文件，可在 Zotero 退出后手动清理该作业中的 `babeldoc-*` 与 `output-*` 临时目录。

注意：文档模型/字体的首次获取可能在 BabelDOC Python 执行期间自行联网，uv 的 `--offline` **并不**阻止 BabelDOC 应用内部网络请求；后续应单独提示/预热资源与控制费用。

复现实测：先 `npm run build`，再运行 `uv run --project "<Zotero profile>/paralens/backend" --no-sync --offline python scripts/offline-translation-smoke.py`；在 `.scaffold/offline-effect/` 查看译文 PDF 与预览图。该脚本用本地替身译文、不请求用户配置的 API，不能替代对真实服务的实测。另可运行 `scripts/local-api-translation-smoke.py`，在回环地址接收真实 OpenAI SDK 请求并返回固定译文；此测试发现 BabelDOC 默认共享缓存可能跳过当前 API 请求，现已禁用该缓存以避免不同接口间误复用，重复翻译请留意费用。用户实际试译请将新生成的 XPI 安装至 Zotero，在 ParaLens 设置检查 uv/后端、语言及 API 后，选中单页 PDF，右键「ParaLens：翻译 PDF」并确认可能产生费用。自定义地址若填入完整 `/v1/responses` 端点，插件会在调用 BabelDOC 的 Chat Completions 时仅使用同一主机的 `/v1` 作为 SDK Base URL；保留首选项中原始输入，不将密钥放入 URL。

## 翻译 API：不必一开始就引入巨型依赖

调查结果：BabelDOC **0.6.4** 内置 `OpenAITranslator`，支持配置 `model`、`base_url`、`api_key`；当前固定版本的 CLI 翻译服务入口主要是 `--openai`。因此先通过预设接 OpenAI、OpenRouter、DeepSeek，再用“自定义 OpenAI 兼容接口”接其他厂商或用户已有的 LiteLLM 网关，避免为每个提供商分别写 SDK。DeepSeek 预设使用官方当前推荐的 `deepseek-flash`，不使用已退役的 `deepseek-v4-flash` 别名。

| 路线                            | 覆盖范围                                                    | 用户需要配置                                             | 本阶段取舍                                           |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| BabelDOC OpenAI 兼容入口 + 预设 | OpenAI、OpenRouter、DeepSeek 等兼容 Chat Completions 的接口 | 选择提供商、API Key，必要时选择模型；URL 预填            | **当前实施**；对大多数用户最简                       |
| OpenRouter                      | 单一 API 入口、多供应商模型（不是本机库）                   | 一个 OpenRouter Key 和模型 ID；需知悉服务路由与费用/隐私 | 已加预设，不自动替用户选付费模型                     |
| LiteLLM Python SDK / Proxy      | 官方文档称支持 100+ 模型/提供商及统一 OpenAI 格式           | 仍需各厂商凭据、必要时部署/配置网关                      | 可在下一阶段按需接入；不默认为每位用户安装重量级网关 |
| 自定义兼容接口                  | 本机 LLM、用户自建网关                                      | URL、模型 ID、网关认证方式                               | 已提供；仅远程 HTTPS 或本机回环 HTTP                 |

**“统一调用大量 API”不能等于“无需配置凭据”**：直连不同厂商时权限、计费、请求字段和模型名不同。当前设置页的预设是最小界面负担，LiteLLM 是覆盖非常规供应商的可选路径；兼容接口也不保证每个模型都满足 BabelDOC 对输出和占位符的要求，实际翻译要单独验收。

## 密钥与限制

- API Key 由 Zotero 使用的 Gecko `Services.logins` 凭据管理器保存，按 provider 分离；模型、URL、uv 路径才进入插件首选项。Zotero 10.0.3 临时测试 profile 已实测虚拟密钥的增删查。
- 设置页不会显示已保存密钥明文；留空意味着不覆盖；可对当前 provider 删除。保存设置不发起 API 请求。
- 插件已从 Gecko 凭据管理器读取密钥，写入受限权限的一次性作业配置文件；worker 在加载模型和网络调用前删除该文件，插件在作业退出后也执行清理。密钥不进入命令行、普通状态、日志或映射。取消通过作业标记在后端进度回调生效，网络调用中未必即时中断。
- 本项目计划覆盖 Zotero 7–10，但当前凭据和启动流程只在 10.0.3 做了实机验证；其余版本仍需测试。

参考原始资料：uv 官方 [项目运行](https://docs.astral.sh/uv/concepts/projects/run/) 与 [锁定/同步](https://docs.astral.sh/uv/concepts/projects/sync/)；[BabelDOC v0.6.4 翻译器](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/babeldoc/translator/translator.py)；[LiteLLM 官方文档](https://docs.litellm.ai/docs/)；[OpenRouter 文档](https://openrouter.ai/docs/quickstart)；[DeepSeek API 文档](https://api-docs.deepseek.com/)。

## Zotero 原生 Reader 隔离回归（不调用已保存 API Key）

`npm test` 的上游脚手架会清空其工作目录下 `.scaffold/test/`，不可直接用共享仓库或真实 Zotero profile 验收。先在 PowerShell 指定**已经安装 BabelDOC 0.6.4** 的 uv 虚拟环境（仅复用 Python 依赖），再运行：

```powershell
$env:PARALENS_TEST_VENV = 'C:\path\to\Zotero\Profiles\test-profile\paralens\backend\.venv'
# 如果 Zotero 未安装在 C:\Program Files\Zotero\zotero.exe，还需设置：
# $env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH = 'C:\path\to\zotero.exe'
npm run test:gui:isolated
```

运行器每次在 `.scaffold/gui-smoke-<随机值>/` 建立**新目录**、临时 Zotero profile 和数据目录，不清空旧内容；为已有虚拟环境建立仅复用依赖的目录链接（链接本身不强制只读），进程结束后保留隔离目录供查验。脚手架的全局 Zotero kill 命令被禁用，隔离实例使用 `-no-remote`；**无需关闭当前 Zotero**。测试使用合成双段英文 PDF、一次性的 `local-test-only` 凭据和 `127.0.0.1` 模拟 OpenAI 接口；无需也不会读取已有真实 API Key。它经真实 PDF 右键菜单翻译、导入译文附件、保存映射、打开两份原生 Reader，并在源／译 PDF 页面合成指针移动，断言另一侧绘制瞬时高亮。`--prepare-only` 只创建隔离副本，不启动 Zotero 或模拟服务。

本机该流程已有 **9 项 Zotero 测试通过**（含未安装时按钮显示、点击后 uv 安装命令的拦截验证，不联网安装）；后端单页双段布局、中文文本层和实际 Reader 双向悬停已验证。经用户明确授权，另以用户已保存的 API Key 对单页合成 PDF 完成 **1 次真实试译**：两段分别为「河水缓缓流淌。水很清澈。」和「今天海洋很平静。空气清新。」；译文 PDF 的页面预览正常、中文文字可由 Zotero 原生 PDF.js 提取，2 个段落均生成有效的双向映射。实际费用需以 API 服务商账单为准，本测试不包含复杂论文版式或所有语言模型的质量验收。

该真实试译通过 `node scripts/gui-smoke-isolated.mjs --real-api` 显式触发，要求 `PARALENS_TEST_VENV` 指向已安装依赖的虚拟环境，`PARALENS_REAL_API_SOURCE_PROFILE` 指向用户授权的 Zotero profile；运行器仅在临时 Zotero profile 中复制 Gecko 凭据文件，结束时删除副本。**每运行一次都可能再次产生费用**，不要将此命令作为默认单元测试。默认 `npm run test:gui:isolated` 仍只调用本机模拟服务。

使用同一授权配置运行 `node scripts/gui-smoke-isolated.mjs --real-api --two-pages` 时，采用仓库内自行生成的两页英文样本，这会产生**新的**可能计费的 API 调用。2026-09-30 首次真实两页翻译已经输出两页可见、可提取的中文 PDF，但 PDF 换行使整段 IL 文本无法直接定位，2 条映射均标为 `uncertain`；随后补充整段文字在单一 PDF 文字块中唯一匹配的 CJK 跨行定位（重复文本依然拒绝），再进行第二次真实两页试译，**2/2 个段落均为 `aligned`**。已检查两页渲染预览，并用该真实产物离线回放验证缩放/旋转和原文/译文 Reader 第 1→2 页双向悬停跳转；回放还逐行核对了高亮轮廓：两页原文各 9 行，译文分别 5、6 行，不只检查首行。不要误把第一次仅生成译文的试译当作双语高亮成功，实际费用以 API 账单为准。

真实 API 产出的 PDF 与未绑定映射还可**离线回放**，不复制凭据、不再次调用 API：

```powershell
$env:PARALENS_REPLAY_PDF = "<上次真实作业>/translated.pdf"
$env:PARALENS_REPLAY_MAPPING = "<上次真实作业>/mapping.v1.json"
node scripts/gui-smoke-isolated.mjs --replay-real
```

回放两页真实作业时，还要设置 `PARALENS_REPLAY_SOURCE` 为该次隔离测试目录中 `fixtures/gui-smoke-short-en.pdf` 的路径（路径需位于 `.scaffold/`），并改用 `--replay-artifact`；否则默认单页测试原文的 SHA-256 不匹配，运行器会拒绝回放。回放前运行器核对 PDF 与映射 SHA-256、合成原文的 SHA-256 和后端来源。在全新隔离 Zotero 中导入两份 PDF、绑定附件 key，执行插件真实「打开双语对照」右键命令，并在两侧 PDF 页面检查双向悬停。2026-09-30 本机用真实 API 的单页双段结果回放，**1 项 GUI 测试通过**。

同一回放流程也能测试更接近论文的两栏样本，而**不再次调用付费 API**：先用已安装 BabelDOC 的 Python 执行 `scripts/local-api-translation-smoke.py --two-columns`，它只请求 `127.0.0.1` 的假译文服务；然后把新生成目录下的 `short-en.pdf`、`job-1/translated.pdf` 和 `job-1/mapping.v1.json` 分别设置为 `PARALENS_REPLAY_SOURCE`、`PARALENS_REPLAY_PDF`、`PARALENS_REPLAY_MAPPING`，运行 `node scripts/gui-smoke-isolated.mjs --replay-artifact`。实测 1 页、左右两栏保留布局、2 段映射的源／译四个位置互不串栏，并在原生 Reader 双向悬停通过 **1 项 GUI 回放测试**。此外，两页本机模拟 API 产物的离线 Reader 回放验证了跨页段落悬停：从原文第 2 页悬停会将译文 Reader 从第 1 页导航到第 2 页；在同一段译文上反向悬停，也会将原文 Reader 导航回对应页。修复了远端高亮覆盖本地悬停状态后，真实 API 的单页双段产物也重新通过离线回放，未重复调用 API。此外，原生 Reader 的离线 GUI 回放已验证译文页在 1.25 倍缩放与旋转 90° 后，高亮仍位于当前 PDF 页面，且轮廓按新 viewport 重绘；真实 API 双段产物和本机模拟 API 两栏产物各通过一次。此项回放不请求 API、不产生新费用。这仍不代表真实论文的任意表格、公式、跨页合并段落或 Zotero 7–9 均通过。

## 批量队列与映射附件

多选 PDF 后仅确认一次费用，任务按入队顺序串行执行；同一原文的排队/运行任务不重复入队。失败不会阻塞后续任务。任务窗口可取消排队、协作取消运行和重新开始；重新开始从头调用后端且需再次确认费用。启动只恢复任务记录，将未完成任务标为中断，不自动重发请求。队列记录在本机 profile 的 paralens/translation-queue.json，不含 API Key。

每次成功翻译导入一个译文 PDF 和一个 mapping.v1 JSON 存储附件，均归属同一文献。JSON 带原文/译文附件 key 标签，另一设备通过 Zotero 元数据与文件同步获得附件后无需本机映射缓存即可打开对照。未下载的 JSON 会提示先下载；不通过同步状态猜测坐标。旧 profile-only 映射首次读取时迁移，旧译文和映射附件保留。OCR 暂不支持。

### 进度与错误提示

任务窗口显示总体百分比与阶段，失败保留最后进度。译文生成后还需要建立段落映射、导入附件；只有最终提交成功才会显示 100%，不要在排版保存阶段结束时强制退出 Zotero。后台检测、安装和翻译使用隐藏进程启动，Windows 不需要打开命令行窗口。

如果映射快照不可用但译文 PDF 可读，会保留译文，任务提示“段落对照不可用”，此时请直接阅读译文；不会猜测坐标。内存不足、文件读写错误和取消仍按失败/取消处理。错误提示包含安全的错误码（例如 `api_auth`、`api_rate_limit`、`memory_exhausted`、`mapping_failed`），排查时提供错误码和阶段即可，不需要提供 API Key。

## 复杂文档回归（显式、独立临时环境）

已有 BabelDOC 产物可不调用 API 重放完整的映射/结果发布路径：

```powershell
& '<已安装 venv>/Scripts/python.exe' scripts/replay-translation-artifacts.py --job '<已停止作业目录>'
$env:PARALENS_TEST_VENV = '<已安装 venv>'
$env:PARALENS_REPLAY_DIRECTORY = '<上一步输出的 REPLAY_DIRECTORY>'
node scripts/gui-smoke-isolated.mjs --replay-complex
```

重放输入只读；新产物、Zotero profile、论文附件副本均留在系统临时目录，不复制到仓库 fixtures，不读取密钥，也不重复计费。回归使用生产 `finalize_translation()`，检查附件哈希、映射附件重载、可信段落双向高亮的实际几何和跨远页跳转。15 页复杂样本的 29 个可信段落已全部通过 GUI 回放；未对齐段落仍不会高亮。

完整本机假 API 回归：

```powershell
& '<已安装 venv>/Scripts/python.exe' scripts/complex-local-translation-smoke.py --source '<PDF 路径>'
```

该脚本禁止非 loopback 网络连接、绕过本机系统代理，不读取密钥，真实运行布局/翻译请求/排版/映射/发布。15 页样本已完成一次完整调用链（607 个 localhost 请求、15 页输出、原文哈希不变）；假译文只是排版压力测试，不代表真实翻译质量或可信对齐覆盖率。

需要**真实 API 复测（可能产生费用）**时，显式设置 `PARALENS_REAL_API_SOURCE_PROFILE`、`PARALENS_TEST_VENV`、`PARALENS_COMPLEX_SOURCE` 和 `PARALENS_COMPLEX_EXPECTED_PAGES`，运行 `node scripts/gui-smoke-isolated.mjs --real-complex`。运行器只在独立系统临时 profile 中复制凭据，结束后移除凭据副本，不修改日常 Zotero 库。

复杂文档取消不能仅依赖进度事件：worker 现在单独监测取消标记，并通过后端 cancellation event 阻止新翻译任务。已发送的 API 请求仍可能计费。BabelDOC 的段落 fallback 会吞掉部分提供商错误；worker 独立记录安全的调用结果，全部请求失败时不会把未翻译的 PDF 当成功产物，鉴权失败会停止继续请求。

授权真实复测已完成：同一 15 页 PDF 输出 15 页中文译文，原文/译文/JSON 三附件提交成功，队列 completed/100%，端到端约 26 分钟。36 条可信对齐段落全部通过另一次最终代码 GUI 回放；其余段落不会伪装成已对齐。临时凭据副本已清理。这是该样本与当前配置的验收，不是任意复杂 PDF 的质量保证。

## 取消历史删除与译文完整性

- 任务进入「已取消」状态后可以删除队列记录。运行中、排队中和已完成的任务不允许通过该按钮删除；磁盘保存失败时保留原记录。删除操作不删除原文、译文或映射附件，不发起翻译请求，重启后不会恢复已删除记录。
- BabelDOC 0.6.4 的原生 LLM 请求预算为 2048 tokens。本插件将预算至少提升到 8192；对空白/null 或截断输出仅追加一次更大预算（至少 16384）的尝试。该预算是输出上限，不是承诺实际用量；推理模型的内部推理可能占用预算。重试和补译都可能产生额外 API 费用，取消不能撤回已发送的请求。
- 对官方支持双模式的 DeepSeek 型号（如 `deepseek-flash`、`deepseek-v4-pro`），翻译请求显式设置 `thinking.type=disabled`，避免默认高强度思考占用输出预算；不向其他型号发送这个特有参数，也不覆盖显式思考配置。模式依据 DeepSeek 官方 Thinking Mode 文档。
- 英文→中文时，对正文和图表说明中的长英文残留进行补译，既检查完全未译的段落，也检查少量中文夹着长英文的段落。补译保留翻译前的正文结构，复用 BabelDOC 原有公式/样式占位符流程，避免将已转成译文 Unicode 的段落误当作不可翻译的调试文字；短名称、引用、缩写和公式不因为含有英文就被强制补译。补译仍不完整时报告 `translation_incomplete`，不将原文 fallback 当作成功译文。该检查不是语义正确性或所有语言质量的保证。 对连续编号的参考文献，逐条检查中文标题/说明；作者、出版场所和标识符保留原拼写，不将长作者列表当作未译正文。未译条目、编号缺失或混杂真实英文正文仍不能通过。
- 对照坐标优先逐字符核验 IL 的字符内容及位置，绘制的 quads 必须来自实际 PDF 文本层。完整文本回退也必须核验唯一匹配；不使用整段包围盒、文字前缀或段落序号硬配。无法核验的段落保留为 uncertain，不伪造可高亮坐标。
- 旧译文和旧映射不会被升级自动重写。修复英文残留需要重新翻译；离线重建映射只能改善对照，不能修复译文本身。

开发验收可用 `scripts/audit-translation-artifacts.py` 只读审查已保存的原始/翻译/排版 IL、最终 PDF 和映射，输出全篇正文的残留及覆盖计数，不输出论文正文或凭据。真实 API 测试在复制凭据前先检查测试入口 TypeScript；仍应在隔离 profile 中运行。

## 翻译速度与请求上限

ParaLens 设置页新增「翻译并发数」（1–16）和「每秒最多发起请求数」（1–10），默认分别为 **4 / 2**。旧 worker 固定 `qps=1`，且未指定 `pool_max_workers`，导致单 PDF 的翻译线程数跟随 QPS 默认值。现在二者独立传入后端，正文与 fallback 线程池、空响应重试和完整性补译共享同一个实际请求 gate；SDK 隐式重试关闭，连接/服务端异常保留最多两次显式重试，BabelDOC 的限流重试也经过该 gate。

- PDF 作业依然逐个处理，避免多份大文档同时消耗内存；并发仅针对单份 PDF 内的 API 请求。
- 选项在入队时保存快照，只影响之后新入队的任务。旧队列没有新字段时补入默认值，重启仍不会自动开始计费；损坏/越界值拒绝运行。
- 并发不是倍速承诺：模型响应、提供商限流、解析、排版与映射都会影响实际耗时。遇到 429 或较低配额时，请先降低 QPS/并发。
- 等待 gate 的请求可取消；已经发送的请求仍可能计费，无法撤回。

## 图片与图内文字高亮的边界

映射适配器版本 3 对 1–4 字符图内标签不再要求至少五个字符，而是要求全部字符身份、实际位置与唯一性核验通过。图内可提取文本仍按实际 PDF 字符 quads 高亮。

另外为源/译 PDF 中全篇唯一且 decoded-image digest 相同的栅格图片增加图片级区域映射。其四边形来自 PDF 实际图片 transform，支持 CropBox 和旋转；文字命中优先于包含它的图片区域；嵌套图片优先命中较小的实际区域，避免大图遮住图内小图。不能用整图高亮冒充文字逐段对齐。重复图片/图标、内容已改变的栅格、裁剪越界区域和无法核验的文字不强行配对；纯矢量图、扫描图片内无独立文本层的译文仍不保证支持。

既有译文和映射不会自动更新。重新翻译会生成新版映射；拥有原始 BabelDOC IL 的开发者也可离线重建映射，但这不会修复译文内容，也不发起 API 调用。

## 依赖升级说明

当前 BabelDOC 固定为 0.6.4。升级插件只部署后端脚本与依赖声明，不会静默更新已有 `.venv`；旧版后端会显示版本不匹配，需在 ParaLens 设置中显式点击「安装后端」完成依赖更新（可能联网下载），随后再翻译。

前端依赖按最新发布版本更新；TypeScript 使用 `~6.0.3`，因为当前 typescript-eslint 解析器的支持范围是 `<6.1.0`，暂不升级到 TypeScript 7。
