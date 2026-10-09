const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const Zip = require("adm-zip");
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const archive = new Zip(path.join(root, ".scaffold/build/zotero-paralens.xpi"));
const required = [
  ["LICENSE.txt", "LICENSE"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["docs/source-distribution.md", "docs/source-distribution.md"],
  [
    "licenses/zotero-plugin-toolkit-LICENSE.txt",
    "licenses/zotero-plugin-toolkit-LICENSE.txt",
  ],
  [
    "licenses/BabelDOC-0.5.20-LICENSE.txt",
    "licenses/BabelDOC-0.5.20-LICENSE.txt",
  ],
  ["content/licenses/LICENSE.txt", "LICENSE"],
  ["content/licenses/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  [
    "content/licenses/zotero-plugin-toolkit-LICENSE.txt",
    "licenses/zotero-plugin-toolkit-LICENSE.txt",
  ],
  [
    "content/licenses/BabelDOC-0.5.20-LICENSE.txt",
    "licenses/BabelDOC-0.5.20-LICENSE.txt",
  ],
];
for (const [entry, source] of required) {
  assert.ok(archive.getEntry(entry), "Missing legal material in XPI: " + entry);
  assert.equal(
    archive.readAsText(entry).replace(/\r\n/g, "\n"),
    fs.readFileSync(path.join(root, source), "utf8").replace(/\r\n/g, "\n"),
    "License text changed in XPI: " + entry,
  );
}
const manifest = JSON.parse(
  archive.readAsText("content/licenses/DEPENDENCIES.json"),
);
assert.equal(manifest.project.version, pkg.version);
assert.equal(
  manifest.bundled[0].version,
  require("zotero-plugin-toolkit/package.json").version,
);
assert.ok(
  manifest.project.sourceArchive.endsWith(
    "/zotero-paralens-" + pkg.version + "-source.tar.gz",
  ),
);
for (const entry of archive.getEntries()) {
  const components = entry.entryName.split("/");
  assert.ok(
    !components.some(
      (name) =>
        name === ".env" ||
        name.startsWith(".env.") ||
        [
          ".venv",
          "node_modules",
          "logins.json",
          "key4.db",
          "zotero.sqlite",
        ].includes(name),
    ),
    "Private/runtime file in XPI: " + entry.entryName,
  );
}
console.log(
  "Verified full project/upstream license texts, notices and versioned source metadata in XPI.",
);
