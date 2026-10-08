import { translationPerformance } from "../backend/performance";
import { executeHidden } from "../backend/process";
import { deleteAPIKey, hasAPIKey, saveAPIKey } from "../backend/credentials";
import {
  getProvider,
  PROVIDERS,
  resolveProviderConfig,
  ProviderId,
} from "../backend/providers";
import { inspectUV } from "../backend/uvRuntime";
import {
  bundledBackendProjectDir,
  installBundledBackend,
} from "../backend/install";
import { isBackendInstalled } from "../backend/installationStatus";
import {
  BACKENDS,
  backendInstallArguments,
  resolveBackend,
} from "../backend/selection";
import { getPref, setPref } from "../utils/prefs";

export async function registerPrefsScripts(win: Window): Promise<void> {
  const doc = win.document;
  const select = doc.getElementById(
    "paralens-provider",
  ) as HTMLSelectElement | null;
  const model = doc.getElementById("paralens-model") as HTMLInputElement | null;
  const base = doc.getElementById(
    "paralens-base-url",
  ) as HTMLInputElement | null;
  const key = doc.getElementById("paralens-api-key") as HTMLInputElement | null;
  const uvPath = doc.getElementById(
    "paralens-uv-path",
  ) as HTMLInputElement | null;
  const status = doc.getElementById("paralens-uv-status");
  const backendStatus = doc.getElementById("paralens-backend-status");
  const sourceLanguage = doc.getElementById(
    "paralens-source-language",
  ) as HTMLSelectElement | null;
  const targetLanguage = doc.getElementById(
    "paralens-target-language",
  ) as HTMLSelectElement | null;
  const backendSelect = doc.getElementById(
    "paralens-backend",
  ) as HTMLSelectElement | null;
  const backendInstall = doc.getElementById(
    "paralens-backend-install",
  ) as HTMLButtonElement | null;
  const concurrency = doc.getElementById(
    "paralens-concurrency",
  ) as HTMLInputElement | null;
  const qps = doc.getElementById("paralens-qps") as HTMLInputElement | null;
  const keyStatus = doc.getElementById("paralens-key-status");
  const saveStatus = doc.getElementById("paralens-save-status");
  if (
    !select ||
    !model ||
    !base ||
    !key ||
    !uvPath ||
    !status ||
    !backendStatus ||
    !sourceLanguage ||
    !targetLanguage ||
    !backendSelect ||
    !backendInstall ||
    !keyStatus ||
    !concurrency ||
    !qps ||
    !saveStatus
  )
    return;
  const zh = (win.navigator.language || "en").toLowerCase().startsWith("zh");
  const msg = (cn: string, en: string) => (zh ? cn : en);
  const report = (element: Element, text: string) => {
    element.textContent = text;
  };

  // The groupbox load event may occur again: do not bind duplicate listeners.
  if (select.dataset.paralensBound === "1") return;
  select.dataset.paralensBound = "1";
  for (const provider of PROVIDERS) {
    const option = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "option",
    ) as HTMLOptionElement;
    option.value = provider.id;
    option.textContent = provider.name;
    select.appendChild(option);
  }
  for (const backend of BACKENDS) {
    const option = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "option",
    ) as HTMLOptionElement;
    option.value = backend.id;
    option.textContent = backend.name;
    backendSelect.appendChild(option);
  }
  backendSelect.value = resolveBackend(getPref("backend") || "babeldoc").id;
  select.value = getProvider(getPref("provider") || "openai").id;
  model.value = getPref("model") || getProvider(select.value).suggestedModel;
  uvPath.value = getPref("uvPath") || "";
  // Invalid legacy preferences must not prevent opening settings to repair them.
  let performance;
  try {
    performance = translationPerformance(
      getPref("translationConcurrency"),
      getPref("translationQps"),
    );
  } catch {
    performance = translationPerformance(undefined, undefined);
  }
  concurrency.value = String(performance.concurrency);
  qps.value = String(performance.qps);
  sourceLanguage.value = getPref("sourceLanguage") || "en";
  targetLanguage.value = getPref("targetLanguage") || "zh";

  const showUV = () => {
    const uv = addon.data.uv;
    report(
      status,
      uv?.available
        ? msg(`uv 已就绪：${uv.path}`, `uv ready: ${uv.path}`)
        : uv?.reason === "exec-failed"
          ? msg(
              uv.message,
              "uv was found but uv --version failed. Check permissions or enter another uv path.",
            )
          : msg(
              uv?.message || "uv 检测失败；翻译功能已禁用。",
              "uv not found; translation is disabled. Install uv or enter its absolute path.",
            ),
    );
  };
  const showKey = async () => {
    const selected = select.value as ProviderId;
    try {
      const saved = await hasAPIKey(selected);
      if (selected === select.value) {
        report(
          keyStatus,
          saved
            ? msg(
                "已安全保存 API Key（输入框保持空白）。",
                "API key saved securely (input left empty).",
              )
            : msg("尚未保存 API Key。", "No API key saved."),
        );
      }
    } catch {
      report(
        keyStatus,
        msg(
          "无法访问凭据管理器；不会以明文保存密钥。",
          "Credential manager unavailable; key will not be saved as plaintext.",
        ),
      );
    }
  };
  const showProvider = () => {
    const preset = getProvider(select.value);
    base.value =
      preset.id === "custom" ? getPref("customBaseURL") || "" : preset.baseURL;
    base.readOnly = preset.id !== "custom";
    void showKey();
  };
  showUV();
  let installing = false;
  let backendCheck = 0;
  const checkBackendInstalled = (projectDir: string | undefined) =>
    isBackendInstalled(
      projectDir,
      Services.appinfo.OS === "WINNT",
      (path) => IOUtils.exists(path),
      async (path, args) => (await executeHidden(path, args)) === true,
    );
  const showBackend = async () => {
    const selected = backendSelect.value;
    const backend = resolveBackend(selected);
    if (backend.id !== selected) return;
    const check = ++backendCheck;
    const backendDir =
      addon.data.backendProjectDir || bundledBackendProjectDir();
    backendInstall.disabled = true;
    const installed = await checkBackendInstalled(backendDir);
    if (check !== backendCheck || backendSelect.value !== selected) return;
    // A click initiates provisioning; neither opening preferences nor saving
    // settings downloads Python packages.
    backendInstall.hidden = installed;
    backendInstall.disabled = installing;
    report(
      backendStatus,
      installed
        ? msg(
            `${backend.name} 已安装：${backendDir}`,
            `${backend.name} installed: ${backendDir}`,
          )
        : !addon.data.backendInstallError
          ? msg(
              `${backend.name} 未安装：${backendDir}`,
              `${backend.name} not installed: ${backendDir}`,
            )
          : msg(
              addon.data.backendInstallError,
              `${backend.name} backend files are not available. Click Install to retry.`,
            ),
    );
  };
  backendSelect.addEventListener("change", () => {
    void showBackend();
  });
  backendInstall.addEventListener("click", async () => {
    if (installing) return;
    installing = true;
    backendInstall.disabled = true;
    backendSelect.disabled = true;
    const backend = resolveBackend(backendSelect.value);
    try {
      if (backend.id !== backendSelect.value)
        throw new Error("Unsupported backend");
      // Revalidate packaged sources on explicit installation; preserve .venv.
      const projectDir = await installBundledBackend(rootURI);
      addon.data.backendProjectDir = projectDir;
      addon.data.backendInstallError = undefined;
      // Respect the path currently shown in preferences without committing it
      // until Save; the uv probe accepts an override for this explicit action.
      const uv = await inspectUV(uvPath.value.trim());
      addon.data.uv = uv;
      showUV();
      if (!uv.available || !uv.path)
        throw new Error(
          msg(
            "未找到可运行的 uv；请先安装 uv 或填写其绝对路径。",
            "uv is unavailable; install uv or enter its absolute path first.",
          ),
        );
      report(
        backendStatus,
        msg(`正在安装 ${backend.name}…`, `Installing ${backend.name}…`),
      );
      const success = await executeHidden(
        uv.path,
        backendInstallArguments(backend.id, projectDir),
      );
      if (success !== true || !(await checkBackendInstalled(projectDir)))
        throw new Error(
          msg(
            "安装失败；请检查网络、磁盘空间及 uv 日志。",
            "Installation failed; check network, free space, and uv logs.",
          ),
        );
      await showBackend();
    } catch (error) {
      report(
        backendStatus,
        error instanceof Error
          ? error.message
          : msg("安装失败。", "Installation failed."),
      );
    } finally {
      installing = false;
      backendInstall.disabled = false;
      backendSelect.disabled = false;
    }
  });
  showProvider();
  void showBackend();

  select.addEventListener("change", () => {
    model.value = getProvider(select.value).suggestedModel;
    key.value = "";
    showProvider();
  });
  doc
    .getElementById("paralens-uv-check")
    ?.addEventListener("click", async () => {
      setPref("uvPath", uvPath.value.trim());
      report(status, msg("正在检测 uv…", "Checking uv…"));
      try {
        addon.data.uv = await inspectUV();
      } catch {
        addon.data.uv = { available: false, message: "uv 检测失败" };
      }
      showUV();
    });
  doc.getElementById("paralens-save")?.addEventListener("click", async () => {
    try {
      const selected = resolveProviderConfig(
        select.value,
        model.value,
        base.value,
      );
      if (sourceLanguage.value === targetLanguage.value)
        throw new Error(
          msg(
            "原文和译文语言不能相同",
            "Source and target languages must differ",
          ),
        );
      const performance = translationPerformance(
        Number(concurrency.value),
        Number(qps.value),
      );
      if (key.value.trim()) await saveAPIKey(selected.provider, key.value);
      setPref("provider", selected.provider);
      const backend = resolveBackend(backendSelect.value);
      if (backend.id !== backendSelect.value)
        throw new Error(
          msg("不支持的翻译后端", "Unsupported translation backend"),
        );
      setPref("backend", backend.id);
      setPref("translationConcurrency", performance.concurrency);
      setPref("translationQps", performance.qps);
      setPref("sourceLanguage", sourceLanguage.value);
      setPref("targetLanguage", targetLanguage.value);
      setPref("model", selected.model);
      setPref(
        "customBaseURL",
        selected.provider === "custom"
          ? selected.baseURL
          : getPref("customBaseURL") || "",
      );
      setPref("uvPath", uvPath.value.trim());
      try {
        addon.data.uv = await inspectUV();
      } catch {
        addon.data.uv = { available: false, message: "uv 检测失败" };
      }
      showUV();
      key.value = "";
      await showKey();
      report(
        saveStatus,
        msg(
          "设置已保存（未调用翻译 API）。",
          "Settings saved (translation API not called).",
        ),
      );
    } catch (error) {
      report(
        saveStatus,
        error instanceof Error ? error.message : msg("保存失败", "Save failed"),
      );
    }
  });
  doc
    .getElementById("paralens-delete-key")
    ?.addEventListener("click", async () => {
      try {
        await deleteAPIKey(select.value as ProviderId);
        key.value = "";
        await showKey();
        report(
          saveStatus,
          msg("已删除该服务的 API Key。", "API key for this provider deleted."),
        );
      } catch {
        report(
          saveStatus,
          msg(
            "删除失败；请检查凭据管理器。",
            "Deletion failed; check credential manager.",
          ),
        );
      }
    });
}
