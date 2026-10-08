const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { build } = require("esbuild");

const output = path.resolve(".scaffold/cancel-menu-test.cjs");
async function buildMenu() {
  await build({
    entryPoints: ["src/reader/menu.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "fake-workflow",
        setup(build) {
          build.onResolve({ filter: /translationWorkflow$/ }, () => ({
            path: "workflow",
            namespace: "fake",
          }));
          build.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
            contents: [
              "export const isTranslationCancellable = () => globalThis.__running;",
              "export const cancelActiveTranslation = async () => { globalThis.__cancelCalls++; return true; };",
              "export const translateSelection = async () => { globalThis.__translateCalls++; };",
              "export const openSavedBilingual = async () => {};",
              "export const openTranslationQueue = async () => {};",
            ].join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  return require(output);
}

test("cancel action is visible only while a worker is cancellable", async () => {
  const { registerTranslationMenu, unregisterTranslationMenu } =
    await buildMenu();
  const actions = new Map();
  const entries = new Map();
  const popup = {
    appendChild(node) {
      entries.set(node.id, node);
    },
    addEventListener(event, callback) {
      actions.set(event, callback);
    },
    removeEventListener(event) {
      actions.delete(event);
    },
  };
  const win = {
    navigator: { language: "zh-CN" },
    document: {
      getElementById: (id) => (id === "zotero-itemmenu" ? popup : null),
      createXULElement: () => ({
        hidden: false,
        setAttribute(name, value) {
          this[name] = value;
        },
        addEventListener(name, callback) {
          this[name] = callback;
        },
        remove() {
          entries.delete(this.id);
        },
      }),
    },
    addEventListener() {},
    removeEventListener() {},
    alert(message) {
      throw Error("unexpected alert: " + message);
    },
  };
  global.Zotero = {
    getActiveZoteroPane: () => ({
      getSelectedItems: () => [{ isPDFAttachment: () => true }],
    }),
  };
  globalThis.__running = false;
  globalThis.__cancelCalls = 0;
  globalThis.__translateCalls = 0;
  try {
    registerTranslationMenu(win);
    assert.equal(entries.size, 4);
    actions.get("popupshowing")();
    const cancel = entries.get("paralens-cancel-translation");
    assert.equal(cancel.hidden, true);
    assert.equal(entries.get("paralens-translate-pdf").hidden, false);
    globalThis.__running = true;
    actions.get("popupshowing")();
    assert.equal(cancel.hidden, false);
    cancel.command();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(globalThis.__cancelCalls, 1);
    assert.equal(globalThis.__translateCalls, 0);
    globalThis.__running = false;
    actions.get("popupshowing")();
    assert.equal(cancel.hidden, true);
  } finally {
    unregisterTranslationMenu(win);
    assert.equal(entries.size, 0);
    assert.equal(actions.size, 0);
  }
});
