require("./helpers/mock-process.cjs").installMockProcess();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { build } = require("esbuild");

const outfile = path.resolve(".scaffold/frontend-workflow-test.cjs");
async function loadWorkflow() {
  await build({
    entryPoints: ["src/reader/translationWorkflow.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "mock-translation-process",
        setup(build) {
          build.onResolve({ filter: /backend\/babeldoc$/ }, () => ({
            path: "backend",
            namespace: "mock",
          }));
          build.onResolve({ filter: /nativeOverlay$/ }, () => ({
            path: "overlay",
            namespace: "mock",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "mock" },
            ({ path: name }) => ({
              contents:
                name === "backend"
                  ? `export const createBabelDocJobDirectory = async () => "job";
           export class TranslationCancelledError extends Error {
             constructor() { super("翻译已取消"); this.name="TranslationCancelledError"; }
           }
           export class BabelDocBackend {
             async translate(req, onProgress) {
               globalThis.__requests.push(req); onProgress({stage:"translate", completed:1,total:2});
               if (globalThis.__holdJob) return await new Promise(resolve => globalThis.__resolveJob = resolve);
               return globalThis.__result;
             }
             async cancel() {
               globalThis.__cancelledJobs = (globalThis.__cancelledJobs || 0) + 1;
               globalThis.__resolveJob?.(globalThis.__result);
             }
           }`
                  : `export class NativeReaderPair { attach() { return true; } detach() {} }`,
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  return require(outfile);
}
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("one selected PDF -> import translation -> bind/persist mapping -> open native Readers", async () => {
  const {
    translateSelection,
    openSavedBilingual,
    selectedSourceAttachment,
    translatedAttachmentTitle,
    detachBilingual,
    isTranslationCancellable,
    cancelActiveTranslation,
  } = await loadWorkflow();
  assert.equal(
    translatedAttachmentTitle("A PDF", "zh"),
    "A PDF（ParaLens 中文译文）",
  );
  assert.equal(
    translatedAttachmentTitle("A PDF", "en"),
    "A PDF（ParaLens 英文译文）",
  );
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "paralens-ui-"));
  const sourcePath = path.join(profile, "source.pdf");
  const translatedPath = path.join(profile, "translated.pdf");
  const sourceBytes = Buffer.from("%PDF-1.7\nsource");
  const translatedBytes = Buffer.from("%PDF-1.7\ntarget");
  await fs.writeFile(sourcePath, sourceBytes);
  await fs.writeFile(translatedPath, translatedBytes);
  const source = {
    key: "ABCD1234",
    id: 1,
    libraryID: 1,
    parentItemID: 3,
    isPDFAttachment: () => true,
    getFilePathAsync: async () => sourcePath,
    getDisplayTitle: () => "Source",
  };
  const target = {
    key: "EFGH5678",
    id: 2,
    libraryID: 1,
    isPDFAttachment: () => true,
    getFilePathAsync: async () => translatedPath,
  };
  const opened = [],
    imported = [],
    labels = [];
  globalThis.__requests = [];
  globalThis.__result = {
    translatedPdfPath: translatedPath,
    mapping: {
      schemaVersion: 1,
      source: { sha256: sha(sourceBytes), pageCount: 1 },
      target: { sha256: sha(translatedBytes), pageCount: 1 },
      segments: [
        {
          id: "p-0",
          level: "paragraph",
          status: "aligned",
          source: [
            { pageIndex: 0, quads: [[0.1, 0.1, 0.9, 0.1, 0.9, 0.2, 0.1, 0.2]] },
          ],
          target: [
            { pageIndex: 0, quads: [[0.1, 0.1, 0.9, 0.1, 0.9, 0.2, 0.1, 0.2]] },
          ],
        },
      ],
      provenance: {
        backend: "babeldoc",
        adapterVersion: "1",
        createdAt: "2026-09-29T00:00:00Z",
      },
    },
  };
  global.PathUtils = {
    profileDir: profile,
    join: path.join,
    parent: path.dirname,
  };
  global.IOUtils = {
    exists: async (p) =>
      fs.access(p).then(
        () => true,
        () => false,
      ),
    makeDirectory: async (p) => fs.mkdir(p, { recursive: true }),
    writeJSON: async (p, value) => fs.writeFile(p, JSON.stringify(value)),
    readJSON: async (p) => JSON.parse(await fs.readFile(p, "utf8")),
    computeHexDigest: async (p) => sha(await fs.readFile(p)),
  };
  global.addon = {
    data: { backendProjectDir: profile, uv: { available: true }, alive: true },
  };
  global.Services = { appinfo: { OS: "WINNT" } };
  await fs.mkdir(path.join(profile, ".venv", "Scripts"), { recursive: true });
  await fs.writeFile(path.join(profile, ".venv", "pyvenv.cfg"), "home = test");
  await fs.writeFile(
    path.join(profile, ".venv", "Scripts", "python.exe"),
    "test stub",
  );
  global.Zotero = {
    Prefs: {
      get: (key) =>
        ({ backend: "babeldoc", sourceLanguage: "en", targetLanguage: "zh" })[
          key.split(".").at(-1)
        ],
    },
    Items: {
      getByLibraryAndKeyAsync: async (_libraryID, key) =>
        ({ ABCD1234: source, EFGH5678: target })[key] || false,
    },
    Attachments: {
      importFromFile: async (args) => {
        imported.push(args);
        return target;
      },
    },
    Reader: {
      _readers: [
        { itemID: 1, _item: source },
        { itemID: 2, _item: target },
      ],
      open: async (id) => {
        opened.push(id);
      },
    },
    ProgressWindow: class {
      ItemProgress = class {
        constructor(_icon, text) {
          labels.push(text);
        }
        setText(text) {
          labels.push(text);
        }
        setProgress() {}
        setError() {}
      };
      changeHeadline() {}
      show() {}
      startCloseTimer() {}
    },
    Utilities: { Internal: { exec: async () => true } },
    debug() {},
  };
  try {
    await translateSelection({ confirm: () => true } /* window */, [source]);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].parentItemID, 3);
    assert.equal(imported[0].title, "Source（ParaLens 中文译文）");
    assert.deepEqual(opened, [1, 2]);
    assert.deepEqual(
      globalThis.__requests.map((r) => [r.sourcePath, r.targetLanguage]),
      [[sourcePath, "zh"]],
    );
    const saved = JSON.parse(
      await fs.readFile(
        path.join(profile, "paralens/mappings/1-ABCD1234.json"),
        "utf8",
      ),
    );
    assert.equal(saved.target.attachmentKey, "EFGH5678");
    assert(labels.includes("翻译已完成：译文已导入 Zotero"));
    await openSavedBilingual([source]);
    assert.deepEqual(opened, [1, 2, 1, 2]);
    // A cancelled worker may still return, but its result must never be imported.
    const importsBeforeCancel = imported.length;
    const oldMapping = await fs.readFile(
      path.join(profile, "paralens/mappings/1-ABCD1234.json"),
      "utf8",
    );
    globalThis.__holdJob = true;
    const pendingTranslation = translateSelection({ confirm: () => true }, [
      source,
    ]);
    for (let i = 0; i < 100 && !isTranslationCancellable(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(isTranslationCancellable(), true);
    assert.equal(await cancelActiveTranslation(), true);
    assert.equal(isTranslationCancellable(), false);
    await pendingTranslation;
    assert.equal(await cancelActiveTranslation(), false);
    assert.equal(globalThis.__cancelledJobs, 1);
    assert.equal(imported.length, importsBeforeCancel);
    assert.equal(
      await fs.readFile(
        path.join(profile, "paralens/mappings/1-ABCD1234.json"),
        "utf8",
      ),
      oldMapping,
    );
    assert(labels.some((text) => text.includes("API 请求可能仍产生费用")));
    globalThis.__holdJob = false;
    globalThis.__resolveJob = undefined;
    const savedFile = path.join(profile, "paralens/mappings/1-ABCD1234.json");
    assert.equal(
      translatedAttachmentTitle(
        "A PDF",
        "zh",
        new Date("2026-09-30T12:34:56.123Z"),
      ),
      "A PDF（ParaLens 中文译文 · 2026-09-30 12:34:56.123 UTC）",
    );
    const beforeRetry = globalThis.__requests.length;
    let retryPrompt = "";
    await translateSelection(
      {
        confirm: (message) => {
          retryPrompt = message;
          return false;
        },
      },
      [source],
    );
    assert.match(retryPrompt, /已有 ParaLens 译文/);
    assert.match(retryPrompt, /旧译文附件仍会保留/);
    assert.equal(
      globalThis.__requests.length,
      beforeRetry,
      "declining an existing translation must not call the paid API again",
    );
    await fs.writeFile(savedFile, "{broken json");
    let damagedPrompt = "";
    await translateSelection(
      {
        confirm: (message) => {
          damagedPrompt = message;
          return false;
        },
      },
      [source],
    );
    assert.match(damagedPrompt, /旧的双语映射无法读取/);
    assert.equal(globalThis.__requests.length, beforeRetry);
    await fs.writeFile(savedFile, JSON.stringify(saved));

    const versionedTarget = { ...target, id: 4, key: "NEWV1234" };
    const originalImportForVersion = Zotero.Attachments.importFromFile;
    const originalLookup = Zotero.Items.getByLibraryAndKeyAsync;
    Zotero.Attachments.importFromFile = async (args) => {
      imported.push(args);
      return versionedTarget;
    };
    Zotero.Items.getByLibraryAndKeyAsync = async (libraryID, key) =>
      key === versionedTarget.key
        ? versionedTarget
        : originalLookup(libraryID, key);
    Zotero.Reader._readers.push({
      itemID: versionedTarget.id,
      _item: versionedTarget,
    });
    try {
      await translateSelection({ confirm: () => true }, [source]);
      assert.match(
        imported.at(-1).title,
        /^Source（ParaLens 中文译文 · \d{4}-\d{2}-\d{2} .* UTC）$/,
      );
      const replaced = JSON.parse(await fs.readFile(savedFile, "utf8"));
      assert.equal(replaced.target.attachmentKey, versionedTarget.key);
      assert.deepEqual(opened.slice(-2), [source.id, versionedTarget.id]);
      assert.equal(
        target.key,
        "EFGH5678",
        "old translation attachment stays untouched",
      );
    } finally {
      await fs.writeFile(savedFile, JSON.stringify(saved));
      Zotero.Attachments.importFromFile = originalImportForVersion;
      Zotero.Items.getByLibraryAndKeyAsync = originalLookup;
      Zotero.Reader._readers.pop();
    }
    // An imported PDF without a committed mapping is not a usable pair.
    // Both checksum failure and mapping-write failure must roll it back,
    // leaving the previously successful translation untouched.
    let rollbackAttempts = 0;
    const failedTarget = {
      ...target,
      key: "NEWP1234",
      eraseTx: async () => {
        rollbackAttempts++;
        return true;
      },
    };
    const originalImport = Zotero.Attachments.importFromFile;
    Zotero.Attachments.importFromFile = async () => failedTarget;
    const originalDigest = globalThis.__result.mapping.target.sha256;
    try {
      globalThis.__result.mapping.target.sha256 = "0".repeat(64);
      await assert.rejects(
        translateSelection({ confirm: () => true }, [source]),
        /译文附件校验失败/,
      );
      assert.equal(rollbackAttempts, 1);
      globalThis.__result.mapping.target.sha256 = originalDigest;
      const originalWrite = IOUtils.writeJSON;
      try {
        IOUtils.writeJSON = async () => {
          throw new Error("mapping disk full");
        };
        failedTarget.eraseTx = async () => {
          rollbackAttempts++;
          throw new Error("erase failed");
        };
        await assert.rejects(
          translateSelection({ confirm: () => true }, [source]),
          /mapping disk full/,
          "cleanup failure must not hide the mapping write failure",
        );
        assert.equal(rollbackAttempts, 2);
      } finally {
        IOUtils.writeJSON = originalWrite;
      }
      const stillSaved = JSON.parse(
        await fs.readFile(
          path.join(profile, "paralens/mappings/1-ABCD1234.json"),
          "utf8",
        ),
      );
      assert.equal(stillSaved.target.attachmentKey, "EFGH5678");
    } finally {
      globalThis.__result.mapping.target.sha256 = originalDigest;
      Zotero.Attachments.importFromFile = originalImport;
    }
    const count = globalThis.__requests.length;
    await translateSelection({ confirm: () => false }, [source]);
    assert.equal(
      globalThis.__requests.length,
      count,
      "declining confirmation never calls the backend",
    );
    await fs.rm(path.join(profile, ".venv", "pyvenv.cfg"));
    await assert.rejects(
      translateSelection(
        {
          confirm: () => {
            throw Error("No paid confirmation should appear");
          },
        },
        [source],
      ),
      /尚未安装/,
    );
    assert.equal(globalThis.__requests.length, count);
    await fs.writeFile(translatedPath, "changed PDF");
    await assert.rejects(openSavedBilingual([source]), /PDF 内容已变更/);
    await fs.writeFile(translatedPath, translatedBytes);
    await fs.writeFile(
      path.join(profile, ".venv", "pyvenv.cfg"),
      "home = test",
    );
    globalThis.__result.mapping.segments = [
      {
        id: "p-0",
        level: "paragraph",
        status: "uncertain",
        source: [],
        target: [],
      },
    ];
    const openedBeforeNoAlignment = opened.length;
    await translateSelection({ confirm: () => true }, [source]);
    assert.deepEqual(
      opened.slice(openedBeforeNoAlignment),
      [target.id],
      "when alignment fails the translated PDF remains readable, but no fake pair opens",
    );
    assert(labels.some((text) => text.includes("未能定位可悬停的段落")));
    await assert.rejects(openSavedBilingual([source]), /未能定位可悬停的段落/);
    await assert.rejects(
      selectedSourceAttachment([source, target]),
      /只选中一个/,
    );
  } finally {
    detachBilingual();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
