import { repository, version } from "../../package.json";

export function releaseSourceURLs() {
  const base = repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  return {
    source: base + "/tree/v" + version,
    archive:
      base +
      "/releases/download/v" +
      version +
      "/zotero-paralens-" +
      version +
      "-source.tar.gz",
  };
}

/** Local license texts are loaded only when the user opens the disclosure. */
export function registerLicenseUI(win: Window): void {
  const doc = win.document;
  const details = doc.getElementById(
    "paralens-legal",
  ) as HTMLDetailsElement | null;
  const text = doc.getElementById("paralens-legal-text");
  if (!details || !text || details.dataset.paralensBound === "1") return;
  details.dataset.paralensBound = "1";
  const urls = releaseSourceURLs();
  for (const [id, url] of [
    ["paralens-source", urls.source],
    ["paralens-source-archive", urls.archive],
  ]) {
    doc
      .getElementById(id)
      ?.addEventListener("click", () => Zotero.launchURL(url));
  }
  let loading = false;
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loading || loaded) return;
    loading = true;
    try {
      const names = [
        "THIRD_PARTY_NOTICES.md",
        "LICENSE.txt",
        "zotero-plugin-toolkit-LICENSE.txt",
        "BabelDOC-0.5.20-LICENSE.txt",
        "DEPENDENCIES.json",
      ];
      const texts = await Promise.all(
        names.map(async (name) => {
          const content = await Zotero.File.getResourceAsync(
            rootURI.replace(/\/?$/, "/") + "content/licenses/" + name,
          );
          return name + "\n\n" + content;
        }),
      );
      text.textContent = texts.join(
        "\n\n----------------------------------------\n\n",
      );
      loaded = true;
    } catch {
      const zh = (win.navigator.language || "en")
        .toLowerCase()
        .startsWith("zh");
      text.textContent = zh
        ? "无法读取本地许可文件。关闭后重新展开可重试；也可在 XPI 的 licenses 目录中查看。"
        : "Unable to read local license files. Reopen to retry, or inspect the licenses directory inside the XPI.";
    } finally {
      loading = false;
    }
  });
}
