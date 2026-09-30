import { assert } from "chai";
import {
  deleteAPIKey,
  hasAPIKey,
  saveAPIKey,
} from "../src/backend/credentials";
import { isBackendInstalled } from "../src/backend/installationStatus";
import { loadMapping } from "../src/mapping/store";
import { supportsNativePdfOverlay } from "../src/reader/nativeOverlay";

import { getPref, setPref } from "../src/utils/prefs";
import { config } from "../package.json";

type PdfSmokeWindow = Window & {
  PDFViewerApplication: {
    pdfDocument: {
      getPage(number: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str: string }> }>;
      }>;
    };
    pdfViewer: {
      getPageView(index: number): {
        div: HTMLElement;
        pdfPage?: {
          getTextContent(): Promise<{ items: Array<{ str: string }> }>;
        };
        viewport: {
          viewBox: number[];
          width: number;
          height: number;
          convertToViewportPoint(x: number, y: number): [number, number];
        };
      };
    };
  };
};
interface PdfSmokeReader {
  _internalReader: { _primaryView: { _iframeWindow: PdfSmokeWindow } };
}

describe("isolated native Reader translation with a localhost API", function () {
  it("imports a PDF, calls the local API, persists mapping and opens both Readers", async function () {
    this.timeout(120000);
    const checkpoint = (stage: string) =>
      (window as unknown as { debug?: (data: string) => void }).debug?.(
        "GUI smoke checkpoint: " + stage,
      );
    checkpoint("started");
    // Never run on a user's default Zotero profile or with their API key.
    const port = Services.env.get("PARALENS_MOCK_API_PORT");
    const pdf = Services.env.get("PARALENS_TEST_SOURCE_PDF");
    if (!port || !pdf) this.skip();
    assert.match(port, /^[0-9]{2,5}$/);
    assert.isTrue(await IOUtils.exists(pdf));
    checkpoint("before-key-probe");
    assert.isFalse(
      await hasAPIKey("custom"),
      "Refuse to overwrite a saved key",
    );
    const instance = Zotero[config.addonInstance] as {
      data: { backendProjectDir?: string; uv?: { available: boolean } };
    };
    checkpoint("before-uv-probe");
    assert.isTrue(instance.data.uv?.available);
    assert.isTrue(
      await isBackendInstalled(
        instance.data.backendProjectDir,
        Services.appinfo.OS === "WINNT",
        (file) => IOUtils.exists(file),
        async (file, args) =>
          (await Zotero.Utilities.Internal.exec(file, args)) === true,
      ),
      "Isolated test profile needs the prepared BabelDOC venv",
    );
    checkpoint("after-backend-probe");
    const win = Zotero.getMainWindow() as Window;
    assert.isNotNull(win);
    const originalConfirm = win.confirm;
    const originalAlert = win.alert;
    let commandError = "";
    const old = {
      backend: getPref("backend"),
      provider: getPref("provider"),
      model: getPref("model"),
      customBaseURL: getPref("customBaseURL"),
      sourceLanguage: getPref("sourceLanguage"),
      targetLanguage: getPref("targetLanguage"),
    };
    try {
      checkpoint("before-credential-save");
      await saveAPIKey("custom", "local-test-only");
      setPref("backend", "babeldoc");
      setPref("provider", "custom");
      setPref("model", "local-smoke");
      setPref("customBaseURL", `http://127.0.0.1:${port}/v1/responses`);
      setPref("sourceLanguage", "en");
      setPref("targetLanguage", "zh");
      checkpoint("before-item-create");
      const parent = new Zotero.Item("journalArticle");
      parent.libraryID = Zotero.Libraries.userLibraryID;
      parent.setField("title", "ParaLens disposable GUI smoke test");
      await parent.saveTx();
      checkpoint("before-attachment-import");
      let source: Zotero.Item;
      try {
        source = await Zotero.Attachments.importFromFile({
          file: pdf,
          parentItemID: parent.id,
          title: "English synthetic PDF",
          contentType: "application/pdf",
        });
      } catch (error) {
        checkpoint(
          `import-error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
        checkpoint(
          "import-stack: " +
            (error instanceof Error ? error.stack?.slice(0, 700) : "unknown"),
        );
        // Disposable test data only. Preserve Zotero’s real error for diagnosis.
        throw new Error(
          `Zotero attachment import failed: ${error instanceof Error ? error.stack : String(error)}`,
        );
      }
      checkpoint("after-attachment-import");
      // Exercise the add-on's actual native context-menu command, not a second
      // copy of its module in the test bundle. The fake API is loopback-only.
      win.confirm = () => true;
      win.alert = (message) => {
        commandError = String(message);
      };
      const pane = Zotero.getActiveZoteroPane();
      assert.isNotNull(pane);
      checkpoint("after-pane");
      // Zotero 10 implements selectItem asynchronously despite the older type.
      await pane!.selectItem(source.id, true);
      for (
        let i = 0;
        i < 50 && pane!.getSelectedItems()[0]?.id !== source.id;
        i++
      )
        await Zotero.Promise.delay(100);
      assert.equal(
        pane!.getSelectedItems()[0]?.id,
        source.id,
        "The test PDF must be selected before the context-menu command",
      );
      checkpoint("after-select");
      const menu = win.document.getElementById("paralens-translate-pdf");
      assert.isNotNull(menu, "Actual ParaLens context-menu item is missing");
      checkpoint("before-translate");
      const event = win.document.createEvent("Event");
      event.initEvent("command", true, false);
      menu!.dispatchEvent(event);
      let mapping;
      for (let i = 0; i < 480; i++) {
        if (commandError)
          throw new Error("Menu translation failed: " + commandError);
        mapping = await loadMapping(source.libraryID, source.key);
        if (mapping) break;
        await Zotero.Promise.delay(250);
      }
      checkpoint("after-translate");
      assert.isDefined(mapping);
      assert.isAtLeast(
        mapping!.segments.filter((segment) => segment.status === "aligned")
          .length,
        2,
      );
      const target = await Zotero.Items.getByLibraryAndKeyAsync(
        source.libraryID,
        mapping!.target.attachmentKey,
      );
      assert.isTrue(target?.isPDFAttachment());
      checkpoint("after-mapping-check");
      let originalReader;
      let translatedReader;
      for (let i = 0; i < 40; i++) {
        const readers = Zotero.Reader._readers;
        originalReader = readers.find((reader) => reader.itemID === source.id);
        translatedReader = readers.find(
          (reader) => reader.itemID === target?.id,
        );
        if (
          originalReader &&
          translatedReader &&
          supportsNativePdfOverlay(originalReader) &&
          supportsNativePdfOverlay(translatedReader)
        )
          break;
        await Zotero.Promise.delay(250);
      }
      assert.isDefined(originalReader);
      assert.isDefined(translatedReader);
      assert.isTrue(supportsNativePdfOverlay(originalReader!));
      assert.isTrue(supportsNativePdfOverlay(translatedReader!));
      const sourceKey = (
        originalReader as unknown as { _item?: { key?: string } }
      )._item?.key;
      const targetKey = (
        translatedReader as unknown as { _item?: { key?: string } }
      )._item?.key;
      assert.equal(sourceKey, mapping!.source.attachmentKey);
      assert.equal(targetKey, mapping!.target.attachmentKey);
      checkpoint("before-real-pointer-hover");
      function pdfView(reader: NonNullable<typeof originalReader>) {
        const readerWindow = (reader as unknown as PdfSmokeReader)
          ._internalReader._primaryView._iframeWindow;
        return {
          win: readerWindow,
          page: readerWindow.PDFViewerApplication.pdfViewer.getPageView(0),
        };
      }
      let sourceView = pdfView(originalReader!);
      let targetView = pdfView(translatedReader!);
      for (let i = 0; i < 40; i++) {
        sourceView = pdfView(originalReader!);
        targetView = pdfView(translatedReader!);
        if (
          sourceView.page?.div?.isConnected &&
          targetView.page?.div?.isConnected &&
          sourceView.page.div.getBoundingClientRect().width > 0 &&
          targetView.page.div.getBoundingClientRect().width > 0
        )
          break;
        await Zotero.Promise.delay(250);
      }
      assert.isTrue(sourceView.page?.div?.isConnected);
      assert.isTrue(targetView.page?.div?.isConnected);
      // Assert that the translated Reader contains actual Chinese PDF text,
      // not merely a saved mapping and an opened (but unchanged) document.
      const translatedPdfDocument =
        targetView.win.PDFViewerApplication.pdfDocument;
      checkpoint(
        `translated PDF.js page: ${Boolean(targetView.page.pdfPage)} doc: ${Boolean(translatedPdfDocument)}`,
      );
      const translatedPage =
        targetView.page.pdfPage ||
        (translatedPdfDocument && (await translatedPdfDocument.getPage(1)));
      assert.isDefined(translatedPage);
      const translatedText = (await translatedPage.getTextContent()).items
        .map((item) => item.str)
        .join("");
      assert.include(translatedText, "河流");
      assert.include(translatedText, "海洋");
      assert.notInclude(translatedText.toLowerCase(), "the river");
      checkpoint("translated PDF text layer verified");
      function hover(view: typeof sourceView, quad: number[]) {
        const viewport = view.page.viewport;
        const box = viewport.viewBox;
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        const [vx, vy] = viewport.convertToViewportPoint(
          box[0] + x * (box[2] - box[0]),
          box[3] - y * (box[3] - box[1]),
        );
        const rect = view.page.div.getBoundingClientRect();
        const event = view.win.document.createEvent("MouseEvents");
        event.initMouseEvent(
          "pointermove",
          true,
          true,
          view.win,
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
        view.page.div.dispatchEvent(event);
      }
      const first = mapping!.segments[0];
      const second = mapping!.segments[1];
      for (let i = 0; i < 100; i++) {
        hover(sourceView, first.source[0].quads[0]);
        if (targetView.win.document.querySelector(".paralens-hover-overlay"))
          break;
        await Zotero.Promise.delay(100);
      }
      const targetOverlay = targetView.win.document.querySelector(
        ".paralens-hover-overlay",
      ) as HTMLElement | null;
      assert.isNotNull(
        targetOverlay,
        "Source hover must paint the target Reader",
      );
      assert.equal(targetOverlay?.style.pointerEvents, "none");
      for (let i = 0; i < 100; i++) {
        hover(targetView, second.target[0].quads[0]);
        if (sourceView.win.document.querySelector(".paralens-hover-overlay"))
          break;
        await Zotero.Promise.delay(100);
      }
      assert.isNotNull(
        sourceView.win.document.querySelector(".paralens-hover-overlay"),
        "Target hover must paint the source Reader",
      );
      const attachmentCount = parent.getAttachments().length;
      let repeatedConfirmation = "";
      win.confirm = (message) => {
        repeatedConfirmation = String(message);
        return false;
      };
      await pane!.selectItem(source.id, true);
      for (
        let i = 0;
        i < 50 && pane!.getSelectedItems()[0]?.id !== source.id;
        i++
      )
        await Zotero.Promise.delay(100);
      assert.equal(
        pane!.getSelectedItems()[0]?.id,
        source.id,
        "the source must still be selected before trying to translate it again",
      );
      await Zotero.Promise.delay(500);
      menu!.dispatchEvent(event);
      for (let i = 0; i < 40 && !repeatedConfirmation && !commandError; i++)
        await Zotero.Promise.delay(100);
      assert.equal(
        commandError,
        "",
        "repeat menu command should not fail before prompting",
      );
      assert.include(repeatedConfirmation, "已有 ParaLens 译文");
      assert.include(repeatedConfirmation, "旧译文附件仍会保留");
      assert.equal(
        parent.getAttachments().length,
        attachmentCount,
        "declining a paid retry must not create another PDF attachment",
      );
      assert.equal(
        (await loadMapping(source.libraryID, source.key))!.target.attachmentKey,
        target!.key,
        "existing mapping should remain active",
      );
      assert.equal(commandError, "");
    } finally {
      win.confirm = originalConfirm;
      win.alert = originalAlert;
      for (const [key, value] of Object.entries(old))
        setPref(key as keyof typeof old, value);
      await deleteAPIKey("custom");
    }
  });
});
