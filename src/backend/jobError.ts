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
    "API 返回了空内容或输出被截断；请检查模型与服务输出限制",
  translation_untranslated:
    "检查发现疑似漏译段落；译文将按部分完成保留，请人工核对",
  translation_quality_failed: "漏译检查或补译异常；已跳过该步骤并尝试保留译文",
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
  let detail = "";
  if (
    record.code === "translation_untranslated" &&
    record.quality &&
    typeof record.quality === "object"
  ) {
    const quality = record.quality as Record<string, unknown>;
    const count = (key: string): number | undefined => {
      const value = quality[key];
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 1000000
        ? value
        : undefined;
    };
    const pending = count("pending"),
      repaired = count("repaired"),
      remaining = count("remaining");
    if (
      pending !== undefined &&
      repaired !== undefined &&
      remaining !== undefined &&
      repaired + remaining === pending
    ) {
      detail = `；疑似漏译 ${pending} 段，已修复 ${repaired} 段，剩余 ${remaining} 段`;
      for (const [key, label] of [
        ["no_input", "无法准备补译"],
        ["no_chinese_reply", "返回无中文"],
        ["incomplete_compositions", "仍残留未译内容"],
        ["response_incomplete", "返回空内容或截断"],
      ]) {
        const value = count(key);
        if (value !== undefined && value > 0 && value <= remaining)
          detail += `，${label} ${value} 段`;
      }
    }
  }
  return `${stages[record.stage]}：${errors[record.code]}${detail}（${record.code}）`;
}
