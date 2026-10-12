const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const outfile = path.resolve(".scaffold/install-process-tests.cjs");
buildSync({
  entryPoints: ["src/backend/installProcess.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { executeBackendInstall } = require(outfile);
function fixture(chunks, exitCode = 0) {
  const state = { calls: [], killed: false, closed: false };
  global.PathUtils = { isAbsolute: path.isAbsolute };
  global.Zotero = { debug() {}, Prefs: { get: () => false } };
  global.ChromeUtils = {
    importESModule(module) {
      assert.equal(module, "resource://gre/modules/Subprocess.sys.mjs");
      return {
        Subprocess: {
          call: async (options) => {
            state.calls.push(options);
            return {
              stdout: { readString: async () => chunks.shift() ?? null },
              stdin: {
                close: async () => {
                  state.closed = true;
                },
              },
              wait: async () => ({ exitCode }),
              kill: async () => {
                state.killed = true;
              },
            };
          },
        },
      };
    },
  };
  return state;
}
test("installer drains combined output, assembles split lines and flushes an unterminated final line", async () => {
  const state = fixture([
    "Resol",
    "ved 2 packages\r\nDownloading lib\r",
    "Downloaded lib\nInstalled 2 packages",
  ]);
  const lines = [];
  const executable = path.resolve("uv.exe"),
    args = ["sync", "--project", "a b"];
  assert.equal(
    await executeBackendInstall(executable, args, (line) => lines.push(line)),
    true,
  );
  assert.deepEqual(lines, [
    "Resolved 2 packages",
    "Downloading lib",
    "Downloaded lib",
    "Installed 2 packages",
  ]);
  assert.equal(state.calls[0].command, executable);
  assert.deepEqual(state.calls[0].arguments, args);
  assert.equal(state.calls[0].stderr, "stdout");
  assert.equal(state.calls[0].environmentAppend, true);
  assert.equal(state.closed, true);
  assert.equal(state.killed, false);
});
test("failed installers reject and invalid commands cannot start a subprocess", async () => {
  const state = fixture(["error: failed\n"], 1);
  await assert.rejects(
    executeBackendInstall(path.resolve("uv.exe"), ["sync"], () => {}),
    /安装进程执行失败/,
  );
  assert.equal(state.killed, true);
  await assert.rejects(
    executeBackendInstall("relative.exe", [], () => {}),
    /不合法/,
  );
  await assert.rejects(
    executeBackendInstall(path.resolve("uv.exe"), ["\0"], () => {}),
    /不合法/,
  );
  assert.equal(state.calls.length, 1);
});
test("a detached UI callback cannot stop backend installation", async () => {
  const state = fixture(["Resolved 1 package\n"]);
  assert.equal(
    await executeBackendInstall(path.resolve("uv.exe"), ["sync"], () => {
      throw Error("closed UI");
    }),
    true,
  );
  assert.equal(state.killed, false);
});
