const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const outfile = path.resolve(".scaffold/file-log-tests.cjs");
buildSync({
  entryPoints: ["src/utils/log.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { log, flushLogs, pluginLogDirectory, redactLog } = require(outfile);
function fixture() {
  const state = {
    enabled: false,
    dirs: [],
    writes: [],
    files: new Map(),
    debug: [],
    fail: false,
  };
  global.PathUtils = {
    join: path.join,
    profileDir: path.resolve("mock-profile"),
  };
  global.Zotero = {
    Prefs: { get: () => state.enabled },
    debug: (message) => state.debug.push(message),
  };
  global.IOUtils = {
    makeDirectory: async (directory, options) => {
      state.dirs.push({ directory, options });
    },
    writeUTF8: async (file, text, options) => {
      if (state.fail) throw Error("PRIVATE_DISK_ERROR");
      // Gecko append refuses to create a missing file.
      if (options.mode === "append" && !state.files.has(file))
        throw Error("Missing log file");
      state.files.set(file, (state.files.get(file) || "") + text);
      state.writes.push({ file, text, options });
    },
  };
  return state;
}
test("disabled logging creates no directory or file; enabling serializes timestamped daily appends", async () => {
  const state = fixture();
  log("off");
  await flushLogs();
  assert.equal(state.dirs.length, 0);
  assert.equal(state.writes.length, 0);
  state.enabled = true;
  log("first");
  log("second");
  await flushLogs();
  assert.equal(state.writes.length, 2);
  assert.equal(path.dirname(state.writes[0].file), pluginLogDirectory());
  assert.match(
    path.basename(state.writes[0].file),
    /^paralens-\d{4}-\d{2}-\d{2}\.log$/,
  );
  assert.match(state.writes[0].text, /^\d{4}-.*Z first\n$/);
  assert.match(state.writes[1].text, / second\n$/);
  assert.deepEqual(state.writes[0].options, { mode: "appendOrCreate" });
  assert.equal(state.dirs[0].options.permissions, 0o700);
  state.enabled = false;
  log("off again");
  await flushLogs();
  assert.equal(state.writes.length, 2);
});
test("switching off discards queued log writes and write errors allow later recovery", async () => {
  const state = fixture();
  state.enabled = true;
  log("queued");
  state.enabled = false;
  await flushLogs();
  assert.equal(state.writes.length, 0);
  state.enabled = true;
  state.fail = true;
  log("will fail");
  await flushLogs();
  assert.match(state.debug.at(-1), /日志保存失败/);
  assert(!state.debug.join(" ").includes("PRIVATE_DISK_ERROR"));
  state.fail = false;
  log("recovered");
  await flushLogs();
  assert.equal(state.writes.length, 1);
  assert.match(state.writes[0].text, /recovered/);
});
test("credentials are redacted from both saved logs and Zotero diagnostics", async () => {
  const state = fixture();
  state.enabled = true;
  const message =
    "Authorization: Bearer PRIVATE_AUTH api_key=PRIVATE_KEY https://user:PRIVATE_PASS@example.invalid/?token=PRIVATE_TOKEN sk-PRIVATE_SECRET";
  log(message);
  await flushLogs();
  for (const text of [
    state.writes[0].text,
    state.debug[0],
    redactLog(message),
  ]) {
    assert(!text.includes("PRIVATE_"), text);
    assert(text.includes("[redacted]"));
  }
});
