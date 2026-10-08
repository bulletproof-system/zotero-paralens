import { executeHidden } from "./process";
import { getPref } from "../utils/prefs";
import { detectUV, UVStatus } from "./uv";

/** Startup probe; a missing uv disables translation but not preferences. */
export async function inspectUV(
  override = getPref("uvPath") || "",
): Promise<UVStatus> {
  const env = {
    path: Services.env.get("PATH"),
    home: Services.env.get("USERPROFILE") || Services.env.get("HOME"),
    localAppData: Services.env.get("LOCALAPPDATA"),
    isWindows: Services.appinfo.OS === "WINNT",
  };
  return detectUV(
    env,
    override,
    (path) => IOUtils.exists(path),
    async (path) => (await executeHidden(path, ["--version"])) === true,
  );
}

export function requireUV(status?: UVStatus): string {
  if (!status?.available || !status.path) {
    throw new Error(status?.message || "uv 尚未完成检测，翻译功能不可用");
  }
  return status.path;
}
