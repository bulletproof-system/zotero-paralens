/** A venv directory can survive an interrupted uv sync. Check the actual
 * pinned distribution without activating the environment or downloading it. */
export async function isBackendInstalled(
  projectDir: string | undefined,
  isWindows: boolean,
  exists: (path: string) => Promise<boolean>,
  execute: (path: string, args: string[]) => Promise<boolean>,
): Promise<boolean> {
  if (!projectDir) return false;
  const environment = PathUtils.join(projectDir, ".venv");
  const python = isWindows
    ? PathUtils.join(environment, "Scripts", "python.exe")
    : PathUtils.join(environment, "bin", "python");
  try {
    if (
      !(await exists(PathUtils.join(environment, "pyvenv.cfg"))) ||
      !(await exists(python))
    )
      return false;
    return await execute(python, [
      "-c",
      "from importlib.metadata import version; assert version('babeldoc') == '0.5.20'",
    ]);
  } catch {
    return false;
  }
}
