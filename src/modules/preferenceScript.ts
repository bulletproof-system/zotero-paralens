import { translationPerformance } from "../backend/performance";
import {
  executeBackendInstall,
  executeBackendProbe,
} from "../backend/installProcess";
import {
  BackendInstallProgress,
  InstallStage,
} from "../backend/installProgress";
import { log, pluginLogDirectory } from "../utils/log";
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
import {
  inspectBackendInstallation,
  BackendInstallationState,
} from "../backend/installationStatus";
import {
  BACKENDS,
  backendInstallArguments,
  resolveBackend,
} from "../backend/selection";
import { getPref, setPref } from "../utils/prefs";
import { registerLicenseUI } from "../utils/license";
import { translationQueue } from "../reader/translationWorkflow";

const backendSettingsListeners = new Set<(origin: Document) => void>();

export async function registerPrefsScripts(win: Window): Promise<void> {
  registerLicenseUI(win);
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
  const backendCheckButton = doc.getElementById(
    "paralens-backend-check",
  ) as HTMLButtonElement | null;
  const backendProgress = doc.getElementById(
    "paralens-backend-progress",
  ) as HTMLProgressElement | null;
  const saveLogs = doc.getElementById(
    "paralens-save-logs",
  ) as HTMLInputElement | null;
  const logPath = doc.getElementById("paralens-log-path");
  const backendReinstall = doc.getElementById(
    "paralens-backend-reinstall",
  ) as HTMLButtonElement | null;
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
  const autoRepair = doc.getElementById(
    "paralens-auto-repair",
  ) as HTMLInputElement | null;
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
    !backendReinstall ||
    !sourceLanguage ||
    !targetLanguage ||
    !backendSelect ||
    !backendInstall ||
    !keyStatus ||
    !concurrency ||
    !qps ||
    !autoRepair ||
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
  autoRepair.checked = getPref("autoRepair") === true;
  if (saveLogs) {
    saveLogs.checked = getPref("saveLogs") === true;
    // Diagnostic logging takes effect immediately, including before installation.
    saveLogs.addEventListener("change", () => {
      setPref("saveLogs", saveLogs.checked);
      if (saveLogs.checked) log("日志保存已开启");
    });
  }
  if (logPath)
    report(
      logPath,
      msg("日志目录：", "Log directory: ") + pluginLogDirectory(),
    );
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
  let backendChecking = false;
  let backendCheck = 0;
  const updateBackendControls = () => {
    const busy = installing || addon.data.backendInstalling === true;
    backendSelect.disabled = busy;
    backendInstall.disabled = busy || backendChecking;
    backendReinstall.disabled = busy || backendChecking;
    if (backendCheckButton)
      backendCheckButton.disabled = busy || backendChecking;
  };
  const checkBackend = (projectDir: string | undefined) =>
    inspectBackendInstallation(
      projectDir,
      Services.appinfo.OS === "WINNT",
      (path) => IOUtils.exists(path),
      executeBackendProbe,
    );
  const backendDescription = (
    state: BackendInstallationState,
    name: string,
    directory: string,
  ) => {
    if (state === "ready")
      return msg(
        name + " 已安装：" + directory,
        name + " installed: " + directory,
      );
    if (state === "broken")
      return msg(
        name +
          " 已安装，但依赖模块加载失败。请开启日志保存后点击「检测后端」，检查 Python 依赖或系统运行库。",
        name +
          " is installed, but dependency imports failed. Enable log saving and click Check backend to inspect Python dependencies or system runtime libraries.",
      );
    if (state === "incompatible")
      return msg(
        name +
          " 未安装、版本不符或 Python 无法启动：" +
          directory +
          "。请开启日志后检测或重新安装。",
        name +
          " is missing, has an incompatible version, or Python cannot start: " +
          directory +
          ". Enable logs and check or reinstall.",
      );
    return (
      addon.data.backendInstallError ||
      msg(name + " 未安装：" + directory, name + " not installed: " + directory)
    );
  };
  const showBackend = async () => {
    if (installing || addon.data.backendInstalling) {
      updateBackendControls();
      return;
    }
    const selected = backendSelect.value;
    const backend = resolveBackend(selected);
    if (backend.id !== selected) return;
    const check = ++backendCheck;
    const backendDir =
      addon.data.backendProjectDir || bundledBackendProjectDir();
    backendChecking = true;
    updateBackendControls();
    try {
      const state = await checkBackend(backendDir);
      if (
        check !== backendCheck ||
        backendSelect.value !== selected ||
        installing ||
        addon.data.backendInstalling
      )
        return;
      backendInstall.hidden = state === "ready" || state === "broken";
      report(
        backendStatus,
        backendDescription(state, backend.name, backendDir),
      );
      log("后端检测结果：" + state);
    } finally {
      if (check === backendCheck) backendChecking = false;
      updateBackendControls();
    }
  };
  const onBackendStateChanged = (origin: Document) => {
    if (win.closed || backendSelect.isConnected === false) {
      backendSettingsListeners.delete(onBackendStateChanged);
      return;
    }
    updateBackendControls();
    if (origin !== doc && !addon.data.backendInstalling) void showBackend();
  };
  backendSettingsListeners.add(onBackendStateChanged);
  win.addEventListener?.(
    "unload",
    () => backendSettingsListeners.delete(onBackendStateChanged),
    { once: true },
  );
  const notifyBackendStateChanged = () => {
    for (const listener of backendSettingsListeners) listener(doc);
  };
  backendSelect.addEventListener("change", () => {
    void showBackend();
  });
  backendCheckButton?.addEventListener("click", () => {
    void showBackend();
  });
  const provisionBackend = async (reinstall: boolean) => {
    if (installing || addon.data.backendInstalling) return;
    if (
      translationQueue()
        .snapshot()
        .some((task) => ["queued", "running"].includes(task.state))
    ) {
      report(
        backendStatus,
        msg(
          "请先等待翻译完成或取消排队和运行中的任务，再安装／重新安装后端。",
          "Finish or cancel queued/running translations before installing or reinstalling the backend.",
        ),
      );
      return;
    }
    if (
      reinstall &&
      !win.confirm(
        msg(
          "重新安装将重新部署后端脚本，并由 uv 重新安装 Python 依赖，可能联网下载并占用时间。不会删除 API Key、PDF、映射附件或已有作业产物。继续？",
          "Reinstall will redeploy backend scripts and reinstall Python dependencies using uv, which may download files and take time. API keys, PDFs, mapping attachments and existing job artifacts are retained. Continue?",
        ),
      )
    )
      return;
    const trigger = reinstall ? backendReinstall : backendInstall;
    const restoreFocus = doc.activeElement === trigger;
    installing = true;
    addon.data.backendInstalling = true;
    ++backendCheck;
    backendChecking = false;
    notifyBackendStateChanged();
    const backend = resolveBackend(backendSelect.value);
    const stages: Record<InstallStage, string> = {
      preparing: msg("准备后端文件", "Preparing backend files"),
      "checking-uv": msg("检测 uv", "Checking uv"),
      resolving: msg(
        "解析依赖及准备 Python 环境",
        "Resolving dependencies and preparing Python",
      ),
      downloading: msg(
        "下载及构建依赖",
        "Downloading and building dependencies",
      ),
      installing: msg("安装依赖", "Installing dependencies"),
      verifying: msg("验证后端模块", "Verifying backend modules"),
      completed: msg("安装完成", "Installation complete"),
    };
    let lastPercent = 0;
    const progress = new BackendInstallProgress(({ stage, percent }) => {
      lastPercent = percent;
      if (backendProgress) {
        backendProgress.hidden = false;
        backendProgress.max = 100;
        backendProgress.value = percent;
      }
      report(
        backendStatus,
        msg(
          (reinstall ? "正在重新安装 " : "正在安装 ") +
            backend.name +
            " · " +
            percent +
            "%" +
            (percent < 100 ? "（估算）" : "") +
            " · " +
            stages[stage],
          (reinstall ? "Reinstalling " : "Installing ") +
            backend.name +
            " · " +
            percent +
            "%" +
            (percent < 100 ? " (estimated)" : "") +
            " · " +
            stages[stage],
        ),
      );
    });
    progress.advance("preparing", 0);
    log(reinstall ? "开始重新安装后端" : "开始安装后端");
    try {
      if (backend.id !== backendSelect.value)
        throw new Error("Unsupported backend");
      // Revalidate packaged sources on explicit installation; preserve .venv.
      const projectDir = await installBundledBackend(rootURI);
      addon.data.backendProjectDir = projectDir;
      addon.data.backendInstallError = undefined;
      // Respect the path currently shown in preferences without committing it
      // until Save; the uv probe accepts an override for this explicit action.
      progress.advance("checking-uv", 10);
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
      progress.advance("resolving", 20);
      const success = await executeBackendInstall(
        uv.path,
        backendInstallArguments(backend.id, projectDir, reinstall),
        (line) => progress.output(line),
      );
      progress.advance("verifying", 95);
      const state =
        success === true ? await checkBackend(projectDir) : "incompatible";
      if (state !== "ready") {
        log("安装后验证失败：" + state);
        throw new Error(backendDescription(state, backend.name, projectDir));
      }
      progress.advance("completed", 100);
      log(reinstall ? "后端重新安装完成" : "后端安装完成");
      report(
        backendStatus,
        msg(
          reinstall ? "后端重新安装完成（100%）。" : "后端安装完成（100%）。",
          reinstall
            ? "Backend reinstalled (100%)."
            : "Backend installed (100%).",
        ),
      );
      backendInstall.hidden = true;
    } catch (error) {
      log("后端安装失败，最后进度：" + lastPercent + "%");
      report(
        backendStatus,
        lastPercent +
          "% · " +
          msg("安装失败：", "Installation failed: ") +
          (error instanceof Error
            ? error.message
            : msg("安装失败。", "Installation failed.")),
      );
    } finally {
      installing = false;
      addon.data.backendInstalling = false;
      notifyBackendStateChanged();
      // Hiding/disabling the focused install button can strand Gecko popup focus.
      if (restoreFocus && !win.closed) {
        (trigger.hidden ? backendSelect : trigger).focus();
      }
    }
  };
  backendInstall.addEventListener("click", () => {
    void provisionBackend(false);
  });
  backendReinstall.addEventListener("click", () => {
    void provisionBackend(true);
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
      setPref("autoRepair", autoRepair.checked);
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
