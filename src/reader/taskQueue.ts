import { translationPerformance } from "../backend/performance";
import { TranslationJobProgress } from "../backend/contracts";
import { resolveProviderConfig } from "../backend/providers";

export type JobState =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface JobOptions {
  backend: "babeldoc";
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  model: string;
  customBaseURL: string;
  concurrency?: number;
  qps?: number;
  openReader?: boolean;
  autoRepair?: boolean;
}
export interface TranslationTask {
  id: string;
  libraryID: number;
  sourceKey: string;
  title: string;
  state: JobState;
  options: JobOptions;
  createdAt: string;
  updatedAt: string;
  progress?: TranslationJobProgress;
  error?: string;
  /** A retained Zotero PDF attachment, never a filesystem path or secret. */
  targetKey?: string;
}
export interface TranslationTaskOutcome {
  state: "completed" | "partial";
  targetKey?: string;
  message?: string;
}
export interface QueueStorage {
  read(): Promise<unknown>;
  write(tasks: TranslationTask[]): Promise<void>;
}

/** Persistent serial queue. Restart never resumes a possibly billable job implicitly. */
export class TranslationQueue {
  private tasks: TranslationTask[] = [];
  private initialized?: Promise<void>;
  private pumping?: Promise<void>;
  private stopped = false;
  private sequence = 0;
  private saves: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private restartReservations = new Set<string>();
  constructor(
    private readonly storage: QueueStorage,
    private readonly execute: (
      task: TranslationTask,
      report: (progress: TranslationJobProgress) => void,
    ) => Promise<void | TranslationTaskOutcome>,
  ) {}

