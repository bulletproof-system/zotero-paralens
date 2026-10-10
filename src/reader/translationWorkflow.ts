import { translationPerformance } from "../backend/performance";
import { TranslationJobProgress } from "../backend/contracts";
import { executeHidden } from "../backend/process";
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
import {
  TranslationQueue,
  JobOptions,
  TranslationTask,
  TranslationTaskOutcome,
} from "./taskQueue";
import { showTaskQueue, closeTaskQueueWindows } from "./taskQueueUI";
import { resolveProviderConfig } from "../backend/providers";
import { tileReaderWindows } from "./windowLayout";

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
      async (path, args) => (await executeHidden(path, args)) === true,
    ))
  )
    throw new Error(
      "BabelDOC 尚未安装或版本不正确；请到 ParaLens 设置点击安装后端",
    );
}

let queue: TranslationQueue | undefined;
function optionsFromPreferences(): JobOptions {
  const selected = resolveProviderConfig(
    getPref("provider") || "openai",
    getPref("model") || "",
    getPref("customBaseURL") || "",
  );
  const sourceLanguage = getPref("sourceLanguage") || "en";
  const targetLanguage = getPref("targetLanguage") || "zh";
  if (
    !["en", "zh"].includes(sourceLanguage) ||
    !["en", "zh"].includes(targetLanguage) ||
    sourceLanguage === targetLanguage
  )
    throw new Error("请选择不同的中英翻译语言；OCR 暂不支持");
  return {
    backend: "babeldoc",
    ...translationPerformance(
      getPref("translationConcurrency"),
      getPref("translationQps"),
    ),
    sourceLanguage,
    targetLanguage,
    provider: selected.provider,
    model: selected.model,
    customBaseURL: selected.provider === "custom" ? selected.baseURL : "",
  };
}
export function translationQueue(): TranslationQueue {
  if (queue) return queue;
  const path = PathUtils.join(
    PathUtils.profileDir,
    "paralens",
    "translation-queue.json",
  );
  queue = new TranslationQueue(
    {
      read: async () =>
        (await IOUtils.exists(path)) ? IOUtils.readJSON(path) : undefined,
      write: async (tasks) => {
        await IOUtils.makeDirectory(PathUtils.parent(path)!, {
          createAncestors: true,
          ignoreExisting: true,
          permissions: 0o700,
        });
        await IOUtils.writeJSON(path, tasks, { tmpPath: path + ".tmp" });
      },
    },
    async (task, report) => {
      const source = await Zotero.Items.getByLibraryAndKeyAsync(
        task.libraryID,
        task.sourceKey,
      );
      if (!source || source.deleted || !source.isPDFAttachment())
        throw new Error("任务原文附件已删除");
      const win = Zotero.getMainWindow();
      if (!win) throw new Error("请先打开 Zotero 主窗口再重新开始任务");
      return translateAttachment(win, source, task.options, report);
    },
  );
  return queue;
}
export async function initializeTranslationQueue(): Promise<void> {
  await translationQueue().initialize(); // No jobs start on restore.
}
export async function openTranslationQueue(win: Window): Promise<void> {
  await showTaskQueue(
    win,
    translationQueue(),
    cancelActiveTranslation,
    async (task: TranslationTask) => {
      if (task.state === "partial" && task.targetKey) {
        const target = await Zotero.Items.getByLibraryAndKeyAsync(
          task.libraryID,
          task.targetKey,
        );
        if (!target || target.deleted || !target.isPDFAttachment())
          throw new Error("保留的译文附件已删除");
        await Zotero.Reader.open(target.id);
        return;
      }
      const source = await Zotero.Items.getByLibraryAndKeyAsync(
        task.libraryID,
        task.sourceKey,
      );
      if (!source) throw new Error("原文附件已删除");
      await openSavedBilingual([source]);
    },
  );
}
export async function selectedSourceAttachments(
  items: Zotero.Item[],
): Promise<Zotero.Item[]> {
  if (!items.length) throw new Error("请选择 PDF 附件或文献记录");
  const sources = new Map<string, Zotero.Item>();
  for (const item of items) {
    const source = await selectedSourceAttachment([item]);
    sources.set(source.libraryID + ":" + source.key, source);
  }
  return Array.from(sources.values());
}

