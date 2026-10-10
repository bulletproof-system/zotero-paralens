const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync, spawnSync } = require("node:child_process");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..");
const workspace = path.join(root, ".scaffold");
fs.mkdirSync(workspace, { recursive: true });

function tempRepo(t) {
  const repo = fs.mkdtempSync(path.join(workspace, "license-source-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(repo)), path.resolve(workspace));
    assert.ok(path.basename(repo).startsWith("license-source-test-"));
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const write = (file, data) => {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "License test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  write(".gitignore", ".scaffold/\n.env\n");
  write(
    "package.json",
    JSON.stringify({
      name: "zotero-paralens",
      version: "1.2.3",
      license: "AGPL-3.0-or-later",
    }),
  );
  write(
    "package-lock.json",
    JSON.stringify({
      version: "1.2.3",
      packages: { "": { version: "1.2.3" } },
    }),
  );
  for (const file of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "docs/source-distribution.md",
    "licenses/zotero-plugin-toolkit-LICENSE.txt",
    "licenses/BabelDOC-0.6.4-LICENSE.txt",
    "scripts/create-source-archive.cjs",
  ])
    write(file, fs.readFileSync(path.join(root, file)));
  write("src/index.ts", "export const example = true;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Synthetic license archive fixture");
  git("tag", "v1.2.3");
  const run = (tag) =>
    spawnSync(
      process.execPath,
      [path.join(repo, "scripts/create-source-archive.cjs"), tag],
      { cwd: repo, encoding: "utf8", windowsHide: true },
    );
  return { repo, write, git, run };
}

function tarEntries(archive) {
  const data = zlib.gunzipSync(fs.readFileSync(archive));
  const names = [];
  let offset = 0;
  while (offset + 512 <= data.length && data[offset]) {
    const name = data
      .subarray(offset, offset + 100)
      .toString("utf8")
      .split("\0")[0];
    const size = parseInt(
      data
        .subarray(offset + 124, offset + 136)
        .toString("ascii")
        .replace(/\0/g, "")
        .trim() || "0",
      8,
    );
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

test("staged license files preserve full texts and actual bundled versions", () => {
  execFileSync(
    process.execPath,
    [path.join(root, "scripts/stage-licenses.cjs")],
    { cwd: root, windowsHide: true },
  );
  for (const [target, source] of [
    ["addon/LICENSE.txt", "LICENSE"],
    ["addon/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    [
      "addon/licenses/zotero-plugin-toolkit-LICENSE.txt",
      "licenses/zotero-plugin-toolkit-LICENSE.txt",
    ],
    [
      "addon/licenses/BabelDOC-0.6.4-LICENSE.txt",
      "licenses/BabelDOC-0.6.4-LICENSE.txt",
    ],
    ["addon/content/licenses/LICENSE.txt", "LICENSE"],
  ])
    assert.deepEqual(
      fs.readFileSync(path.join(root, target)),
      fs.readFileSync(path.join(root, source)),
    );
  const metadata = JSON.parse(
    fs.readFileSync(
      path.join(root, "addon/content/licenses/DEPENDENCIES.json"),
      "utf8",
    ),
  );
  assert.equal(metadata.project.version, require("../package.json").version);
  assert.equal(
    metadata.bundled[0].version,
    require("zotero-plugin-toolkit/package.json").version,
  );
  assert.equal(metadata.installedSeparately[0].version, "0.6.4");
  assert.match(metadata.limitations, /not a complete audited inventory/);
});

test("source archive matches its tag, contains legal/build materials and excludes ignored credentials", (t) => {
  const fixture = tempRepo(t);
  fixture.write(".env", "LOCAL_ONLY_DUMMY_VALUE=not-a-real-secret\n");
  const result = fixture.run("v1.2.3");
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(
    fixture.repo,
    ".scaffold/source/zotero-paralens-1.2.3-source.tar.gz",
  );
  const entries = tarEntries(file);
  assert.ok(entries.includes("zotero-paralens-1.2.3/LICENSE"));
  assert.ok(entries.includes("zotero-paralens-1.2.3/src/index.ts"));
  assert.ok(
    entries.includes("zotero-paralens-1.2.3/docs/source-distribution.md"),
  );
  assert.ok(
    !entries.some(
      (name) =>
        name.includes("/.env") ||
        name.includes("/.git/") ||
        name.includes("/.scaffold/"),
    ),
  );
  const digest = crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  const meta = JSON.parse(
    fs.readFileSync(file.replace(/\.tar\.gz$/, ".json"), "utf8"),
  );
  assert.equal(meta.sha256, digest);
  assert.equal(meta.commit, fixture.git("rev-parse", "HEAD"));
  assert.ok(
    fs.readFileSync(file + ".sha256", "utf8").startsWith(digest + "  "),
  );
});

test("source archive refuses wrong tags and dirty tracked sources", (t) => {
  const fixture = tempRepo(t);
  assert.match(fixture.run("v9.9.9").stderr, /Supply the release tag matching/);
  fixture.write("src/index.ts", "export const unpublished = true;\n");
  assert.match(fixture.run("v1.2.3").stderr, /clean tracked working tree/);
});

test("source archive refuses a tag pointing to a different commit", (t) => {
  const fixture = tempRepo(t);
  fixture.write("src/index.ts", "export const nextCommit = true;\n");
  fixture.git("add", ".");
  fixture.git("commit", "--quiet", "-m", "Another synthetic commit");
  assert.match(fixture.run("v1.2.3").stderr, /HEAD must be the release tag/);
});

test("source archive rejects tracked private .env variants", (t) => {
  const fixture = tempRepo(t);
  fixture.write(".env.production", "DUMMY=synthetic-test\n");
  fixture.git("add", ".env.production");
  fixture.git("commit", "--quiet", "-m", "Synthetic invalid private file");
  fixture.git("tag", "--force", "v1.2.3");
  assert.match(fixture.run("v1.2.3").stderr, /Refusing to archive private/);
});

test("license settings load offline texts once and use versioned source links", async () => {
  const output = path.join(workspace, "license-ui-tests.cjs");
  buildSync({
    entryPoints: [path.join(root, "src/utils/license.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: output,
  });
  const { registerLicenseUI, releaseSourceURLs } = require(output);
  const pkg = require("../package.json");
  assert.ok(releaseSourceURLs().source.endsWith("/tree/v" + pkg.version));
  assert.ok(
    releaseSourceURLs().archive.endsWith(
      "/zotero-paralens-" + pkg.version + "-source.tar.gz",
    ),
  );
  const nodes = new Map();
  for (const id of [
    "paralens-legal",
    "paralens-legal-text",
    "paralens-source",
    "paralens-source-archive",
  ])
    nodes.set(id, {
      dataset: {},
      open: false,
      textContent: "",
      listeners: new Map(),
      addEventListener(type, callback) {
        this.listeners.set(type, callback);
      },
    });
  const reads = [],
    urls = [];
  global.rootURI = "jar:file:///synthetic-plugin.xpi!/";
  global.Zotero = {
    File: {
      getResourceAsync: async (uri) => {
        reads.push(uri);
        return "synthetic license text";
      },
    },
    launchURL: (url) => urls.push(url),
  };
  const win = {
    document: { getElementById: (id) => nodes.get(id) },
    navigator: { language: "en" },
  };
  registerLicenseUI(win);
  registerLicenseUI(win);
  assert.equal(reads.length, 0);
  const details = nodes.get("paralens-legal");
  details.open = true;
  await details.listeners.get("toggle")();
  assert.equal(reads.length, 5);
  assert.ok(
    reads.every((uri) => uri.startsWith(global.rootURI + "content/licenses/")),
  );
  assert.match(
    nodes.get("paralens-legal-text").textContent,
    /synthetic license text/,
  );
  await details.listeners.get("toggle")();
  assert.equal(reads.length, 5);
  nodes.get("paralens-source").listeners.get("click")();
  nodes.get("paralens-source-archive").listeners.get("click")();
  assert.deepEqual(urls, [
    releaseSourceURLs().source,
    releaseSourceURLs().archive,
  ]);
});
