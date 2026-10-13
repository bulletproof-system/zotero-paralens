const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const outfile = path.resolve(".scaffold/worker-diagnostics-tests.cjs");
buildSync({
  entryPoints: ["src/backend/progress.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { normalizeWorkerProgress } = require(outfile);
const diagnosticFile = path.resolve(".scaffold/worker-diagnostics-format.cjs");
buildSync({
  entryPoints: ["src/backend/jobError.ts"],
  outfile: diagnosticFile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const {
  describeWorkerDiagnostics,
  describeJobDiagnostics,
  workerStageLabel,
} = require(diagnosticFile);

test("quality and repair progress do not go backwards or display premature success", () => {
  let previous;
  const percentages = [];
  for (const update of [
    { stage: "Translate Paragraphs", percent: 75 },
    { stage: "检查译文漏译（不发起补译请求）", percent: 75 },
    { stage: "补译未翻译的正文段落 · 第 1/2 段 · 尝试 1/2", percent: 80 },
    { stage: "Typesetting", percent: 77 },
    { stage: "修复字体字符映射", percent: NaN },
    { stage: "写入 PDF 元数据", percent: 100, completed: 8, total: 2 },
  ]) {
    previous = normalizeWorkerProgress(update, previous);
    assert.notEqual(previous.stage, "unknown");
    percentages.push(previous.percent);
  }
  assert.deepEqual(percentages, [75, 75, 80, 80, 80, 97]);
  assert.equal(previous.completed, 2);
  assert.equal(
    normalizeWorkerProgress({
      stage: "PRIVATE_DOCUMENT_TEXT",
      completed: -1,
      total: Infinity,
    }).stage,
    "unknown",
  );
  assert.equal(
    workerStageLabel("补译未翻译的正文段落 · 第 1/2 段 · 尝试 1/2"),
    "补译未翻译的正文段落 · 第 1/2 段 · 尝试 1/2",
  );
});

test("worker summaries retain numerical diagnostics and exclude credentials, responses and arbitrary fields", () => {
  const value = {
    schemaVersion: 1,
    stage: "translation",
    backendStage: "修复字体字符映射",
    elapsedMs: 123,
    apiKey: "PRIVATE_KEY",
    message: "PRIVATE_MESSAGE",
    config: { apiKey: "PRIVATE_CONFIG" },
    runtime: {
      python: "3.12.15",
      pymupdf: "1.28.2",
      openai: "PRIVATE_VERSION",
      apiKey: "PRIVATE_KEY",
    },
    api: {
      requests: 3,
      retries: 2,
      promptTokens: 24,
      activeRequests: 0,
      authorization: "PRIVATE_AUTH",
      response: "PRIVATE_RESPONSE",
      httpStatuses: { 200: 2, 503: 1, PRIVATE_TOKEN: 1 },
    },
    input: {
      pages: 8,
      pathLength: 200,
      path: "PRIVATE_PATH",
      text: "PRIVATE_PDF",
    },
    pdfSave: { failed: 1, maxPathLength: 360 },
    mapping: { aligned: 174, uncertain: 237 },
    stageDurationsMs: { "Save PDF": 1000, PRIVATE_SECRET: 10 },
    artifactsRetained: true,
  };
  const text = describeWorkerDiagnostics(value);
  assert(!text.includes("PRIVATE"), text);
  const summary = JSON.parse(text);
  assert.deepEqual(summary.api.httpStatuses, { 200: 2, 503: 1 });
  assert.equal(summary.input.pathLength, 200);
  assert.equal(summary.pdfSave.maxPathLength, 360);
  assert.equal(summary.runtime.pymupdf, "1.28.2");
  assert.deepEqual(summary.stageDurationsMs, { "Save PDF": 1000 });
  assert.equal(summary.artifactsRetained, true);
});

test("failure diagnostics retain HTTP and MuPDF numeric errors without raw messages", () => {
  const text = describeJobDiagnostics({
    schemaVersion: 1,
    stage: "translation",
    code: "translation_failed",
    backendStage: "修复字体字符映射",
    operation: "pdf_save",
    exceptionType: "FzErrorSystem",
    exceptionChain: [
      {
        type: "FzErrorSystem",
        status_code: 503,
        code: 2,
        message: "PRIVATE_MESSAGE",
      },
    ],
  });
  const value = JSON.parse(text);
  assert.equal(value.operation, "pdf_save");
  assert.equal(value.exceptionChain[0].status_code, 503);
  assert.equal(value.exceptionChain[0].code, 2);
  assert(!text.includes("PRIVATE"));
});
