import { getPref } from "./prefs";

let pending: Promise<void> = Promise.resolve();

export function pluginLogDirectory(): string {
  return PathUtils.join(PathUtils.profileDir, "paralens", "logs");
}

/** Diagnostics only: never pass document text or a worker config. */
export function redactLog(
  message: string,
  secrets: readonly string[] = [],
): string {
  for (const secret of secrets) {
    if (!secret) continue;
    for (const value of [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ])
      message = message.split(value).join("[redacted]");
  }
  return (
    message
      // eslint-disable-next-line no-control-regex -- Strip terminal ANSI escapes.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
      .replace(
        /("(?:authorization|api[_-]?key|access[_-]?token|password|secret|cookie|set-cookie|x-api-key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[redacted]"',
      )
      .replace(
        /(\b(?:authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)[^\r\n]+/gi,
        "$1[redacted]",
      )
      .replace(
        /([?&](?:api[_-]?key|key|token|access_token|secret|password|signature|credential)=)[^\s&#]+/gi,
        "$1[redacted]",
      )
      .replace(
        /((?:authorization|api[_-]?key|access[_-]?token|password|secret)[\s"':=]+)(?:Bearer\s+)?[^\s,;"'}]+/gi,
        "$1[redacted]",
      )
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
  );
}

function loggingEnabled(): boolean {
  try {
    return getPref("saveLogs") === true;
  } catch {
    return false;
  }
}

/** Serialize appends; turning logging off also discards pending writes. */
export function log(message: string, secrets: readonly string[] = []): void {
  const safe = redactLog(message, secrets).replace(/[\r\n]+/g, " ");
  Zotero.debug?.(safe.startsWith("[ParaLens]") ? safe : "[ParaLens] " + safe);
  if (!loggingEnabled()) return;
  const timestamp = new Date().toISOString();
  const line = timestamp + " " + safe.replace(/[\r\n]+/g, " ") + "\n";
  pending = pending
    .then(async () => {
      if (!loggingEnabled()) return;
      const directory = pluginLogDirectory();
      await IOUtils.makeDirectory(directory, {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
      if (!loggingEnabled()) return;
      await IOUtils.writeUTF8(
        PathUtils.join(
          directory,
          "paralens-" + timestamp.slice(0, 10) + ".log",
        ),
        line,
        { mode: "appendOrCreate" },
      );
    })
    .catch(() => {
      Zotero.debug(
        "[ParaLens] 日志保存失败，请检查插件目录的写入权限和磁盘空间",
      );
    });
}

export function flushLogs(): Promise<void> {
  return pending;
}
