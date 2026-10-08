/* global structuredClone, Zotero */
global.Zotero = { Prefs: { get: () => false, set: () => {} } };
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");

const outdir = path.resolve(".scaffold", "mapping-tests");
buildSync({
  entryPoints: [
    "src/mapping/validation.ts",
    "src/reader/geometry.ts",
    "src/reader/nativeOverlay.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir,
  outExtension: { ".js": ".cjs" },
});
const { validateMapping, bindAttachmentKeys, findHit } = require(
  path.join(outdir, "mapping", "validation.cjs"),
);
const { viewportToNormalized, normalizedToViewport } = require(
  path.join(outdir, "reader", "geometry.cjs"),
);

const { NativeReaderPair, supportsNativePdfOverlay } = require(
  path.join(outdir, "reader", "nativeOverlay.cjs"),
);

function sample() {
  return {
    schemaVersion: 1,
    source: { sha256: "a".repeat(64), attachmentKey: "S", pageCount: 2 },
    target: { sha256: "b".repeat(64), attachmentKey: "T", pageCount: 3 },
    provenance: {
      backend: "babeldoc",
      backendVersion: "0.5.20",
      adapterVersion: "1",
      createdAt: "2026-09-29T00:00:00Z",
    },
    segments: [
      {
        id: "p-000001",
        level: "paragraph",
        status: "aligned",
        confidence: 0.9,
        source: [
          { pageIndex: 0, quads: [[0.1, 0.2, 0.4, 0.2, 0.4, 0.3, 0.1, 0.3]] },
        ],
        target: [
          { pageIndex: 2, quads: [[0.5, 0.6, 0.9, 0.6, 0.9, 0.7, 0.5, 0.7]] },
        ],
      },
    ],
  };
}

test("backend-neutral mapping supports bidirectional hit on different pages", () => {
  const map = validateMapping(sample());
  assert.equal(findHit(map, "source", 0, 0.25, 0.25)?.segment.id, "p-000001");
  assert.equal(findHit(map, "target", 2, 0.65, 0.65)?.segment.id, "p-000001");
  assert.equal(findHit(map, "target", 0, 0.65, 0.65), undefined);
});

test("reject invalid geometry and duplicate IDs; never hit skipped", () => {
  const invalid = sample();
  invalid.segments[0].target[0].quads[0][0] = 1.2;
  assert.throws(() => validateMapping(invalid), /quads/);
  const duplicate = sample();
  duplicate.segments.push(structuredClone(duplicate.segments[0]));
  assert.throws(() => validateMapping(duplicate), /duplicate segment id/);
  const empty = sample();
  empty.segments[0].target[0].quads = [];
  assert.throws(() => validateMapping(empty), /requires quads on both sides/);
  const skipped = sample();
  skipped.segments[0].status = "skipped";
  assert.equal(
    findHit(validateMapping(skipped), "source", 0, 0.2, 0.25),
    undefined,
  );
});

test("viewport transform accounts for offset CropBox and rotation", () => {
  const box = [10, 20, 110, 220];
  const viewport = {
    viewBox: box,
    width: 400,
    height: 200,
    convertToViewportPoint(x, y) {
      return [(y - 20) * 2, (x - 10) * 2];
    },
    convertToPdfPoint(x, y) {
      return [y / 2 + 10, x / 2 + 20];
    },
  };
  assert.deepEqual(normalizedToViewport(viewport, 0.25, 0.75), [100, 50]);
  assert.deepEqual(viewportToNormalized(viewport, 100, 50), [0.25, 0.75]);
});

test("unsupported Reader and mismatched attachments fail closed", () => {
  assert.equal(supportsNativePdfOverlay({ type: "pdf" }), false);
  const pair = new NativeReaderPair(
    { type: "pdf", _item: { key: "WRONG" } },
    { type: "pdf", _item: { key: "T" } },
    validateMapping(sample()),
  );
  assert.equal(pair.attach(), false);
});

test("backend draft is bound only after target attachment is imported", () => {
  const draft = sample();
  delete draft.source.attachmentKey;
  delete draft.target.attachmentKey;
  const mapping = bindAttachmentKeys(draft, "S", "T");
  assert.equal(mapping.target.attachmentKey, "T");
  assert.equal(mapping.provenance.backend, "babeldoc");
  assert.throws(
    () => bindAttachmentKeys(draft, "S", ""),
    /target.attachmentKey/,
  );
});

function fakeReader(key, pageIndex) {
  const listeners = new Map();
  const events = new Map();
  const viewBox = [0, 0, 100, 100];
  const viewport = {
    viewBox,
    width: 100,
    height: 100,
    convertToViewportPoint: (x, y) => [x, 100 - y],
    convertToPdfPoint: (x, y) => [x, 100 - y],
  };
  const doc = {
    documentElement: {},
    createElement() {
      return {
        style: {},
        setAttribute() {},
        remove() {
          this.removed = true;
        },
      };
    },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
  };
  const page = {
    dataset: { pageNumber: String(pageIndex + 1) },
    isConnected: true,
    children: [],
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      width: 100,
      height: 100,
    }),
    appendChild(child) {
      this.children.push(child);
    },
  };
  const win = {
    document: doc,
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
    PDFViewerApplication: {
      pdfViewer: {
        currentPageNumber: 1,
        getPageView: (index) =>
          index === pageIndex ? { div: page, viewport } : undefined,
      },
      eventBus: {
        on(name, handler) {
          events.set(name, handler);
        },
        off(name, handler) {
          if (events.get(name) === handler) events.delete(name);
        },
      },
    },
  };
  const reader = {
    type: "pdf",
    _item: { key },
    _internalReader: { _primaryView: { _iframeWindow: win } },
  };
  return {
    reader,
    page,
    viewer: win.PDFViewerApplication.pdfViewer,
    listeners,
    events,
    move(x, y) {
      listeners.get("pointermove")({
        target: { closest: () => page },
        clientX: 10 + x * 100,
        clientY: 20 + y * 100,
      });
    },
    leave() {
      listeners.get("pointermove")({ target: { closest: () => null } });
    },
    redraw() {
      events.get("pagerendered")();
    },
  };
}

