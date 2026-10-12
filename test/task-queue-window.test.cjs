const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const outfile = path.resolve(".scaffold/task-queue-window-tests.cjs");
buildSync({
  entryPoints: ["src/reader/taskQueueUI.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { showTaskQueue } = require(outfile);
function fixture(ready = false, readyState = "complete") {
  const events = new Map();
  const state = { subscribed: 0, unsubscribed: 0, appends: 0, ready };
  const list = {
    appendChild(node) {
      state.appends++;
      node.parentNode = this;
    },
  };
  const status = {};
  const win = {
    closed: false,
    document: {
      readyState,
      getElementById(id) {
        return state.ready ? { tasks: list, status }[id] : null;
      },
      createElementNS() {
        return { parentNode: null };
      },
    },
    addEventListener(type, handler) {
      if (!events.has(type)) events.set(type, new Set());
      events.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      events.get(type)?.delete(handler);
    },
  };
  const fire = (type) => {
    for (const handler of [...(events.get(type) || [])]) handler();
  };
  const queue = {
    initialize: async () => {},
    snapshot: () => [],
    subscribe: () => {
      state.subscribed++;
      return () => state.unsubscribed++;
    },
  };
  const parent = { openDialog: () => win };
  return { state, win, queue, parent, fire, events };
}
test("a complete blank dialog waits for the target document, even after an intermediate load", async () => {
  const { state, parent, queue, fire, events } = fixture();
  await showTaskQueue(
    parent,
    queue,
    async () => false,
    async () => {},
  );
  assert.equal(state.subscribed, 0);
  fire("load");
  assert.equal(state.subscribed, 0);
  assert.equal(events.get("load").size, 1);
  state.ready = true;
  fire("load");
  assert.equal(state.subscribed, 1);
  assert.equal(state.appends, 1);
  assert.equal(events.get("load").size, 0);
  fire("load");
  assert.equal(state.subscribed, 1);
  fire("unload");
  assert.equal(state.unsubscribed, 1);
});
test("an already loaded target initializes immediately and once", async () => {
  const { state, parent, queue, fire } = fixture(true);
  await showTaskQueue(
    parent,
    queue,
    async () => false,
    async () => {},
  );
  assert.equal(state.subscribed, 1);
  fire("load");
  assert.equal(state.subscribed, 1);
  fire("unload");
});
test("a loading target waits until its document is complete", async () => {
  const { state, win, parent, queue, fire } = fixture(true, "loading");
  await showTaskQueue(
    parent,
    queue,
    async () => false,
    async () => {},
  );
  assert.equal(state.subscribed, 0);
  win.document.readyState = "complete";
  fire("load");
  assert.equal(state.subscribed, 1);
  fire("unload");
});
