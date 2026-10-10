const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const out = path.resolve(".scaffold/task-queue-tests.cjs");
buildSync({
  entryPoints: ["src/reader/taskQueue.ts"],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { TranslationQueue } = require(out);
const options = {
  backend: "babeldoc",
  sourceLanguage: "en",
  targetLanguage: "zh",
  provider: "openai",
  model: "test-model",
  customBaseURL: "",
};
const input = (key) => ({ libraryID: 1, sourceKey: key, title: key, options });
const storage = (initial) => ({
  value: initial,
  async read() {
    return this.value;
  },
  async write(value) {
    this.value = structuredClone(value);
  },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("batch jobs are serial, deduplicated, failed jobs do not block later jobs", async () => {
  const disk = storage();
  let active = 0,
    maximum = 0;
  const calls = [];
  const queue = new TranslationQueue(disk, async (task) => {
    active++;
    maximum = Math.max(active, maximum);
    calls.push(task.sourceKey);
    assert.equal(
      disk.value.find((item) => item.id === task.id).state,
      "running",
      "state persisted before request",
    );
    await tick();
    active--;
    if (task.sourceKey === "BBBB2222") throw new Error("failure");
  });
  const ids = await queue.enqueue([
    input("AAAA1111"),
    input("AAAA1111"),
    input("BBBB2222"),
    input("CCCC3333"),
  ]);
  assert.equal(ids.length, 3);
  await queue.waitForIdle();
  assert.equal(maximum, 1);
  assert.deepEqual(calls, ["AAAA1111", "BBBB2222", "CCCC3333"]);
  assert.deepEqual(
    queue.snapshot().map((task) => task.state),
    ["completed", "failed", "completed"],
  );
  assert.equal(JSON.stringify(disk.value).includes("apiKey"), false);
});

test("restart converts recovered queued/running work to interrupted and never charges automatically", async () => {
  const disk = storage();
  let release;
  let started = false;
  const original = new TranslationQueue(disk, async () => {
    started = true;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  await original.enqueue([input("AAAA1111"), input("BBBB2222")]);
  while (!started) await tick();
  const persisted = structuredClone(disk.value);
  await original.stop();
  release();
  await original.waitForIdle();
  let calls = 0;
  const recovered = new TranslationQueue(storage(persisted), async () => {
    calls++;
  });
  await recovered.initialize();
  await tick();
  assert.equal(calls, 0);
  assert.deepEqual(
    recovered.snapshot().map((task) => task.state),
    ["interrupted", "interrupted"],
  );
  const oldId = recovered.snapshot()[0].id;
  const ids = await recovered.restart(oldId);
  await recovered.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(ids.length, 1);
  assert.equal(recovered.snapshot().at(-1).state, "completed");
  assert.equal(
    recovered.snapshot()[0].state,
    "interrupted",
    "The other interrupted task remains visible",
  );
  assert.equal(
    recovered.snapshot().some((task) => task.id === oldId),
    false,
  );
  assert.equal(recovered.snapshot().length, 2);
});

test("queued cancellation skips work; active cancellation and shutdown preserve accurate states", async () => {
  const disk = storage();
  let release;
  let started = false;
  const calls = [];
  const queue = new TranslationQueue(disk, async (task) => {
    calls.push(task.sourceKey);
    started = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    const error = new Error("cancelled");
    error.name = "TranslationCancelledError";
    throw error;
  });
  const ids = await queue.enqueue([input("AAAA1111"), input("BBBB2222")]);
  while (!started) await tick();
  assert.equal(await queue.cancelPending(ids[1]), true);
  assert.equal(await queue.cancelPending(ids[0]), false);
  release();
  await queue.waitForIdle();
  assert.deepEqual(calls, ["AAAA1111"]);
  assert.deepEqual(
    queue.snapshot().map((task) => task.state),
    ["cancelled", "cancelled"],
  );
});

test("failed persistence prevents API execution, and malformed recovery is rejected", async () => {
  let calls = 0;
  const queue = new TranslationQueue(
    {
      read: async () => undefined,
      write: async () => {
        throw Error("disk full");
      },
    },
    async () => {
      calls++;
    },
  );
  await assert.rejects(queue.enqueue([input("AAAA1111")]), /disk full/);
  assert.equal(calls, 0);
  assert.deepEqual(queue.snapshot(), []);
  const bad = new TranslationQueue(
    storage([{ id: "unknown", options: {} }]),
    async () => {
      calls++;
    },
  );
  await assert.rejects(bad.initialize(), /文件损坏/);
  assert.equal(calls, 0);
});

test("queued tasks preserve their authorized provider/model configuration when preferences or snapshots change", async () => {
  const disk = storage();
  let release,
    started = false;
  const models = [];
  const savedOptions = { ...options, model: "authorized-model" };
  const queue = new TranslationQueue(disk, async (task) => {
    models.push(task.options.model);
    if (models.length === 1) {
      started = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  });
  await queue.enqueue([
    { ...input("AAAA1111"), options: savedOptions },
    { ...input("BBBB2222"), options: savedOptions },
  ]);
  while (!started) await tick();
  savedOptions.model = "changed-after-confirmation";
  queue.snapshot()[1].options.model = "changed-snapshot";
  release();
  await queue.waitForIdle();
  assert.deepEqual(models, ["authorized-model", "authorized-model"]);
  assert(disk.value.every((task) => task.options.model === "authorized-model"));
});

test("overall queue progress is live, finite and monotonic across stages; only committed success reaches 100", async () => {
  const disk = storage();
  let report, release;
  const seen = [];
  const queue = new TranslationQueue(disk, async (_task, update) => {
    report = update;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  queue.subscribe(() => seen.push(queue.snapshot()));
  await queue.enqueue([input("AAAA1111"), input("BBBB2222")]);
  while (!report) await tick();
  assert.equal(queue.snapshot()[1].progress.percent, 0);
  for (const percent of [NaN, Infinity, -5])
    report({ stage: "stage", percent });
  assert.equal(queue.snapshot()[0].progress.percent, 0);
  report({ stage: "翻译", percent: 75.8, completed: 2, total: 3 });
  report({ stage: "新阶段", percent: 12 });
  assert.equal(queue.snapshot()[0].progress.percent, 75.8);
  report({
    stage: "s".repeat(130),
    percent: 150,
    completed: NaN,
    total: Infinity,
  });
  const running = queue.snapshot()[0];
  assert.equal(running.progress.percent, 99);
  assert.equal(running.progress.stage.length, 120);
  assert.equal(running.progress.completed, undefined);
  assert.equal(running.progress.total, undefined);
  assert.equal(running.state, "running");
  // Cancel the next job so the held executor is used only once.
  await queue.cancelPending(queue.snapshot()[1].id);
  release();
  await queue.waitForIdle();
  assert.equal(queue.snapshot()[0].progress.percent, 100);
  assert.equal(disk.value[0].progress.percent, 100);
  assert.ok(seen.some((tasks) => tasks[0]?.progress?.percent === 75.8));
});

test("failed tasks preserve their last progress and safe error; old queue files restore without progress", async () => {
  const disk = storage();
  const queue = new TranslationQueue(disk, async (_task, report) => {
    report({ stage: "生成段落映射", percent: 92 });
    throw Error("段落映射失败，请检查 PDF");
  });
  await queue.enqueue([input("AAAA1111")]);
  await queue.waitForIdle();
  const failed = queue.snapshot()[0];
  assert.equal(failed.progress.percent, 92);
  assert.equal(failed.error, "段落映射失败，请检查 PDF");
  const recovered = new TranslationQueue(storage(disk.value), async () =>
    assert.fail("No implicit retry"),
  );
  await recovered.initialize();
  assert.deepEqual(recovered.snapshot()[0].progress, failed.progress);
  assert.equal(recovered.snapshot()[0].error, failed.error);
  const old = structuredClone(disk.value);
  delete old[0].progress;
  delete old[0].error;
  const legacy = new TranslationQueue(storage(old), async () =>
    assert.fail("No implicit retry"),
  );
  await legacy.initialize();
  assert.equal(legacy.snapshot()[0].progress, undefined);
});

test("successful translation can retain an honest mapping warning without pretending hover is available", async () => {
  const disk = storage();
  const queue = new TranslationQueue(disk, async (_task, report) => {
    report({
      stage: "已完成",
      percent: 100,
      message: "译文已导入，段落对照不可用",
    });
  });
  await queue.enqueue([input("AAAA1111")]);
  await queue.waitForIdle();
  assert.equal(queue.snapshot()[0].progress.percent, 100);
  assert.equal(
    queue.snapshot()[0].progress.message,
    "译文已导入，段落对照不可用",
  );
});

test("cancelled tasks can be deleted durably without removing active/completed jobs or starting API work", async () => {
  const disk = storage();
  let release,
    started = false,
    calls = 0;
  const queue = new TranslationQueue(disk, async () => {
    calls++;
    started = true;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const ids = await queue.enqueue([input("AAAA1111"), input("BBBB2222")]);
  while (!started) await tick();
  assert.equal(
    await queue.removeCancelled(ids[0]),
    false,
    "Running job must not be deleted",
  );
  assert.equal(
    await queue.removeCancelled(ids[1]),
    false,
    "Queued job must be cancelled first",
  );
  await queue.cancelPending(ids[1]);
  assert.equal(await queue.removeCancelled(ids[1]), true);
  assert.equal(
    await queue.removeCancelled(ids[1]),
    false,
    "Deleting twice is harmless",
  );
  assert.equal(disk.value.length, 1);
  assert.equal(queue.snapshot().length, 1);
  release();
  await queue.waitForIdle();
  assert.equal(await queue.removeCancelled(ids[0]), false);
  assert.equal(calls, 1);
  const restored = new TranslationQueue(storage(disk.value), async () =>
    assert.fail("No implicit API"),
  );
  await restored.initialize();
  assert.equal(restored.snapshot().length, 1);
});

test("cancelled deletion keeps its row after disk failure and cannot be resurrected by racing enqueue", async () => {
  const initial = {
    ...input("AAAA1111"),
    id: "cancelled-history",
    state: "cancelled",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const disk = storage([initial]);
  let fail = false,
    hold = false,
    release,
    entered;
  const normalWrite = disk.write.bind(disk);
  disk.write = async (value) => {
    if (fail) throw Error("disk full");
    if (hold) {
      entered = true;
      await new Promise((resolve) => {
        release = resolve;
      });
      hold = false;
    }
    return normalWrite(value);
  };
  const queue = new TranslationQueue(disk, async () => {});
  await queue.initialize();
  fail = true;
  await assert.rejects(queue.removeCancelled(initial.id), /disk full/);
  assert.equal(queue.snapshot()[0].id, initial.id);
  assert.equal(disk.value[0].id, initial.id);
  fail = false;
  hold = true;
  const deleting = queue.removeCancelled(initial.id);
  while (!entered) await tick();
  const enqueuing = queue.enqueue([input("BBBB2222")]);
  release();
  assert.equal(await deleting, true);
  await enqueuing;
  await queue.waitForIdle();
  assert.equal(
    queue.snapshot().some((task) => task.id === initial.id),
    false,
  );
  assert.equal(
    disk.value.some((task) => task.id === initial.id),
    false,
  );
});

test("performance is snapshotted per job and legacy jobs receive defaults without auto-running", async () => {
  const disk = storage();
  const queue = new TranslationQueue(disk, async () => {});
  const custom = { ...options, concurrency: 8, qps: 3 };
  await queue.enqueue([{ ...input("AAAA1111"), options: custom }]);
  await queue.waitForIdle();
  custom.concurrency = 1;
  assert.equal(disk.value[0].options.concurrency, 8);
  assert.equal(disk.value[0].options.qps, 3);
  const legacy = structuredClone(disk.value);
  delete legacy[0].options.concurrency;
  delete legacy[0].options.qps;
  legacy[0].state = "running";
  let calls = 0;
  const restored = new TranslationQueue(storage(legacy), async () => {
    calls++;
  });
  await restored.initialize();
  assert.equal(calls, 0);
  assert.equal(restored.snapshot()[0].state, "interrupted");
  assert.equal(restored.snapshot()[0].options.concurrency, 4);
  assert.equal(restored.snapshot()[0].options.qps, 2);
  legacy[0].options.qps = 999;
  const invalid = new TranslationQueue(storage(legacy), async () => {
    calls++;
  });
  await assert.rejects(invalid.initialize(), /整数/);
  assert.equal(calls, 0);
});

test("restart durably replaces the old row, clears stale progress, and suppresses double clicks", async () => {
  const initial = {
    ...input("AAAA1111"),
    id: "failed-old",
    state: "failed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: "old failure",
    progress: { stage: "failed", percent: 77 },
    targetKey: "OLDP1234",
  };
  const disk = storage([initial]);
  let calls = 0;
  const queue = new TranslationQueue(disk, async () => {
    calls++;
  });
  const [first, second] = await Promise.all([
    queue.restart(initial.id),
    queue.restart(initial.id),
  ]);
  await queue.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(first.length + second.length, 1);
  assert.equal(queue.snapshot().length, 1);
  assert.notEqual(queue.snapshot()[0].id, initial.id);
  assert.equal(queue.snapshot()[0].state, "completed");
  assert.equal(queue.snapshot()[0].error, undefined);
  assert.equal(queue.snapshot()[0].targetKey, undefined);
  assert.equal(
    disk.value.some((task) => task.id === initial.id),
    false,
  );
});

test("failed restart persistence retains the old row and cannot charge the API", async () => {
  const initial = {
    ...input("AAAA1111"),
    id: "failed-old",
    state: "failed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const disk = storage([initial]);
  let fail = false,
    calls = 0;
  const write = disk.write.bind(disk);
  disk.write = async (tasks) => {
    if (fail) throw Error("disk full");
    return write(tasks);
  };
  const queue = new TranslationQueue(disk, async () => {
    calls++;
  });
  await queue.initialize();
  fail = true;
  await assert.rejects(queue.restart(initial.id), /disk full/);
  assert.equal(queue.snapshot()[0].id, initial.id);
  assert.equal(disk.value[0].id, initial.id);
  assert.equal(calls, 0);
  fail = false;
  await queue.restart(initial.id);
  await queue.waitForIdle();
  assert.equal(calls, 1);
});

test("restart reservation prevents a racing same-source enqueue from cloning the task", async () => {
  const initial = {
    ...input("AAAA1111"),
    id: "failed-old",
    state: "failed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const disk = storage([initial]);
  let hold = false,
    entered = false,
    release,
    calls = 0;
  const write = disk.write.bind(disk);
  disk.write = async (tasks) => {
    if (hold) {
      entered = true;
      await new Promise((resolve) => (release = resolve));
      hold = false;
    }
    return write(tasks);
  };
  const queue = new TranslationQueue(disk, async () => {
    calls++;
  });
  await queue.initialize();
  hold = true;
  const restarting = queue.restart(initial.id);
  while (!entered) await tick();
  const racing = queue.enqueue([input("AAAA1111"), input("BBBB2222")]);
  release();
  await restarting;
  await racing;
  await queue.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(queue.snapshot().length, 2);
  assert.equal(
    disk.value.filter((task) => task.sourceKey === "AAAA1111").length,
    1,
  );
  assert.equal(
    disk.value.some((task) => task.id === initial.id),
    false,
  );
});

test("partial results retain a safe target attachment key across restore, never claim 100 percent", async () => {
  const disk = storage();
  const queue = new TranslationQueue(disk, async (_task, report) => {
    report({ stage: "保留产物", percent: 99 });
    return {
      state: "partial",
      targetKey: "PART1234",
      message: "译文不完整，PDF 已保留",
    };
  });
  await queue.enqueue([input("AAAA1111")]);
  await queue.waitForIdle();
  const task = queue.snapshot()[0];
  assert.equal(task.state, "partial");
  assert.equal(task.targetKey, "PART1234");
  assert.equal(task.progress.percent, 99);
  const restored = new TranslationQueue(storage(disk.value), async () =>
    assert.fail("No automatic restart"),
  );
  await restored.initialize();
  assert.deepEqual(restored.snapshot()[0], {
    ...task,
    options: { ...task.options, openReader: true },
  });
  const ids = await queue.restart(task.id);
  await queue.waitForIdle();
  assert.equal(queue.snapshot().length, 1);
  assert.equal(queue.snapshot()[0].id, ids[0]);
});

test("automatic repair is opt-in per task and survives restore/restart without enabling legacy jobs", async () => {
  const disk = storage();
  const executed = [];
  const queue = new TranslationQueue(disk, async (task) =>
    executed.push(task.options.autoRepair === true),
  );
  await queue.enqueue([
    input("AAAA1111"),
    { ...input("BBBB2222"), options: { ...options, autoRepair: true } },
  ]);
  await queue.waitForIdle();
  assert.deepEqual(executed, [false, true]);
  const restored = new TranslationQueue(storage(disk.value), async (task) =>
    executed.push(task.options.autoRepair === true),
  );
  await restored.initialize();
  assert.equal(restored.snapshot()[0].options.autoRepair === true, false);
  assert.equal(restored.snapshot()[1].options.autoRepair, true);
  await restored.restart(restored.snapshot()[0].id);
  await restored.waitForIdle();
  assert.equal(executed.at(-1), false);
  await restored.restart(
    restored.snapshot().find((task) => task.sourceKey === "BBBB2222").id,
  );
  await restored.waitForIdle();
  assert.equal(executed.at(-1), true);
});
