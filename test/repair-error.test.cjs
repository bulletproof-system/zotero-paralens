const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const out = path.resolve(".scaffold/repair-error-tests.cjs");
buildSync({
  entryPoints: ["src/backend/jobError.ts"],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { describeJobFailure } = require(out);
const warning = {
  schemaVersion: 1,
  stage: "translation",
  code: "translation_untranslated",
  quality: {
    pending: 3,
    repaired: 1,
    remaining: 2,
    no_chinese_reply: 1,
    incomplete_compositions: 1,
  },
};

test("repair warnings distinguish untranslated prose from empty API content with safe counts", () => {
  const message = describeJobFailure({
    ...warning,
    message: "PRIVATE_API_KEY PRIVATE_DOCUMENT",
    quality: { ...warning.quality, filename: "PRIVATE_PATH" },
  });
  assert.match(message, /待补译 3 段，已修复 1 段，剩余 2 段/);
  assert.match(message, /返回无中文 1 段/);
  assert.match(message, /仍残留未译内容 1 段/);
  assert.match(message, /translation_untranslated/);
  assert.ok(!message.includes("PRIVATE"));
  const empty = describeJobFailure({
    ...warning,
    code: "translation_incomplete",
  });
  assert.match(empty, /API 返回了空内容或输出被截断/);
  assert.ok(!empty.includes("待补译"));
});

test("untrusted repair counters are ignored, never interpolated as arbitrary strings", () => {
  for (const pending of ["PRIVATE_PATH", -1, 1.5, Infinity, null, 1000001]) {
    const message = describeJobFailure({
      ...warning,
      quality: { ...warning.quality, pending },
    });
    assert.ok(!message.includes("待补译"));
    assert.ok(!message.includes("PRIVATE"));
  }
  const inconsistent = describeJobFailure({
    ...warning,
    quality: { ...warning.quality, repaired: 2 },
  });
  assert.ok(!inconsistent.includes("待补译"));
  const reason = describeJobFailure({
    ...warning,
    quality: { ...warning.quality, no_chinese_reply: "PRIVATE_TEXT" },
  });
  assert.ok(!reason.includes("PRIVATE"));
  assert.ok(!reason.includes("返回无中文"));
});

test("unknown stages and codes retain the generic safe failure message", () => {
  for (const value of [
    { ...warning, code: "PRIVATE_CODE" },
    { ...warning, stage: "PRIVATE_STAGE" },
    null,
  ]) {
    const message = describeJobFailure(value);
    assert.match(message, /BabelDOC 执行失败/);
    assert.ok(!message.includes("PRIVATE"));
  }
});
