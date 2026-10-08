import { assert } from "chai";
import { TranslationQueue } from "../src/reader/taskQueue";
import { showTaskQueue } from "../src/reader/taskQueueUI";
import { TranslationJobProgress } from "../src/backend/contracts";

describe("live translation queue progress", function () {
  it("renders live percentages without replacing focused buttons; shows success, warnings and stage errors", async function () {
    this.timeout(15000);
    let win: Window | undefined;
    let report: ((value: TranslationJobProgress) => void) | undefined;
    let release: (() => void) | undefined;
    let cancelled = 0;
    const queue = new TranslationQueue(
      { read: async () => undefined, write: async () => {} },
      async (task, update) => {
        if (task.sourceKey === "BBBB2222") {
          update({ stage: "生成段落映射", percent: 92 });
          throw Error("段落映射生成失败（mapping_failed）");
        }
        report = update;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        update({
          stage: "已完成",
          percent: 100,
          message: "译文已导入，段落对照不可用",
        });
      },
    );
    const wait = async (condition: () => boolean) => {
      for (let i = 0; i < 100; i++) {
        if (condition()) return;
        await Zotero.Promise.delay(50);
      }
      throw Error("Queue UI condition timed out");
    };
    const parent = Zotero.getMainWindow() as Window & {
      openDialog: (...args: unknown[]) => Window;
    };
    const host = {
      openDialog: (...args: unknown[]) => {
        win = parent.openDialog(...args);
        return win;
      },
    };
    try {
      await showTaskQueue(
        host as unknown as Window,
        queue,
        async () => {
          cancelled++;
          return false;
        },
        async () => {},
      );
      await wait(() => Boolean(win?.document.getElementById("tasks")));
      const options = {
        backend: "babeldoc" as const,
        sourceLanguage: "en",
        targetLanguage: "zh",
        provider: "openai",
        model: "test-only",
        customBaseURL: "",
      };
      const ids = await queue.enqueue(
        ["AAAA1111", "BBBB2222", "CCCC3333"].map((sourceKey) => ({
          libraryID: 1,
          sourceKey,
          title: sourceKey,
          options,
        })),
      );
      await wait(() =>
        Boolean(report && win?.document.querySelectorAll(".task").length === 3),
      );
      const row = win!.document.querySelector(`[data-task-id="${ids[0]}"]`)!;
      const button = row.querySelector("button") as HTMLButtonElement;
      const pending = win!.document.querySelector(
        `[data-task-id="${ids[1]}"]`,
      )!;
      assert.equal(pending.querySelector("progress")!.value, 0);
      const cancelledRow = win!.document.querySelector(
        `[data-task-id="${ids[2]}"]`,
      )!;
      await queue.cancelPending(ids[2]);
      assert.include(cancelledRow.textContent!, "已取消");
      const deleteButton = Array.from(
        cancelledRow.querySelectorAll("button"),
      ).find((entry) => entry.textContent === "删除任务") as HTMLButtonElement;
      assert.isDefined(deleteButton);
      assert.notInclude(
        row.textContent!,
        "删除任务",
        "Running jobs cannot be deleted",
      );
      deleteButton.click();
      await wait(
        () => !win!.document.querySelector(`[data-task-id="${ids[2]}"]`),
      );
      assert.equal(queue.snapshot().length, 2);
      button.focus();
      report!({ stage: "翻译段落", percent: 55.7 });
      assert.equal(row.querySelector("progress")!.value, 55.7);
      assert.include(
        row.querySelector(".paralens-task-percentage")!.textContent!,
        "55%",
      );
      report!({ stage: "生成段落映射", percent: 91 });
      assert.strictEqual(row.querySelector("button"), button);
      assert.strictEqual(win!.document.activeElement, button);
      button.click();
      await wait(() => cancelled === 1);
      release!();
      await queue.waitForIdle();
      assert.equal(row.querySelector("progress")!.value, 100);
      assert.include(row.textContent!, "100%");
      assert.include(row.textContent!, "段落对照不可用");
      assert.equal(pending.querySelector("progress")!.value, 92);
      assert.include(pending.textContent!, "mapping_failed");
      assert.include(pending.textContent!, "失败");
    } finally {
      await queue.stop();
      release?.();
      await queue.waitForIdle();
      win?.close();
    }
  });
});
