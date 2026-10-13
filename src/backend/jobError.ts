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
  pdf_scanned:
    "PDF 被识别为扫描件或缺少可用文本层；当前不支持 OCR，请换用可选择、复制正文的原始 PDF",
  pdf_text_extraction: "PDF 文本提取失败，请检查文本层、字体和文件完整性",
  pdf_already_translated: "输入文件已由 BabelDOC 生成，请选择原始 PDF 进行翻译",
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
  const message =
    record.code === "translation_failed" &&
    record.backendStage === "DetectScannedFile"
      ? "PDF 扫描检测阶段失败；请检查文本层、图片和 PDF 完整性"
      : errors[record.code];
  return (
    stages[record.stage] + "：" + message + detail + "（" + record.code + "）"
  );
}

/** Bounded metadata only: never serialize a worker record or exception message. */
export function diagnosticLabel(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 120 &&
    /^[A-Za-z0-9_ .:/+()（）·\-\u3400-\u9fff]+$/.test(value)
    ? value
    : "unknown";
}

const workerStages = new Set([
  ...Object.keys(stages),
  "加载后端与模型",
  "翻译段落",
  "生成段落映射",
  "保存翻译结果",
  "检查译文漏译（不发起补译请求）",
  "修复字体字符映射",
  "写入 PDF 元数据",
  "Parse PDF and Create Intermediate Representation",
  "DetectScannedFile",
  "Parse Page Layout",
  "Parse Table",
  "Parse Paragraphs",
  "Parse Formulas and Styles",
  "Extract Terms",
  "Translate Paragraphs",
  "Typesetting",
  "Add Fonts",
  "Generate drawing instructions",
  "Subset font",
  "Save PDF",
]);

export function workerStageLabel(value: unknown): string {
  return typeof value === "string" &&
    (workerStages.has(value) ||
      /^补译未翻译的正文段落(?: · 第 [0-9]{1,7}\/[0-9]{1,7} 段 · 尝试 [0-9]{1,3}\/[0-9]{1,3})?$/.test(
        value,
      ))
    ? value
    : "unknown";
}

export function describeJobDiagnostics(value: unknown): string {
  if (!value || typeof value !== "object") return "诊断格式无效";
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return "诊断版本无效";
  const detail: Record<string, unknown> = {
    stage:
      typeof record.stage === "string" && Object.hasOwn(stages, record.stage)
        ? record.stage
        : "unknown",
    code:
      typeof record.code === "string" && Object.hasOwn(errors, record.code)
        ? record.code
        : "unknown",
    backendStage: workerStageLabel(record.backendStage),
    exceptionType: diagnosticLabel(record.exceptionType),
  };
  if (record.runtime && typeof record.runtime === "object") {
    const runtime = record.runtime as Record<string, unknown>;
    detail.runtime = {
      python: diagnosticLabel(runtime.python),
      babeldoc: diagnosticLabel(runtime.babeldoc),
      pymupdf: diagnosticLabel(runtime.pymupdf),
    };
  }
  if (record.operation === "pdf_save") detail.operation = record.operation;
  if (Array.isArray(record.exceptionChain)) {
    detail.exceptionChain = record.exceptionChain
      .slice(0, 4)
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return { type: "unknown" };
        const exception = item as Record<string, unknown>;
        const entry: Record<string, unknown> = {
          type: diagnosticLabel(exception.type),
        };
        if (
          typeof exception.errno === "number" &&
          Number.isSafeInteger(exception.errno)
        )
          entry.errno = exception.errno;
        if (
          typeof exception.winerror === "number" &&
          Number.isSafeInteger(exception.winerror)
        )
          entry.winerror = exception.winerror;
        for (const key of ["status_code", "code"]) {
          const value = exception[key];
          if (
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            (key !== "status_code" || (value >= 100 && value <= 599))
          )
            entry[key] = value;
        }
        if (Array.isArray(exception.frames))
          entry.frames = exception.frames.slice(-8).map((item: unknown) => {
            if (!item || typeof item !== "object") return {};
            const frame = item as Record<string, unknown>;
            return {
              file:
                typeof frame.file === "string" &&
                /^[A-Za-z0-9_.-]{1,100}\.py$/.test(frame.file)
                  ? frame.file
                  : "unknown",
              function: diagnosticLabel(frame.function),
              line:
                typeof frame.line === "number" &&
                Number.isSafeInteger(frame.line) &&
                frame.line > 0
                  ? frame.line
                  : undefined,
            };
          });
        return entry;
      });
  }
  return JSON.stringify(detail);
}

