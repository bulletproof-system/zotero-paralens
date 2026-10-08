/** Run the real Zotero UI smoke test only in a fresh, disposable copy.
 * No saved API key is read, no existing test profile is reset, and the
 * scaffold's global Zotero kill command is replaced with a no-op. */
import { spawn, execFileSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
import { prepareMockUV } from "./mock-uv-executable.mjs";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(root, ".scaffold");
const prepareOnly = process.argv.includes("--prepare-only");
const realComplex = process.argv.includes("--real-complex");
const realAPI = realComplex || process.argv.includes("--real-api");
const complexSource = process.env.PARALENS_COMPLEX_SOURCE;
if (
  realComplex &&
  (!complexSource ||
    !existsSync(complexSource) ||
    !complexSource.toLowerCase().endsWith(".pdf"))
)
  throw new Error(
    "Real complex translation requires an explicit existing PDF source",
  );
const twoPageReal = process.argv.includes("--two-pages");
if (twoPageReal && !realAPI) throw new Error("--two-pages requires --real-api");
const complexReplay = process.argv.includes("--replay-complex");
const replayReal =
  complexReplay ||
  process.argv.includes("--replay-real") ||
  process.argv.includes("--replay-artifact");
if (realAPI && replayReal) throw new Error("Select only one test mode");
const replayDirectory = process.env.PARALENS_REPLAY_DIRECTORY;
if (
  complexReplay &&
  (!replayDirectory ||
    !existsSync(join(replayDirectory, "result.json")) ||
    !realpathSync(replayDirectory)
      .toLowerCase()
      .startsWith(realpathSync(tmpdir()).toLowerCase() + sep) ||
    !/^paralens-artifact-replay-/.test(replayDirectory.split(/[\\/]/).at(-1)))
)
  throw new Error(
    "Complex replay requires a fresh OS-temporary artifact replay directory",
  );
const replayPdf = complexReplay
  ? join(replayDirectory, "translated.pdf")
  : process.env.PARALENS_REPLAY_PDF;
const replayMapping = complexReplay
  ? join(replayDirectory, "mapping.v1.json")
  : process.env.PARALENS_REPLAY_MAPPING;
const replaySource = complexReplay
  ? JSON.parse(readFileSync(join(replayDirectory, "replay-input.json"), "utf8"))
      .sourcePath
  : process.env.PARALENS_REPLAY_SOURCE;
if (
  replayReal &&
  !complexReplay &&
  replaySource &&
  (!existsSync(replaySource) ||
    !realpathSync(replaySource)
      .toLowerCase()
      .startsWith(realpathSync(workspace).toLowerCase() + sep))
)
  throw new Error("Replay source must exist within the disposable workspace");
if (
  replayReal &&
  (!replayPdf ||
    !replayMapping ||
    !existsSync(replayPdf) ||
    !existsSync(replayMapping))
)
  throw new Error(
    "Set PARALENS_REPLAY_PDF and PARALENS_REPLAY_MAPPING to previous real translation artifacts",
  );
// The production tsconfig intentionally excludes tests. Check the opt-in
// billable test before reading/copying credentials or starting any API work.
if (realAPI)
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--project",
      join(root, "test", "tsconfig.gui-real.json"),
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
const credentialProfile = process.env.PARALENS_REAL_API_SOURCE_PROFILE;
if (
  realAPI &&
  (!credentialProfile ||
    !["key4.db", "logins.json"].every((file) =>
      existsSync(join(credentialProfile, file)),
    ))
)
  throw new Error(
    "Real API test needs PARALENS_REAL_API_SOURCE_PROFILE with Zotero credentials",
  );
const venv = process.env.PARALENS_TEST_VENV;
const zotero =
  process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH ||
  (process.platform === "win32" ? "C:\\Program Files\\Zotero\\zotero.exe" : "");
if (!venv || !existsSync(join(venv, "pyvenv.cfg")))
  throw new Error("Set PARALENS_TEST_VENV to an existing BabelDOC uv .venv");
if (!zotero || !existsSync(zotero))
  throw new Error("Set ZOTERO_PLUGIN_ZOTERO_BIN_PATH to a Zotero executable");
if (!existsSync(join(root, "node_modules", "zotero-plugin-scaffold")))
  throw new Error("Run npm install in the repository first");

mkdirSync(workspace, { recursive: true });
const testParent = complexReplay || realComplex ? tmpdir() : workspace;
const isolated = join(
  testParent,
  `paralens-gui-smoke-${randomUUID().slice(0, 8)}`,
);
const workspaceReal = realpathSync(testParent);
if (
  !resolve(isolated)
    .toLowerCase()
    .startsWith(workspaceReal.toLowerCase() + sep)
)
  throw new Error("Isolated target is outside the expected workspace");
mkdirSync(isolated); // Exclusive: never empty, overwrite or move an existing directory.
for (const folder of ["src", "addon", "test", "scripts", "typings"]) {
  cpSync(join(root, folder), join(isolated, folder), {
    recursive: true,
    filter: (file) => !file.split(/[\\/]/).includes("__pycache__"),
  });
}
mkdirSync(join(isolated, "backend"));
for (const name of ["pyproject.toml", "worker.py", "mapping_adapter.py"])
  copyFileSync(join(root, "backend", name), join(isolated, "backend", name));
if (realAPI) {
  mkdirSync(join(isolated, "real-test"));
  copyFileSync(
    join(root, "test", "gui-real-translation.test.ts"),
    join(isolated, "real-test", "gui-real-translation.test.ts"),
  );
}
if (replayReal) {
  mkdirSync(join(isolated, "replay-test"));
  copyFileSync(
    join(
      root,
      "test",
      complexReplay ? "gui-complex-replay.test.ts" : "gui-replay-real.test.ts",
    ),
    join(isolated, "replay-test", "gui-replay-real.test.ts"),
  );
}
mkdirSync(join(isolated, "fixtures"));
copyFileSync(
  join(
    root,
    "fixtures",
    twoPageReal ? "gui-smoke-two-pages-en.pdf" : "gui-smoke-short-en.pdf",
  ),
  join(isolated, "fixtures", "gui-smoke-short-en.pdf"),
);
if (replayReal) {
  const hash = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const mapping = JSON.parse(readFileSync(replayMapping, "utf8"));
  const source =
    replaySource || join(root, "fixtures", "gui-smoke-short-en.pdf");
  if (
    mapping.source.sha256 !== hash(source) ||
    mapping.target.sha256 !== hash(replayPdf) ||
    mapping.provenance?.backend !== "babeldoc"
  )
    throw new Error(
      "Replay mapping does not match the synthetic source and translation",
    );
  if (replaySource && !complexReplay)
    copyFileSync(source, join(isolated, "fixtures", "gui-smoke-short-en.pdf"));
  if (!complexReplay) {
    copyFileSync(replayPdf, join(isolated, "fixtures", "real-translation.pdf"));
    copyFileSync(
      replayMapping,
      join(isolated, "fixtures", "real-translation.mapping.json"),
    );
  }
}
for (const name of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".gitignore",
])
  copyFileSync(join(root, name), join(isolated, name));