  private sanitizeProgress(
    progress: TranslationJobProgress,
  ): TranslationJobProgress {
    const finite = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const percent = finite(progress.percent);
    return {
      stage:
        typeof progress.stage === "string"
          ? progress.stage.slice(0, 120)
          : "翻译中",
      percent:
        percent === undefined ? undefined : Math.max(0, Math.min(100, percent)),
      completed: finite(progress.completed),
      total: finite(progress.total),
      message:
        typeof progress.message === "string"
          ? progress.message.slice(0, 500)
          : undefined,
    };
  }
  snapshot(): TranslationTask[] {
    return JSON.parse(JSON.stringify(this.tasks));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A closed UI cannot interrupt jobs. */
      }
    }
  }
  private save(): Promise<void> {
    const next = this.saves
      .catch(() => {})
      .then(() => this.storage.write(this.snapshot()));
    this.saves = next;
    return next;
  }
  initialize(): Promise<void> {
    return (this.initialized ??= this.restore());
  }
  private async restore(): Promise<void> {
    const raw = await this.storage.read();
    if (raw !== undefined) {
      if (!Array.isArray(raw))
        throw new Error("任务队列文件损坏；请检查配置目录");
      const ids = new Set<string>();
      this.tasks = raw.map((value) => {
        const task = value as TranslationTask;
        if (
          !task ||
          typeof task.id !== "string" ||
          ids.has(task.id) ||
          !Number.isSafeInteger(task.libraryID) ||
          task.libraryID <= 0 ||
          !/^[A-Z0-9]{8}$/.test(task.sourceKey) ||
          typeof task.title !== "string" ||
          ![
            "queued",
            "running",
            "completed",
            "partial",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(task.state) ||
          !task.options ||
          task.options.backend !== "babeldoc" ||
          !["en", "zh"].includes(task.options.sourceLanguage) ||
          !["en", "zh"].includes(task.options.targetLanguage) ||
          task.options.sourceLanguage === task.options.targetLanguage ||
          !Number.isFinite(Date.parse(task.createdAt)) ||
          !Number.isFinite(Date.parse(task.updatedAt))
        )
          throw new Error("任务队列文件损坏；请检查配置目录");
        const provider = resolveProviderConfig(
          task.options.provider,
          task.options.model,
          task.options.customBaseURL,
        );
        ids.add(task.id);
        // Whitelist persisted properties: credentials/paths never belong in queue state.
        return {
          id: task.id,
          libraryID: task.libraryID,
          sourceKey: task.sourceKey,
          title: task.title,
          state: ["queued", "running"].includes(task.state)
            ? ("interrupted" as const)
            : task.state,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          progress: task.progress && this.sanitizeProgress(task.progress),
          targetKey:
            typeof task.targetKey === "string" &&
            /^[A-Z0-9]{8}$/.test(task.targetKey)
              ? task.targetKey
              : undefined,
          error:
            typeof task.error === "string"
              ? task.error.slice(0, 500)
              : undefined,
          options: {
            backend: "babeldoc" as const,
            sourceLanguage: task.options.sourceLanguage,
            targetLanguage: task.options.targetLanguage,
            provider: provider.provider,
            model: provider.model,
            customBaseURL: task.options.customBaseURL,
            ...translationPerformance(
              task.options.concurrency,
              task.options.qps,
            ),
            openReader: task.options.openReader !== false,
            ...(task.options.autoRepair !== undefined
              ? { autoRepair: task.options.autoRepair === true }
              : {}),
          },
        };
      });
      await this.save();
    }
    this.changed();
  }
  async enqueue(
    inputs: Array<
      Pick<TranslationTask, "libraryID" | "sourceKey" | "title" | "options">
    >,
  ): Promise<string[]> {
    await this.initialize();
    if (this.stopped) throw new Error("任务队列已停止");
    const added: string[] = [];
    for (const input of inputs) {
      if (
        this.restartReservations.has(input.libraryID + ":" + input.sourceKey) ||
        this.tasks.some(
          (task) =>
            task.libraryID === input.libraryID &&
            task.sourceKey === input.sourceKey &&
            ["queued", "running"].includes(task.state),
        )
      )
        continue;
      const now = new Date().toISOString();
      const task: TranslationTask = {
        ...input,
        options: {
          ...input.options,
          ...translationPerformance(
            input.options.concurrency,
            input.options.qps,
          ),
        },
        id:
          Date.now().toString(36) +
          "-" +
          ++this.sequence +
          "-" +
          Math.random().toString(36).slice(2, 10),
        state: "queued",
        createdAt: now,
        updatedAt: now,
        progress: { stage: "等待中", percent: 0 },
        error: undefined,
      };
      this.tasks.push(task);
      added.push(task.id);
    }
    try {
      await this.save();
    } catch (error) {
      this.tasks = this.tasks.filter((task) => !added.includes(task.id));
      throw error;
    }
    this.changed();
    this.start();
    return added;
  }
  private start(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      // An enqueue can race with the final persistence write.
      if (!this.stopped && this.tasks.some((task) => task.state === "queued"))
        this.start();
    });
    // Errors in queue persistence must not become unhandled menu promises.
    void this.pumping.catch(() => {});
  }
  private async pump(): Promise<void> {
    while (!this.stopped) {
      const task = this.tasks.find((item) => item.state === "queued");
      if (!task) return;
      task.state = "running";
      task.progress = { stage: "准备翻译", percent: 0 };
      task.updatedAt = new Date().toISOString();
      try {
        await this.save(); // Persist before any provider request.
        this.changed();
        if (this.stopped) return;
        const outcome = await this.execute(
          { ...task, options: { ...task.options } },
          (update) => {
            if (task.state !== "running") return;
            const progress = this.sanitizeProgress(update);
            progress.percent = Math.min(
              99,
              Math.max(task.progress?.percent ?? 0, progress.percent ?? 0),
            );
            task.progress = progress;
            this.changed();
          },
        );
        if (task.state === "running") {
          task.state = outcome?.state === "partial" ? "partial" : "completed";
          task.targetKey =
            outcome?.targetKey && /^[A-Z0-9]{8}$/.test(outcome.targetKey)
              ? outcome.targetKey
              : undefined;
          task.progress = {
            stage:
              task.state === "partial" ? "部分完成（译文已保留）" : "已完成",
            percent:
              task.state === "partial"
                ? Math.min(99, task.progress?.percent ?? 99)
                : 100,
            message: outcome?.message?.slice(0, 500) || task.progress?.message,
          };
        }
      } catch (error) {
        task.error =
          error instanceof Error
            ? error.message.slice(0, 500)
            : "翻译失败，请检查后端和作业状态";
        if (task.state === "running")
          task.state =
            error instanceof Error && error.name === "TranslationCancelledError"
              ? "cancelled"
              : "failed";
      }
      task.updatedAt = new Date().toISOString();
      this.changed();
      try {
        await this.save();
      } catch {
        this.stopped = true;
        throw new Error("任务队列保存失败；已停止启动后续任务");
      }
    }
  }
  async waitForIdle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }
  async cancelPending(id: string): Promise<boolean> {
    await this.initialize();
    const task = this.tasks.find((item) => item.id === id);
    if (!task || task.state !== "queued") return false;
    task.state = "cancelled";
    task.updatedAt = new Date().toISOString();
    await this.save();
    this.changed();
    return true;
  }
  /** Delete only cancelled history, never an active job or its PDF attachments.
   * Persist before removing the live row; serialize with other writes so a
   * racing enqueue/progress save cannot resurrect the deleted record.
   */
  async removeCancelled(id: string): Promise<boolean> {
    await this.initialize();
    const next = this.saves
      .catch(() => {})
      .then(async () => {
        const task = this.tasks.find((item) => item.id === id);
        if (!task || task.state !== "cancelled") return false;
        const remaining = this.snapshot().filter((item) => item.id !== id);
        await this.storage.write(remaining);
        this.tasks = this.tasks.filter((item) => item.id !== id);
        this.changed();
        return true;
      });
    this.saves = next.then(() => {});
    return next;
  }
  /** Caller must obtain explicit confirmation before restarting paid work. */
  async restart(id: string): Promise<string[]> {
    await this.initialize();
    if (this.stopped) throw new Error("任务队列已停止");
    // Replace the terminal record only after the replacement is durable. A
    // failed write keeps the original row; double clicks cannot create clones.
    const next = this.saves
      .catch(() => {})
      .then(async () => {
        const task = this.tasks.find((item) => item.id === id);
        if (!task || ["queued", "running"].includes(task.state)) return [];
        const key = task.libraryID + ":" + task.sourceKey;
        if (
          this.tasks.some(
            (item) =>
              item.id !== id &&
              item.libraryID === task.libraryID &&
              item.sourceKey === task.sourceKey &&
              ["queued", "running"].includes(item.state),
          )
        )
          return [];
        const now = new Date().toISOString();
        const replacement: TranslationTask = {
          id:
            Date.now().toString(36) +
            "-" +
            ++this.sequence +
            "-" +
            Math.random().toString(36).slice(2, 10),
          libraryID: task.libraryID,
          sourceKey: task.sourceKey,
          title: task.title,
          options: { ...task.options },
          state: "queued",
          createdAt: now,
          updatedAt: now,
          progress: { stage: "等待中", percent: 0 },
        };
        this.restartReservations.add(key);
        try {
          await this.storage.write([
            ...this.snapshot().filter((item) => item.id !== id),
            replacement,
          ]);
          this.tasks = [
            ...this.tasks.filter((item) => item.id !== id),
            replacement,
          ];
          this.changed();
          return [replacement.id];
        } finally {
          this.restartReservations.delete(key);
        }
      });
    this.saves = next.then(() => {});
    const ids = await next;
    if (ids.length) this.start();
    return ids;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.initialize();
    for (const task of this.tasks) {
      if (["queued", "running"].includes(task.state)) {
        task.state = "interrupted";
        task.updatedAt = new Date().toISOString();
      }
    }
    await this.save();
    this.changed();
  }
}