/** Parse only numerical / fixed metadata, never serialize arbitrary worker records. */
export function describeWorkerDiagnostics(value: unknown): string {
  if (!value || typeof value !== "object") return "诊断格式无效";
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return "诊断版本无效";
  const integer = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  const fields = (value: unknown, names: readonly string[]) => {
    const result: Record<string, number> = {};
    if (value && typeof value === "object")
      for (const name of names) {
        const number = integer((value as Record<string, unknown>)[name]);
        if (number !== undefined) result[name] = number;
      }
    return result;
  };
  const detail: Record<string, unknown> = {
    stage:
      typeof record.stage === "string" && Object.hasOwn(stages, record.stage)
        ? record.stage
        : "unknown",
    backendStage: workerStageLabel(record.backendStage),
    elapsedMs: integer(record.elapsedMs),
  };
  if (record.operation === "pdf_save") detail.operation = record.operation;
  if (record.runtime && typeof record.runtime === "object") {
    const runtime = record.runtime as Record<string, unknown>;
    detail.runtime = Object.fromEntries(
      ["python", "babeldoc", "pymupdf", "openai", "httpx", "onnxruntime"].map(
        (name) => [
          name,
          typeof runtime[name] === "string" &&
          /^[A-Za-z0-9.+-]{1,40}$/.test(runtime[name] as string)
            ? runtime[name]
            : "unknown",
        ],
      ),
    );
  }
  detail.input = fields(record.input, [
    "bytes",
    "pages",
    "pathLength",
    "filenameLength",
  ]);
  if (record.input && typeof record.input === "object") {
    const input = record.input as Record<string, unknown>;
    for (const name of ["encrypted", "repaired"])
      if (typeof input[name] === "boolean")
        (detail.input as Record<string, unknown>)[name] = input[name];
  }
  detail.pdfSave = fields(record.pdfSave, [
    "attempts",
    "successful",
    "failed",
    "lastPathLength",
    "maxPathLength",
  ]);
  detail.mapping = fields(record.mapping, [
    "segments",
    "aligned",
    "uncertain",
    "sourceMissing",
    "targetMissing",
    "unchanged",
  ]);
  detail.api = fields(record.api, [
    "requests",
    "successful",
    "failed",
    "retries",
    "emptyResponses",
    "truncatedResponses",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "requestDurationMs",
    "activeRequests",
    "peakActiveRequests",
  ]);
  if (record.api && typeof record.api === "object") {
    const statuses = (record.api as Record<string, unknown>).httpStatuses;
    if (statuses && typeof statuses === "object")
      (detail.api as Record<string, unknown>).httpStatuses = Object.fromEntries(
        Object.entries(statuses)
          .filter(
            ([key, count]) =>
              /^[1-5][0-9]{2}$/.test(key) && integer(count) !== undefined,
          )
          .slice(0, 20),
      );
  }
  if (record.stageDurationsMs && typeof record.stageDurationsMs === "object")
    detail.stageDurationsMs = Object.fromEntries(
      Object.entries(record.stageDurationsMs)
        .filter(
          ([name, duration]) =>
            workerStageLabel(name) !== "unknown" &&
            integer(duration) !== undefined,
        )
        .slice(0, 40),
    );
  for (const name of ["artifactsRetained", "cleanupPending"])
    if (typeof record[name] === "boolean") detail[name] = record[name];
  return JSON.stringify(detail);
}
