const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const out = path.resolve(".scaffold/reader-navigation-tests");
buildSync({
  entryPoints: ["src/reader/scrollSync.ts", "src/reader/windowLayout.ts"],
  outdir: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  outExtension: { ".js": ".cjs" },
});
const { counterpartScrollPoint } = require(path.join(out, "scrollSync.cjs"));
const { tileReaderWindows } = require(path.join(out, "windowLayout.cjs"));
const map = {
  source: { pageCount: 2 },
  target: { pageCount: 4 },
  segments: [
    {
      status: "aligned",
      source: [
        { pageIndex: 0, quads: [[0.1, 0.2, 0.8, 0.2, 0.8, 0.4, 0.1, 0.4]] },
      ],
      target: [
        { pageIndex: 2, quads: [[0.2, 0.4, 0.9, 0.4, 0.9, 0.8, 0.2, 0.8]] },
      ],
    },
  ],
};

test("scroll uses aligned anchors both ways and page-ratio fallback for unmapped pages", () => {
  let point = counterpartScrollPoint(map, "source", {
    pageIndex: 0,
    x: 0.1,
    y: 0.3,
  });
  assert.equal(point.pageIndex, 2);
  assert(Math.abs(point.y - 0.6) < 1e-9);
  point = counterpartScrollPoint(map, "target", {
    pageIndex: 2,
    x: 0.2,
    y: 0.6,
  });
  assert.equal(point.pageIndex, 0);
  assert(Math.abs(point.y - 0.3) < 1e-9);
  point = counterpartScrollPoint(map, "source", {
    pageIndex: 1,
    x: 0.2,
    y: 0.4,
  });
  assert.equal(point.pageIndex, 2);
  assert(Math.abs(point.y - 0.8) < 1e-9);
});

test("two native windows tile left/right on the same display including negative monitor coordinates", () => {
  const calls = [];
  const win = (name) => ({
    screen: {
      availLeft: -1920,
      availTop: 40,
      availWidth: 1920,
      availHeight: 1040,
    },
    restore() {
      calls.push([name, "restore"]);
    },
    resizeTo(w, h) {
      calls.push([name, "resize", w, h]);
    },
    moveTo(x, y) {
      calls.push([name, "move", x, y]);
    },
  });
  const left = win("left"),
    right = win("right");
  assert.equal(tileReaderWindows({ _window: left }, { _window: right }), true);
  assert(
    calls.some(
      (call) =>
        JSON.stringify(call) === JSON.stringify(["left", "move", -1920, 40]),
    ),
  );
  assert(
    calls.some(
      (call) =>
        JSON.stringify(call) === JSON.stringify(["right", "move", -960, 40]),
    ),
  );
  assert.equal(tileReaderWindows({ _window: left }, { _window: left }), false);
});
