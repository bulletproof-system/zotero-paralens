const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
const tag = process.argv[2];
if (
  !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag || "") ||
  tag !== "v" + pkg.version
)
  throw new Error(
    "Supply the release tag matching package.json (v" + pkg.version + ")",
  );
if (lock.version !== pkg.version || lock.packages[""].version !== pkg.version)
  throw new Error("package-lock.json version does not match the release");
if (git(["status", "--porcelain", "--untracked-files=no"]))
  throw new Error("Source archive requires a clean tracked working tree");
const commit = git(["rev-parse", "HEAD"]);
if (git(["rev-parse", "refs/tags/" + tag + "^{commit}"]) !== commit)
  throw new Error("HEAD must be the release tag's commit");
const files = git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
for (const file of [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "docs/source-distribution.md",
  "licenses/zotero-plugin-toolkit-LICENSE.txt",
  "licenses/BabelDOC-0.6.4-LICENSE.txt",
])
  if (!files.includes(file))
    throw new Error("Required source material is not committed: " + file);
for (const file of files) {
  const components = file.split("/");
  if (
    components.some(
      (name) =>
        name === ".env" ||
        (name.startsWith(".env.") &&
          ![".env.example", ".env.template"].includes(name)) ||
        [
          ".scaffold",
          ".venv",
          "node_modules",
          "logins.json",
          "logins-backup.json",
          "key4.db",
          "zotero.sqlite",
        ].includes(name),
    )
  )
    throw new Error("Refusing to archive private/runtime path: " + file);
}
const out = path.join(root, ".scaffold/source");
fs.mkdirSync(out, { recursive: true });
const stem = "zotero-paralens-" + pkg.version + "-source";
const archive = path.join(out, stem + ".tar.gz");
git([
  "archive",
  "--format=tar.gz",
  "--prefix=zotero-paralens-" + pkg.version + "/",
  "--output=" + archive,
  "HEAD",
]);
const sha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(archive))
  .digest("hex");
fs.writeFileSync(
  archive + ".sha256",
  sha256 + "  " + path.basename(archive) + "\n",
);
fs.writeFileSync(
  path.join(out, stem + ".json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      tag,
      commit,
      license: pkg.license,
      archive: path.basename(archive),
      sha256,
      scope:
        "Tracked project source; external dependency sources are referenced in THIRD_PARTY_NOTICES.md.",
    },
    null,
    2,
  ) + "\n",
);
console.log("Created source archive for " + tag + " at " + commit);
