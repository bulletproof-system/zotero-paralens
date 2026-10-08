import { assert } from "chai";
import { hasAPIKey } from "../src/backend/credentials";
import { loadMapping } from "../src/mapping/store";
import { resolveProviderConfig } from "../src/backend/providers";
import { getPref, setPref } from "../src/utils/prefs";
import { config } from "../package.json";

declare const window: Window;

/** Opt-in real provider test in an isolated Zotero profile. Never log secrets. */
describe("authorized real API PDF translation", function () {
  it("renders a Chinese translation and aligns both PDFs", async function () {
    if (Services.env.get("PARALENS_REAL_API") !== "1") this.skip();
    const twoPages = Services.env.get("PARALENS_REAL_API_TWO_PAGES") === "1";
    const complex = Services.env.get("PARALENS_REAL_API_COMPLEX") === "1";
    this.timeout(complex ? 3600000 : twoPages ? 360000 : 240000);
    const checkpoint = (stage: string) =>
      (window as unknown as { debug?: (s: string) => void }).debug?.(
        "real API smoke: " + stage,
      );
    checkpoint("start");
    const fixture = Services.env.get("PARALENS_TEST_SOURCE_PDF");
    assert.isTrue(await IOUtils.exists(fixture));
    const settings = JSON.parse(
      Services.env.get("PARALENS_REAL_API_SETTINGS"),
    ) as {
      provider: string;
      model: string;
      customBaseURL: string;
    };
    assert.equal(settings.provider, "custom");
    assert.match(settings.model, /^[^\s]{1,120}$/);
    checkpoint("settings loaded");
    assert.isTrue(
      await hasAPIKey("custom"),
      "Saved API key unavailable in isolated Zotero",
    );
    checkpoint("credential available");
    // BabelDOC calls chat.completions.create. A /responses endpoint is not a
    // SDK base URL. Test /v1/chat/completions on the SAME origin with the
    // user's model and saved key; do not edit the source profile preferences.
    const configuredURL = new URL(settings.customBaseURL);
    assert.equal(configuredURL.protocol, "https:");
    const baseURL = new URL(configuredURL.toString());
    baseURL.pathname = baseURL.pathname.replace(/\/responses\/?$/, "");
    assert.equal(
      resolveProviderConfig("custom", settings.model, settings.customBaseURL)
        .baseURL,
      baseURL.toString().replace(/\/$/, ""),
    );
    const old = {
      provider: getPref("provider"),
      model: getPref("model"),
      customBaseURL: getPref("customBaseURL"),
      backend: getPref("backend"),
      sourceLanguage: getPref("sourceLanguage"),
      targetLanguage: getPref("targetLanguage"),
    };
    const win = Zotero.getMainWindow() as Window;
    const originalConfirm = win.confirm;
    const originalAlert = win.alert;
    let succeeded = false;
    try {
      setPref("provider", "custom");
      setPref("model", settings.model);
      setPref("customBaseURL", settings.customBaseURL);
      setPref("backend", "babeldoc");
      setPref("sourceLanguage", "en");
      setPref("targetLanguage", "zh");
      const instance = (Zotero as unknown as Record<string, unknown>)[
        config.addonInstance
      ] as {
        data: { backendProjectDir?: string; uv?: { available?: boolean } };
      };
      assert.isTrue(instance.data.uv?.available);
      assert.isString(instance.data.backendProjectDir);
      checkpoint("preferences prepared");
      const item = new Zotero.Item("journalArticle");
      item.libraryID = Zotero.Libraries.userLibraryID;
      item.setField(
        "title",
        `ParaLens authorized ${complex ? "complex-document" : twoPages ? "two-page" : "one-page"} API test`,
      );
      await item.saveTx();
      checkpoint("item created");
      const source = await Zotero.Attachments.importFromFile({
        file: fixture,
        parentItemID: item.id,
        title: complex
          ? "Private complex English sample"
          : `${twoPages ? "Two-page" : "One-page"} public synthetic English sample`,
        contentType: "application/pdf",
      });
      // This opt-in test uses the saved API key and may incur charges.
      checkpoint("source imported");
      checkpoint(
        `source PDF path: ${Boolean(await source.getFilePathAsync())}`,
      );
      checkpoint(
        `language and backend: ${getPref("sourceLanguage")}/${getPref("targetLanguage")}/${getPref("backend")}`,
      );
      let confirmed = false;
      let commandError = "";
      win.alert = (message = "") => {
        commandError = String(message);
      };
      win.confirm = () => {
        confirmed = true;
        checkpoint("billing confirmation");
        return true;
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
      const menu = win.document.getElementById("paralens-translate-pdf");
      assert.isNotNull(menu);
      const event = win.document.createEvent("Event");
      event.initEvent("command", true, false);
      menu!.dispatchEvent(event);
      checkpoint("context menu dispatched");
      let mapping;
      for (let i = 0; i < (complex ? 14000 : twoPages ? 1200 : 720); i++) {
        if (commandError) {
          // Only diagnostic stage/class is logged, never HTTP response text.
          const known = [
            "BabelDOC 执行失败",
            "uv worker 执行失败",
            "未安装",
            "缺少",
            "API Key",
          ];
          const diagnosticCode = commandError.match(
            /\((api_auth|api_rate_limit|api_connection|api_timeout|api_request|api_server|memory_exhausted|storage_failure|file_missing|pdf_invalid|backend_load_failed|model_load_failed|translation_failed|translation_incomplete|mapping_failed|publish_failed)\)/,
          )?.[1];
          checkpoint(
            "translation failed: " +
              (diagnosticCode ||
                known.find((term) => commandError.includes(term)) ||
                (confirmed
                  ? "unspecified provider error"
                  : "before API confirmation")),
          );
          throw new Error("Real provider translation did not complete");
        }
        mapping = await loadMapping(source.libraryID, source.key);
        if (mapping) break;
        // Async queue failures do not necessarily trigger the menu's alert.
        // Observe the authoritative worker terminal status instead of waiting
        // an hour on a failed/cancelled job (or starting another paid request).
        const jobs = PathUtils.join(PathUtils.profileDir, "paralens-jobs");
        if (await IOUtils.exists(jobs)) {
          for (const job of await IOUtils.getChildren(jobs)) {
            const errorPath = PathUtils.join(job, "error.json");
            if (!(await IOUtils.exists(errorPath))) continue;
            const status = (await IOUtils.readJSON(errorPath)) as {
              code?: string;
            };
            const code =
              typeof status.code === "string" &&
              /^(api_auth|api_rate_limit|api_connection|api_timeout|api_request|api_server|translation_incomplete|translation_failed|mapping_failed|publish_failed|backend_load_failed|model_load_failed|memory_exhausted|storage_failure|file_missing|pdf_invalid|cancelled)$/.test(
                status.code,
              )
                ? status.code
                : "unknown";
            checkpoint("worker terminal failure: " + code);
            throw new Error("Real provider worker did not complete");
          }
        }
        await Zotero.Promise.delay(250);
      }
      checkpoint("translation returned");
      if (complex) {
        const jobs = PathUtils.join(PathUtils.profileDir, "paralens-jobs");
        const children = await IOUtils.getChildren(jobs);
        assert.lengthOf(children, 1);
        const quality = (await IOUtils.readJSON(
          PathUtils.join(children[0], "translation-quality.json"),
        )) as { checked: number; repaired: number; remaining: number };
        assert.isAbove(quality.checked, 0);
        assert.equal(
          quality.remaining,
          0,
          "All substantial untranslated prose must be repaired before publication",
        );
        checkpoint("prose quality checked, repaired=" + quality.repaired);
      }
      assert.isDefined(mapping);
      const aligned = mapping!.segments.filter(
        (segment) => segment.status === "aligned",
      );
      assert.isAtLeast(aligned.length, complex ? 200 : twoPages ? 2 : 1);
      if (complex) {
        assert.isAbove(mapping!.source.pageCount, 2);
        assert.equal(
          mapping!.source.pageCount,
          Number(Services.env.get("PARALENS_COMPLEX_EXPECTED_PAGES")),
        );
        assert.isAbove(mapping!.target.pageCount, 0);
        assert.lengthOf(
          item.getAttachments(),
          3,
          "source, translated PDF and mapping must all be committed",
        );
        checkpoint("complex source and translated attachments committed");
      }
      if (twoPages) {
        assert.equal(mapping!.source.pageCount, 2);
        assert.equal(mapping!.target.pageCount, 2);
        for (const pageIndex of [0, 1]) {
          assert.isTrue(
            aligned.some(
              (segment) =>
                segment.source.some((ref) => ref.pageIndex === pageIndex) &&
                segment.target.some((ref) => ref.pageIndex === pageIndex),
            ),
            `page ${pageIndex + 1} needs an aligned paragraph`,
          );
        }
      }
      const target = await Zotero.Items.getByLibraryAndKeyAsync(
        source.libraryID,
        mapping!.target.attachmentKey,
      );
      assert.isOk(target);
      if (!target) throw new Error("Translated attachment missing");
      assert.isTrue(target.isPDFAttachment());
      const translatedText = async (index: number) => {
        for (let i = 0; i < 70; i++) {
          const reader = Zotero.Reader._readers.find(
            (r) => r.itemID === target?.id,
          ) as unknown as
            | {
                _internalReader?: {
                  _primaryView?: {
                    _iframeWindow?: Window & {
                      PDFViewerApplication?: {
                        pdfViewer?: {
                          currentPageNumber: number;
                          getPageView(n: number): {
                            pdfPage?: {
                              getTextContent(): Promise<{
                                items: Array<{ str: string }>;
                              }>;
                            };
                          };
                        };
                      };
                    };
                  };
                };
              }
            | undefined;
          const viewer =
            reader?._internalReader?._primaryView?._iframeWindow
              ?.PDFViewerApplication?.pdfViewer;
          if (viewer && index > 0) viewer.currentPageNumber = index + 1;
          const page = viewer?.getPageView(index)?.pdfPage;
          if (page) {
            const text = (await page.getTextContent()).items
              .map((piece) => piece.str)
              .join("");
            if (text) return text;
          }
          await Zotero.Promise.delay(200);
        }
        assert.fail("No text layer on translated page " + (index + 1));
        return "";
      };
      const first = await translatedText(0);
      assert.match(first, /[\u3400-\u9fff]/, "First page lacks Chinese text");
      if (complex) {
        let chinesePages = 0;
        for (let index = 0; index < mapping!.target.pageCount; index++) {
          const text = index === 0 ? first : await translatedText(index);
          if (/[\u3400-\u9fff]/.test(text)) chinesePages++;
        }
        assert.isAtLeast(
          chinesePages,
          Math.ceil(mapping!.target.pageCount * 0.8),
          "Chinese text must cover the document, not just its first page",
        );
        checkpoint(
          `Chinese text verified on ${chinesePages}/${mapping!.target.pageCount} pages`,
        );
      }
      assert.notInclude(first.toLowerCase(), "the river flows gently");
      if (twoPages) {
        const second = await translatedText(1);
        assert.match(
          second,
          /[\u3400-\u9fff]/,
          "Second page lacks Chinese text",
        );
        assert.notInclude(second.toLowerCase(), "the ocean is calm today");
      }
      (window as unknown as { debug?: (s: string) => void }).debug?.(
        `Real provider PDF translation: ${aligned.length} aligned segments; Chinese text layer confirmed`,
      );
      succeeded = true;
    } finally {
      if (!succeeded) {
        const cancel = win.document.getElementById(
          "paralens-cancel-translation",
        );
        if (cancel) {
          const event = win.document.createEvent("Event");
          event.initEvent("command", true, false);
          cancel.dispatchEvent(event);
          // The provider may still have one request in flight. Do not silently
          // leave a timed-out test with a running billable worker.
          const root = PathUtils.join(PathUtils.profileDir, "paralens-jobs");
          if (await IOUtils.exists(root)) {
            for (const job of await IOUtils.getChildren(root)) {
              if (
                !(await IOUtils.exists(PathUtils.join(job, "result.json"))) &&
                !(await IOUtils.exists(PathUtils.join(job, "error.json")))
              )
                await IOUtils.writeUTF8(PathUtils.join(job, "cancel"), "");
            }
          }
        }
      }
      win.confirm = originalConfirm;
      win.alert = originalAlert;
      for (const [key, value] of Object.entries(old))
        setPref(key as keyof typeof old, value);
    }
  });
});
