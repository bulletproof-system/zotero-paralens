const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");

const out = path.resolve(".scaffold/backend-install-test.cjs");
buildSync({
  entryPoints: ["src/backend/install.ts"],
  bundle: true,
  outfile: out,
  platform: "node",
  format: "cjs",
});
const { installBundledBackend, bundledBackendProjectDir } = require(out);
const files = ["pyproject.toml", "worker.py", "mapping_adapter.py"];

test("bundled backend is installed in private Zotero profile; reinstall preserves venv", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "paralens-profile-"));
  const calls = [];
  global.PathUtils = { profileDir: profile, join: path.join };
  global.Zotero = {
    File: {
      getResourceAsync: async (uri) => {
        calls.push(uri);
        return fs.readFile(
          path.join("addon", "content", "backend", path.basename(uri)),
          "utf8",
        );
      },
    },
  };
  global.IOUtils = {
    exists: (name) =>
      fs.access(name).then(
        () => true,
        () => false,
      ),
    readUTF8: (name) => fs.readFile(name, "utf8"),
    makeDirectory: (name) => fs.mkdir(name, { recursive: true }),
    writeUTF8: async (name, contents, options) => {
      assert.equal(options.mode, "overwrite");
      await fs.writeFile(options.tmpPath, contents);
      await fs.rename(options.tmpPath, name);
    },
  };
  try {
    const expected = path.join(profile, "paralens", "backend");
    assert.equal(bundledBackendProjectDir(), expected);
    assert.equal(
      await installBundledBackend("jar:file:///plugin.xpi!/"),
      expected,
    );
    for (const name of files) {
      assert.equal(
        await fs.readFile(path.join(expected, name), "utf8"),
        await fs.readFile(path.join("backend", name), "utf8"),
      );
      assert(calls.includes(`jar:file:///plugin.xpi!/content/backend/${name}`));
    }
    const venv = path.join(expected, ".venv", "pyvenv.cfg");
    await fs.mkdir(path.dirname(venv));
    await fs.writeFile(venv, "installed locally");
    await fs.writeFile(path.join(expected, "worker.py"), "outdated worker");
    await installBundledBackend("file:///plugin/");
    assert.equal(await fs.readFile(venv, "utf8"), "installed locally");
    assert.equal(
      await fs.readFile(path.join(expected, "worker.py"), "utf8"),
      await fs.readFile(path.join("backend", "worker.py"), "utf8"),
    );
    const before = await fs.stat(path.join(expected, "worker.py"));
    await installBundledBackend("file:///plugin/");
    assert.equal(
      (await fs.stat(path.join(expected, "worker.py"))).mtimeMs,
      before.mtimeMs,
    );
    global.Zotero.File.getResourceAsync = async () => {
      throw new Error("missing package file");
    };
    await assert.rejects(
      installBundledBackend("file:///missing/"),
      /missing package file/,
    );
    assert.equal(await fs.readFile(venv, "utf8"), "installed locally");
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("packaged backend sources match the executable project", async () => {
  for (const name of files) {
    assert.deepEqual(
      await fs.readFile(path.join("addon", "content", "backend", name)),
      await fs.readFile(path.join("backend", name)),
    );
  }
});
