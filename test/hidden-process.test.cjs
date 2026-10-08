const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const path = require("node:path");
const out = path.resolve(".scaffold/hidden-process-tests.cjs");
buildSync({
  entryPoints: ["src/backend/process.ts", "src/backend/jobError.ts"],
  outdir: path.dirname(out),
  entryNames: "[name]-unit",
  bundle: true,
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});
const { executeHidden } = require(path.resolve(".scaffold/process-unit.cjs"));
const { describeJobFailure } = require(
  path.resolve(".scaffold/jobError-unit.cjs"),
);
global.PathUtils = { isAbsolute: path.isAbsolute };
function setup(topic = "process-finished", code = 0, startError = false) {
  const calls = [];
  global.Components = {
    interfaces: { nsIFile: "file", nsIProcess: "process" },
    classes: {
      "@mozilla.org/file/local;1": {
        createInstance: () => ({
          initWithPath(file) {
            this.path = file;
          },
        }),
      },
      "@mozilla.org/process/util;1": {
        createInstance: () => ({
          init(file) {
            this.file = file;
            if (startError) throw Error("PRIVATE_RAW_ERROR");
          },
          runwAsync(args, length, observer) {
            calls.push({
              path: this.file.path,
              args,
              length,
              hidden: this.startHidden,
              noShell: this.noShell,
            });
            this.exitValue = code;
            observer.observe(null, topic);
          },
        }),
      },
    },
  };
  return calls;
}
test("native process starts hidden and without shell; arguments are preserved as an array", async () => {
  const calls = setup();
  const executable = path.resolve("test dir/python.exe"),
    args = ["a b.pdf", "$(echo unsafe)", "--value", "中文"];
  assert.equal(await executeHidden(executable, args), true);
  assert.deepEqual(calls, [
    { path: executable, args, length: 4, hidden: true, noShell: true },
  ]);
});
test("native nonzero/failed launches reject safely and never fall back to a shell", async () => {
  for (const config of [
    ["process-finished", 7, false],
    ["process-failed", 0, false],
    ["process-finished", 0, true],
  ]) {
    setup(...config);
    await assert.rejects(
      executeHidden(path.resolve("python.exe"), ["PRIVATE_ARGUMENT"]),
      (error) => !error.message.includes("PRIVATE_"),
    );
  }
});
test("invalid paths and NUL-containing arguments cannot start a native process", async () => {
  const calls = setup();
  await assert.rejects(executeHidden("relative.exe", []), /不合法/);
  await assert.rejects(
    executeHidden(path.resolve("python.exe"), ["\0"]),
    /不合法/,
  );
  assert.equal(calls.length, 0);
});
test("worker diagnostics use whitelisted codes/stages, never untrusted messages or keys", () => {
  assert.match(
    describeJobFailure({
      schemaVersion: 1,
      stage: "mapping",
      code: "memory_exhausted",
      message: "PRIVATE_KEY",
    }),
    /内存不足/,
  );
  for (const value of [
    null,
    {},
    { schemaVersion: 1, stage: "translation", code: "__proto__" },
    { schemaVersion: 1, stage: "PRIVATE_TEXT", code: "api_auth" },
    { schemaVersion: 2, stage: "translation", code: "api_auth" },
  ])
    assert.equal(
      describeJobFailure(value),
      "BabelDOC 执行失败；请检查 PDF、虚拟环境及模型配置",
    );
  assert.match(
    describeJobFailure({
      schemaVersion: 1,
      stage: "translation",
      code: "api_auth",
      message: "PRIVATE_KEY",
    }),
    /鉴权失败/,
  );
});
