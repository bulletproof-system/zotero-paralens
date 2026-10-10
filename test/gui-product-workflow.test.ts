import { assert } from "chai";
import { saveAPIKey, deleteAPIKey } from "../src/backend/credentials";
import { loadMapping } from "../src/mapping/store";
import { supportsNativePdfOverlay } from "../src/reader/nativeOverlay";
import { getPref, setPref } from "../src/utils/prefs";

describe("batch queue and paired native Reader product workflow", function () {
  it("queues two PDFs, stores syncable mappings, tiles Readers, locks highlights and optionally syncs scrolling", async function () {
    const checkpoint = (text: string) =>
      (window as unknown as { debug?: (value: string) => void }).debug?.(
        "GUI product checkpoint: " + text,
      );
    const port = Services.env.get("PARALENS_MOCK_API_PORT"),
      pdf = Services.env.get("PARALENS_TEST_SOURCE_PDF");
    if (!port || !pdf) this.skip();
    // Two real local backend jobs plus Reader interaction can exceed 3 minutes
    // on a cold Windows environment; keep a finite end-to-end test bound.
    this.timeout(360000);
    const win = Zotero.getMainWindow() as Window & {
      openDialog: (...args: any[]) => Window;
    };
    const pane = Zotero.getActiveZoteroPane()!;
    const keys = [
      "provider",
      "model",
      "customBaseURL",
      "sourceLanguage",
      "targetLanguage",
      "syncScroll",
    ] as const;
    const old = keys.map((key) => [key, getPref(key)] as const);
    const confirm = win.confirm,
      alert = win.alert,
      openDialog = win.openDialog;
    let queueWindow: Window | undefined,
      error = "",
      prompt = "";
    const wait = async (
      condition: () => Promise<boolean> | boolean,
      message: string,
      attempts = 600,
    ) => {
      for (let i = 0; i < attempts; i++) {
        if (error) throw new Error(error);
        if (await condition()) return;
        await Zotero.Promise.delay(250);
      }
      throw new Error(message);
    };
    const command = (id: string) => {
      const item = win.document.getElementById(id);
      assert.isNotNull(item);
      const event = win.document.createEvent("Event");
      event.initEvent("command", true, false);
      item!.dispatchEvent(event);
    };
    try {
      setPref("provider", "custom");
      setPref("model", "local-smoke");
      setPref("customBaseURL", `http://127.0.0.1:${port}/v1`);
      setPref("sourceLanguage", "en");
      setPref("targetLanguage", "zh");
      setPref("syncScroll", false);
      await saveAPIKey("custom", "local-test-only");
      const parent = new Zotero.Item("journalArticle");
      parent.libraryID = Zotero.Libraries.userLibraryID;
      parent.setField("title", "ParaLens batch product test");
      await parent.saveTx();
      const sources: Zotero.Item[] = [];
      for (let i = 0; i < 2; i++)
        sources.push(
          await Zotero.Attachments.importFromFile({
            file: pdf,
            parentItemID: parent.id,
            title: "Batch source " + (i + 1),
            contentType: "application/pdf",
          }),
        );
      win.confirm = (message) => {
        prompt = String(message);
        return true;
      };
      win.alert = (message) => {
        error = String(message);
      };
      await pane.selectItems(
        sources.map((item) => item.id),
        true,
      );
      await wait(
        () => pane.getSelectedItems().length === 2,
        "batch selection did not complete",
        40,
      );
      command("paralens-translate-pdf");
      const queuePath = PathUtils.join(
        PathUtils.profileDir,
        "paralens",
        "translation-queue.json",
      );
      let tasks: any[] = [];
      await wait(
        async () => {
          if (!(await IOUtils.exists(queuePath))) return false;
          tasks = ((await IOUtils.readJSON(queuePath)) as any[]).filter(
            (task) => sources.some((source) => source.key === task.sourceKey),
          );
          if (tasks.some((task) => task.state === "failed"))
            throw new Error("Batch task failed");
          return (
            tasks.length === 2 &&
            tasks.every((task) => task.state === "completed")
          );
        },
        "batch did not finish",
        1200,
      );
      checkpoint("batch-completed");
      assert.include(prompt, "2 个 PDF");
      assert.isAtLeast(
        Date.parse(tasks[1].updatedAt),
        Date.parse(tasks[0].updatedAt),
      );
      assert.equal(
        parent.getAttachments().length,
        6,
        "two source PDFs + two translated PDFs + two mapping JSON attachments",
      );
      const children = await Zotero.Items.getAsync(parent.getAttachments());
      const storedMappings = children.filter((item) =>
        sources.some((source) => item.hasTag(`paralens-mapping:${source.key}`)),
      );
      assert.lengthOf(storedMappings, 2);
      for (const item of storedMappings) {
        assert.equal(
          item.attachmentLinkMode,
          Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
        );
        assert.isTrue(
          await IOUtils.exists((await item.getFilePathAsync()) as string),
        );
      }
      for (const source of sources) {
        await IOUtils.remove(
          PathUtils.join(
            PathUtils.profileDir,
            "paralens",
            "mappings",
            `${source.libraryID}-${source.key}.json`,
          ),
          { ignoreAbsent: true },
        );
        assert.isDefined(
          await loadMapping(source.libraryID, source.key),
          "mapping must load only from the stored JSON attachment",
        );
      }
      assert.equal(
        parent.getAttachments().length,
        6,
        "reading synced attachments must not recreate mappings",
      );
      // Capture the actual add-on task window, not a second queue instance from the test bundle.
      win.openDialog = function (...args: any[]) {
        const result = openDialog.apply(win, args as any);
        if (String(args[0]).includes("taskQueue.xhtml")) queueWindow = result;
        return result;
      };
      checkpoint("mapping-attachments-verified");
      command("paralens-task-queue");
      await wait(
        () =>
          Boolean(
            (queueWindow?.document.querySelectorAll(".task").length ?? 0) >= 2,
          ),
        "queue UI did not render",
        40,
      );
      checkpoint("queue-ui-rendered");
      assert.include(queueWindow!.document.body.textContent!, "已完成");
      let deniedRetry = "";
      queueWindow!.confirm = (message) => {
        deniedRetry = String(message);
        return false;
      };
      const buttons = Array.from(
        queueWindow!.document.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      buttons.find((button) => button.textContent === "重新开始")!.click();
      await wait(
        () => Boolean(deniedRetry),
        "restart confirmation did not appear",
        10,
      );
      assert.include(deniedRetry, "而非断点继续");
      assert.include(deniedRetry, "删除这条旧任务记录");
      buttons.find((button) => button.textContent === "打开双语对照")!.click();
      const source = sources[1],
        mapping = (await loadMapping(source.libraryID, source.key))!;
      assert.isAtLeast(
        mapping.segments.filter((segment) => segment.status === "aligned")
          .length,
        2,
        "the batch fixture must contain real translations with aligned paragraphs",
      );
      const target = await Zotero.Items.getByLibraryAndKeyAsync(
        source.libraryID,
        mapping.target.attachmentKey,
      );
      let sourceReader: any, targetReader: any;
      await wait(
        () => {
          const uiError =
            queueWindow?.document.getElementById("status")?.textContent;
          if (uiError) throw new Error("Queue open error: " + uiError);
          sourceReader = Zotero.Reader._readers.find(
            (reader) => reader.itemID === source.id,
          );
          targetReader = Zotero.Reader._readers.find(
            (reader) => reader.itemID === target.id,
          );
          return Boolean(
            sourceReader &&
            targetReader &&
            supportsNativePdfOverlay(sourceReader) &&
            supportsNativePdfOverlay(targetReader) &&
            sourceReader._internalReader._primaryView._iframeWindow.document.querySelector(
              ".paralens-reader-controls",
            ),
          );
        },
        "paired Readers or controls missing",
        100,
      );
      checkpoint("paired-readers-ready");
      assert.notEqual(sourceReader._window, targetReader._window);
      await Zotero.Promise.delay(500);
      const left = sourceReader._window as Window,
        right = targetReader._window as Window;
      assert.isBelow(left.screenX, right.screenX);
      assert.isAtMost(
        left.screenX + left.outerWidth,
        right.screenX + 24,
        "native Reader windows must be side-by-side",
      );
      const a = sourceReader._internalReader._primaryView._iframeWindow as any;
      const b = targetReader._internalReader._primaryView._iframeWindow as any;
      await wait(
        () => {
          const sourcePage = a.PDFViewerApplication.pdfViewer.getPageView(0);
          const targetPage = b.PDFViewerApplication.pdfViewer.getPageView(0);
          return Boolean(
            sourcePage?.viewport &&
            targetPage?.viewport &&
            sourcePage.div?.isConnected &&
            targetPage.div?.isConnected &&
            sourcePage.div.getBoundingClientRect().width > 0,
          );
        },
        "PDF pages were not rendered before interaction",
        80,
      );
      const page = a.PDFViewerApplication.pdfViewer.getPageView(0);
      const ref = mapping.segments.find(
        (segment) => segment.status === "aligned",
      )!.source[0];
      const q = ref.quads[0],
        box = page.viewport.viewBox;
      const [vx, vy] = page.viewport.convertToViewportPoint(
        box[0] + ((q[0] + q[4]) / 2) * (box[2] - box[0]),
        box[3] - ((q[1] + q[5]) / 2) * (box[3] - box[1]),
      );
      const rect = page.div.getBoundingClientRect();
      const pointer = (type: string) => {
        const event = a.document.createEvent("MouseEvents");
        event.initMouseEvent(
          type,
          true,
          true,
          a,
          0,
          0,
          0,
          rect.left + (vx / page.viewport.width) * rect.width,
          rect.top + (vy / page.viewport.height) * rect.height,
          false,
          false,
          false,
          false,
          0,
          null,
        );
        page.div.dispatchEvent(event);
      };
      checkpoint("tile-verified");
      pointer("pointermove");
      pointer("click");
      const panelA = a.document.querySelector(".paralens-reader-controls"),
        panelB = b.document.querySelector(".paralens-reader-controls");
      assert.isNotEmpty(panelA.dataset.locked);
      assert.equal(panelA.dataset.locked, panelB.dataset.locked);
      const leave = a.document.createEvent("MouseEvents");
      leave.initMouseEvent(
        "pointermove",
        true,
        true,
        a,
        0,
        0,
        0,
        0,
        0,
        false,
        false,
        false,
        false,
        0,
        null,
      );
      a.document.body.dispatchEvent(leave);
      assert.isNotNull(
        b.document.querySelector(".paralens-hover-overlay"),
        "locked highlight remains after pointer leave",
      );
      panelB.querySelector(".paralens-unlock-highlight").click();
      assert.equal(panelA.dataset.locked, "");
      const checkboxA = panelA.querySelector(".paralens-sync-scroll"),
        checkboxB = panelB.querySelector(".paralens-sync-scroll");
      assert.isFalse(checkboxA.checked);
      checkboxA.checked = true;
      const change = a.document.createEvent("Event");
      change.initEvent("change", true, false);
      checkboxA.dispatchEvent(change);
      checkpoint("lock-unlock-verified");
      assert.isTrue(checkboxB.checked);
      assert.equal(getPref("syncScroll"), true);
      // Spy the real PDF.js scroll call to verify the installed add-on responds only when enabled.
      const viewer = b.PDFViewerApplication.pdfViewer,
        scroll = viewer.scrollPageIntoView.bind(viewer);
      let synced = 0;
      viewer.scrollPageIntoView = (options: unknown) => {
        synced++;
        scroll(options);
      };
      await Zotero.Promise.delay(500);
      const event = a.document.createEvent("Event");
      event.initEvent("scroll", false, false);
      a.PDFViewerApplication.pdfViewer.container.dispatchEvent(event);
      await wait(
        () => synced > 0,
        "enabled synchronization did not move the counterpart",
        10,
      );
      checkboxA.checked = false;
      checkboxA.dispatchEvent(change);
      const before = synced;
      a.PDFViewerApplication.pdfViewer.container.dispatchEvent(event);
      await Zotero.Promise.delay(500);
      assert.equal(
        synced,
        before,
        "disabled synchronization must not scroll the counterpart",
      );
      viewer.scrollPageIntoView = scroll;
    } catch (failure) {
      checkpoint(
        "failure: " + String(failure) + " " + (failure as Error)?.stack,
      );
      checkpoint(
        "readers: " +
          Zotero.Reader._readers
            .map(
              (reader) =>
                `${reader.itemID}:${reader.type}:${Boolean((reader as any)._internalReader?._primaryView?._iframeWindow?.document.querySelector(".paralens-reader-controls"))}`,
            )
            .join(","),
      );
      throw failure;
    } finally {
      win.confirm = confirm;
      win.alert = alert;
      win.openDialog = openDialog;
      queueWindow?.close();
      for (const [key, value] of old) setPref(key, value as never);
      await deleteAPIKey("custom");
    }
  });
});
