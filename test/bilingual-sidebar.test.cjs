const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { transformSync } = require("esbuild");
const { code } = transformSync(
  readFileSync("src/reader/bilingualSidebar.ts", "utf8"),
  { loader: "ts", format: "cjs" },
);

function fixture() {
  const listeners = new Set(),
    calls = [];
  const doc = {
    defaultView: { navigator: { language: "zh-CN" } },
    querySelector: () => null,
  };
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.ownerDocument = doc;
      this.style = {};
      this.children = [];
      this.events = {};
      this.attributes = {};
      this.textContent = "";
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    addEventListener(name, callback) {
      this.events[name] = callback;
    }
    append(...children) {
      this.children.push(...children);
    }
    appendChild(child) {
      this.append(child);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    remove() {
      this.removed = true;
    }
    find(className) {
      if (this.className === className) return this;
      for (const child of this.children) {
        const found = typeof child === "object" && child.find(className);
        if (found) return found;
      }
    }
  }
  doc.createElementNS = (_namespace, tag) => new Element(tag);
  doc.head = new Element("head");
  const body = new Element("div");
  const source = {
    id: 1,
    key: "SOURCE01",
    libraryID: 1,
    isPDFAttachment: () => true,
  };
  const target = { ...source, id: 2, key: "TARGET01" };
  const notify = () => listeners.forEach((listener) => listener());
  const pair = {
    state: { attached: true, syncScroll: false, locked: true },
    setSyncScroll(enabled) {
      this.state.syncScroll = enabled;
      notify();
    },
    unlock() {
      this.state.locked = false;
      notify();
    },
    tile() {
      calls.push("tile");
      return true;
    },
    detach() {
      this.state.attached = false;
      notify();
    },
  };
  let options, opened;
  const Zotero = {
    Reader: { _readers: [{ _item: target, _window: doc.defaultView }] },
    ItemPaneManager: {
      registerSection(value) {
        options = value;
        calls.push("register");
        return "registered-pane";
      },
      unregisterSection(value) {
        calls.push(value);
      },
    },
  };
  const modules = {
    "../utils/log": { log() {} },
    "./translationWorkflow": {
      bilingualPair: () => (pair.state.attached ? pair : undefined),
      subscribeBilingual(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      openSavedBilingual: async (items) => {
        opened = items;
      },
      openTranslationQueue: async () => {
        calls.push("queue");
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports,
    module,
    require: (name) => modules[name],
    Zotero,
    addon: { data: { config: { addonID: "test", addonRef: "paralens" } } },
    Error,
  });
  const args = {
    body,
    doc,
    item: source,
    tabType: "reader",
    setEnabled: (enabled) => calls.push(enabled),
  };
  return {
    api: module.exports,
    args,
    doc,
    body,
    source,
    target,
    pair,
    Zotero,
    modules,
    calls,
    listeners,
    options: () => options,
    opened: () => opened,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("sidebar controls the current translated PDF and cleans up registration and subscriptions", async () => {
  const current = fixture();
  current.api.registerBilingualSidebar();
  current.api.registerBilingualSidebar();
  assert.equal(current.calls.filter((call) => call === "register").length, 1);
  const options = current.options();
  assert.equal(options.header.l10nID, "paralens-bilingual-header");
  options.onInit(current.args);
  assert.equal(
    current.doc.head.children[0].attributes.href,
    "paralens-mainWindow.ftl",
  );
  options.onItemChange({ ...current.args, tabType: "library" });
  assert.equal(current.calls.at(-1), false);
  options.onRender(current.args);
  const find = (name) => current.body.find("paralens-sidebar-" + name);
  assert.equal(find("open").disabled, true);
  assert.equal(find("sync").disabled, false);
  find("sync").checked = true;
  find("sync").events.change();
  assert.equal(current.pair.state.syncScroll, true);
  find("unlock").events.click();
  await settle();
  assert.equal(current.pair.state.locked, false);
  assert.equal(find("unlock").disabled, true);
  find("tile").events.click();
  await settle();
  assert(current.calls.includes("tile"));
  find("stop").events.click();
  await settle();
  assert.equal(find("open").disabled, false);
  assert.equal(find("sync").disabled, true);
  find("open").events.click();
  await settle();
  assert.equal(current.opened()[0], current.target);
  find("queue").events.click();
  await settle();
  assert(current.calls.includes("queue"));
  options.onDestroy(current.args);
  assert.equal(current.listeners.size, 0);
  current.api.unregisterBilingualSidebar();
  assert(current.calls.includes("registered-pane"));
  assert.equal(current.doc.head.children[0].removed, true);
});

test("sidebar selects active tabs, rejects non-PDFs and renders failures as text", async () => {
  const current = fixture();
  current.doc.defaultView.Zotero_Tabs = { selectedID: "active-tab" };
  current.Zotero.Reader._readers.push({
    tabID: "active-tab",
    _item: current.source,
  });
  assert.equal(
    current.api.sidebarAttachment(current.doc, current.target),
    current.source,
  );
  current.pair.state.attached = false;
  current.modules["./translationWorkflow"].openSavedBilingual = async () => {
    throw new Error("<script>not HTML</script>");
  };
  current.api.registerBilingualSidebar();
  current.options().onRender(current.args);
  const button = current.body.find("paralens-sidebar-open");
  button.events.click();
  await settle();
  const container = current.body.children[0];
  assert.equal(
    container.children.at(-1).textContent,
    "<script>not HTML</script>",
  );
  current.Zotero.Reader._readers = [];
  current.options().onRender({
    ...current.args,
    item: { id: 3, isPDFAttachment: () => false },
  });
  assert.equal(button.disabled, true);
  assert.equal(container.children.at(-1).textContent, "");
  current.api.unregisterBilingualSidebar();
  assert.equal(current.listeners.size, 0);
});