test("native Reader hover highlights matching paragraph both ways and cleans up", () => {
  const source = fakeReader("S", 0);
  const target = fakeReader("T", 2);
  const pair = new NativeReaderPair(
    source.reader,
    target.reader,
    validateMapping(sample()),
  );
  assert.equal(supportsNativePdfOverlay(source.reader), true);
  assert.equal(pair.attach(), true);
  source.move(0.25, 0.25);
  assert.equal(target.viewer.currentPageNumber, 3);
  assert.equal(source.viewer.currentPageNumber, 1);
  assert.equal(target.page.children.length, 1);
  // Transient PDF.js text nodes do not implement Element.closest().
  source.listeners.get("pointermove")({ target: {} });
  assert.equal(target.page.children.at(-1).removed, true);
  source.move(0.25, 0.25);
  assert.match(target.page.children[0].style.clipPath, /50% 60%/);
  assert.equal(target.page.children[0].style.pointerEvents, "none");
  const first = target.page.children[0];
  target.redraw();
  assert.equal(first.removed, true);
  assert.equal(target.page.children.length, 3);
  const sourceBeforeReverseHover = source.page.children.at(-1);
  target.move(0.65, 0.65);
  assert.equal(
    sourceBeforeReverseHover.removed,
    true,
    "an inbound highlight must not suppress the first local hover on the same segment",
  );
  assert.equal(source.page.children.length, 3);
  assert.equal(source.page.children[0].removed, true);
  assert.match(source.page.children.at(-1).style.clipPath, /10% 20%/);
  source.leave();
  assert.equal(target.page.children.at(-1).removed, true);
  target.leave();
  assert.equal(source.page.children.at(-1).removed, true);
  pair.detach();
  assert.equal(source.listeners.size, 0);
  assert.equal(target.listeners.size, 0);
  assert.equal(source.events.size, 0);
  assert.equal(target.events.size, 0);
});

test("remote hover navigates to an offscreen counterpart and redraws after rendering", () => {
  const source = fakeReader("S", 0);
  const target = fakeReader("T", 2);
  target.page.isConnected = false;
  const pair = new NativeReaderPair(
    source.reader,
    target.reader,
    validateMapping(sample()),
  );
  assert.equal(pair.attach(), true);
  source.move(0.25, 0.25);
  assert.equal(target.viewer.currentPageNumber, 3);
  assert.equal(
    target.page.children.length,
    0,
    "virtualized page has no overlay yet",
  );
  target.page.isConnected = true;
  target.redraw();
  assert.equal(target.page.children.length, 1);
  pair.detach();
});

