import { version as pluginVersion } from "../../package.json";
import { log } from "../utils/log";
import { translationPerformance } from "./performance";
import {
  describeJobFailure,
  describeJobDiagnostics,
  describeWorkerDiagnostics,
  diagnosticLabel,
} from "./jobError";
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
import { normalizeWorkerProgress } from "./progress";

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
  readonly version = "0.6.4";
  private job?: string;
  private cancelRequested = false;

  constructor(
    private readonly projectDir: string = bundledBackendProjectDir(),
    private readonly uvStatus: () => import("./uv").UVStatus | undefined = () =>
      addon.data.uv,
  ) {}

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    log("收到翻译取消请求");
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
    const started = Date.now();
    const prefix = "[" + PathUtils.filename(job) + "] ";
    const jobLog = (message: string) => log(prefix + message, [apiKey]);
    jobLog(
      "开始 BabelDOC 翻译；后端版本=" +
        this.version +
        "；插件版本=" +
        pluginVersion +
        "；服务=" +
        selected.provider +
        "；模型=" +
        diagnosticLabel(selected.model) +
        "；API 主机=" +
        new URL(selected.baseURL).origin +
        "；语言=" +
        diagnosticLabel(request.sourceLanguage) +
        "→" +
        diagnosticLabel(request.targetLanguage) +
        "；并发=" +
        performance.concurrency +
        "；QPS=" +
        performance.qps +
        "；自动补译=" +
        (request.autoRepair === true),
    );
    jobLog("作业诊断目录=" + job);
    let lastLoggedPercent = -1;
    let lastObservedPercent = -1;
    let lastLoggedStage = "";
    let frontendStep = "写入作业配置";
    try {
      await IOUtils.writeJSON(configFile, {
        sourcePath: PathUtils.normalize(request.sourcePath),
        jobDirectory: job,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        model: selected.model,
        baseURL: selected.baseURL,
        apiKey,
        pluginVersion,
        autoRepair: request.autoRepair === true,
        ...performance,
      });
      // Cancel before spawning any worker if the UI requested it during setup.
      if (this.cancelRequested) throw new TranslationCancelledError();
      // The worker atomically updates progress.json. Never read its private config again.
      frontendStep = "运行翻译后端";
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
      let observed: TranslationJobProgress | undefined;
      let stageStarted = Date.now();
      let lastHeartbeat = Date.now();
      let readFailures = 0;
      const readDiagnostics = async () => {
        const diagnosticsPath = PathUtils.join(job, "diagnostics.json");
        try {
          if (await IOUtils.exists(diagnosticsPath))
            jobLog(
              "后端统计=" +
                describeWorkerDiagnostics(
                  await IOUtils.readJSON(diagnosticsPath),
                ),
            );
        } catch {
          jobLog("无法读取后端统计；未记录原始内容");
        }
      };
      const readProgress = async (final = false) => {
        const path = PathUtils.join(job, "progress.json");
        try {
          if (await IOUtils.exists(path)) {
            const raw = await IOUtils.readUTF8(path);
            if (raw !== last) {
              last = raw;
              const update = normalizeWorkerProgress(JSON.parse(raw), observed);
              observed = update;
              const stage = diagnosticLabel(update.stage);
              const percent =
                typeof update.percent === "number" &&
                Number.isFinite(update.percent)
                  ? Math.max(0, Math.min(100, Math.floor(update.percent)))
                  : undefined;
              if (percent !== undefined) lastObservedPercent = percent;
              if (
                final ||
                stage !== lastLoggedStage ||
                (percent !== undefined && percent >= lastLoggedPercent + 5)
              ) {
                const counter = (value: unknown) =>
                  typeof value === "number" &&
                  Number.isSafeInteger(value) &&
                  value >= 0
                    ? String(value)
                    : "?";
                const stageChanged = stage !== lastLoggedStage;
                const stageElapsed = stageChanged
                  ? 0
                  : Date.now() - stageStarted;
                if (stageChanged && lastLoggedStage)
                  jobLog(
                    "阶段结束=" +
                      lastLoggedStage +
                      "；耗时=" +
                      (Date.now() - stageStarted) +
                      "ms",
                  );
                jobLog(
                  "BabelDOC 翻译进度：" +
                    (percent === undefined ? "未知" : percent + "%") +
                    "；阶段=" +
                    stage +
                    "；完成=" +
                    counter(update.completed) +
                    "/" +
                    counter(update.total) +
                    "；阶段耗时=" +
                    stageElapsed +
                    "ms" +
                    "；作业耗时=" +
                    (Date.now() - started) +
                    "ms",
                );
                if (stageChanged) stageStarted = Date.now();
                lastLoggedStage = stage;
                if (percent !== undefined) lastLoggedPercent = percent;
              }
              try {
                onProgress?.({
                  stage: update.stage,
                  completed: update.completed,
                  total: update.total,
                  percent: update.percent,
                });
              } catch {
                /* Closing a UI must not interrupt the worker or its diagnostics. */
              }
            }
          }
        } catch {
          readFailures++;
          if (readFailures === 1 || readFailures % 20 === 0)
            jobLog(
              "无法读取或解析 progress.json；失败次数=" +
                readFailures +
                "；继续等待后端；未记录原始内容",
            );
        }
      };
      while (!finished) {
        await readProgress();
        if (Date.now() - lastHeartbeat >= 15000) {
          jobLog(
            "后端仍在运行；阶段=" +
              (lastLoggedStage || "等待进度") +
              "；进度=" +
              (lastObservedPercent < 0 ? "未知" : lastObservedPercent + "%") +
              "；阶段耗时=" +
              (Date.now() - stageStarted) +
              "ms" +
              "；作业耗时=" +
              (Date.now() - started) +
              "ms",
          );
          await readDiagnostics();
          lastHeartbeat = Date.now();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      // Capture a final stage written immediately before the process exits.
      await readProgress(true);
      await readDiagnostics();
      // Wait for the child to exit rather than detaching a potentially
      // billable subprocess. Never import a result after cancellation.
      if (this.cancelRequested) throw new TranslationCancelledError();
      let failureDetail: unknown;
      if (failure) {
        try {
          failureDetail = await IOUtils.readJSON(
            PathUtils.join(job, "error.json"),
          );
          jobLog(describeJobFailure(failureDetail));
          jobLog("后端失败诊断=" + describeJobDiagnostics(failureDetail));
        } catch {
          jobLog(
            "无法读取 error.json；后端可能异常退出或未写入诊断；最后阶段=" +
              lastLoggedStage,
          );
        }
      }
      const resultPath = PathUtils.join(job, "result.json");
      if (!(await IOUtils.exists(resultPath))) {
        jobLog("未生成 result.json；最后阶段=" + lastLoggedStage);
        throw new Error(
          failure
            ? describeJobFailure(failureDetail)
            : "BabelDOC 未写入作业结果",
        );
      }
      frontendStep = "读取作业结果";
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
      frontendStep = "校验输出文件位置";
      jobLog("开始校验译文文件、段落映射和 PDF 摘要");
      const pdf = PathUtils.join(job, "translated.pdf");
      const draft = PathUtils.join(job, "mapping.v1.json");
      if (
        result.translatedPdfPath !== pdf ||
        result.mappingDraftPath !== draft ||
        !(await IOUtils.exists(pdf))
      ) {
        throw new Error("BabelDOC 输出文件位置不合法或不存在");
      }
      frontendStep = "校验段落映射";
      const mapping = (await IOUtils.readJSON(draft)) as UnboundMappingV1;
      // Validate untrusted worker output without binding arbitrary Zotero attachment keys.
      validateMapping({
        ...mapping,
        source: { ...mapping.source, attachmentKey: "source" },
        target: { ...mapping.target, attachmentKey: "target" },
      });
      frontendStep = "校验 PDF 摘要";
      if (
        (await IOUtils.computeHexDigest(pdf, "sha256")).toLowerCase() !==
          mapping.target.sha256 ||
        (
          await IOUtils.computeHexDigest(request.sourcePath, "sha256")
        ).toLowerCase() !== mapping.source.sha256
      ) {
        throw new Error("BabelDOC 输出摘要与 PDF 不一致");
      }
      jobLog(
        (result.completion === "partial"
          ? "BabelDOC 返回部分译文"
          : "BabelDOC 翻译完成") +
          "；映射段落数=" +
          mapping.segments.length +
          "；可信映射=" +
          mapping.segments.filter((segment) => segment.status === "aligned")
            .length +
          "；不确定映射=" +
          mapping.segments.filter((segment) => segment.status === "uncertain")
            .length +
          "；原文页数=" +
          mapping.source.pageCount +
          "；译文页数=" +
          mapping.target.pageCount +
          "；耗时=" +
          (Date.now() - started) +
          "ms",
      );
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
    } catch (error) {
      jobLog(
        (this.cancelRequested ? "BabelDOC 翻译已取消" : "BabelDOC 翻译失败") +
          "；前端步骤=" +
          frontendStep +
          "；最后阶段=" +
          (lastLoggedStage || "尚无进度") +
          "；进度=" +
          (lastObservedPercent < 0 ? "未知" : lastObservedPercent + "%") +
          "；异常类型=" +
          diagnosticLabel(error instanceof Error ? error.name : undefined) +
          "；耗时=" +
          (Date.now() - started) +
          "ms",
      );
      throw error;
    } finally {
      this.job = undefined;
      await IOUtils.remove(configFile, { ignoreAbsent: true });
    }
  }
}