/** One explicit batch confirmation authorizes the queued jobs, never restart-on-launch. */
export async function translateSelection(
  win: Window,
  items: Zotero.Item[],
): Promise<void> {
  const sources = await selectedSourceAttachments(items);
  await assertReady();
  const options = optionsFromPreferences();
  const running = translationQueue().snapshot();
  const additions = sources.filter(
    (source) =>
      !running.some(
        (task) =>
          task.libraryID === source.libraryID &&
          task.sourceKey === source.key &&
          ["queued", "running"].includes(task.state),
      ),
  );
  if (!additions.length) {
    await openTranslationQueue(win);
    return;
  }
  let existingTranslation = false;
  let unreadableMapping = false;
  for (const source of additions) {
    if (!(await source.getFilePathAsync()))
      throw new Error("找不到本地 PDF；请先下载附件");
    try {
      if (await loadMapping(source.libraryID, source.key))
        existingTranslation = true;
    } catch {
      unreadableMapping = true;
    }
  }
  const warning = unreadableMapping
    ? "旧的双语映射无法读取，新成功结果会覆盖旧映射；已有附件不会删除。"
    : existingTranslation
      ? "部分 PDF 已有 ParaLens 译文；新成功译文将成为默认对照，旧译文附件仍会保留。"
      : "";
  if (
    !win.confirm(
      "ParaLens 将调用你配置的翻译 API，可能产生费用。确认将 " +
        additions.length +
        " 个 PDF 加入串行任务队列？" +
        warning,
    )
  )
    return;
  await translationQueue().enqueue(
    additions.map((source) => ({
      libraryID: source.libraryID,
      sourceKey: source.key,
      title: source.getDisplayTitle(),
      options: { ...options, openReader: additions.length === 1 },
    })),
  );
  // Menu commands are fire-and-forget; callers/tests may await the entire batch.
  await translationQueue().waitForIdle();
}

