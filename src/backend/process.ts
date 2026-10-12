import { log } from "../utils/log";

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
      log("启动后端隐藏进程");
      process.runwAsync(args, args.length, {
        observe(_subject: nsISupports, topic: string) {
          log(
            topic === "process-finished"
              ? "后端进程退出，代码：" + process.exitValue
              : "后端进程启动失败",
          );
          if (topic === "process-finished" && process.exitValue === 0)
            resolve(true);
          else reject(new Error("后端进程执行失败，请检查作业状态与后端安装"));
        },
      });
    } catch {
      log("后端隐藏进程启动失败");
      reject(new Error("无法以隐藏窗口方式启动后端，请检查可执行文件及权限"));
    }
  });
}