symlinkSync(
  realpathSync(join(root, "node_modules")),
  join(isolated, "node_modules"),
  "junction",
);

const config = readFileSync(join(root, "zotero-plugin.config.ts"), "utf8");
if (
  !config.includes('import pkg from "./package.json";') ||
  !config.includes("  test: {")
)
  throw new Error(
    "The Zotero scaffold config changed; inspect it before running GUI tests",
  );
const isolatedConfig = config
  .replace(
    'import pkg from "./package.json";',
    'import pkg from "./package.json";\nimport { existsSync, mkdirSync, symlinkSync, copyFileSync } from "node:fs";\nimport { join } from "node:path";',
  )
  .replace(
    "  test: {",
    `  server: { devtools: false, startArgs: ["-no-remote"] },
  test: {
    hooks: {
      "test:prebuild": () => {
        const installed = process.env.PARALENS_TEST_VENV;
        if (!installed || !existsSync(join(installed, "pyvenv.cfg")))
          throw new Error("Test venv is unavailable");
        const backend = join(process.cwd(), ".scaffold", "test", "profile", "paralens", "backend");
        mkdirSync(backend, { recursive: true });
        const destination = join(backend, ".venv");
        if (existsSync(destination)) throw new Error("Refusing to replace an existing test venv");
        symlinkSync(installed, destination, "junction");
        if (process.env.PARALENS_REAL_API === "1") {
          const source = process.env.PARALENS_REAL_API_SOURCE_PROFILE;
          if (!source) throw new Error("Missing source profile");
          for (const name of ["key4.db", "logins.json"])
            copyFileSync(join(source, name), join(process.cwd(), ".scaffold", "test", "profile", name));
        }
      },
    },
    entries: ${JSON.stringify(realAPI ? "real-test" : replayReal ? "replay-test" : "test")},
    mocha: { timeout: ${realComplex ? 3600000 : realAPI ? 360000 : 180000} },`,
  );
