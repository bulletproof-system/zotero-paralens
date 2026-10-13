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
  const diagnosticLogs = [];
  let expectedAutoRepair = false;
  global.Zotero = {
    debug: (message) => diagnosticLogs.push(message),
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
          assert.equal(config.concurrency, 4);
          assert.equal(config.qps, 2);
          assert.equal(config.autoRepair, expectedAutoRepair);
          await fs.rm(args.at(-1)); // worker consumes the one-time config
          const job = config.jobDirectory;
          await fs.writeFile(
            path.join(job, "progress.json"),
            JSON.stringify({
              stage: "翻译段落",
              completed: 1,
              total: 1,
              percent: 36,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 350));
          // The final worker update can regress; displayed progress stays monotonic.
          await fs.writeFile(
            path.join(job, "progress.json"),
            JSON.stringify({
              stage: "Save PDF",
              completed: 1,
              total: 1,
              percent: 20,
            }),
          );
          await fs.writeFile(
            path.join(job, "diagnostics.json"),
            JSON.stringify({
              schemaVersion: 1,
              stage: "publish",
              backendStage: "写入 PDF 元数据",
              elapsedMs: 1000,
              api: {
                requests: 3,
                retries: 1,
                apiKey: "TEST_SECRET",
                response: "PRIVATE_TEXT",
              },
              mapping: { segments: 1, aligned: 0, uncertain: 1 },
              config: { apiKey: "TEST_SECRET" },
            }),
          );
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
    const reports = [];
    const result = await backend.translate(
      {
        sourcePath: source,
        jobDirectory,
        sourceLanguage: "en",
        targetLanguage: "zh",
      },
      (progress) => reports.push(progress),
    );
    assert.ok(
      reports.some(
        (progress) => progress.percent === 36 && progress.stage === "翻译段落",
      ),
    );
    assert(
      reports.some(
        (progress) => progress.stage === "Save PDF" && progress.percent === 36,
      ),
    );
    assert(
      reports.every(
        (progress, index) =>
          index === 0 || progress.percent >= reports[index - 1].percent,
      ),
    );
    assert(
      diagnosticLogs.some((line) =>
        /后端统计=.*"requests":3.*"retries":1/.test(line),
      ),
    );
    assert.equal(result.mapping.provenance.backend, "babeldoc");
    assert(
      diagnosticLogs.some((line) => /阶段=翻译段落.*完成=1\/1/.test(line)),
    );
    assert(diagnosticLogs.some((line) => /阶段=Save PDF/.test(line)));
    assert(
      diagnosticLogs.some((line) =>
        line.includes("作业诊断目录=" + jobDirectory),
      ),
    );
    assert(
      diagnosticLogs.some((line) =>
        /服务=openai.*模型=gpt-4.1-mini.*并发=4.*QPS=2/.test(line),
      ),
    );
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
      // Even a nonzero worker exit may contain a validated explicitly partial
      // result. Raw diagnostic messages must not leak into the retained warning.
      global.Zotero.Utilities.Internal.exec = async (binary, args) => {
        const config = JSON.parse(await fs.readFile(args.at(-1), "utf8"));
        await originalExec(binary, args);
        const resultFile = path.join(config.jobDirectory, "result.json");
        const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
        result.completion = "partial";
        result.warning = {
          schemaVersion: 1,
          stage: "translation",
          code: "translation_incomplete",
          message: "TEST_SECRET PRIVATE_TEXT",
        };
        await fs.writeFile(resultFile, JSON.stringify(result));
        return false;
      };
      const partialJob = await createBabelDocJobDirectory();
      const retained = await new BabelDocBackend(project, () => ({
        available: true,
        path: path.join(profile, "uv.exe"),
        message: "ok",
      })).translate({
        sourcePath: source,
        jobDirectory: partialJob,
        sourceLanguage: "en",
        targetLanguage: "zh",
      });
      assert.equal(retained.completion, "partial");
      assert.match(retained.warning, /translation_incomplete/);
      assert.ok(!retained.warning.includes("TEST_SECRET"));
      assert.equal(
        await global.IOUtils.exists(retained.translatedPdfPath),
        true,
      );
      assert.equal(
        await global.IOUtils.exists(path.join(partialJob, "config-1")),
        false,
      );
      expectedAutoRepair = true;
      const repairJob = await createBabelDocJobDirectory();
      await new BabelDocBackend(project, () => ({
        available: true,
        path: path.join(profile, "uv.exe"),
        message: "ok",
      })).translate({
        sourcePath: source,
        jobDirectory: repairJob,
        sourceLanguage: "en",
        targetLanguage: "zh",
        autoRepair: true,
      });
      expectedAutoRepair = false;
      for (const [diagnostic, pattern] of [
        [
          {
            schemaVersion: 1,
            stage: "translation",
            code: "api_auth",
            backendStage: "Save PDF",
            exceptionType: "RuntimeError",
            runtime: { python: "3.12.8", babeldoc: "0.6.4" },
            exceptionChain: [
              {
                type: "RuntimeError",
                frames: [
                  {
                    file: "high_level.py",
                    function: "safe_save",
                    line: 90,
                    source: "PRIVATE_TEXT",
                  },
                ],
              },
            ],
            message: "TEST_SECRET PRIVATE_TEXT",
          },
          /API 鉴权失败/,
        ],
        [
          {
            schemaVersion: 1,
            stage: "mapping",
            code: "memory_exhausted",
            message: "TEST_SECRET PRIVATE_TEXT",
          },
          /内存不足/,
        ],
        [
          {
            schemaVersion: 1,
            stage: "mapping",
            code: "unknown",
            message: "TEST_SECRET PRIVATE_TEXT",
          },
          /BabelDOC 执行失败/,
        ],
      ]) {
        const failedJob = await createBabelDocJobDirectory();
        global.Zotero.Utilities.Internal.exec = async () => {
          await fs.writeFile(
            path.join(failedJob, "error.json"),
            JSON.stringify(diagnostic),
          );
          return false;
        };
        const failed = new BabelDocBackend(project, () => ({
          available: true,
          path: path.join(profile, "uv.exe"),
          message: "ok",
        }));
        await assert.rejects(
          failed.translate({
            sourcePath: source,
            jobDirectory: failedJob,
            sourceLanguage: "en",
            targetLanguage: "zh",
          }),
          (error) => {
            assert.match(error.message, pattern);
            assert.ok(!error.message.includes("TEST_SECRET"));
            return true;
          },
        );
        assert.equal(
          await global.IOUtils.exists(path.join(failedJob, "config-1")),
          false,
        );
      }
      assert(
        diagnosticLogs.some((line) =>
          /后端失败诊断=.*RuntimeError.*safe_save/.test(line),
        ),
      );
      assert(
        diagnosticLogs.some((line) =>
          /BabelDOC 翻译失败.*耗时=\d+ms/.test(line),
        ),
      );
      assert(!diagnosticLogs.join(" ").includes("TEST_SECRET"));
      assert(!diagnosticLogs.join(" ").includes("PRIVATE_TEXT"));
    } finally {
      global.Zotero.Utilities.Internal.exec = originalExec;
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});
