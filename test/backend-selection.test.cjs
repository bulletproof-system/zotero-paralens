const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");

const outdir = path.resolve(".scaffold", "backend-selection-tests");
buildSync({
  entryPoints: [
    "src/backend/selection.ts",
    "src/backend/installationStatus.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir,
  outExtension: { ".js": ".cjs" },
});
const { BACKENDS, resolveBackend, backendInstallArguments } = require(
  path.join(outdir, "selection.cjs"),
);
const { isBackendInstalled } = require(
  path.join(outdir, "installationStatus.cjs"),
);

test("only implemented backends appear in the selector", () => {
  assert.deepEqual(
    BACKENDS.map(({ id }) => id),
    ["babeldoc"],
  );
  assert.equal(resolveBackend("unsupported").id, "babeldoc");
});

test("explicit installation uses a fixed uv argument array", () => {
  assert.deepEqual(
    backendInstallArguments("babeldoc", "/profile/paralens/backend"),
    ["sync", "--project", "/profile/paralens/backend", "--python", "3.12"],
  );
  assert.deepEqual(
    backendInstallArguments("babeldoc", "/profile/paralens/backend", true),
    [
      "sync",
      "--project",
      "/profile/paralens/backend",
      "--python",
      "3.12",
      "--reinstall",
    ],
  );
  assert.throws(
    () => backendInstallArguments("unsupported", "/profile"),
    /Unsupported backend/,
  );
});

test("install button only hides for a runnable venv with the pinned BabelDOC version", async () => {
  global.PathUtils = { join: path.join };
  const project = path.join("profile", "paralens", "backend");
  const config = path.join(project, ".venv", "pyvenv.cfg");
  const winPython = path.join(project, ".venv", "Scripts", "python.exe");
  const unixPython = path.join(project, ".venv", "bin", "python");
  const calls = [];
  const execute = async (binary, args) => {
    calls.push({ binary, args });
    return true;
  };
  const present = new Set([config, winPython]);
  const exists = async (file) => present.has(file);
  assert.equal(
    await isBackendInstalled(undefined, true, exists, execute),
    false,
  );
  assert.equal(
    await isBackendInstalled(project, false, exists, execute),
    false,
  );
  assert.equal(await isBackendInstalled(project, true, exists, execute), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, winPython);
  assert.equal(calls[0].args[0], "-c");
  assert.match(calls[0].args[1], /babeldoc.*0\.6\.4/);
  assert(
    !calls[0].args[1].includes("high_level"),
    "Translation readiness keeps the lightweight version probe",
  );
  assert.equal(
    await isBackendInstalled(project, true, exists, execute, true),
    true,
  );
  for (const module of [
    "pymupdf",
    "DocLayoutModel",
    "do_translate",
    "PDFCreater",
    "ILTranslatorLLMOnly",
  ])
    assert(calls[1].args[1].includes(module));
  assert(!calls[1].args[1].includes("load_onnx("));
  assert(!calls[0].args.join(" ").includes("API_KEY"));
  present.delete(winPython);
  assert.equal(await isBackendInstalled(project, true, exists, execute), false);
  present.add(unixPython);
  assert.equal(await isBackendInstalled(project, false, exists, execute), true);
  assert.equal(
    await isBackendInstalled(project, false, exists, async () => false),
    false,
  );
  assert.equal(
    await isBackendInstalled(project, false, exists, async () => {
      throw Error("broken venv");
    }),
    false,
  );
});

test("settings probe rejects a pinned distribution whose worker imports fail", async () => {
  global.PathUtils = { join: path.join };
  const execute = async (_binary, args) => !args[1].includes("high_level");
  assert.equal(
    await isBackendInstalled(
      "/profile/backend",
      false,
      async () => true,
      execute,
    ),
    true,
  );
  assert.equal(
    await isBackendInstalled(
      "/profile/backend",
      false,
      async () => true,
      execute,
      true,
    ),
    false,
  );
});
