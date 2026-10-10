# ParaLens 项目架构

ParaLens 是 Zotero 插件：本机 Python/BabelDOC worker 生成单语译文 PDF，TypeScript 层校验并导入附件，两个 Zotero 原生 Reader 根据可信映射提供双语对照。原文附件保持不变。

## 模块边界

| 模块          | 路径                                                                                | 职责                                                     |
| ------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 插件生命周期  | `src/hooks.ts`、`src/addon.ts`                                                      | 初始化设置、检测 uv、部署后端脚本、注册菜单及释放资源    |
| 设置与凭据    | `src/modules/preferenceScript.ts`、`src/backend/credentials.ts`                     | 保存非敏感选项，以 Gecko 登录管理器保存 API Key          |
| 后端接口      | `src/backend/contracts.ts`、`src/backend/babeldoc.ts`                               | 创建受限作业配置，运行 worker，读取进度，校验输出        |
| Python worker | `backend/worker.py`                                                                 | 请求翻译、检查疑似漏译、执行可选补译、排版与发布结果     |
| 映射适配器    | `backend/mapping_adapter.py`                                                        | 从 IL 和实际 PDF 几何生成不带 Zotero 附件 key 的映射草稿 |
| 任务与导入    | `src/reader/taskQueue.ts`、`src/reader/translationWorkflow.ts`                      | 串行调度、费用确认、译文导入及部分结果保留               |
| 映射存储      | `src/mapping/`                                                                      | 校验协议、绑定附件 key、保存和读取映射附件               |
| 原生阅读器    | `src/reader/nativeOverlay.ts`、`src/reader/geometry.ts`、`src/reader/scrollSync.ts` | 双向命中、高亮锁定、跨页导航和可选同步滚动               |

`TranslationBackend` 是后端无关接口；可选择的实现只有 BabelDOC。Reader 不直接消费 BabelDOC IL 或内部段落 ID。

## 翻译与导入流程

1. 从选中项解析 PDF 附件，读取语言、服务、模型及性能选项，明确确认 API 费用。
2. 按任务保存选项快照。同一原文的排队中或运行中任务去重，不同 PDF 串行处理。
3. 执行时从凭据管理器读取 API Key，创建独立作业目录与一次性配置，以参数数组启动 worker；密钥不进入命令行或队列文件。
4. BabelDOC 解析和翻译 PDF。默认只检查疑似漏译；只有任务的 `autoRepair` 为 `true` 才发起补译请求。
5. 对可用段落继续排版，生成译文 PDF、映射草稿及摘要。检查或补译异常降级为警告；主动取消和全部 API 请求失败不发布成功结果。
6. TypeScript 层检查输出路径、PDF、映射结构及源／译 SHA-256，导入译文附件，绑定 Zotero 附件 key。
7. 完整成功结果保存为默认对照。可用部分译文保留为需人工核对的附件，不覆盖已有默认对照。

## 映射协议

前端使用 `mapping.v1`（`schemaVersion: 1`），定义见 `src/mapping/types.ts` 和 `src/mapping/mapping.v1.schema.json`。

- `source`／`target` 各自保存 PDF SHA-256、页数和 Zotero 附件 key；worker 输出的草稿不含附件 key。
- `segments` 保存任务内 ID、粒度、状态、置信度及两侧几何。协议允许多页引用，不能据此认定当前 BabelDOC 适配器具备任意跨页合并段落的对齐能力。
- `provenance` 保存后端、后端版本、适配器版本及创建时间；BabelDOC 的 `debug_id` 不是跨任务稳定标识。
- 只有 `aligned` 且双侧几何完整的记录可参与悬停；`uncertain` 不产生猜测高亮。
- 当前适配器输出段落级映射及可唯一匹配的栅格图片区域，不提供句子级对齐或 OCR。

坐标与图片匹配约束见[原生阅读器架构](native-reader-architecture.md)。

## 持久化与任务状态

- 后端目录：`<Zotero profile>/paralens/backend/`。启动部署受管脚本，不自动安装依赖。
- 队列文件：`<Zotero profile>/paralens/translation-queue.json`。不含 API Key；恢复记录不自动恢复可能计费的任务。
- 作业目录：`<Zotero profile>/paralens-jobs/job-*`。可能含私有文档和中间产物，不应提交或直接上传。
- 映射作为 Zotero JSON 存储附件保存；跨设备依赖 Zotero 元数据及附件文件同步。
- 完成、部分完成、失败、取消和中断记录可重新开始，需确认费用；重新开始替换记录、完整处理，不提供断点续译，也不删除已有附件或作业产物。
- 失败或取消记录可删除；删除先持久化再移除界面行，不涉及附件、作业产物或 API。

## 工程与能力边界

构建配置见 `package.json` 和 `zotero-plugin.config.ts`；Python 项目要求 Python 3.12 并固定 `babeldoc==0.6.4`。构建将后端源码和许可材料同步到 XPI。

文档与注释遵循 [AGENT.md](../AGENT.md)，仅描述已确认的当前行为。兼容性和测试范围见[兼容性说明](compatibility.md)；安装与测试操作见[后端设置指南](backend-setup.md)和[开发指南](../doc/development.md)。
