import {
  BabelDocBackend,
  createBabelDocJobDirectory,
  TranslationCancelledError,
} from "../backend/babeldoc";
import { resolveBackend } from "../backend/selection";
import { isBackendInstalled } from "../backend/installationStatus";
import { bindAttachmentKeys } from "../mapping/validation";
import { loadMapping, saveMapping } from "../mapping/store";
import { MappingV1 } from "../mapping/types";
import { getPref } from "../utils/prefs";
import { NativeReaderPair, NativeReaderLike } from "./nativeOverlay";

const activePairs = new Map<string, NativeReaderPair>();
let activeBackend: BabelDocBackend | undefined;
let workerRunning = false;
let cancelRequested = false;
let showCancellationMessage: (() => void) | undefined;

export function isTranslationCancellable(): boolean {
  return Boolean(activeBackend && workerRunning && !cancelRequested);
}

/** Only cancel the active worker. Never interrupt an attachment import. */
export async function cancelActiveTranslation(): Promise<boolean> {
  if (!isTranslationCancellable()) return false;
  cancelRequested = true;
  showCancellationMessage?.();
  await activeBackend!.cancel();
  return true;
}

/** Require an unambiguous PDF. A bibliographic item with multiple PDFs needs an explicit choice. */
export async function selectedSourceAttachment(
  items: Zotero.Item[],
): Promise<Zotero.Item> {
  if (items.length !== 1)
    throw new Error("请只选中一个 PDF 附件或一条文献记录");
  const item = items[0];
  if (item.isPDFAttachment()) return item;
  if (!item.isRegularItem()) throw new Error("请选择 PDF 附件");
  const attachments = await Zotero.Items.getAsync(item.getAttachments());
  const pdfs = attachments.filter((attachment) => attachment.isPDFAttachment());
  if (pdfs.length !== 1) throw new Error("请在该条目下明确选中一个 PDF 附件");
  return pdfs[0];
}

export function translatedAttachmentTitle(
  sourceTitle: string,
  targetLanguage: string,
  retranslatedAt?: Date,
): string {
  const language = targetLanguage === "en" ? "英文译文" : "中文译文";
  const version = retranslatedAt
    ? " · " +
      retranslatedAt.toISOString().replace("T", " ").replace("Z", " UTC")
    : "";
  return sourceTitle + "（ParaLens " + language + version + "）";
}

function progressWindow(win: Window): Zotero.ProgressWindow {
  const progress = new Zotero.ProgressWindow({ window: win });
  progress.changeHeadline("ParaLens · 翻译 PDF");
  progress.show();
  return progress;
}

async function assertReady(): Promise<void> {
  const selected = getPref("backend") || "babeldoc";
  if (resolveBackend(selected).id !== selected || selected !== "babeldoc")
    throw new Error("不支持的翻译后端");
  if (!addon.data.backendProjectDir || !addon.data.uv?.available)
    throw new Error("请先在 ParaLens 设置中安装后端并检测 uv");
  if (
    !(await isBackendInstalled(
      addon.data.backendProjectDir,
      Services.appinfo.OS === "WINNT",
      (path) => IOUtils.exists(path),
      async (path, args) =>
        (await Zotero.Utilities.Internal.exec(path, args)) === true,
    ))
  )
    throw new Error(
      "BabelDOC 尚未安装或版本不正确；请到 ParaLens 设置点击安装后端",
    );
}

