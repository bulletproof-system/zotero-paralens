const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");

const outdir = path.resolve(".scaffold", "environment-tests");
buildSync({
  entryPoints: [
    "src/backend/uv.ts",
    "src/backend/providers.ts",
    "src/backend/performance.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir,
  outExtension: { ".js": ".cjs" },
});
const { uvCandidatePaths, detectUV, uvRunArguments } = require(
  path.join(outdir, "uv.cjs"),
);
const { getProvider, resolveProviderConfig, validateBaseURL } = require(
  path.join(outdir, "providers.cjs"),
);

test("startup checks uv candidate with --version, ignores broken PATH entries", async () => {
  const env = {
    path: "C:\\broken;C:\\tools",
    isWindows: true,
    home: "C:\\Users\\abc",
  };
  const calls = [];
  const result = await detectUV(
    env,
    "",
    async (p) => p.includes("tools"),
    async (p) => {
      calls.push(p);
      return true;
    },
  );
  assert.equal(result.available, true);
  assert.match(result.path, /tools[/\\]uv\.exe$/);
  assert.equal(calls.length, 1);
  assert(uvCandidatePaths(env).includes("C:\\Users\\abc\\.local\\bin\\uv.exe"));
});

test("Windows uses native absolute paths for PATH and common installer locations", () => {
  const candidates = uvCandidatePaths({
    path: '"C:\\Tools\\uv bin";C:\\Users\\abc\\AppData\\Local\\hermes\\bin',
    home: "C:\\Users\\abc",
    isWindows: true,
  });
  assert(candidates.includes("C:\\Tools\\uv bin\\uv.exe"));
  assert(candidates.includes("C:\\Users\\abc\\.local\\bin\\uv.exe"));
  assert(
    candidates.includes("C:\\Users\\abc\\AppData\\Local\\hermes\\bin\\uv.exe"),
  );
  assert(!candidates.some((p) => p.includes("/uv.exe")));
});
test("reports when uv exists but cannot execute", async () => {
  const status = await detectUV(
    { path: "C:\\Tools", isWindows: true },
    "",
    async () => true,
    async () => false,
  );
  assert.equal(status.available, false);
  assert.equal(status.reason, "exec-failed");
});
test("missing uv cannot enable work even when overridden with arbitrary executable", async () => {
  const env = { path: "", isWindows: false };
  const status = await detectUV(
    env,
    "/tmp/evil.sh",
    async () => true,
    async () => true,
  );
  assert.equal(status.available, false);
});

test("work command uses uv project venv, never shell or credentials in argv", () => {
  const argv = uvRunArguments(
    "/backend",
    "/backend/worker.py",
    "/jobs/001/config.json",
  );
  assert.deepEqual(argv.slice(0, 6), [
    "run",
    "--project",
    "/backend",
    "--no-sync",
    "--offline",
    "python",
  ]);
  assert.equal(argv.at(-1), "/jobs/001/config.json");
  assert(!argv.join(" ").includes("API_KEY"));
});

test("presets reduce configuration but reject unencrypted remote endpoints", () => {
  assert.equal(
    getProvider("openrouter").baseURL,
    "https://openrouter.ai/api/v1",
  );
  assert.equal(resolveProviderConfig("openai", "", "").provider, "openai");
  assert.equal(
    resolveProviderConfig(
      "custom",
      "model",
      "https://api.example.invalid/v1/responses",
    ).baseURL,
    "https://api.example.invalid/v1",
  );
  assert.equal(
    resolveProviderConfig("custom", "model", "https://api.example.invalid/v1")
      .baseURL,
    "https://api.example.invalid/v1",
  );
  assert.throws(
    () => resolveProviderConfig("custom", "model", "http://example.com/v1"),
    /HTTPS/,
  );
  assert.throws(
    () => validateBaseURL("https://key:secret@example.com/v1"),
    /密钥/,
  );
  assert.equal(
    validateBaseURL("http://localhost:4000/v1"),
    "http://localhost:4000/v1",
  );
});

const { translationPerformance } = require(
  path.join(outdir, "performance.cjs"),
);
test("translation concurrency and QPS are independent, bounded integers", () => {
  assert.deepEqual(translationPerformance(undefined, undefined), {
    concurrency: 4,
    qps: 2,
  });
  assert.deepEqual(translationPerformance(16, 1), { concurrency: 16, qps: 1 });
  for (const value of [0, -1, 1.5, NaN, Infinity, true, "4", 17]) {
    assert.throws(() => translationPerformance(value, 2));
  }
  assert.throws(() => translationPerformance(4, 11));
});
