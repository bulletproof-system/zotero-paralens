export interface UVEnvironment {
  path: string;
  home?: string;
  localAppData?: string;
  isWindows: boolean;
}

export interface UVStatus {
  available: boolean;
  path?: string;
  message: string;
  reason?: "not-found" | "exec-failed";
}

/** Pure PATH discovery, including common uv installer locations. */
export function uvCandidatePaths(env: UVEnvironment, override = ""): string[] {
  const exe = env.isWindows ? "uv.exe" : "uv";
  const separator = env.isWindows ? ";" : ":";
  const slash = env.isWindows ? "\\" : "/";
  const directories = env.path
    .split(separator)
    .map((p) => p.trim().replace(/^"|"$/g, ""));
  if (env.home)
    directories.push(
      `${env.home}${slash}.local${slash}bin`,
      `${env.home}${slash}.cargo${slash}bin`,
    );
  if (env.isWindows && env.localAppData)
    directories.push(
      `${env.localAppData}${slash}Microsoft${slash}WinGet${slash}Links`,
    );
  const candidates = [
    override.trim(),
    ...directories
      .filter(Boolean)
      .map((dir) => `${dir.replace(/[\\/]+$/, "")}${slash}${exe}`),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

/** Call with absolute paths and argument arrays only, never through a shell. */
export async function detectUV(
  env: UVEnvironment,
  override: string,
  exists: (path: string) => Promise<boolean>,
  check: (path: string) => Promise<boolean>,
): Promise<UVStatus> {
  let foundExecutable = false;
  for (const path of uvCandidatePaths(env, override)) {
    if (!/(?:^|[\\/])uv(?:\.exe)?$/i.test(path)) continue;
    try {
      if (await exists(path)) {
        foundExecutable = true;
        if (!(await check(path))) continue;
        return { available: true, path, message: "uv 已就绪" };
      }
    } catch {
      // Ignore a broken PATH entry and keep checking other locations.
    }
  }
  return {
    available: false,
    reason: foundExecutable ? "exec-failed" : "not-found",
    message: foundExecutable
      ? "找到了 uv，但运行 uv --version 失败；请检查执行权限或填写其他 uv 路径。"
      : "未找到 uv；翻译功能已禁用。请安装 uv，或在设置中填写 uv 的绝对路径。",
  };
}

export function uvRunArguments(
  projectDir: string,
  workerScript: string,
  jobConfigPath: string,
): string[] {
  if (![projectDir, workerScript, jobConfigPath].every(Boolean))
    throw new Error("缺少后端项目或作业路径");
  // --no-sync and --offline prohibit installing/updating dependencies during a job.
  return [
    "run",
    "--project",
    projectDir,
    "--no-sync",
    "--offline",
    "python",
    workerScript,
    jobConfigPath,
  ];
}
