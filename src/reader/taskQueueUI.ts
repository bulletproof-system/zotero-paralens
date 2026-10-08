import { TranslationQueue, TranslationTask } from "./taskQueue";

const windows = new Set<Window>();
const labels: Record<string, string> = {
  queued: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断（需重新开始）",
};

export async function showTaskQueue(
  parent: Window,
  queue: TranslationQueue,
  cancel: () => Promise<boolean>,
  open: (task: TranslationTask) => Promise<void>,
): Promise<void> {
  await queue.initialize();
  const win = (
    parent as Window & { openDialog: (...args: unknown[]) => Window }
  ).openDialog(
    "chrome://paralens/content/taskQueue.xhtml",
    "",
    "chrome,centerscreen,resizable,width=780,height=520",
  );
  if (!win) throw new Error("无法打开任务队列窗口");
  windows.add(win);
  const setup = () => {
    const doc = win.document;
    const list = doc.getElementById("tasks")!;
    const status = doc.getElementById("status")!;
    const element = (name: string) =>
      doc.createElementNS("http://www.w3.org/1999/xhtml", name);
    const action = (
      row: Element,
      text: string,
      run: () => Promise<unknown>,
    ) => {
      const button = element("button") as HTMLButtonElement;
      button.textContent = text;
      button.addEventListener("click", () => {
        button.disabled = true;
        void run()
          .catch((error: unknown) => {
            status.textContent =
              error instanceof Error
                ? error.message
                : "操作失败，请检查附件、后端和配置目录。";
          })
          .finally(() => {
            button.disabled = false;
          });
      });
      row.appendChild(button);
    };
    // Keep live rows/buttons stable while the worker reports progress. A full
    // list rebuild can steal focus or discard a click between pointer events.
    const rows = new Map<
      string,
      {
        row: Element;
        description: Element;
        progress: HTMLProgressElement;
        percentage: Element;
        detail: Element;
        actions: Element;
        state?: string;
      }
    >();
    const empty = element("p");
    empty.textContent = "暂无任务。请在文献列表中多选 PDF，右键翻译。";
    const render = () => {
      const tasks = queue.snapshot();
      const ids = new Set(tasks.map((task) => task.id));
      for (const [id, view] of rows) {
        if (!ids.has(id)) {
          view.row.remove();
          rows.delete(id);
        }
      }
      if (!tasks.length) {
        if (!empty.parentNode) list.appendChild(empty);
        return;
      }
      empty.remove();
      for (const task of tasks) {
        let view = rows.get(task.id);
        if (!view) {
          const row = element("div");
          row.className = "task";
          row.setAttribute("data-task-id", task.id);
          const description = element("span");
          description.className = "paralens-task-description";
          const progress = element("progress") as HTMLProgressElement;
          progress.max = 100;
          progress.className = "paralens-task-progress";
          progress.setAttribute("aria-label", "翻译进度");
          const percentage = element("span");
          percentage.className = "paralens-task-percentage";
          const detail = element("p");
          detail.className = "paralens-task-detail";
          const actions = element("div");
          actions.className = "paralens-task-actions";
          row.append(description, progress, percentage, detail, actions);
          view = { row, description, progress, percentage, detail, actions };
          rows.set(task.id, view);
          list.prepend(row);
        }
        view.description.textContent =
          task.title +
          " · " +
          task.options.sourceLanguage +
          " → " +
          task.options.targetLanguage +
          " · " +
          task.options.provider +
          "/" +
          task.options.model +
          " · " +
          labels[task.state];
        view.progress.value =
          task.state === "completed" ? 100 : (task.progress?.percent ?? 0);
        view.percentage.textContent =
          Math.floor(view.progress.value) +
          "%" +
          (task.progress?.stage ? " · " + task.progress.stage : "");
        view.detail.textContent =
          task.state === "failed"
            ? task.error || "翻译失败，请检查后端和作业状态"
            : task.progress?.message || "";
        view.detail.setAttribute("data-error", String(task.state === "failed"));
        if (view.state === task.state) continue;
        view.state = task.state;
        view.actions.replaceChildren();
        if (task.state === "queued")
          action(view.actions, "取消排队", () => queue.cancelPending(task.id));
        else if (task.state === "running")
          action(view.actions, "取消翻译", cancel);
        else {
          action(view.actions, "重新开始", async () => {
            if (
              win.confirm(
                "重新开始将完整运行翻译，不从断点继续，可能再次产生 API 费用；已有译文保留，新成功结果成为默认对照。继续？",
              )
            )
              await queue.restart(task.id);
          });
          if (task.state === "cancelled")
            action(view.actions, "删除任务", () =>
              queue.removeCancelled(task.id),
            );
          if (task.state === "completed")
            action(view.actions, "打开双语对照", () => open(task));
        }
      }
    };
    const unsubscribe = queue.subscribe(render);
    win.addEventListener(
      "unload",
      () => {
        unsubscribe();
        windows.delete(win);
      },
      { once: true },
    );
    render();
  };
  if (win.document.readyState === "complete") setup();
  else win.addEventListener("load", setup, { once: true });
}

export function closeTaskQueueWindows(): void {
  for (const win of windows) win.close();
  windows.clear();
}
