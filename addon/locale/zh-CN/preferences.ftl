pref-title = ParaLens 环境与翻译 API
pref-description = 翻译需要 uv；目前仅支持 BabelDOC 后端；未安装时可在此点击安装。API 服务均通过 OpenAI 兼容接口接入。
pref-uv-path = uv 路径（留空自动检测）
pref-uv-check = 重新检测 uv
pref-backend = 翻译后端
pref-backend-note = 安装或重新安装会由 uv 下载 Python 依赖，npm 仅用于构建插件。重新安装用于修复后端加载失败，保留密钥、附件和作业产物；请先结束或取消翻译任务。
pref-backend-install = 安装后端
pref-backend-reinstall = 重新安装后端
pref-source-language = 原文语言
pref-target-language = 译文语言
pref-provider = 翻译 API
pref-model = 模型 ID
pref-base-url = API Base URL
pref-api-key = API Key（留空保持原值）
pref-delete-key = 删除已存密钥
pref-save = 保存设置
pref-privacy = API Key 保存在 Zotero 的凭据管理器中，不写入首选项；保存设置不会发起付费 API 请求。

pref-concurrency = 翻译并发数
pref-qps = 每秒最多发起请求数
pref-performance-note = 默认并发 4、每秒最多 2 个请求。仅影响新入队任务，PDF 仍逐个翻译。遇到限流请降低；并发请求可能增加同时计费的请求数，取消无法撤回已发请求。

pref-legal-title = 许可证、第三方声明与源码
pref-legal-notice = 版权所有：ltt 和 ParaLens 贡献者；上游作者保留其权利。ParaLens 以 AGPL-3.0-or-later 按现状提供，不提供保证。你可以按适用许可修改和再分发。下方离线显示完整许可文本，不发起网络请求。
pref-legal-source-note = 源码链接对应安装包版本。开发构建可能包含未公开的修改；旧版本可能没有源码附件，访问也取决于仓库可见性。
pref-legal-source = 浏览对应版本源码
pref-legal-archive = 下载 Release 源码附件

pref-auto-repair = 自动补译疑似漏译段落（默认关闭）
pref-auto-repair-note = 默认只检查漏译，不额外调用 API；疑似漏译或检查异常时仍尝试生成并保留 PDF。开启后仅影响新入队任务，每段最多补译两次，可能增加 API 费用和等待时间；补译失败不会阻止保留译文。
