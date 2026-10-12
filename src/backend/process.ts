import { log } from "../utils/log";

let nextProcessId = 0;

/** Spawn trusted executables without shell or Windows console windows.
 * Arguments remain an array; never log them (worker config paths are private). */
export function executeHidden(
  executable: string,
  args: string[],
): Promise<boolean> {
  if (
    !PathUtils.isAbsolute(executable) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    return Promise.reject(new Error("进程路径或参数不合法"));
  const id = ++nextProcessId;
  const started = Date.now();
  const prefix = "[process-" + id + "] ";
  return new Promise((resolve, reject) => {
    try {
      const classes = Components.classes as unknown as Record<
        string,
        { createInstance(iid: unknown): unknown }
      >;
      const file = classes["@mozilla.org/file/local;1"].createInstance(
        Components.interfaces.nsIFile,
      ) as nsIFile;
      file.initWithPath(executable);
      const process = classes["@mozilla.org/process/util;1"].createInstance(
        Components.interfaces.nsIProcess,
      ) as nsIProcess;
      process.init(file);
      process.startHidden = true;
      process.noShell = true;
      log(prefix + "启动后端隐藏进程；可执行文件=" + executable);
      process.runwAsync(args, args.length, {
        observe(_subject: nsISupports, topic: string) {
          let exitCode: number | undefined;
          try {
            const value = process.exitValue;
            if (Number.isSafeInteger(value)) exitCode = value;
          } catch {
            // Gecko may not expose an exit value after a native process failure.
          }
          const event =
            topic === "process-finished" || topic === "process-failed"
              ? topic
              : "unknown";
          log(
            prefix +
              (topic === "process-finished"
                ? "后端进程退出"
                : "后端进程异常结束") +
              "；事件=" +
              event +
              "；退出码=" +
              (exitCode ?? "不可用") +
              "；耗时=" +
              (Date.now() - started) +
              "ms",
          );
          if (topic === "process-finished" && exitCode === 0) resolve(true);
          else reject(new Error("后端进程执行失败，请检查作业状态与后端安装"));
        },
      });
    } catch (error) {
      const name =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name)
          ? error.name
          : "UnknownError";
      log(
        prefix +
          "后端隐藏进程启动失败；异常类型=" +
          name +
          "；耗时=" +
          (Date.now() - started) +
          "ms",
      );
      reject(new Error("无法以隐藏窗口方式启动后端，请检查可执行文件及权限"));
    }
  });
}
