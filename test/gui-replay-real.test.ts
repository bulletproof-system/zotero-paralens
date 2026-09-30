import { assert } from "chai";
import { bindAttachmentKeys } from "../src/mapping/validation";
import { saveMapping } from "../src/mapping/store";
import { UnboundMappingV1 } from "../src/mapping/types";
import { config } from "../package.json";

type PdfWindow = Window & {
  PDFViewerApplication: {
    pdfViewer: {
      currentScale: number;
      currentPageNumber: number;
      pagesRotation: number;
      getPageView(index: number): {
        div: HTMLElement;
        viewport: {
          viewBox: number[];
          width: number;
          height: number;
          rotation: number;
          convertToViewportPoint(x: number, y: number): [number, number];
        };
        pdfPage?: {
          getTextContent(): Promise<{ items: Array<{ str: string }> }>;
        };
      };
    };
  };
};
type PdfReader = {
  _internalReader: { _primaryView: { _iframeWindow: PdfWindow } };
};

/** Replays a saved BabelDOC PDF and draft; no API or key is used. */
describe("saved BabelDOC artifact in native Zotero Readers", function () {
  it("highlights both directions and redraws on zoom and rotation", async function () {
    if (Services.env.get("PARALENS_REPLAY_REAL") !== "1") this.skip();
    this.timeout(60000);
    const sourcePath = Services.env.get("PARALENS_TEST_SOURCE_PDF");
    const targetPath = Services.env.get("PARALENS_REPLAY_PDF_PATH");
    const draftPath = Services.env.get("PARALENS_REPLAY_MAPPING_PATH");
    for (const file of [sourcePath, targetPath, draftPath])
      assert.isTrue(await IOUtils.exists(file));
    const draft = (await IOUtils.readJSON(draftPath)) as UnboundMappingV1;
    assert.equal(draft.provenance.backend, "babeldoc");
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ParaLens authorized real translation replay");
    await parent.saveTx();
    const source = await Zotero.Attachments.importFromFile({
      file: sourcePath,
      parentItemID: parent.id,
      title: "English synthetic PDF",
      contentType: "application/pdf",
    });
    const target = await Zotero.Attachments.importFromFile({
      file: targetPath,
      parentItemID: parent.id,
      title: "Real-provider Chinese translation",
      contentType: "application/pdf",
    });
    const mapping = bindAttachmentKeys(draft, source.key, target.key);
    await saveMapping(mapping, source.libraryID);
    const win = Zotero.getMainWindow() as Window;
    const oldAlert = win.alert;
    let commandError = false;
    try {
      win.alert = () => {
        commandError = true;
      };
      const pane = Zotero.getActiveZoteroPane();
      assert.isNotNull(pane);
      await pane!.selectItem(source.id, true);
      for (
        let i = 0;
        i < 50 && pane!.getSelectedItems()[0]?.id !== source.id;
        i++
      )
        await Zotero.Promise.delay(100);
      assert.equal(pane!.getSelectedItems()[0]?.id, source.id);
      const menu = win.document.getElementById("paralens-open-bilingual");
      assert.isNotNull(menu);
      const event = win.document.createEvent("Event");
      event.initEvent("command", true, false);
      menu!.dispatchEvent(event);
      let originalReader;
      let translatedReader;
      for (let i = 0; i < 100; i++) {
        if (commandError) throw new Error("Open bilingual command failed");
        originalReader = Zotero.Reader._readers.find(
          (r) => r.itemID === source.id,
        );
        translatedReader = Zotero.Reader._readers.find(
          (r) => r.itemID === target.id,
        );
        const a = (originalReader as unknown as PdfReader)?._internalReader
          ?._primaryView?._iframeWindow;
        const b = (translatedReader as unknown as PdfReader)?._internalReader
          ?._primaryView?._iframeWindow;
        if (
          a?.PDFViewerApplication?.pdfViewer?.getPageView(0)?.div
            ?.isConnected &&
          b?.PDFViewerApplication?.pdfViewer?.getPageView(0)?.div?.isConnected
        )
          break;
        await Zotero.Promise.delay(100);
      }
      assert.isFalse(commandError);
      assert.isDefined(originalReader);
      assert.isDefined(translatedReader);
      const view = (reader: typeof originalReader, index = 0) => {
        const pdfWin = (reader as unknown as PdfReader)._internalReader
          ._primaryView._iframeWindow;
        return {
          win: pdfWin,
          page: pdfWin.PDFViewerApplication.pdfViewer.getPageView(index),
        };
      };
      const srcView = view(originalReader);
      const dstView = view(translatedReader);
      assert.isTrue(srcView.page.div.isConnected);
      assert.isTrue(dstView.page.div.isConnected);
      const text = (await dstView.page.pdfPage!.getTextContent()).items
        .map((piece) => piece.str)
        .join("");
      assert.match(text, /河[水流]/);
      if (draft.source.pageCount === 1) assert.include(text, "海洋");
      const hover = (v: typeof srcView, quad: number[]) => {
        const viewport = v.page.viewport;
        const box = viewport.viewBox;
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        const [vx, vy] = viewport.convertToViewportPoint(
          box[0] + x * (box[2] - box[0]),
          box[3] - y * (box[3] - box[1]),
        );
        const rect = v.page.div.getBoundingClientRect();
        const move = v.win.document.createEvent("MouseEvents");
        move.initMouseEvent(
          "pointermove",
          true,
          true,
          v.win,
          0,
          0,
          0,
          rect.left + (vx / viewport.width) * rect.width,
          rect.top + (vy / viewport.height) * rect.height,
          false,
          false,
          false,
          false,
          0,
          null,
        );
        v.page.div.dispatchEvent(move);
      };
      assert.equal(
        mapping.segments.filter((s) => s.status === "aligned").length,
        2,
      );
      if (Services.env.get("PARALENS_REPLAY_TWO_COLUMNS") === "1") {
        for (const side of ["source", "target"] as const) {
          const left = mapping.segments[0][side][0].quads.flat();
          const right = mapping.segments[1][side][0].quads.flat();
          assert.isBelow(
            Math.max(...left.filter((_, i) => i % 2 === 0)),
            Math.min(...right.filter((_, i) => i % 2 === 0)),
            `${side}: separate column highlights must not overlap`,
          );
        }
      }
      for (let i = 0; i < 50; i++) {
        hover(srcView, mapping.segments[0].source[0].quads[0]);
        if (dstView.win.document.querySelector(".paralens-hover-overlay"))
          break;
        await Zotero.Promise.delay(100);
      }
      assert.isNotNull(
        dstView.win.document.querySelector(".paralens-hover-overlay"),
        "English hover should highlight the Chinese translation",
      );
      for (let i = 0; i < 50; i++) {
        hover(dstView, mapping.segments[1].target[0].quads[0]);
        if (srcView.win.document.querySelector(".paralens-hover-overlay"))
          break;
        await Zotero.Promise.delay(100);
      }
      assert.isNotNull(
        srcView.win.document.querySelector(".paralens-hover-overlay"),
        "Chinese hover should highlight the original English",
      );

      // PDF.js may replace page nodes on scale/rotation changes. Verify the
      // transient highlight is drawn on the *current* page, not an old node.
      const targetViewer = dstView.win.PDFViewerApplication.pdfViewer;
      const originalScale = targetViewer.currentScale;
      const originalRotation = targetViewer.pagesRotation;
      const originalWidth = targetViewer.getPageView(0).viewport.width;
      const targetQuads = mapping.segments[0].target[0].quads;
      const expectedPolygon = (
        page: ReturnType<typeof targetViewer.getPageView>,
        targetQuad: number[],
      ) => {
        const { viewport } = page;
        const [x0, y0, x1, y1] = viewport.viewBox;
        const points: string[] = [];
        for (let i = 0; i < 8; i += 2) {
          const [x, y] = viewport.convertToViewportPoint(
            x0 + targetQuad[i] * (x1 - x0),
            y1 - targetQuad[i + 1] * (y1 - y0),
          );
          points.push(
            `${(x / viewport.width) * 100}% ${(y / viewport.height) * 100}%`,
          );
        }
        return `polygon(${points.join(", ")})`;
      };
      const polygonMatches = (actual: string, expected: string) => {
        const values = (polygon: string) =>
          Array.from(polygon.matchAll(/-?\d+(?:\.\d+)?/g), ([value]) =>
            Number(value),
          );
        const a = values(actual);
        const b = values(expected);
        return (
          a.length === 8 &&
          b.length === 8 &&
          a.every((value, index) => Math.abs(value - b[index]) < 0.001)
        );
      };
      hover(view(originalReader), mapping.segments[0].source[0].quads[0]);
      const assertCurrentHighlight = async (
        description: string,
        transformed: (
          page: ReturnType<typeof targetViewer.getPageView>,
        ) => boolean,
      ) => {
        let last = "";
        for (let i = 0; i < 60; i++) {
          const currentPage = targetViewer.getPageView(0);
          const overlays = Array.from(
            currentPage.div.querySelectorAll<HTMLElement>(
              ".paralens-hover-overlay",
            ),
          );
          last = "overlays=" + overlays.length + "/" + targetQuads.length;
          if (
            currentPage.div.isConnected &&
            transformed(currentPage) &&
            overlays.length === targetQuads.length &&
            overlays.every(
              (overlay, index) =>
                overlay.isConnected &&
                polygonMatches(
                  overlay.style.clipPath,
                  expectedPolygon(currentPage, targetQuads[index]),
                ),
            )
          )
            return;
          await Zotero.Promise.delay(100);
        }
        assert.fail(
          description +
            ": all line highlights missing or misplaced on the current PDF page; " +
            last,
        );
      };
      try {
        await assertCurrentHighlight("before zoom", () => true);
        targetViewer.currentScale = originalScale * 1.25;
        await assertCurrentHighlight(
          "after zoom",
          (page) => page.viewport.width > originalWidth * 1.05,
        );
        const rotated = (originalRotation + 90) % 360;
        targetViewer.pagesRotation = rotated;
        await assertCurrentHighlight(
          "after rotation",
          (page) => ((page.viewport.rotation % 360) + 360) % 360 === rotated,
        );
      } finally {
        targetViewer.pagesRotation = originalRotation;
        targetViewer.currentScale = originalScale;
      }

      if (draft.source.pageCount === 2) {
        assert.equal(draft.target.pageCount, 2);
        assert.equal(mapping.segments[1].source[0].pageIndex, 1);
        assert.equal(mapping.segments[1].target[0].pageIndex, 1);
        const sourceViewer = srcView.win.PDFViewerApplication.pdfViewer;
        // Page 2 initially exists only on the source side. A real hover
        // should navigate the other Zotero Reader before highlighting it.
        targetViewer.currentPageNumber = 1;
        sourceViewer.currentPageNumber = 2;
        for (let i = 0; i < 50; i++) {
          if (view(originalReader, 1).page.div.isConnected) break;
          await Zotero.Promise.delay(100);
        }
        assert.isTrue(view(originalReader, 1).page.div.isConnected);
        for (let i = 0; i < 50; i++) {
          hover(
            view(originalReader, 1),
            mapping.segments[1].source[0].quads[0],
          );
          if (
            targetViewer.currentPageNumber === 2 &&
            view(translatedReader, 1).page.div.isConnected &&
            view(translatedReader, 1).page.div.querySelector(
              ".paralens-hover-overlay",
            )
          )
            break;
          await Zotero.Promise.delay(100);
        }
        assert.equal(
          targetViewer.currentPageNumber,
          2,
          "source hover must navigate the target Reader to page 2",
        );
        const pageTwoText = (
          await view(translatedReader, 1).page.pdfPage!.getTextContent()
        ).items
          .map((piece) => piece.str)
          .join("");
        assert.include(
          pageTwoText,
          "海",
          "second page retains the ocean-related Chinese translation",
        );
        assert.equal(
          view(translatedReader, 1).page.div.querySelectorAll(
            ".paralens-hover-overlay",
          ).length,
          mapping.segments[1].target[0].quads.length,
          "source page 2 hover should highlight every line on target page 2",
        );
        // Now reverse direction on the SAME segment while source is on page
        // 1. Incoming highlighting must not suppress the local pointer event.
        sourceViewer.currentPageNumber = 1;
        for (let i = 0; i < 50; i++) {
          hover(
            view(translatedReader, 1),
            mapping.segments[1].target[0].quads[0],
          );
          if (
            sourceViewer.currentPageNumber === 2 &&
            view(originalReader, 1).page.div.isConnected &&
            view(originalReader, 1).page.div.querySelector(
              ".paralens-hover-overlay",
            )
          )
            break;
          await Zotero.Promise.delay(100);
        }
        assert.equal(
          sourceViewer.currentPageNumber,
          2,
          "target hover must navigate the source Reader to page 2",
        );
        assert.equal(
          view(originalReader, 1).page.div.querySelectorAll(
            ".paralens-hover-overlay",
          ).length,
          mapping.segments[1].source[0].quads.length,
          "target page 2 hover should highlight every line on source page 2",
        );
      }
    } finally {
      win.alert = oldAlert;
    }
  });
});