writeFileSync(join(isolated, "zotero-plugin.config.ts"), isolatedConfig);
console.log(`Isolated GUI test: ${isolated}`);
if (prepareOnly) process.exit(0);

function startMockServer() {
  return new Promise((fulfill, reject) => {
    const server = spawn(process.execPath, ["scripts/mock-api-server.mjs"], {
      cwd: isolated,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Local mock server did not start")),
      10000,
    );
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/PORT=(\d+)/);
      if (match) {
        clearTimeout(timeout);
        fulfill({ server, port: match[1] });
      }
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Mock API exited early (${code})`));
    });
  });
}

const mockUV =
  realAPI || replayReal ? undefined : await prepareMockUV(isolated);
function removeCopiedCredentials() {
  // Remove only the credential copies in this verified disposable profile.
  const profile = join(isolated, ".scaffold", "test", "profile");
  if (
    !resolve(profile)
      .toLowerCase()
      .startsWith(realpathSync(isolated).toLowerCase() + sep)
  )
    throw new Error("Refusing to clean outside the workspace");
  for (const name of [
    "logins.json",
    "logins-backup.json",
    "key4.db",
    "key4.db-shm",
    "key4.db-wal",
  ]) {
    const file = join(profile, name);
    if (existsSync(file)) unlinkSync(file);
  }
}

const mock = realAPI || replayReal ? undefined : await startMockServer();
try {
  const child = spawn(
    process.execPath,
    [
      join(
        isolated,
        "node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs",
      ),
      "test",
      "--exit-on-finish",
    ],
    {
      cwd: isolated,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        PARALENS_REAL_API: realAPI ? "1" : "0",
        PARALENS_REAL_API_TWO_PAGES: twoPageReal ? "1" : "0",
        PARALENS_REAL_API_COMPLEX: realComplex ? "1" : "0",
        PARALENS_TEST_RETAIN_FAILED_IL: realComplex ? "1" : "0",
        PARALENS_REPLAY_REAL: replayReal ? "1" : "0",
        PARALENS_REPLAY_COMPLEX: complexReplay ? "1" : "0",
        PARALENS_REPLAY_TWO_COLUMNS:
          replayReal && process.argv.includes("--two-columns") ? "1" : "0",
        PARALENS_REPLAY_PDF_PATH: replayReal
          ? complexReplay
            ? replayPdf
            : join(isolated, "fixtures", "real-translation.pdf")
          : "",
        PARALENS_REPLAY_MAPPING_PATH: replayReal
          ? complexReplay
            ? replayMapping
            : join(isolated, "fixtures", "real-translation.mapping.json")
          : "",
        PARALENS_REAL_API_SOURCE_PROFILE: realAPI ? credentialProfile : "",
        PARALENS_TEST_VENV: realpathSync(venv),
        PARALENS_TEST_INSTALL_UV: mockUV?.executable || "",
        PARALENS_TEST_INSTALL_ARGS: mockUV?.record || "",
        PARALENS_TEST_SOURCE_PDF: realComplex
          ? complexSource
          : complexReplay
            ? replaySource
            : join(isolated, "fixtures", "gui-smoke-short-en.pdf"),
        ...(realAPI
          ? {
              PARALENS_REAL_API: "1",
              PARALENS_REAL_API_SOURCE_PROFILE: credentialProfile,
              PARALENS_REAL_API_SETTINGS: JSON.stringify(
                (() => {
                  const prefs = readFileSync(
                    join(credentialProfile, "prefs.js"),
                    "utf8",
                  );
                  return Object.fromEntries(
                    ["provider", "model", "customBaseURL"].map((key) => {
                      const line = prefs
                        .split(/\r?\n/)
                        .find((value) =>
                          value.startsWith(
                            `user_pref("extensions.zotero.paralens.${key}", `,
                          ),
                        );
                      if (!line) throw new Error(`No saved preference: ${key}`);
                      return [
                        key,
                        JSON.parse(line.slice(line.indexOf(", ") + 2, -2)),
                      ];
                    }),
                  );
                })(),
              ),
            }
          : { PARALENS_MOCK_API_PORT: mock?.port || "" }),
        ZOTERO_PLUGIN_ZOTERO_BIN_PATH: zotero,
        ZOTERO_PLUGIN_KILL_COMMAND: 'powershell -NoProfile -Command "exit 0"',
      },
    },
  );
  const exitCode = await new Promise((fulfill, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => fulfill(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  mock?.server.kill(); // Only this script's localhost server, never Zotero by process name.
  if (realAPI) removeCopiedCredentials();
  console.log(
    `Disposable profile retained for inspection: ${join(isolated, ".scaffold", "test", "profile")}`,
  );
}
