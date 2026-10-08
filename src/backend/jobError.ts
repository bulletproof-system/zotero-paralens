/** Only worker-owned error codes are displayed. Never trust exception/message fields. */
const stages: Record<string, string> = {
  backend_load: "加载后端",
  model_load: "加载模型",
  translation: "翻译与排版",
  mapping: "生成段落映射",
  publish: "保存翻译结果",
};
const errors: Record<string, string> = {
  translation_incomplete:
    "翻译返回了空内容、被截断，或仍有正文未翻译；请检查模型与服务输出限制后重新开始",
  api_auth: "API 鉴权失败，请检查密钥和模型访问权限",
  api_rate_limit: "API 请求被限流或额度不足，请检查服务额度后手动重新开始",
  api_connection: "无法连接 API，请检查网络和 API 地址",
  api_timeout: "API 请求超时，请检查网络或换用响应更快的模型",
  api_request: "API 请求或模型不被支持，请检查模型名称和接口配置",
  api_server: "API 服务暂时异常，请稍后手动重新开始",
  memory_exhausted: "内存不足；复杂 PDF 可能需要更多内存或先拆分后翻译",
  storage_failure: "文件读写失败，请检查磁盘空间、权限及文件占用",
  file_missing: "必要文件不存在，请检查 PDF、模型缓存和后端安装",
  pdf_invalid: "PDF 无法解析，请检查文件是否损坏或加密",
  backend_load_failed: "后端加载失败，请在设置中检查或重新安装后端",
  model_load_failed: "布局模型加载失败，请检查模型缓存和网络",
  translation_failed: "翻译或排版失败，请检查 PDF、模型和 API 配置",
  mapping_failed: "段落映射生成失败，请检查 PDF 的文本层和复杂版式",
  publish_failed: "翻译结果保存失败，请检查磁盘空间、权限和文件占用",
};
export function describeJobFailure(value: unknown): string {
  const generic = "BabelDOC 执行失败；请检查 PDF、虚拟环境及模型配置";
  if (!value || typeof value !== "object") return generic;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.code !== "string" ||
    typeof record.stage !== "string"
  )
    return generic;
  if (
    !Object.hasOwn(errors, record.code) ||
    !Object.hasOwn(stages, record.stage)
  )
    return generic;
  return `${stages[record.stage]}：${errors[record.code]}（${record.code}）`;
}
