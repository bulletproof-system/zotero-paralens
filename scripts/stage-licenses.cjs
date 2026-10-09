// Stage legal materials without network access or copying private local files.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const toolkitDir = path.dirname(
  require.resolve("zotero-plugin-toolkit/package.json"),
);
const toolkit = JSON.parse(
  fs.readFileSync(path.join(toolkitDir, "package.json"), "utf8"),
);
if (toolkit.license !== "MIT")
  throw new Error("Toolkit license changed; review notices before packaging");
const snapshot = fs.readFileSync(
  path.join(root, "licenses/zotero-plugin-toolkit-LICENSE.txt"),
);
const installedLicense = fs.readFileSync(path.join(toolkitDir, "LICENSE"));
if (
  snapshot.toString("utf8").replace(/\r\n/g, "\n") !==
  installedLicense.toString("utf8").replace(/\r\n/g, "\n")
)
  throw new Error(
    "Toolkit license text changed; review and update the checked-in snapshot",
  );
const out = path.join(root, "addon");
function copy(source, target) {
  const contents = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(contents))
    fs.writeFileSync(target, contents);
}
copy(path.join(root, "LICENSE"), path.join(out, "LICENSE.txt"));
copy(
  path.join(root, "THIRD_PARTY_NOTICES.md"),
  path.join(out, "THIRD_PARTY_NOTICES.md"),
);
copy(
  path.join(root, "docs/source-distribution.md"),
  path.join(out, "docs/source-distribution.md"),
);
for (const file of [
  "BabelDOC-0.5.20-LICENSE.txt",
  "zotero-plugin-toolkit-LICENSE.txt",
])
  copy(path.join(root, "licenses", file), path.join(out, "licenses", file));
// Local readable texts under content/ are available to the settings-page viewer.
for (const file of ["LICENSE.txt", "THIRD_PARTY_NOTICES.md"])
  copy(path.join(out, file), path.join(out, "content/licenses", file));
for (const file of [
  "BabelDOC-0.5.20-LICENSE.txt",
  "zotero-plugin-toolkit-LICENSE.txt",
])
  copy(
    path.join(out, "licenses", file),
    path.join(out, "content/licenses", file),
  );
const repository = pkg.repository.url
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const metadata = {
  project: {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    source: repository + "/tree/v" + pkg.version,
    sourceArchive:
      repository +
      "/releases/download/v" +
      pkg.version +
      "/zotero-paralens-" +
      pkg.version +
      "-source.tar.gz",
  },
  bundled: [
    {
      name: toolkit.name,
      version: toolkit.version,
      license: toolkit.license,
      licenseFile: "licenses/zotero-plugin-toolkit-LICENSE.txt",
    },
  ],
  installedSeparately: [
    {
      name: "babeldoc",
      version: "0.5.20",
      license: "AGPL-3.0 (upstream declaration)",
      source: "https://github.com/funstory-ai/BabelDOC/tree/v0.5.20",
      licenseFile: "licenses/BabelDOC-0.5.20-LICENSE.txt",
    },
  ],
  limitations:
    "Python transitive dependencies, models and fonts are not a complete audited inventory. Development builds can contain unpublished changes.",
};
fs.writeFileSync(
  path.join(out, "content/licenses/DEPENDENCIES.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
