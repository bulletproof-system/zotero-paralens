const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const outfile = path.resolve(".scaffold/install-progress-tests.cjs");
buildSync({
  entryPoints: ["src/backend/installProgress.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { BackendInstallProgress } = require(outfile);

test("uv milestones remain monotonic across interleaved output and never finish before validation", () => {
  const updates = [];
  const progress = new BackendInstallProgress((update) => updates.push(update));
  progress.advance("preparing", 0);
  progress.advance("resolving", 20);
  for (const line of [
    "Resolved 100 packages in 1s",
    "Downloading torch (100MiB)",
    "Downloaded torch",
    "Downloading small (1KiB)",
    "Prepared 100 packages in 2m",
    "Installed 100 packages in 3s",
    " + babeldoc==0.6.4",
  ])
    progress.output(line);
  assert.deepEqual(
    updates.map((update) => update.percent),
    [0, 20, 30, 40, 65, 85, 95],
  );
  assert.equal(updates.at(-1).stage, "verifying");
  progress.advance("completed", 100);
  assert.equal(updates.at(-1).percent, 100);
});

test("cached installs and ANSI output advance to verification, unrelated numbers do not", () => {
  const updates = [];
  const progress = new BackendInstallProgress((update) => updates.push(update));
  progress.advance("resolving", 20);
  progress.output("error: download 100% failed");
  assert.equal(updates.at(-1).percent, 20);
  progress.output("\x1b[32mAudited 1 package in 1ms\x1b[0m");
  assert.equal(updates.at(-1).percent, 95);
});
