const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const { transformSync } = require("esbuild");

const source = readFileSync(path.join(__dirname, "uv-startup.test.ts"), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });

function loadInstallTest(environment = {}, backendInstalled = false) {
  const cases = new Map();
  let backendProbes = 0;
  const modules = {
    "../src/backend/process": {},
    "../src/backend/uvRuntime": {},
    "../src/backend/installationStatus": {
      isBackendInstalled: async () => {
        backendProbes++;
        return backendInstalled;
      },
    },
    chai: {
      assert: {
        isString: (value) => assert.equal(typeof value, "string"),
        isTrue: (value, message) => assert.equal(value, true, message),
      },
    },
    "../src/utils/prefs": {},
    "../package.json": { config: { addonInstance: "ParaLens" } },
  };
  runInNewContext(code, {
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), "Unexpected import: " + name);
      return modules[name];
    },
    describe: (_name, register) => register(),
    it: (name, run) => cases.set(name, run),
    Services: {
      env: { get: (name) => environment[name] || "" },
      appinfo: { OS: "Linux" },
    },
    Zotero: { ParaLens: { data: { backendProjectDir: "/isolated/backend" } } },
  });
  const run = cases.get(
    "installs a missing backend only after clicking Install",
  );
  assert.equal(typeof run, "function");
  return { run, backendProbes: () => backendProbes };
}

for (const environment of [
  {},
  { PARALENS_TEST_INSTALL_UV: "/isolated/mock-uv" },
  { PARALENS_TEST_INSTALL_ARGS: "/isolated/uv.args" },
]) {
  test(
    "installation test skips before backend probes without complete fixtures: " +
      JSON.stringify(environment),
    async () => {
      const fixture = loadInstallTest(environment);
      const skipped = new Error("Mocha pending test");
      await assert.rejects(
        fixture.run.call({
          skip() {
            throw skipped;
          },
        }),
        (error) => error === skipped,
      );
      assert.equal(fixture.backendProbes(), 0);
    },
  );
}

test("installation test still rejects an unprepared backend when fixtures are supplied", async () => {
  const fixture = loadInstallTest({
    PARALENS_TEST_INSTALL_UV: "/isolated/mock-uv",
    PARALENS_TEST_INSTALL_ARGS: "/isolated/uv.args",
  });
  await assert.rejects(
    fixture.run.call({
      skip: () => assert.fail("Prepared fixtures must not skip"),
    }),
    /This test must use a prepared isolated venv/,
  );
  assert.equal(fixture.backendProbes(), 1);
});