/** User-initiated, potentially billable translation; never called from startup. */
export async function translateSelection(
  win: Window,
  items: Zotero.Item[],
): Promise<void> {
  if (activeBackend) throw new Error("已有翻译任务正在运行");
  const source = await selectedSourceAttachment(items);
  const sourcePath = await source.getFilePathAsync();
  if (!sourcePath) throw new Error("找不到本地 PDF；请先下载附件");
  await assertReady();
  const sourceLanguage = getPref("sourceLanguage") || "en";
  const targetLanguage = getPref("targetLanguage") || "zh";
  if (
    !["en", "zh"].includes(sourceLanguage) ||
    !["en", "zh"].includes(targetLanguage) ||
    sourceLanguage === targetLanguage
  )
    throw new Error("请在设置中选择不同的原文和译文语言");
  // Re-running a billable job must not silently replace the active mapping
  // while creating a second attachment with exactly the same visible title.
  let existingTranslation = false;
  let unreadableMapping = false;
  let existing: MappingV1 | undefined;
  try {
    existing = await loadMapping(source.libraryID, source.key);
  } catch {
    // A damaged mapping can be repaired by retranslation, but the user must
    // explicitly accept replacement instead of paying for a silent retry.
    unreadableMapping = true;
  }
  if (existing) {
    // Do not disguise Zotero database errors as a damaged mapping: fail
    // before a paid request if the old attachment lookup cannot complete.
    const previous = await Zotero.Items.getByLibraryAndKeyAsync(
      source.libraryID,
      existing.target.attachmentKey,
    );
    existingTranslation = Boolean(previous && previous.isPDFAttachment());
  }
  const confirmation = unreadableMapping
    ? "旧的双语映射无法读取。重新翻译可能产生费用，并会覆盖旧映射；已有附件不会删除。继续？"
    : existingTranslation
      ? "此 PDF 已有 ParaLens 译文。重新翻译会再次调用 API、可能产生费用；新译文将成为默认对照，旧译文附件仍会保留。继续？"
      : "ParaLens 将调用你配置的翻译 API，可能产生费用。确认翻译此 PDF？";
  if (!win.confirm(confirmation)) return;
  const progress = progressWindow(win);
  const line = new progress.ItemProgress("", "准备翻译…");
  const backend = new BabelDocBackend(addon.data.backendProjectDir);
  activeBackend = backend;
  cancelRequested = false;
  let importedTarget: Zotero.Item | undefined;
  let mappingSaved = false;
  try {
    const jobDirectory = await createBabelDocJobDirectory();
    workerRunning = true;
    showCancellationMessage = () =>
      line.setText(
        "正在等待当前请求结束后取消；已发送的 API 请求可能仍产生费用",
      );
    let result;
    try {
      result = await backend.translate(
        {
          sourcePath,
          jobDirectory,
          sourceLanguage,
          targetLanguage,
        },
        (status) => {
          if (cancelRequested) return;
          const done = status.completed ?? 0;
          const total = status.total ?? 0;
          line.setText(
            status.stage + (total > 0 ? " (" + done + "/" + total + ")" : ""),
          );
          if (total > 0) line.setProgress(Math.round((done / total) * 85));
        },
      );
    } finally {
      workerRunning = false;
      showCancellationMessage = undefined;
    }
    if (cancelRequested) throw new TranslationCancelledError();
    if (!addon.data.alive) return;
    line.setText("正在导入译文 PDF…");
    const target = await Zotero.Attachments.importFromFile({
      file: result.translatedPdfPath,
      parentItemID: source.parentItemID || undefined,
      libraryID: source.libraryID,
      title: translatedAttachmentTitle(
        source.getDisplayTitle(),
        targetLanguage,
        existingTranslation || unreadableMapping ? new Date() : undefined,
      ),
      contentType: "application/pdf",
    });
    importedTarget = target;
    const targetPath = await target.getFilePathAsync();
    if (
      !targetPath ||
      (await IOUtils.computeHexDigest(targetPath, "sha256")).toLowerCase() !==
        result.mapping.target.sha256
    ) {
      throw new Error("译文附件校验失败；请检查导入的 PDF");
    }
    const mapping = bindAttachmentKeys(result.mapping, source.key, target.key);
    await saveMapping(mapping, source.libraryID);
    mappingSaved = true;
    line.setProgress(100);
    const aligned = mapping.segments.filter(
      (item) => item.status === "aligned",
    ).length;
    if (aligned === 0) {
      // The translation is still valuable, but an empty/uncertain mapping
      // must never masquerade as a working bilingual hover pair.
      line.setText("译文已导入，但未能定位可悬停的段落；请直接阅读译文 PDF");
      try {
        await Zotero.Reader.open(target.id);
      } catch {
        // The imported attachment remains accessible in the item pane.
      }
      progress.startCloseTimer(16000);
      return;
    }
    line.setText(
      aligned === mapping.segments.length
        ? "翻译已完成：译文已导入 Zotero"
        : "译文已导入：可对照 " +
            aligned +
            "/" +
            mapping.segments.length +
            " 个段落",
    );
    // Show actual Zotero Readers, not a second PDF.js instance.
    try {
      const paired = await openBilingual(mapping, source.libraryID);
      if (!paired)
        line.setText(
          "译文已导入；当前 Reader 不支持双语悬停，可分别阅读两侧 PDF",
        );
    } catch {
      line.setText(
        "译文已导入；无法自动打开 Reader，请在 Zotero 中手动打开译文附件",
      );
    }
    progress.startCloseTimer(9000);
  } catch (error) {
    if (cancelRequested || error instanceof TranslationCancelledError) {
      line.setText("翻译已取消；已发送的 API 请求可能仍产生费用");
      progress.startCloseTimer(12000);
      return;
    }
    // Only a successfully committed mapping makes this attachment a usable
    // translation. Roll back a newly imported orphan without masking the
    // original PDF validation or mapping persistence failure.
    if (importedTarget && !mappingSaved) {
      try {
        await importedTarget.eraseTx();
      } catch {
        Zotero.debug(
          "[ParaLens] Could not remove the incomplete translation attachment",
        );
      }
    }
    line.setError();
    line.setText(error instanceof Error ? error.message : "翻译失败");
    progress.startCloseTimer(16000);
    throw error;
  } finally {
    activeBackend = undefined;
    workerRunning = false;
    showCancellationMessage = undefined;
    cancelRequested = false;
  }
}

