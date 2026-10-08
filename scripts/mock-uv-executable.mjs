/** Build a tiny, test-only uv substitute. No package installation/network is possible. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
export async function prepareMockUV(workspace) {
  if (process.platform !== "win32") return undefined;
  const compiler = ["Framework64", "Framework"]
    .map((folder) =>
      join(
        process.env.WINDIR || "C:\\Windows",
        "Microsoft.NET",
        folder,
        "v4.0.30319",
        "csc.exe",
      ),
    )
    .find(existsSync);
  if (!compiler)
    throw new Error(
      "Windows GUI install test needs the bundled .NET C# compiler",
    );
  const directory = join(workspace, "mock-uv");
  mkdirSync(directory);
  const source = join(directory, "MockUV.cs"),
    executable = join(directory, "uv.exe");
  writeFileSync(
    source,
    `using System; using System.IO; using System.Reflection; using System.Diagnostics; using System.Runtime.InteropServices;
class MockUV {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static string Visible() { var window = GetConsoleWindow(); return (window != IntPtr.Zero && IsWindowVisible(window)).ToString().ToLowerInvariant(); }
  static int Main(string[] args) {
    if (args.Length == 2 && args[0] == "--child-probe") {
      File.AppendAllText(args[1], "child:" + Visible() + Environment.NewLine); return 0;
    }
    if (args.Length == 2 && args[0] == "--hidden-probe") {
      File.WriteAllText(args[1], "parent:" + Visible() + Environment.NewLine);
      var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location);
      start.UseShellExecute = false; start.CreateNoWindow = false;
      start.Arguments = "--child-probe " + (char)34 + args[1] + (char)34;
      using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
    }
    if (args.Length == 1 && args[0] == "--exit-error") return 17;
    if (args.Length > 0 && args[0] == "sync") File.WriteAllLines(Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".args"), args);
    Console.WriteLine("uv 0.test-only"); return 0;
  }
}`,
    "utf8",
  );
  await new Promise((resolve, reject) => {
    const child = spawn(
      compiler,
      ["/nologo", "/target:exe", "/out:" + executable, source],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Mock uv compilation failed")),
    );
  });
  return { executable, record: join(directory, "uv.args") };
}
