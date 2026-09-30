# uv 环境与翻译 API 选择（2026-09-29）

## uv 启动检查与作业环境

插件启动时会查找自定义绝对路径、进程 `PATH` 及 uv 常见安装目录，并以参数数组执行 `uv --version` 验证。找不到 uv 时**只禁用翻译**，仍允许打开设置页、修正路径并重新检测；不因缺少 uv 导致整个插件无法加载。本机 uv 可运行；Zotero 10.0.3 隔离测试已验证后端安装、PDF 翻译与双向悬停，真实 API 试译结果见下文。

后端项目 `backend/pyproject.toml` 固定 Python 3.12 与 `babeldoc==0.5.20`。用户明确授权首次联网安装后，可在任何工作目录执行（将占位符换成设置页显示的绝对路径）：

```sh
uv sync --project "<Zotero profile>/paralens/backend" --python 3.12
```

已存在可用译文时，右键再次翻译会先明确提示将再次调用可能计费的 API、新译文成为默认对照、原译文附件仍保留；拒绝确认不会发起作业。确认重译后，新译文附件标题包含 UTC 时间以区别旧附件；旧的映射文件将由新结果覆盖，不会自动删除用户的旧附件。如果旧映射已损坏，同样要求明确确认后才允许覆盖。

翻译进行时可从 PDF 附件右键菜单选择「ParaLens：取消正在运行的翻译」。取消为协作式：插件写入取消标记并等待 worker 退出，不导入已取消作业的结果，也不覆盖已有映射；正在处理的 API 请求不一定能立即中止，已发送的请求仍可能计费。取消入口仅在作业可取消时出现，导入译文阶段不提供取消。

设置页的「翻译后端」当前仅列出已实现的 BabelDOC；通过虚拟环境中的 Python 检查 `babeldoc==0.5.20` 是否真实可用，而非仅检查 `.venv` 是否存在。未安装或安装不完整时显示「安装后端」，点击后使用已检测到的 uv 执行同一 `uv sync` 命令（可能联网下载 Python 与依赖），安装中会禁用重复点击。npm 用于构建 Zotero 插件，不能替代 Python 后端所需的 uv。安装会在该 Zotero profile 的 `paralens/backend/.venv/` 生成虚拟环境；开发仓库的 `backend/.venv/` 被 Git 忽略。插件启动只将 XPI 内固定的三个脚本/配置文件部署到 `PathUtils.profileDir/paralens/backend/`，设置页显示实际目录。**插件启动、打开设置页与作业运行都不自动执行 `uv sync`**，以免用户不知情时联网下载依赖、模型或字体。`runUVWorker` 只接受绝对路径、可信后端目录下的 worker 脚本、作业配置文件路径；运行命令是：

```text
uv run --project <backend> --no-sync --offline python <backend/worker.py> <job-config-path>
```

`--no-sync --offline` 保证作业不更新依赖/不从 uv 下载包。缺少 uv、`.venv/pyvenv.cfg` 或 worker 时明确拒绝作业。已实现 `backend/worker.py`、IL→mapping.v1 草稿适配器和插件侧 `BabelDocBackend`（见 `backend/README.md`），后端脚本已打包并在插件启动时部署；现已加入 PDF 右键翻译入口、Zotero 译文附件导入及原生 Reader 打开流程；已对一页 PDF 使用真实 BabelDOC/PDF 流程与本地替身译文完成离线试译，**已在隔离 Zotero 10.0.3 用本机模拟 API 验证双向悬停，并以用户授权的真实 API 试译单页双段合成 PDF**。worker 通过 BabelDOC 固定版 Python API 调用翻译器，不向 BabelDOC CLI 参数传 API Key。

在 Windows 上如果 BabelDOC 的临时 PDF 文件句柄尚未释放，worker 会分别重试清理两个临时目录；清理失败不会掩盖翻译失败或丢弃已成功生成的译文，而会在作业目录写入不含密钥/正文/路径的 `cleanup-warning.json`。如遇该文件，可在 Zotero 退出后手动清理该作业中的 `babeldoc-*` 与 `output-*` 临时目录。

注意：文档模型/字体的首次获取可能在 BabelDOC Python 执行期间自行联网，uv 的 `--offline` **并不**阻止 BabelDOC 应用内部网络请求；后续应单独提示/预热资源与控制费用。

