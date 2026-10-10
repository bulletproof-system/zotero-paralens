const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { build } = require("esbuild");

const outfile = path.resolve(".scaffold/backend-reinstall-ui-tests.cjs");
const loaded = build({
  entryPoints: ["src/modules/preferenceScript.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  plugins: [
    {
      name: "offline-preference-actions",
      setup(build) {
        const mocked = {
          "backend/process": `export async function executeHidden(binary, args) {
        const state = globalThis.__reinstallUI;
        if (args[0] !== "sync") return state.probeSuccess;
        state.sync.push({binary, args});
        if (state.syncGate) await state.syncGate;
        if (state.syncFailure) throw Error("后端进程执行失败");
        return true;
      }`,
          "backend/credentials": `export async function hasAPIKey() { return true; }
        export async function saveAPIKey() { throw Error("Must not change credentials"); }
        export async function deleteAPIKey() { throw Error("Must not remove credentials"); }`,
          "backend/uvRuntime": `export async function inspectUV() { return { available: true, path: "/mock/uv" }; }`,
          "backend/install": `export function bundledBackendProjectDir() { return "/profile/backend"; }
        export async function installBundledBackend() { globalThis.__reinstallUI.deploys++; return "/profile/backend"; }`,
          "utils/prefs": `export function getPref() { return undefined; } export function setPref() {}`,
          "utils/license": `export function registerLicenseUI() {}`,
          "reader/translationWorkflow": `export function translationQueue() { return { snapshot: () => globalThis.__reinstallUI.tasks }; }`,
        };
        build.onResolve({ filter: /.*/ }, (args) => {
          const key = Object.keys(mocked).find((key) =>
            args.path.endsWith(key),
          );
          if (key) return { path: key, namespace: "mock" };
        });
        build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: mocked[args.path],
          loader: "js",
        }));
      },
    },
  ],
}).then(() => require(outfile));
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function wait(condition) {
  for (let i = 0; i < 50; i++) {
    if (condition()) return;
    await tick();
  }
  assert.fail("Preferences action did not finish");
}
async function fixture() {
  const { registerPrefsScripts } = await loaded;
  const state = (globalThis.__reinstallUI = {
    sync: [],
    deploys: 0,
    tasks: [],
    probeSuccess: true,
    confirms: [],
    allow: true,
  });
  global.addon = {
    data: {
      backendProjectDir: "/profile/backend",
      uv: { available: true, path: "/mock/uv" },
    },
  };
  global.rootURI = "file:///mock-addon/";
  global.Services = { appinfo: { OS: "WINNT" } };
  global.PathUtils = { join: path.join };
  global.IOUtils = { exists: async () => true };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        dataset: {},
        value: "",
        checked: false,
        disabled: false,
        hidden: false,
        textContent: "",
        events: {},
        appendChild() {},
        addEventListener(name, callback) {
          this.events[name] = callback;
        },
        click() {
          if (!this.disabled) this.events.click?.();
        },
      });
    return elements.get(id);
  };
  await registerPrefsScripts({
    navigator: { language: "zh-CN" },
    document: { getElementById: element, createElementNS: () => ({}) },
    confirm(message) {
      state.confirms.push(message);
      return state.allow;
    },
  });
  const install = element("paralens-backend-install"),
    reinstall = element("paralens-backend-reinstall"),
    status = element("paralens-backend-status");
  await wait(() => !reinstall.disabled);
  return { state, install, reinstall, status };
}

test("reinstall requires confirmation and remains available for installed backends", async () => {
  const { state, install, reinstall } = await fixture();
  assert.equal(install.hidden, true);
  assert.equal(reinstall.hidden, false);
  assert.equal(
    state.sync.length,
    0,
    "Opening preferences must not install packages",
  );
  state.allow = false;
  reinstall.click();
  await tick();
  assert.match(state.confirms[0], /重新安装.*依赖/);
  assert.equal(state.deploys, 0);
  assert.equal(state.sync.length, 0);
});

test("reinstall forces dependency installation, blocks duplicates and permits retry after failure", async () => {
  const { state, install, reinstall, status } = await fixture();
  let release;
  state.syncGate = new Promise((resolve) => {
    release = resolve;
  });
  reinstall.click();
  await wait(() => state.sync.length === 1);
  assert.equal(reinstall.disabled, true);
  assert.equal(install.disabled, true);
  assert.equal(global.addon.data.backendInstalling, true);
  reinstall.click();
  assert.equal(state.deploys, 1);
  assert.deepEqual(state.sync[0].args, [
    "sync",
    "--project",
    "/profile/backend",
    "--python",
    "3.12",
    "--reinstall",
  ]);
  state.syncFailure = true;
  release();
  await wait(() => !reinstall.disabled);
  assert.match(status.textContent, /执行失败/);
  assert.equal(global.addon.data.backendInstalling, false);
  state.syncFailure = false;
  state.syncGate = undefined;
  reinstall.click();
  await wait(() => state.sync.length === 2 && !reinstall.disabled);
  assert.match(status.textContent, /重新安装完成/);
  assert.equal(state.deploys, 2);
});

test("queued/running translations and another preferences installation block backend changes", async () => {
  const { state, reinstall, status } = await fixture();
  for (const taskState of ["queued", "running"]) {
    state.tasks = [{ state: taskState }];
    reinstall.click();
    await tick();
    assert.match(status.textContent, /取消.*任务/);
  }
  state.tasks = [];
  global.addon.data.backendInstalling = true;
  reinstall.click();
  await tick();
  assert.equal(state.confirms.length, 0);
  assert.equal(state.deploys, 0);
  assert.equal(state.sync.length, 0);
  global.addon.data.backendInstalling = false;
});

test("a successful uv exit is not accepted when worker imports still fail", async () => {
  const { state, reinstall, status } = await fixture();
  state.probeSuccess = false;
  reinstall.click();
  await wait(() => state.sync.length === 1 && !reinstall.disabled);
  assert.match(status.textContent, /安装失败/);
  assert.equal(global.addon.data.backendInstalling, false);
  assert.equal(
    reinstall.hidden,
    false,
    "Failed health checks retain the repair option",
  );
});
