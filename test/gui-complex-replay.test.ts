import { assert } from "chai";
import { config } from "../package.json";
import { bindAttachmentKeys, findHit } from "../src/mapping/validation";
import { loadMapping, saveMapping } from "../src/mapping/store";
import {
  UnboundMappingV1,
  MappingSegment,
  MappingSideName,
} from "../src/mapping/types";

/** Opt-in replay of a user's saved output. No translation/API/credentials.
 * The runner uses an OS-temporary profile; no PDF is copied into repo fixtures.
 * Logs contain counts and page indices only, never paths or extracted text.
 */
describe("complex PDF artifact in native Zotero Readers", function () {
  it("imports the real PDFs and mapping, reloads the stored attachment, and highlights trusted segments across the document", async function () {
    if (Services.env.get("PARALENS_REPLAY_COMPLEX") !== "1") this.skip();
    this.timeout(600000);
    const checkpoint = (value: string) =>
      (window as unknown as { debug?: (value: string) => void }).debug?.(
        "complex replay: " + value,
      );
    const sourcePath = Services.env.get("PARALENS_TEST_SOURCE_PDF");
    const pdfPath = Services.env.get("PARALENS_REPLAY_PDF_PATH");
    const mappingPath = Services.env.get("PARALENS_REPLAY_MAPPING_PATH");
    const draft = (await IOUtils.readJSON(mappingPath)) as UnboundMappingV1;
    assert.isAbove(
      draft.source.pageCount,
      2,
      "This gate requires an actual multipage complex sample",
    );
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ParaLens private complex artifact replay");
    await parent.saveTx();
    const source = await Zotero.Attachments.importFromFile({
      file: sourcePath,
      parentItemID: parent.id,
      title: "Private source PDF",
      contentType: "application/pdf",
    });
    const target = await Zotero.Attachments.importFromFile({
      file: pdfPath,
      parentItemID: parent.id,
      title: "Private translated PDF",
      contentType: "application/pdf",
    });
    const bound = bindAttachmentKeys(draft, source.key, target.key);
    await saveMapping(bound, source.libraryID);
    assert.lengthOf(
      parent.getAttachments(),
      3,
      "source + translation + mapping attachment",
    );
    for (const [item, expected] of [
      [source, bound.source],
      [target, bound.target],
    ] as const) {
      const file = (await item.getFilePathAsync()) as string;
      assert.equal(
        (await IOUtils.computeHexDigest(file, "sha256")).toLowerCase(),
        expected.sha256,
      );
    }
    await IOUtils.remove(
      PathUtils.join(
        PathUtils.profileDir,
        "paralens",
        "mappings",
        `${source.libraryID}-${source.key}.json`,
      ),
      { ignoreAbsent: true },
    );
    const mapping = (await loadMapping(source.libraryID, source.key))!;
    assert.isDefined(
      mapping,
      "attachment-backed mapping must load without a profile cache",
    );
    assert.deepEqual(mapping.segments, bound.segments);
    const aligned = mapping.segments.filter(
      (segment) => segment.status === "aligned",
    );
    assert.isAbove(aligned.length, 0);
    checkpoint(
      `imported ${mapping.source.pageCount} pages, ${mapping.segments.length} segments, ${aligned.length} aligned`,
    );

    const main = Zotero.getMainWindow();
    const oldAlert = main.alert;
    let uiError = false;
    main.alert = () => {
      uiError = true;
    };
    const wait = async (
      condition: () => boolean | Promise<boolean>,
      description: string,
      attempts = 200,
    ) => {
      for (let i = 0; i < attempts; i++) {
        if (uiError) throw Error("Production open-pair command failed");
        if (await condition()) return;
        await Zotero.Promise.delay(100);
      }
      throw Error(description);
    };
    try {
      await Zotero.getActiveZoteroPane()!.selectItem(source.id, true);
      await wait(
        () =>
          Zotero.getActiveZoteroPane()!.getSelectedItems()[0]?.id === source.id,
        "Source not selected",
      );
      const command = main.document.getElementById("paralens-open-bilingual")!;
      assert.isNotNull(command);
      const event = main.document.createEvent("Event");
      event.initEvent("command", true, false);
      command.dispatchEvent(event);
      const reader = (side: MappingSideName): any =>
        Zotero.Reader._readers.find(
          (entry) =>
            entry.itemID === (side === "source" ? source.id : target.id),
        );
      const pdfWindow = (side: MappingSideName): any =>
        reader(side)?._internalReader?._primaryView?._iframeWindow;
      const viewer = (side: MappingSideName): any =>
        pdfWindow(side)?.PDFViewerApplication?.pdfViewer;
      await wait(
        () =>
          ["source", "target"].every((side) =>
            Boolean(
              pdfWindow(side as MappingSideName)?.document.querySelector(
                ".paralens-reader-controls",
              ),
            ),
          ),
        "Production paired Readers not ready",
      );
      checkpoint("paired readers ready");
      await wait(
        () =>
          ["source", "target"].every((side) =>
            Boolean(
              pdfWindow(side as MappingSideName)?.PDFViewerApplication
                ?.pdfDocument,
            ),
          ),
        "PDF documents not loaded",
      );
      for (const side of ["source", "target"] as const) {
        const document = pdfWindow(side).PDFViewerApplication.pdfDocument;
        assert.equal(document.numPages, mapping[side].pageCount);
      }
      const navigate = async (side: MappingSideName, index: number) => {
        viewer(side).currentPageNumber = index + 1;
        await wait(
          () => {
            const page = viewer(side).getPageView(index);
            const rect = page?.div?.getBoundingClientRect();
            return (
              page?.div?.isConnected && rect?.width > 0 && rect?.height > 0
            );
          },
          `Page ${index + 1} not materialized`,
        );
      };
      const hover = (side: MappingSideName, segment: MappingSegment) => {
        const ref = segment[side][0];
        const page = viewer(side).getPageView(ref.pageIndex);
        let hitPoint: [number, number] | undefined;
        for (const candidate of ref.quads) {
          // Text inside a figure has priority. Find an actual image-only point
          // rather than assuming the image center is free of translated text.
          const fractions =
            segment.metadata?.kind === "figure"
              ? [0.5, 0.2, 0.8, 0.05, 0.95]
              : [0.5];
          for (const u of fractions) {
            for (const v of fractions) {
              const x =
                (1 - v) * ((1 - u) * candidate[0] + u * candidate[2]) +
                v * ((1 - u) * candidate[6] + u * candidate[4]);
              const y =
                (1 - v) * ((1 - u) * candidate[1] + u * candidate[3]) +
                v * ((1 - u) * candidate[7] + u * candidate[5]);
              if (
                findHit(mapping, side, ref.pageIndex, x, y)?.segment.id ===
                segment.id
              ) {
                hitPoint = [x, y];
                break;
              }
            }
            if (hitPoint) break;
          }
          if (hitPoint) break;
        }
        assert.isDefined(
          hitPoint,
          `Trusted segment ${segment.id}/${side} must have an independently hittable quad`,
        );
        const [x, y] = hitPoint!;
        const viewport = page.viewport,
          box = viewport.viewBox;
        const [vx, vy] = viewport.convertToViewportPoint(
          box[0] + x * (box[2] - box[0]),
          box[3] - y * (box[3] - box[1]),
        );
        const rect = page.div.getBoundingClientRect(),
          win = pdfWindow(side);
        const move = win.document.createEvent("MouseEvents");
        move.initMouseEvent(
          "pointermove",
          true,
          true,
          win,
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
        page.div.dispatchEvent(move);
      };
      const hasExpectedHighlight = (
        side: MappingSideName,
        segment: MappingSegment,
      ) => {
        const ref = segment[side][0],
          page = viewer(side).getPageView(ref.pageIndex);
        if (!page?.div?.isConnected) return false;
        const overlays = Array.from(
          page.div.querySelectorAll(".paralens-hover-overlay"),
        ) as HTMLElement[];
        if (overlays.length !== ref.quads.length) return false;
        return ref.quads.every((quad, i) => {
          const viewport = page.viewport,
            box = viewport.viewBox;
          const expected = [];
          for (let j = 0; j < 8; j += 2) {
            const [x, y] = viewport.convertToViewportPoint(
              box[0] + quad[j] * (box[2] - box[0]),
              box[3] - quad[j + 1] * (box[3] - box[1]),
            );
            expected.push(
              (x / viewport.width) * 100,
              (y / viewport.height) * 100,
            );
          }
          const actual = overlays[i].style.clipPath
            .match(/-?\d+(?:\.\d+)?/g)
            ?.map(Number);
          return (
            actual?.length === 8 &&
            actual.every((value, j) => Math.abs(value - expected[j]) < 0.001)
          );
        });
      };
      checkpoint("document page counts verified");
      let verified = 0;
      for (const segment of aligned) {
        await navigate("source", segment.source[0].pageIndex);
        await navigate("target", segment.target[0].pageIndex);
        hover("source", segment);
        await wait(
          () =>
            hasExpectedHighlight("source", segment) &&
            hasExpectedHighlight("target", segment),
          `Source-to-target geometry failed for ${segment.id}`,
          50,
        );
        hover("target", segment);
        await wait(
          () =>
            hasExpectedHighlight("source", segment) &&
            hasExpectedHighlight("target", segment),
          `Target-to-source geometry failed for ${segment.id}`,
          50,
        );
        verified++;
        if (verified % 25 === 0)
          checkpoint(`${verified}/${aligned.length} segments verified`);
      }
      checkpoint(`verified ${verified} segments in both directions`);
      assert.equal(verified, aligned.length);
      // These pages are far apart in a long paper. The production adapter must
      // materialize a counterpart page even if that Reader was elsewhere.
      const first = aligned[0],
        last = aligned.at(-1)!;
      if (last.target[0].pageIndex !== first.target[0].pageIndex) {
        await navigate("target", first.target[0].pageIndex);
        await navigate("source", last.source[0].pageIndex);
        // Reset local hover so that revisiting the last segment emits a new event.
        const leave = pdfWindow("source").document.createEvent("MouseEvents");
        leave.initMouseEvent(
          "pointermove",
          true,
          true,
          pdfWindow("source"),
          0,
          0,
          0,
          -1,
          -1,
          false,
          false,
          false,
          false,
          0,
          null,
        );
        viewer("source")
          .getPageView(last.source[0].pageIndex)
          .div.dispatchEvent(leave);
        hover("source", last);
        await wait(
          () =>
            viewer("target").currentPageNumber ===
              last.target[0].pageIndex + 1 &&
            hasExpectedHighlight("target", last),
          "Distant counterpart page did not navigate/redraw",
          80,
        );
      }
      assert.isFalse(uiError);
    } catch (failure) {
      checkpoint(
        "failure: " +
          String((failure as Error)?.message) +
          " " +
          (failure as Error)?.stack,
      );
      throw failure;
    } finally {
      main.alert = oldAlert;
    }
  });
});