复现实测：先 `npm run build`，再运行 `uv run --project "<Zotero profile>/paralens/backend" --no-sync --offline python scripts/offline-translation-smoke.py`；在 `.scaffold/offline-effect/` 查看译文 PDF 与预览图。该脚本用本地替身译文、不请求用户配置的 API，不能替代对真实服务的实测。另可运行 `scripts/local-api-translation-smoke.py`，在回环地址接收真实 OpenAI SDK 请求并返回固定译文；此测试发现 BabelDOC 默认共享缓存可能跳过当前 API 请求，现已禁用该缓存以避免不同接口间误复用，重复翻译请留意费用。用户实际试译请将新生成的 XPI 安装至 Zotero，在 ParaLens 设置检查 uv/后端、语言及 API 后，选中单页 PDF，右键「ParaLens：翻译 PDF」并确认可能产生费用。自定义地址若填入完整 `/v1/responses` 端点，插件会在调用 BabelDOC 的 Chat Completions 时仅使用同一主机的 `/v1` 作为 SDK Base URL；保留首选项中原始输入，不将密钥放入 URL。

## 翻译 API：不必一开始就引入巨型依赖

调查结果：BabelDOC **0.5.20** 内置 `OpenAITranslator`，支持配置 `model`、`base_url`、`api_key`；当前固定版本的 CLI 翻译服务入口主要是 `--openai`。因此先通过预设接 OpenAI、OpenRouter、DeepSeek，再用“自定义 OpenAI 兼容接口”接其他厂商或用户已有的 LiteLLM 网关，避免为每个提供商分别写 SDK。DeepSeek 预设使用官方当前推荐的 `deepseek-flash`，不使用已退役的 `deepseek-v4-flash` 别名。

| 路线 | 覆盖范围 | 用户需要配置 | 本阶段取舍 |
| --- | --- | --- | --- |
| BabelDOC OpenAI 兼容入口 + 预设 | OpenAI、OpenRouter、DeepSeek 等兼容 Chat Completions 的接口 | 选择提供商、API Key，必要时选择模型；URL 预填 | **当前实施**；对大多数用户最简 |
| OpenRouter | 单一 API 入口、多供应商模型（不是本机库） | 一个 OpenRouter Key 和模型 ID；需知悉服务路由与费用/隐私 | 已加预设，不自动替用户选付费模型 |
| LiteLLM Python SDK / Proxy | 官方文档称支持 100+ 模型/提供商及统一 OpenAI 格式 | 仍需各厂商凭据、必要时部署/配置网关 | 可在下一阶段按需接入；不默认为每位用户安装重量级网关 |
| 自定义兼容接口 | 本机 LLM、用户自建网关 | URL、模型 ID、网关认证方式 | 已提供；仅远程 HTTPS 或本机回环 HTTP |

**“统一调用大量 API”不能等于“无需配置凭据”**：直连不同厂商时权限、计费、请求字段和模型名不同。当前设置页的预设是最小界面负担，LiteLLM 是覆盖非常规供应商的可选路径；兼容接口也不保证每个模型都满足 BabelDOC 对输出和占位符的要求，实际翻译要单独验收。

## 密钥与限制

- API Key 由 Zotero 使用的 Gecko `Services.logins` 凭据管理器保存，按 provider 分离；模型、URL、uv 路径才进入插件首选项。Zotero 10.0.3 临时测试 profile 已实测虚拟密钥的增删查。
- 设置页不会显示已保存密钥明文；留空意味着不覆盖；可对当前 provider 删除。保存设置不发起 API 请求。
- 插件已从 Gecko 凭据管理器读取密钥，写入受限权限的一次性作业配置文件；worker 在加载模型和网络调用前删除该文件，插件在作业退出后也执行清理。密钥不进入命令行、普通状态、日志或映射。取消通过作业标记在后端进度回调生效，网络调用中未必即时中断。
- 本项目计划覆盖 Zotero 7–10，但当前凭据和启动流程只在 10.0.3 做了实机验证；其余版本仍需测试。

参考原始资料：uv 官方 [项目运行](https://docs.astral.sh/uv/concepts/projects/run/) 与 [锁定/同步](https://docs.astral.sh/uv/concepts/projects/sync/)；[BabelDOC v0.5.20 翻译器](https://github.com/funstory-ai/BabelDOC/blob/v0.5.20/babeldoc/translator/translator.py)；[LiteLLM 官方文档](https://docs.litellm.ai/docs/)；[OpenRouter 文档](https://openrouter.ai/docs/quickstart)；[DeepSeek API 文档](https://api-docs.deepseek.com/)。
## Zotero 原生 Reader 隔离回归（不调用已保存 API Key）

`npm test` 的上游脚手架会清空其工作目录下 `.scaffold/test/`，不可直接用共享仓库或真实 Zotero profile 验收。先在 PowerShell 指定**已经安装 BabelDOC 0.5.20** 的 uv 虚拟环境（仅复用 Python 依赖），再运行：

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