test("real BabelDOC two-paragraph fixture maps distinct hover targets in both Readers", () => {
  const fixture = JSON.parse(
    require("node:fs").readFileSync(
      path.resolve("fixtures/two-paragraphs.mapping.v1.json"),
      "utf8",
    ),
  );
  const mapping = validateMapping(fixture);
  assert.equal(mapping.segments.length, 2);
  const source = fakeReader("S", 0);
  const target = fakeReader("T", 0);
  const pair = new NativeReaderPair(source.reader, target.reader, mapping);
  assert.equal(pair.attach(), true);
  function center(quad) {
    return [
      quad.filter((_, index) => index % 2 === 0).reduce((a, b) => a + b, 0) / 4,
      quad.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0) / 4,
    ];
  }
  try {
    for (const segment of mapping.segments) {
      const sourcePoint = center(segment.source[0].quads[0]);
      const targetPoint = center(segment.target[0].quads[0]);
      assert.equal(
        findHit(mapping, "source", 0, ...sourcePoint)?.segment.id,
        segment.id,
      );
      assert.equal(
        findHit(mapping, "target", 0, ...targetPoint)?.segment.id,
        segment.id,
      );
      source.move(...sourcePoint);
      assert.equal(target.page.children.at(-1).removed, undefined);
      target.move(...targetPoint);
      assert.equal(source.page.children.at(-1).removed, undefined);
    }
    assert.notEqual(
      source.page.children[0].style.clipPath,
      source.page.children.at(-1).style.clipPath,
    );
    const firstSource = center(mapping.segments[0].source[0].quads[0]);
    const secondTarget = center(mapping.segments[1].target[0].quads[0]);
    source.move(...firstSource);
    const firstTargetPolygon = target.page.children.at(-1).style.clipPath;
    target.move(...secondTarget);
    assert.notEqual(
      target.page.children.at(-1).style.clipPath,
      firstTargetPolygon,
    );
    source.move(...firstSource);
    assert.equal(
      target.page.children.at(-1).style.clipPath,
      firstTargetPolygon,
      "a local hover must override the other Reader's more recent highlight",
    );
    assert.equal(source.page.children[0].removed, true);
    assert.equal(target.page.children[0].removed, true);
  } finally {
    pair.detach();
  }
});

test("Gecko DOM wrappers for the same PDF page must not suppress hover", () => {
  const source = fakeReader("S", 0);
  const target = fakeReader("T", 2);
  const wrappedPage = {
    dataset: source.page.dataset,
    getBoundingClientRect: () => source.page.getBoundingClientRect(),
  };
  source.page.isSameNode = (other) => other === wrappedPage;
  const pair = new NativeReaderPair(
    source.reader,
    target.reader,
    validateMapping(sample()),
  );
  assert.equal(pair.attach(), true);
  try {
    source.listeners.get("pointermove")({
      target: { closest: () => wrappedPage },
      clientX: 35,
      clientY: 45,
    });
    assert.equal(target.page.children.length, 1);
    assert.equal(target.page.children[0].removed, undefined);
  } finally {
    pair.detach();
  }
});

test("figure regions support bidirectional hover but never intercept finer text hits", () => {
  const map = sample();
  const figure = structuredClone(map.segments[0]);
  figure.id = "figure-0000";
  figure.metadata = { kind: "figure", identity: "unique-decoded-image" };
  for (const side of ["source", "target"]) {
    figure[side][0].quads = [[0.05, 0.05, 0.95, 0.05, 0.95, 0.95, 0.05, 0.95]];
  }
  map.segments.unshift(figure);
  const valid = validateMapping(map);
  assert.equal(findHit(valid, "source", 0, 0.25, 0.25)?.segment.id, "p-000001");
  assert.equal(findHit(valid, "target", 2, 0.65, 0.65)?.segment.id, "p-000001");
  assert.equal(
    findHit(valid, "source", 0, 0.8, 0.8)?.segment.id,
    "figure-0000",
  );
  assert.equal(
    findHit(valid, "target", 2, 0.2, 0.2)?.segment.id,
    "figure-0000",
  );
});

test("nested images prefer the smallest actual region and keep the containing figure hittable", () => {
  const map = sample();
  const outer = structuredClone(map.segments[0]);
  outer.id = "figure-outer";
  outer.metadata = { kind: "figure" };
  const inner = structuredClone(outer);
  inner.id = "figure-inner";
  for (const side of ["source", "target"]) {
    outer[side][0].quads = [[0.05, 0.05, 0.95, 0.05, 0.95, 0.95, 0.05, 0.95]];
    inner[side][0].quads = [[0.5, 0.4, 0.6, 0.4, 0.6, 0.5, 0.5, 0.5]];
  }
  map.segments.push(outer, inner);
  for (const order of [map.segments, [...map.segments].reverse()]) {
    const valid = validateMapping({ ...map, segments: order });
    for (const [side, page] of [
      ["source", 0],
      ["target", 2],
    ]) {
      assert.equal(
        findHit(valid, side, page, 0.55, 0.45)?.segment.id,
        "figure-inner",
      );
      assert.equal(
        findHit(valid, side, page, 0.8, 0.8)?.segment.id,
        "figure-outer",
      );
    }
  }
});