async function translateAttachment(
  win: Window,
  source: Zotero.Item,
  options: JobOptions,
  report: (progress: TranslationJobProgress) => void,
): Promise<void | TranslationTaskOutcome> {
  if (activeBackend) throw new Error("已有翻译任务正在运行");
  const sourcePath = await source.getFilePathAsync();
  if (!sourcePath) throw new Error("找不到本地 PDF；请先下载附件");
  await assertReady();
  const { sourceLanguage, targetLanguage } = options;
  let existingTranslation = false;
  let unreadableMapping = false;
  try {
    existingTranslation = Boolean(
      await loadMapping(source.libraryID, source.key),
    );
  } catch {
    unreadableMapping = true;
  }
  const progress = progressWindow(win);
  const line = new progress.ItemProgress("", "准备翻译…");
  const backend = new BabelDocBackend(addon.data.backendProjectDir);
  activeBackend = backend;
  cancelRequested = false;
  let importedTarget: Zotero.Item | undefined;
  let validatedTarget = false;
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
          provider: options.provider,
          model: options.model,
          customBaseURL: options.customBaseURL,
          concurrency: options.concurrency,
          qps: options.qps,
        },
        (status) => {
          if (cancelRequested) return;
          report({ ...status, percent: Math.min(97, status.percent ?? 0) });
          const done = status.completed ?? 0;
          const total = status.total ?? 0;
          line.setText(
            status.stage + (total > 0 ? " (" + done + "/" + total + ")" : ""),
          );
          if (typeof status.percent === "number")
            line.setProgress(Math.round(Math.min(97, status.percent)));
        },
      );
    } finally {
      workerRunning = false;
      showCancellationMessage = undefined;
    }
    if (cancelRequested) throw new TranslationCancelledError();
    if (!addon.data.alive) return;
    line.setText("正在导入译文 PDF…");
    report({ stage: "导入译文 PDF", percent: 98 });
    const target = await Zotero.Attachments.importFromFile({
      file: result.translatedPdfPath,
      parentItemID: source.parentItemID || undefined,
      libraryID: source.libraryID,
      title:
        translatedAttachmentTitle(
          source.getDisplayTitle(),
          targetLanguage,
          existingTranslation || unreadableMapping ? new Date() : undefined,
        ) + (result.completion === "partial" ? "（部分翻译，需核对）" : ""),
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
    validatedTarget = true;
    if (result.completion === "partial") {
      const message =
        (result.warning || "部分内容未能完成翻译") +
        "；不完整译文已保留为附件，请人工核对。已有完整双语对照不会被替换。";
      report({ stage: "部分完成（译文已保留）", percent: 99, message });
      line.setError();
      line.setText(message);
      if (options.openReader !== false) {
        try {
          await Zotero.Reader.open(target.id);
        } catch {
          /* Attachment remains accessible in the item pane. */
        }
      }
      progress.startCloseTimer(16000);
      return { state: "partial", targetKey: target.key, message };
    }
    const mapping = bindAttachmentKeys(result.mapping, source.key, target.key);
    report({ stage: "保存映射附件", percent: 99 });
    await saveMapping(mapping, source.libraryID);
    line.setProgress(100);
    const aligned = mapping.segments.filter(
      (item) => item.status === "aligned",
    ).length;
    report({
      stage: "已完成",
      percent: 100,
      message:
        aligned === 0
          ? "译文已导入，但没有可信段落映射；可直接阅读译文 PDF。"
          : undefined,
    });
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
      return { state: "completed", targetKey: target.key };
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
    if (options.openReader === false) {
      line.setText("译文和映射已导入；可从任务队列打开双语对照");
      progress.startCloseTimer(5000);
      return { state: "completed", targetKey: target.key };
    }
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
    return { state: "completed", targetKey: target.key };
  } catch (error) {
    if (cancelRequested || error instanceof TranslationCancelledError) {
      line.setText("翻译已取消；已发送的 API 请求可能仍产生费用");
      progress.startCloseTimer(12000);
      throw new TranslationCancelledError();
    }
    // Mapping/postprocessing failures must not destroy an already validated
    // PDF. It remains readable, but is never presented as a complete hover pair.
    if (importedTarget && validatedTarget) {
      const message =
        (error instanceof Error ? error.message : "保存段落映射失败") +
        "；译文 PDF 已保留为附件，但双语映射未完成，请人工核对。";
      report({ stage: "部分完成（译文已保留）", percent: 99, message });
      line.setError();
      line.setText(message);
      progress.startCloseTimer(16000);
      return { state: "partial", targetKey: importedTarget.key, message };
    }
    // Invalid/corrupt imported bytes are not a safe artifact to retain as a
    // translation. The worker's local job files are left intact for diagnosis.
    if (importedTarget && !validatedTarget) {
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
  const openedSource = await Zotero.Reader.open(source.id, undefined, {
    openInWindow: true,
  });
  const openedTarget = await Zotero.Reader.open(target.id, undefined, {
    openInWindow: true,
  });
  const pairKey = `${libraryID}:${mapping.source.attachmentKey}`;
  const old = activePairs.get(pairKey);
  old?.detach();
  activePairs.delete(pairKey);
  for (let i = 0; i < 80; i++) {
    const readers = Zotero.Reader._readers;
    const sourceReader =
      openedSource || readers.find((reader) => reader.itemID === source.id);
    const targetReader =
      openedTarget || readers.find((reader) => reader.itemID === target.id);
    if (sourceReader && targetReader) {
      const pair = new NativeReaderPair(
        sourceReader as unknown as NativeReaderLike,
        targetReader as unknown as NativeReaderLike,
        mapping,
      );
      if (pair.attach()) {
        tileReaderWindows(sourceReader, targetReader);
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
  void activeBackend?.cancel().catch(() => {});
  void queue?.stop().catch(() => {});
  closeTaskQueueWindows();
}
