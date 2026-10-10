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
          build.onResolve({ filter: /taskQueueUI$/ }, () => ({
            path: "queueUI",
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
               globalThis.__requests.push(req); onProgress({stage:"translate", completed:1,total:2,percent:36});
               if (globalThis.__holdJob) return await new Promise(resolve => globalThis.__resolveJob = resolve);
               globalThis.__result.mapping.provenance.createdAt = new Date(Date.now() + globalThis.__requests.length).toISOString();
               return globalThis.__result;
             }
             async cancel() {
               globalThis.__cancelledJobs = (globalThis.__cancelledJobs || 0) + 1;
               globalThis.__resolveJob?.(globalThis.__result);
             }
           }`
                  : name === "queueUI"
                    ? `export async function showTaskQueue(win, queue, cancel, open) { globalThis.__openTask = open; }
                       export function closeTaskQueueWindows() {}`
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
    openTranslationQueue,
    selectedSourceAttachment,
    translatedAttachmentTitle,
    detachBilingual,
    isTranslationCancellable,
    cancelActiveTranslation,
    translationQueue,
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
  const mappingAttachments = [];
  const targets = new Map([[target.key, target]]);
  const opened = [],
    imported = [],
    labels = [],
    percentages = [],
    reported = [];
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
    isAbsolute: path.isAbsolute,
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
    remove: (p) => fs.rm(p, { force: true }),
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
    getMainWindow: () => ({ confirm: () => true }),
    Prefs: {
      get: (key) =>
        ({ backend: "babeldoc", sourceLanguage: "en", targetLanguage: "zh" })[
          key.split(".").at(-1)
        ],
    },
    Items: {
      getAsync: async (ids) =>
        Array.isArray(ids)
          ? mappingAttachments.filter((item) => ids.includes(item.id))
          : {
              getAttachments: () =>
                mappingAttachments
                  .filter((item) => !item.deleted)
                  .map((item) => item.id),
            },
      getAll: async () => mappingAttachments,
      getByLibraryAndKeyAsync: async (_libraryID, key) =>
        (key === source.key ? source : targets.get(key)) || false,
    },
    Attachments: {
      importFromFile: async (args) => {
        if (args.contentType === "application/json") {
          const file = path.join(
            profile,
            "mapping-" + mappingAttachments.length + ".json",
          );
          await fs.copyFile(args.file, file);
          const tags = new Set();
          const item = {
            id: 100 + mappingAttachments.length,
            isAttachment: () => true,
            deleted: false,
            hasTag: (tag) => tags.has(tag),
            addTag: (tag) => tags.add(tag),
            saveTx: async () => {},
            getFilePathAsync: async () => file,
            eraseTx: async () => {
              item.deleted = true;
            },
          };
          mappingAttachments.push(item);
          return item;
        }
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
        setProgress(value) {
          percentages.push(value);
        }
        setError() {}
      };
      changeHeadline() {}
      show() {}
      startCloseTimer() {}
    },
    Utilities: { Internal: { exec: async () => true } },
    debug() {},
  };
  translationQueue().subscribe(() =>
    reported.push(translationQueue().snapshot().at(-1)?.progress),
  );
  try {
    global.addon.data.backendInstalling = true;
    await assert.rejects(
      translateSelection(
        {
          confirm: () => assert.fail("No billing confirmation during install"),
        },
        [source],
      ),
      /后端正在安装/,
    );
    assert.equal(globalThis.__requests.length, 0);
    global.addon.data.backendInstalling = false;
    await translateSelection({ confirm: () => true } /* window */, [source]);
    assert.ok(percentages.includes(36));
    assert.ok(
      reported.some(
        (progress) =>
          progress?.percent === 98 && progress.stage === "导入译文 PDF",
      ),
    );
    assert.ok(
      reported.some(
        (progress) =>
          progress?.percent === 99 && progress.stage === "保存映射附件",
      ),
    );
    assert.equal(translationQueue().snapshot().at(-1).progress.percent, 100);
    assert.equal(globalThis.__requests[0].autoRepair, false);
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
    const latestMappingPath = await mappingAttachments
      .at(-1)
      .getFilePathAsync();
    await fs.writeFile(latestMappingPath, "{broken json");
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
    await fs.writeFile(latestMappingPath, JSON.stringify(saved));

    const versionedTarget = { ...target, id: 4, key: "NEWV1234" };
    const originalImportForVersion = Zotero.Attachments.importFromFile;
    const originalLookup = Zotero.Items.getByLibraryAndKeyAsync;
    Zotero.Attachments.importFromFile = async (args) => {
      if (args.contentType === "application/json")
        return originalImportForVersion(args);
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
      mappingAttachments.at(-1).deleted = true;
    }
    // Corrupt imports roll back; a valid PDF survives mapping failure as a
    // partial attachment without replacing the existing successful pair.
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
      await translateSelection({ confirm: () => true }, [source]);
      assert.equal(translationQueue().snapshot().at(-1).state, "failed");
      assert(labels.some((text) => text.includes("译文附件校验失败")));
      assert.equal(rollbackAttempts, 1);
      globalThis.__result.mapping.target.sha256 = originalDigest;
      const originalWrite = IOUtils.writeJSON;
      try {
        IOUtils.writeJSON = async (file, data) => {
          if (file.includes("mappings")) throw new Error("mapping disk full");
          return originalWrite(file, data);
        };
        failedTarget.eraseTx = async () => {
          rollbackAttempts++;
          throw new Error("erase failed");
        };
        const lookupBeforeFailure = Zotero.Items.getByLibraryAndKeyAsync;
        Zotero.Items.getByLibraryAndKeyAsync = async (lib, key) =>
          key === failedTarget.key
            ? failedTarget
            : lookupBeforeFailure(lib, key);
        await translateSelection({ confirm: () => true }, [source]);
        Zotero.Items.getByLibraryAndKeyAsync = lookupBeforeFailure;
        assert.equal(translationQueue().snapshot().at(-1).state, "partial");
        assert.equal(
          translationQueue().snapshot().at(-1).targetKey,
          failedTarget.key,
        );
        assert.equal(translationQueue().snapshot().at(-1).progress.percent, 99);
        assert(
          labels.some((text) => text.includes("mapping disk full")),
          "cleanup failure must not hide the mapping write failure",
        );
        assert.equal(
          rollbackAttempts,
          1,
          "Mapping failure must retain a verified PDF",
        );
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
    // Partial results keep an independent mapping and cannot displace a complete pair.
    const partialTarget = { ...target, id: 13, key: "PART1234" };
    targets.set(partialTarget.key, partialTarget);
    Zotero.Reader._readers.push({
      itemID: partialTarget.id,
      _item: partialTarget,
    });
    const beforePartialOpened = opened.length;
    const beforePartialImports = imported.length;
    const beforePartialMappings = mappingAttachments.length;
    const beforePartialMapping = await fs.readFile(savedFile, "utf8");
    Zotero.Attachments.importFromFile = async (args) => {
      if (args.contentType === "application/json") return originalImport(args);
      imported.push(args);
      return partialTarget;
    };
    const originalGetPref = Zotero.Prefs.get;
    Zotero.Prefs.get = (key) =>
      key.endsWith(".autoRepair") ? true : originalGetPref(key);
    globalThis.__result.completion = "partial";
    globalThis.__result.warning = "仍有正文未翻译（translation_incomplete）";
    try {
      await translateSelection({ confirm: () => true }, [source]);
      const partialTask = translationQueue().snapshot().at(-1);
      assert.equal(globalThis.__requests.at(-1).autoRepair, true);
      assert.equal(partialTask.options.autoRepair, true);
      assert.equal(partialTask.state, "partial");
      assert.equal(partialTask.targetKey, partialTarget.key);
      assert.equal(partialTask.progress.percent, 99);
      assert.match(partialTask.progress.message, /不完整译文已保留/);
      assert.equal(imported.length, beforePartialImports + 1);
      assert.match(imported.at(-1).title, /部分翻译/);
      assert.equal(mappingAttachments.length, beforePartialMappings + 1);
      const partialMapping = JSON.parse(
        await fs.readFile(
          await mappingAttachments.at(-1).getFilePathAsync(),
          "utf8",
        ),
      );
      assert.equal(partialMapping.completion, "partial");
      assert.equal(partialMapping.target.attachmentKey, partialTarget.key);
      assert.match(partialTask.progress.message, /段落映射已保存/);
      assert.equal(await fs.readFile(savedFile, "utf8"), beforePartialMapping);
      assert.deepEqual(opened.slice(beforePartialOpened), [
        source.id,
        partialTarget.id,
      ]);
      await openSavedBilingual([source]);
      assert.deepEqual(opened.slice(-2), [source.id, target.id]);
      await openTranslationQueue({});
      await globalThis.__openTask(partialTask);
      assert.deepEqual(opened.slice(-2), [source.id, partialTarget.id]);

      const originalSegments = globalThis.__result.mapping.segments;
      globalThis.__result.mapping.segments = [
        {
          id: "mapping-unavailable",
          level: "paragraph",
          status: "failed",
          source: [],
          target: [],
          metadata: { reason: "mapping_unavailable" },
        },
      ];
      try {
        const beforeNoAlignment = opened.length;
        await translateSelection({ confirm: () => true }, [source]);
        const noAlignmentTask = translationQueue().snapshot().at(-1);
        assert.equal(noAlignmentTask.state, "partial");
        assert.match(noAlignmentTask.progress.message, /没有可信段落映射/);
        assert.deepEqual(opened.slice(beforeNoAlignment), [partialTarget.id]);
        await globalThis.__openTask(noAlignmentTask);
        assert.equal(opened.at(-1), partialTarget.id);
      } finally {
        globalThis.__result.mapping.segments = originalSegments;
      }

      const originalWrite = IOUtils.writeJSON;
      IOUtils.writeJSON = async (file, value) => {
        if (file.endsWith(".attachment.json"))
          throw Error("partial mapping disk full");
        return originalWrite(file, value);
      };
      try {
        await translateSelection({ confirm: () => true }, [source]);
        const failedMappingTask = translationQueue().snapshot().at(-1);
        assert.equal(failedMappingTask.state, "partial");
        assert.equal(failedMappingTask.targetKey, partialTarget.key);
        assert.match(
          failedMappingTask.progress.message,
          /partial mapping disk full/,
        );
        assert.match(failedMappingTask.progress.message, /双语映射未完成/);
        assert.equal(
          await fs.readFile(savedFile, "utf8"),
          beforePartialMapping,
        );
      } finally {
        IOUtils.writeJSON = originalWrite;
      }
    } finally {
      Zotero.Attachments.importFromFile = originalImport;
      Zotero.Prefs.get = originalGetPref;
      delete globalThis.__result.completion;
      delete globalThis.__result.warning;
      delete globalThis.__openTask;
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
        id: "mapping-unavailable",
        level: "paragraph",
        status: "failed",
        source: [],
        target: [],
        metadata: { scope: "document", reason: "mapping_unavailable" },
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
    assert.equal(translationQueue().snapshot().at(-1).state, "completed");
    assert.equal(translationQueue().snapshot().at(-1).progress.percent, 100);
    assert.match(
      translationQueue().snapshot().at(-1).progress.message,
      /没有可信段落映射/,
    );
    await assert.rejects(openSavedBilingual([source]), /未能定位可悬停的段落/);
    await assert.rejects(
      selectedSourceAttachment([source, target]),
      /只选中一个/,
    );
  } finally {
    detachBilingual();
    await translationQueue().stop();
    await translationQueue().waitForIdle();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
