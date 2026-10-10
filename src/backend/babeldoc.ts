import { translationPerformance } from "./performance";
import { describeJobFailure } from "./jobError";
import { bundledBackendProjectDir } from "./install";
import {
  TranslationBackend,
  TranslationJobRequest,
  TranslationJobResult,
  TranslationJobProgress,
} from "./contracts";
import { readAPIKey } from "./credentials";
import { resolveProviderConfig } from "./providers";
import { runUVWorker } from "./uvRunner";
import { validateMapping } from "../mapping/validation";
import { UnboundMappingV1 } from "../mapping/types";
import { getPref } from "../utils/prefs";

const root = () => PathUtils.join(PathUtils.profileDir, "paralens-jobs");

/** Job files live under the private Zotero profile, never in the PDF directory. */
export async function createBabelDocJobDirectory(): Promise<string> {
  await IOUtils.makeDirectory(root(), {
    ignoreExisting: true,
    permissions: 0o700,
  });
  return IOUtils.createUniqueDirectory(root(), "job-", 0o700);
}

/** Cancellation is cooperative: an in-flight provider call may still be billed. */
export class TranslationCancelledError extends Error {
  constructor() {
    super("翻译已取消；已发送的 API 请求可能仍产生费用");
    this.name = "TranslationCancelledError";
  }
}

/** A job runs only after the caller supplies an installed backend project path.
 * No download/sync or external service starts implicitly. */
export class BabelDocBackend implements TranslationBackend {
  readonly id = "babeldoc";
  readonly version = "0.5.20";
  private job?: string;
  private cancelRequested = false;

  constructor(
    private readonly projectDir: string = bundledBackendProjectDir(),
    private readonly uvStatus: () => import("./uv").UVStatus | undefined = () =>
      addon.data.uv,
  ) {}

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.job)
      await IOUtils.writeUTF8(PathUtils.join(this.job, "cancel"), "");
  }

  async translate(
    request: TranslationJobRequest,
    onProgress?: (progress: TranslationJobProgress) => void,
  ): Promise<TranslationJobResult> {
    if (this.job) throw new Error("已有 BabelDOC 作业正在运行");
    if (this.cancelRequested) throw new TranslationCancelledError();
    const project = PathUtils.normalize(this.projectDir);
    const job = PathUtils.normalize(request.jobDirectory);
    if (
      !PathUtils.isAbsolute(project) ||
      !PathUtils.isAbsolute(request.sourcePath) ||
      PathUtils.parent(job) !== root() ||
      !PathUtils.filename(job).startsWith("job-")
    ) {
      throw new Error(
        "项目、PDF 或作业目录不合法；请使用 createBabelDocJobDirectory",
      );
    }
    if (
      !(await IOUtils.exists(job)) ||
      (await IOUtils.getChildren(job)).length
    ) {
      throw new Error("作业目录不存在或不是空目录");
    }
    if (
      !(await IOUtils.exists(request.sourcePath)) ||
      !request.sourcePath.toLowerCase().endsWith(".pdf")
    ) {
      throw new Error("原文必须是现有 PDF");
    }
    const selected = resolveProviderConfig(
      request.provider ?? getPref("provider") ?? "openai",
      request.model ?? getPref("model") ?? "",
      request.customBaseURL ?? getPref("customBaseURL") ?? "",
    );
    const performance = translationPerformance(
      request.concurrency ?? getPref("translationConcurrency"),
      request.qps ?? getPref("translationQps"),
    );
    const apiKey = await readAPIKey(selected.provider);
    if (this.cancelRequested) throw new TranslationCancelledError();
    if (!apiKey) throw new Error("请先在 ParaLens 设置中保存翻译 API Key");
    const configFile = await IOUtils.createUniqueFile(job, "config-", 0o600);
    this.job = job;
    try {
      await IOUtils.writeJSON(configFile, {
        sourcePath: PathUtils.normalize(request.sourcePath),
        jobDirectory: job,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        model: selected.model,
        baseURL: selected.baseURL,
        apiKey,
        ...performance,
      });
      // Cancel before spawning any worker if the UI requested it during setup.
      if (this.cancelRequested) throw new TranslationCancelledError();
      // The worker atomically updates progress.json. Never read its private config again.
      const process = runUVWorker(
        this.uvStatus(),
        project,
        PathUtils.join(project, "worker.py"),
        configFile,
      );
      let finished = false;
      let failure: unknown;
      void process.then(
        () => {
          finished = true;
        },
        (error) => {
          failure = error;
          finished = true;
        },
      );
      let last = "";
      while (!finished) {
        if (onProgress) {
          const path = PathUtils.join(job, "progress.json");
          if (await IOUtils.exists(path)) {
            try {
              const raw = await IOUtils.readUTF8(path);
              if (raw !== last) {
                last = raw;
                const update = JSON.parse(raw) as TranslationJobProgress;
                onProgress({
                  stage: update.stage,
                  completed: update.completed,
                  total: update.total,
                  percent: update.percent,
                });
              }
            } catch {
              /* A callback failure must not interrupt the child process. */
            }
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      // Wait for the child to exit rather than detaching a potentially
      // billable subprocess. Never import a result after cancellation.
      if (this.cancelRequested) throw new TranslationCancelledError();
      let failureDetail: unknown;
      if (failure) {
        try {
          failureDetail = await IOUtils.readJSON(
            PathUtils.join(job, "error.json"),
          );
        } catch {
          /* Older workers/abrupt exits may have no structured error. */
        }
      }
      const resultPath = PathUtils.join(job, "result.json");
      if (!(await IOUtils.exists(resultPath)))
        throw new Error(
          failure
            ? describeJobFailure(failureDetail)
            : "BabelDOC 未写入作业结果",
        );
      const result = (await IOUtils.readJSON(resultPath)) as {
        translatedPdfPath: string;
        mappingDraftPath: string;
        completion?: unknown;
        warning?: unknown;
      };
      if (failure && result.completion !== "partial")
        throw new Error(describeJobFailure(failureDetail));
      if (result.completion !== undefined && result.completion !== "partial")
        throw new Error("BabelDOC 结果完成状态不合法");
      const pdf = PathUtils.join(job, "translated.pdf");
      const draft = PathUtils.join(job, "mapping.v1.json");
      if (
        result.translatedPdfPath !== pdf ||
        result.mappingDraftPath !== draft ||
        !(await IOUtils.exists(pdf))
      ) {
        throw new Error("BabelDOC 输出文件位置不合法或不存在");
      }
      const mapping = (await IOUtils.readJSON(draft)) as UnboundMappingV1;
      // Validate untrusted worker output without binding arbitrary Zotero attachment keys.
      validateMapping({
        ...mapping,
        source: { ...mapping.source, attachmentKey: "source" },
        target: { ...mapping.target, attachmentKey: "target" },
      });
      if (
        (await IOUtils.computeHexDigest(pdf, "sha256")).toLowerCase() !==
          mapping.target.sha256 ||
        (
          await IOUtils.computeHexDigest(request.sourcePath, "sha256")
        ).toLowerCase() !== mapping.source.sha256
      ) {
        throw new Error("BabelDOC 输出摘要与 PDF 不一致");
      }
      return {
        translatedPdfPath: pdf,
        mappingDraftPath: draft,
        mapping,
        completion: result.completion === "partial" ? "partial" : undefined,
        warning:
          result.completion === "partial"
            ? describeJobFailure(result.warning || failureDetail)
            : undefined,
      };
    } finally {
      this.job = undefined;
      await IOUtils.remove(configFile, { ignoreAbsent: true });
    }
  }
}
