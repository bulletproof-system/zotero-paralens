import { log } from "../utils/log";

interface InstallProcess {
  stdout: { readString(): Promise<string | null> };
  stdin: { close(): Promise<void> };
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<unknown>;
}

/** Gecko Subprocess uses pipes and a hidden Windows process, without a shell.
 * Keep this separate from translation workers: their raw output stays private. */
export async function executeBackendInstall(
  executable: string,
  args: string[],
  onLine: (line: string) => void,
  diagnostic: "backend-install" | "backend-check" = "backend-install",
): Promise<boolean> {
  if (
    !PathUtils.isAbsolute(executable) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error("进程路径或参数不合法");
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  ) as unknown as {
    Subprocess: {
      call(options: {
        command: string;
        arguments: string[];
        stderr: "stdout";
        environment: Record<string, string>;
        environmentAppend: boolean;
      }): Promise<InstallProcess>;
    };
  };
  let child: InstallProcess;
  try {
    child = await Subprocess.call({
      command: executable,
      arguments: args,
      stderr: "stdout",
      environment: { UV_COLOR: "never", UV_NO_PROGRESS: "1" },
      environmentAppend: true,
    });
  } catch {
    throw new Error("无法启动后端安装，请检查 uv 路径及执行权限");
  }
  const exited = child.wait();
  // Attach the rejection handler before reading, even if waiting fails early.
  void exited.catch(() => {});
  let buffer = "";
  const emit = (line: string) => {
    if (!line.trim()) return;
    log("[" + diagnostic + "] " + line);
    try {
      onLine(line);
    } catch {
      /* Closing the preferences window must not stop installation. */
    }
  };
  try {
    await child.stdin.close();
    while (true) {
      const chunk = await child.stdout.readString();
      if (!chunk) break;
      buffer += chunk;
      const lines = buffer.split(/\r\n|[\r\n]/);
      buffer = lines.pop()!;
      for (const line of lines) emit(line);
      // Bound a malformed/very long output line without dropping the stream.
      if (buffer.length > 16384) {
        emit(buffer.slice(0, 16384));
        buffer = "";
      }
    }
    emit(buffer);
    const { exitCode } = await exited;
    log("[" + diagnostic + "] exit code: " + exitCode);
    if (exitCode !== 0)
      throw new Error("后端安装进程执行失败，请检查网络、磁盘空间及安装日志");
    return true;
  } catch (error) {
    await child.kill().catch(() => {});
    await exited.catch(() => {});
    throw error;
  }
}

/** Fixed import/version probes only: never use this for private worker configs. */
export async function executeBackendProbe(
  executable: string,
  args: string[],
): Promise<boolean> {
  try {
    return await executeBackendInstall(
      executable,
      args,
      () => {},
      "backend-check",
    );
  } catch {
    log("[backend-check] 后端检测进程失败");
    return false;
  }
}