export async function openBilingual(
  mapping: MappingV1,
  libraryID: number,
): Promise<boolean> {
  const source = await Zotero.Items.getByLibraryAndKeyAsync(
    libraryID,
    mapping.source.attachmentKey,
  );
  const target = await Zotero.Items.getByLibraryAndKeyAsync(
    libraryID,
    mapping.target.attachmentKey,
  );
  if (
    !source ||
    !target ||
    !source.isPDFAttachment() ||
    !target.isPDFAttachment()
  )
    throw new Error("原文或译文附件已不存在");
  const sourcePath = await source.getFilePathAsync();
  const targetPath = await target.getFilePathAsync();
  if (
    !sourcePath ||
    !targetPath ||
    (await IOUtils.computeHexDigest(sourcePath, "sha256")).toLowerCase() !==
      mapping.source.sha256 ||
    (await IOUtils.computeHexDigest(targetPath, "sha256")).toLowerCase() !==
      mapping.target.sha256
  )
    throw new Error("PDF 内容已变更，请重新翻译后再打开双语对照");
  await Zotero.Reader.open(source.id);
  await Zotero.Reader.open(target.id, undefined, { openInWindow: true });
  const pairKey = `${libraryID}:${mapping.source.attachmentKey}`;
  const old = activePairs.get(pairKey);
  old?.detach();
  activePairs.delete(pairKey);
  for (let i = 0; i < 20; i++) {
    const readers = Zotero.Reader._readers;
    const sourceReader = readers.find((reader) => reader.itemID === source.id);
    const targetReader = readers.find((reader) => reader.itemID === target.id);
    if (sourceReader && targetReader) {
      const pair = new NativeReaderPair(
        sourceReader as unknown as NativeReaderLike,
        targetReader as unknown as NativeReaderLike,
        mapping,
      );
      if (pair.attach()) {
        activePairs.set(pairKey, pair);
        return true;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  // The translation and both Reader tabs still work if Zotero's internal DOM changed.
  Zotero.debug("[ParaLens] Reader overlay unavailable on this Zotero version");
  return false;
}

export async function openSavedBilingual(items: Zotero.Item[]): Promise<void> {
  const source = await selectedSourceAttachment(items);
  const mapping = await loadMapping(source.libraryID, source.key);
  if (!mapping) throw new Error("此 PDF 尚无 ParaLens 译文");
  if (!mapping.segments.some((segment) => segment.status === "aligned"))
    throw new Error("译文未能定位可悬停的段落；请直接打开译文附件");
  if (!(await openBilingual(mapping, source.libraryID)))
    throw new Error("已打开原文和译文，但当前 Reader 不支持双语悬停");
}

export function detachBilingual(): void {
  for (const pair of activePairs.values()) pair.detach();
  activePairs.clear();
  void activeBackend?.cancel();
}
