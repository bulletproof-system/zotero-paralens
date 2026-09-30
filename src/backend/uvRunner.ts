import { UVStatus, uvRunArguments } from "./uv";
import { requireUV } from "./uvRuntime";

/**
 * Invoke a prepared Python worker from the uv-managed project environment.
 * Do not run `uv sync` here: provisioning is an explicit opt-in setup step.
 * Do not pass any API key via argv; the worker reads and deletes a protected
 * short-lived config file before loading BabelDOC.
 */
export async function runUVWorker(
  status: UVStatus | undefined,
  projectDir: string,
  workerScript: string,
  jobConfigPath: string,
): Promise<void> {
  const uv = requireUV(status);
  if (![projectDir, workerScript, jobConfigPath].every(PathUtils.isAbsolute)) {
    throw new Error("worker 项目、脚本和配置路径必须是绝对路径");
  }
  const root = PathUtils.normalize(projectDir);
  const script = PathUtils.normalize(workerScript);
  if (PathUtils.parent(script) !== root) {
    throw new Error("worker 脚本必须位于受信任的后端项目目录");
  }
  const environmentFile = PathUtils.join(root, ".venv", "pyvenv.cfg");
  if (!(await IOUtils.exists(environmentFile))) {
    throw new Error(
      "缺少 uv 项目虚拟环境。先显式运行 uv sync --project <backend> --python 3.12",
    );
  }
  if (!(await IOUtils.exists(script))) {
    throw new Error("后端 worker 尚未部署，无法启动翻译任务");
  }
  const result = await Zotero.Utilities.Internal.exec(
    uv,
    uvRunArguments(root, script, jobConfigPath),
  );
  // Third-party errors can include request details; never surface them to the UI/logs.
  if (result !== true)
    throw new Error("uv worker 执行失败；请检查 PDF、虚拟环境和 API 配置");
}
