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
          "backend/process": `export async function executeHidden() { return globalThis.__reinstallUI.probeSuccess; }`,
          "backend/installProcess": `export async function executeBackendInstall(binary, args, onLine) {
        const state = globalThis.__reinstallUI;
        state.sync.push({binary, args});
        onLine("Resolved 42 packages in 1s");
        onLine("Downloading babeldoc (1MiB)");
        if (state.outputGate) await state.outputGate;
        onLine("Prepared 42 packages in 2s");
        if (state.syncGate) await state.syncGate;
        if (state.syncFailure) throw Error("后端进程执行失败");
        return true;
      }
      export async function executeBackendProbe(binary, args) {
        const state = globalThis.__reinstallUI;
        if (state.probeGate) await state.probeGate;
        return state.probeSuccess && (state.importSuccess !== false || !args[1].includes("high_level"));
      }`,
          "backend/credentials": `export async function hasAPIKey() { return true; }
        export async function saveAPIKey() { throw Error("Must not change credentials"); }
        export async function deleteAPIKey() { throw Error("Must not remove credentials"); }`,
          "backend/uvRuntime": `export async function inspectUV() { return { available: true, path: "/mock/uv" }; }`,
          "backend/install": `export function bundledBackendProjectDir() { return "/profile/backend"; }
        export async function installBundledBackend() { globalThis.__reinstallUI.deploys++; return "/profile/backend"; }`,
          "utils/prefs": `export function getPref(key) { return globalThis.__reinstallUI.prefs[key]; } export function setPref(key, value) { globalThis.__reinstallUI.prefs[key] = value; }`,
          "utils/log": `export function log(message) { globalThis.__reinstallUI.logs.push(message); } export function pluginLogDirectory() { return "/profile/paralens/logs"; }`,
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
const windows = [];
async function fixture(existing) {
  if (!existing) {
    for (const window of windows.splice(0)) {
      window.closed = true;
      window.events.unload?.();
    }
  }
  const { registerPrefsScripts } = await loaded;
  const state = (globalThis.__reinstallUI = existing || {
    sync: [],
    prefs: {},
    logs: [],
    deploys: 0,
    tasks: [],
    probeSuccess: true,
    importSuccess: true,
    confirms: [],
    allow: true,
  });
  if (!existing)
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
        focus() {
          document.activeElement = this;
        },
        click() {
          if (!this.disabled) {
            this.focus();
            this.events.click?.();
          }
        },
      });
    return elements.get(id);
  };
  const document = {
    getElementById: element,
    createElementNS: () => ({}),
    activeElement: null,
  };
  const window = {
    closed: false,
    events: {},
    addEventListener(type, callback) {
      this.events[type] = callback;
    },
    navigator: { language: "zh-CN" },
    document,
    confirm(message) {
      state.confirms.push(message);
      return state.allow;
    },
  };
  windows.push(window);
  await registerPrefsScripts(window);
  const install = element("paralens-backend-install"),
    reinstall = element("paralens-backend-reinstall"),
    status = element("paralens-backend-status");
  if (!global.addon.data.backendInstalling)
    await wait(() => !reinstall.disabled);
  return {
    state,
    install,
    reinstall,
    status,
    progress: element("paralens-backend-progress"),
    element,
    document,
    window,
  };
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

test("installation percentage follows output, stops below 100 on failure and resets on retry", async () => {
  const { state, reinstall, status, progress } = await fixture();
  let release;
  state.outputGate = new Promise((resolve) => {
    release = resolve;
  });
  reinstall.click();
  await wait(() => state.sync.length === 1);
  assert.equal(progress.hidden, false);
  assert.equal(progress.value, 40);
  assert.match(status.textContent, /40%.*估算.*下载/);
  state.syncFailure = true;
  release();
  await wait(() => !reinstall.disabled);
  assert.equal(progress.value, 85);
  assert.match(status.textContent, /85%.*失败/);
  state.syncFailure = false;
  state.outputGate = undefined;
  reinstall.click();
  assert.equal(progress.value, 0);
  await wait(() => state.sync.length === 2 && !reinstall.disabled);
  assert.equal(progress.value, 100);
  assert.match(status.textContent, /100%/);
});

test("log toggle applies immediately and displays the plugin log folder", async () => {
  const { state, element } = await fixture();
  const toggle = element("paralens-save-logs");
  assert.equal(toggle.checked, false);
  assert.match(
    element("paralens-log-path").textContent,
    /\/profile\/paralens\/logs/,
  );
  toggle.checked = true;
  toggle.events.change();
  assert.equal(state.prefs.saveLogs, true);
  assert.match(state.logs.at(-1), /已开启/);
  toggle.checked = false;
  toggle.events.change();
  assert.equal(state.prefs.saveLogs, false);
});

test("installed packages with broken imports get a runtime failure message and a check action", async () => {
  const { state, element, status, install } = await fixture();
  state.importSuccess = false;
  element("paralens-backend-check").click();
  await wait(() => !element("paralens-backend-check").disabled);
  assert.match(status.textContent, /已安装.*依赖模块加载失败/);
  assert.doesNotMatch(status.textContent, /未安装/);
  assert.equal(install.hidden, true);
});

test("settings opened during installation recover their controls when another pane finishes", async () => {
  const first = await fixture();
  let release;
  first.state.syncGate = new Promise((resolve) => {
    release = resolve;
  });
  first.reinstall.click();
  await wait(() => first.state.sync.length === 1);
  const second = await fixture(first.state);
  assert.equal(second.element("paralens-backend").disabled, true);
  assert.equal(second.reinstall.disabled, true);
  release();
  await wait(() => !first.reinstall.disabled && !second.reinstall.disabled);
  assert.equal(second.element("paralens-backend").disabled, false);
  assert.match(second.status.textContent, /已安装/);
  assert.equal(second.install.hidden, true);
});

test("hiding a focused install button moves focus to an enabled selector", async () => {
  const fixtureUI = await fixture();
  fixtureUI.state.probeSuccess = false;
  fixtureUI.element("paralens-backend-check").click();
  await wait(() => !fixtureUI.element("paralens-backend-check").disabled);
  assert.equal(fixtureUI.install.hidden, false);
  fixtureUI.state.probeSuccess = true;
  fixtureUI.install.click();
  await wait(
    () => fixtureUI.state.sync.length === 1 && !fixtureUI.install.disabled,
  );
  assert.equal(fixtureUI.install.hidden, true);
  assert.equal(
    fixtureUI.document.activeElement,
    fixtureUI.element("paralens-backend"),
  );
  for (const id of [
    "paralens-backend",
    "paralens-provider",
    "paralens-source-language",
    "paralens-target-language",
  ])
    assert.equal(fixtureUI.element(id).disabled, false);
});
