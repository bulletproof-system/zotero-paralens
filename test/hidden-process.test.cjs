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
const { describeJobFailure, describeJobDiagnostics } = require(
  path.resolve(".scaffold/jobError-unit.cjs"),
);
global.PathUtils = { isAbsolute: path.isAbsolute };
const diagnostics = [];
global.Zotero = {
  debug: (message) => diagnostics.push(message),
  Prefs: { get: () => false },
};
function setup(
  topic = "process-finished",
  code = 0,
  startError = false,
  unavailableExit = false,
) {
  diagnostics.length = 0;
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
            if (unavailableExit)
              Object.defineProperty(this, "exitValue", {
                get() {
                  throw Error("PRIVATE_EXIT_ERROR");
                },
              });
            else this.exitValue = code;
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

test("process diagnostics distinguish failed termination from launch failure and tolerate missing exit codes", async () => {
  setup("process-failed", 1);
  await assert.rejects(
    executeHidden(path.resolve("python.exe"), ["PRIVATE_ARGUMENT"]),
  );
  assert.match(
    diagnostics.at(-1),
    /后端进程异常结束.*process-failed.*退出码=1.*耗时=\d+ms/,
  );
  assert(!diagnostics.join(" ").includes("启动失败"));
  assert(!diagnostics.join(" ").includes("PRIVATE_ARGUMENT"));
  setup("process-failed", 0, false, true);
  await assert.rejects(executeHidden(path.resolve("python.exe"), []));
  assert.match(diagnostics.at(-1), /退出码=不可用/);
  assert(!diagnostics.join(" ").includes("PRIVATE_EXIT_ERROR"));
  setup("process-finished", 0, true);
  await assert.rejects(executeHidden(path.resolve("python.exe"), []));
  assert.match(diagnostics.at(-1), /启动失败.*异常类型=Error/);
  assert(!diagnostics.join(" ").includes("PRIVATE_RAW_ERROR"));
});
test("detailed worker diagnostics include bounded code locations and versions without raw messages or locals", () => {
  const detail = describeJobDiagnostics({
    schemaVersion: 1,
    stage: "translation",
    code: "translation_failed",
    backendStage: "Save PDF",
    exceptionType: "RuntimeError",
    runtime: { python: "3.12.8", babeldoc: "0.6.4", secret: "PRIVATE_RUNTIME" },
    message: "PRIVATE_API_RESPONSE",
    source: "PRIVATE_DOCUMENT",
    exceptionChain: [
      {
        type: "OSError",
        errno: 28,
        winerror: 112,
        message: "PRIVATE_MESSAGE",
        frames: [
          {
            file: "high_level.py",
            function: "safe_save",
            line: 89,
            source: "PRIVATE_SOURCE",
            locals: "PRIVATE_KEY",
          },
        ],
      },
    ],
  });
  const record = JSON.parse(detail);
  assert.equal(record.backendStage, "Save PDF");
  assert.equal(record.exceptionChain[0].errno, 28);
  assert.deepEqual(record.exceptionChain[0].frames[0], {
    file: "high_level.py",
    function: "safe_save",
    line: 89,
  });
  assert.equal(record.runtime.python, "3.12.8");
  assert(!detail.includes("PRIVATE_"));
  const invalid = JSON.parse(
    describeJobDiagnostics({
      schemaVersion: 1,
      stage: "__proto__",
      code: "__proto__",
      backendStage: "bad\nvalue",
      exceptionChain: [
        {
          type: "RuntimeError",
          frames: [
            {
              file: "C:/private/document.pdf",
              function: "bad\nvalue",
              line: -1,
            },
          ],
        },
      ],
    }),
  );
  assert.equal(invalid.stage, "unknown");
  assert.equal(invalid.exceptionChain[0].frames[0].file, "unknown");
  assert.equal(invalid.exceptionChain[0].frames[0].line, undefined);
});
