require("./helpers/mock-process.cjs").installMockProcess();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildSync } = require("esbuild");
const out = path.resolve(".scaffold/babeldoc-tests.cjs");
buildSync({
  entryPoints: ["src/backend/babeldoc.ts"],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { BabelDocBackend, createBabelDocJobDirectory } = require(out);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("Zotero -> uv worker -> validated unbound mapping, no secrets in argv", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "paralens-backend-"));
  const project = path.join(profile, "backend");
  const source = path.join(profile, "source.pdf");
  const bytes = Buffer.from("%PDF-1.7\nsource");
  await fs.mkdir(path.join(project, ".venv"), { recursive: true });
  await fs.writeFile(path.join(project, ".venv", "pyvenv.cfg"), "test");
  await fs.writeFile(path.join(project, "worker.py"), "test");
  await fs.writeFile(source, bytes);
  global.PathUtils = {
    profileDir: profile,
    join: path.join,
    parent: path.dirname,
    filename: path.basename,
    normalize: path.normalize,
    isAbsolute: path.isAbsolute,
  };
  global.Services = {
    logins: {
      initializationPromise: Promise.resolve(),
      findLogins: () => [
        {
          username: "openai",
          password: "TEST_SECRET",
        },
      ],
    },
  };
  global.Zotero = {
    Prefs: {
      get: (key) =>
        ({ provider: "openai", model: "gpt-4.1-mini", customBaseURL: "" })[
          key.split(".").at(-1)
        ],
    },
    Utilities: {
      Internal: {
        exec: async (cmd, args) => {
          assert.deepEqual(args.slice(0, 2), ["run", "--project"]);
          assert(!args.join(" ").includes("TEST_SECRET"));
          const config = JSON.parse(await fs.readFile(args.at(-1), "utf8"));
          assert.equal(config.apiKey, "TEST_SECRET");
          await fs.rm(args.at(-1)); // worker consumes the one-time config
          const job = config.jobDirectory;
          const pdf = Buffer.from("%PDF-1.7\ntranslated");
          await fs.writeFile(path.join(job, "translated.pdf"), pdf);
          await fs.writeFile(
            path.join(job, "mapping.v1.json"),
            JSON.stringify({
              schemaVersion: 1,
              source: { sha256: sha(bytes), pageCount: 1 },
              target: { sha256: sha(pdf), pageCount: 1 },
              segments: [
                {
                  id: "p-0",
                  level: "paragraph",
                  status: "uncertain",
                  source: [],
                  target: [],
                },
              ],
              provenance: {
                backend: "babeldoc",
                adapterVersion: "1",
                createdAt: "2026-09-29T00:00:00Z",
              },
            }),
          );
          await fs.writeFile(
            path.join(job, "result.json"),
            JSON.stringify({
              translatedPdfPath: path.join(job, "translated.pdf"),
              mappingDraftPath: path.join(job, "mapping.v1.json"),
            }),
          );
          return true;
        },
      },
    },
  };
  global.IOUtils = {
    exists: async (p) =>
      fs.access(p).then(
        () => true,
        () => false,
      ),
    getChildren: (p) => fs.readdir(p),
    makeDirectory: (p) => fs.mkdir(p, { recursive: true }),
    createUniqueDirectory: (p) => fs.mkdtemp(path.join(p, "job-")),
    createUniqueFile: async (p) => {
      const file = path.join(p, "config-1");
      await fs.writeFile(file, "", { mode: 0o600 });
      return file;
    },
    writeJSON: (p, v) => fs.writeFile(p, JSON.stringify(v)),
    readJSON: async (p) => JSON.parse(await fs.readFile(p, "utf8")),
    readUTF8: (p) => fs.readFile(p, "utf8"),
    remove: (p) => fs.rm(p, { force: true }),
    computeHexDigest: async (p) => sha(await fs.readFile(p)),
  };
  try {
    const jobDirectory = await createBabelDocJobDirectory();
    const backend = new BabelDocBackend(project, () => ({
      available: true,
      path: path.join(profile, "uv.exe"),
      message: "ok",
    }));
    const result = await backend.translate({
      sourcePath: source,
      jobDirectory,
      sourceLanguage: "en",
      targetLanguage: "zh",
    });
    assert.equal(result.mapping.provenance.backend, "babeldoc");
    assert.equal(result.mapping.source.attachmentKey, undefined);
    assert.equal(
      await global.IOUtils.exists(path.join(jobDirectory, "config-1")),
      false,
    );
    // Cancelling an active worker waits for its process to exit, leaves a
    // cooperative marker, and discards its output even if exec resolves.
    global.IOUtils.writeUTF8 = (file, content) => fs.writeFile(file, content);
    const originalExec = global.Zotero.Utilities.Internal.exec;
    let release;
    let started = false;
    try {
      global.Zotero.Utilities.Internal.exec = async () => {
        started = true;
        return new Promise((resolve) => {
          release = resolve;
        });
      };
      const cancelledJob = await createBabelDocJobDirectory();
      const cancellable = new BabelDocBackend(project, () => ({
        available: true,
        path: path.join(profile, "uv.exe"),
        message: "ok",
      }));
      const task = cancellable.translate({
        sourcePath: source,
        jobDirectory: cancelledJob,
        sourceLanguage: "en",
        targetLanguage: "zh",
      });
      for (let i = 0; i < 100 && !started; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        started,
        true,
        "test worker should start before cancellation",
      );
      await cancellable.cancel();
      assert.equal(
        await global.IOUtils.exists(path.join(cancelledJob, "cancel")),
        true,
      );
      release(true);
      await assert.rejects(
        task,
        (error) => error.name === "TranslationCancelledError",
      );
      assert.equal(
        await global.IOUtils.exists(path.join(cancelledJob, "config-1")),
        false,
      );
      const beforeStart = new BabelDocBackend(project, () => ({
        available: true,
        path: path.join(profile, "uv.exe"),
        message: "ok",
      }));
      await beforeStart.cancel();
      await assert.rejects(
        beforeStart.translate({
          sourcePath: source,
          jobDirectory: await createBabelDocJobDirectory(),
          sourceLanguage: "en",
          targetLanguage: "zh",
        }),
        (error) => error.name === "TranslationCancelledError",
      );
    } finally {
      global.Zotero.Utilities.Internal.exec = originalExec;
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});
