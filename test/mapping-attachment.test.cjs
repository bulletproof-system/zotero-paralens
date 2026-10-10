const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildSync } = require("esbuild");
const out = path.resolve(".scaffold/mapping-attachment-tests.cjs");
buildSync({
  entryPoints: ["src/mapping/store.ts"],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { saveMapping, loadMapping } = require(out);
const clean = (value) => JSON.parse(JSON.stringify(value));
const fixture = require("../fixtures/two-paragraphs.mapping.v1.json");

function mocks(root, libraryID, items, imported) {
  global.PathUtils = {
    profileDir: root,
    join: path.join,
    parent: path.dirname,
  };
  global.IOUtils = {
    exists: (file) =>
      fs.access(file).then(
        () => true,
        () => false,
      ),
    makeDirectory: (file) => fs.mkdir(file, { recursive: true }),
    writeJSON: (file, value) => fs.writeFile(file, JSON.stringify(value)),
    readJSON: async (file) => JSON.parse(await fs.readFile(file, "utf8")),
    remove: (file) => fs.rm(file, { force: true }),
  };
  global.Zotero = {
    debug() {},
    Items: {
      getByLibraryAndKeyAsync: async (lib, key) =>
        lib === libraryID ? items.find((item) => item.key === key) : false,
      getAsync: async (ids) =>
        Array.isArray(ids)
          ? items.filter((item) => ids.includes(item.id))
          : items.find((item) => item.id === ids),
      getAll: async (lib) => (lib === libraryID ? items : []),
    },
    Attachments: {
      importFromFile: async (args) => {
        imported.push(args);
        const file = path.join(root, "stored-" + imported.length + ".json");
        await fs.copyFile(args.file, file);
        const item = {
          id: 100 + imported.length,
          key: "JSON" + String(imported.length).padStart(4, "0"),
          parentItemID: args.parentItemID,
          tags: [],
          file,
          deleted: false,
          isAttachment: () => true,
          isPDFAttachment: () => false,
          addTag(tag) {
            this.tags.push(tag);
          },
          hasTag(tag) {
            return this.tags.includes(tag);
          },
          saveTx: async () => {},
          getFilePathAsync: async () => item.file,
          eraseTx: async () => {
            item.deleted = true;
          },
        };
        items.push(item);
        return item;
      },
    },
  };
}
function pdf(key, id, parentItemID) {
  return {
    key,
    id,
    parentItemID,
    isAttachment: () => true,
    isPDFAttachment: () => true,
    hasTag: () => false,
  };
}

test("mapping is stored beside translation and discovered on another device without any profile cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paralens-sync-"));
  try {
    const deviceA = path.join(root, "a"),
      deviceB = path.join(root, "b");
    await fs.mkdir(deviceA);
    await fs.mkdir(deviceB);
    const mapping = structuredClone(fixture);
    mapping.source.attachmentKey = "SOURCE01";
    mapping.target.attachmentKey = "TARGET01";
    const items = [pdf("SOURCE01", 1, 3), pdf("TARGET01", 2, 3)];
    items.push({
      id: 3,
      getAttachments: () =>
        items
          .filter((item) => item.parentItemID === 3 && !item.deleted)
          .map((item) => item.id),
    });
    const imports = [];
    mocks(deviceA, 1, items, imports);
    await saveMapping(mapping, 1);
    assert.equal(imports[0].contentType, "application/json");
    assert.equal(imports[0].parentItemID, 3);
    assert(imports[0].title.includes("TARGET01"));
    const attachment = items.at(-1);
    assert(attachment.hasTag("paralens-mapping:SOURCE01"));
    assert(attachment.hasTag("paralens-target:TARGET01"));
    const copy = path.join(deviceB, "synced-mapping.json");
    await fs.copyFile(attachment.file, copy);
    // Simulate synced attachment metadata and files with different local IDs/library ID.
    const synced = [
      pdf("SOURCE01", 41, 43),
      pdf("TARGET01", 42, 43),
      {
        ...attachment,
        id: 44,
        parentItemID: 43,
        file: copy,
        getFilePathAsync: async () => copy,
      },
    ];
    synced.push({ id: 43, getAttachments: () => [41, 42, 44] });
    mocks(deviceB, 7, synced, []);
    assert.equal(
      await IOUtils.exists(
        path.join(deviceB, "paralens/mappings/7-SOURCE01.json"),
      ),
      false,
    );
    assert.deepEqual(clean(await loadMapping(7, "SOURCE01")), mapping);
    await fs.rm(copy);
    await assert.rejects(loadMapping(7, "SOURCE01"), /尚未下载/);
    await fs.writeFile(copy, "broken JSON");
    await assert.rejects(loadMapping(7, "SOURCE01"), /附件损坏/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("standalone PDFs discover stored mappings, legacy mappings migrate, failed attachment commits roll back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paralens-migrate-"));
  try {
    const mapping = structuredClone(fixture);
    mapping.source.attachmentKey = "SOURCE01";
    mapping.target.attachmentKey = "TARGET01";
    const items = [pdf("SOURCE01", 1), pdf("TARGET01", 2)];
    const imports = [];
    mocks(root, 1, items, imports);
    const cache = path.join(root, "paralens/mappings/1-SOURCE01.json");
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, JSON.stringify(mapping));
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), mapping);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].parentItemID, undefined);
    await fs.rm(cache);
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), mapping);
    const original = Zotero.Attachments.importFromFile;
    Zotero.Attachments.importFromFile = async (args) => {
      const item = await original(args);
      item.saveTx = async () => {
        throw Error("commit failed");
      };
      return item;
    };
    await assert.rejects(saveMapping(mapping, 1), /commit failed/);
    assert.equal(items.at(-1).deleted, true);
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), mapping);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("committed mapping attachments survive local cache/cleanup failures and repair older damaged mappings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paralens-cache-"));
  try {
    const mapping = structuredClone(fixture);
    mapping.source.attachmentKey = "SOURCE01";
    mapping.target.attachmentKey = "TARGET01";
    const items = [pdf("SOURCE01", 1), pdf("TARGET01", 2)],
      imports = [];
    mocks(root, 1, items, imports);
    await saveMapping(mapping, 1);
    await fs.writeFile(items.at(-1).file, "damaged old mapping");
    const originalWrite = IOUtils.writeJSON;
    IOUtils.writeJSON = (file, data) =>
      file.endsWith("1-SOURCE01.json")
        ? Promise.reject(Error("cache full"))
        : originalWrite(file, data);
    IOUtils.remove = async () => {
      throw Error("temporary handle retained");
    };
    mapping.provenance.createdAt = "2026-10-08T01:00:00Z";
    await saveMapping(mapping, 1);
    assert.equal(items.at(-1).deleted, false);
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), mapping);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("partial mappings sync independently, preserve complete defaults and open by exact target", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paralens-partial-map-"),
  );
  try {
    const complete = structuredClone(fixture);
    complete.source.attachmentKey = "SOURCE01";
    complete.target.attachmentKey = "TARGET01";
    const partial = structuredClone(complete);
    partial.completion = "partial";
    partial.target.attachmentKey = "PARTIAL1";
    partial.provenance.createdAt = "2026-10-10T01:00:00Z";
    const items = [pdf("SOURCE01", 1), pdf("TARGET01", 2), pdf("PARTIAL1", 3)];
    const imports = [];
    mocks(root, 1, items, imports);
    await saveMapping(complete, 1);
    const cache = path.join(root, "paralens/mappings/1-SOURCE01.json");
    const cachedComplete = await fs.readFile(cache, "utf8");
    await saveMapping(partial, 1);
    assert.equal(imports.length, 2);
    assert.match(imports.at(-1).title, /部分翻译/);
    assert.equal(await fs.readFile(cache, "utf8"), cachedComplete);
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), complete);
    assert.deepEqual(
      clean(await loadMapping(1, "SOURCE01", "PARTIAL1")),
      partial,
    );
    assert.deepEqual(
      clean(await loadMapping(1, "SOURCE01", "TARGET01")),
      complete,
    );
    assert.equal(await loadMapping(1, "SOURCE01", "ABSENT01"), undefined);

    // Synced attachments, not the profile cache, determine the preferred result.
    await fs.rm(path.join(root, "paralens"), { recursive: true, force: true });
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), complete);
    assert.deepEqual(
      clean(await loadMapping(1, "SOURCE01", "PARTIAL1")),
      partial,
    );
    const partialAttachment = items.at(-1);
    await fs.rm(partialAttachment.file);
    await assert.rejects(loadMapping(1, "SOURCE01", "PARTIAL1"), /尚未下载/);
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), complete);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial mapping is readable without an existing complete translation", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paralens-only-partial-"),
  );
  try {
    const mapping = structuredClone(fixture);
    mapping.source.attachmentKey = "SOURCE01";
    mapping.target.attachmentKey = "PARTIAL1";
    mapping.completion = "partial";
    mocks(root, 1, [pdf("SOURCE01", 1), pdf("PARTIAL1", 2)], []);
    await saveMapping(mapping, 1);
    assert.equal(
      await IOUtils.exists(
        path.join(root, "paralens/mappings/1-SOURCE01.json"),
      ),
      false,
    );
    assert.deepEqual(clean(await loadMapping(1, "SOURCE01")), mapping);
    assert.deepEqual(
      clean(await loadMapping(1, "SOURCE01", "PARTIAL1")),
      mapping,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
