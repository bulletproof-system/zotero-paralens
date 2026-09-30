import { installBundledBackend } from "./backend/install";
import { inspectUV } from "./backend/uvRuntime";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  registerTranslationMenu,
  unregisterAllTranslationMenus,
  unregisterTranslationMenu,
} from "./reader/menu";
import { detachBilingual } from "./reader/translationWorkflow";

async function onStartup(): Promise<void> {
  // Deploy packaged scripts even if the Reader UI is not yet ready.
  try {
    addon.data.backendProjectDir = await installBundledBackend(rootURI);
  } catch (error) {
    const reason =
      error && typeof error === "object" && "name" in error
        ? String(error.name)
            .replace(/[^A-Za-z0-9_-]/g, "")
            .slice(0, 40)
        : "UnknownError";
    addon.data.backendInstallError = `后端脚本安装失败（${reason}）；请检查插件包及 Zotero 配置目录。`;
    Zotero.debug(`[ParaLens] 后端脚本安装失败（${reason}）`);
  }

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: addon.data.config.addonName,
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

  try {
    addon.data.uv = await inspectUV();
  } catch {
    addon.data.uv = {
      available: false,
      message: "uv 检测失败；翻译不可用。请在 ParaLens 设置中重新检测。",
    };
  }
  if (!addon.data.uv.available) {
    Zotero.debug(`[ParaLens] ${addon.data.uv.message}`);
  }
  // On a hot/temporary install Zotero may already have a main window open,
  // so onMainWindowLoad will not fire for it. The menu helper is idempotent.
  for (const win of Zotero.getMainWindows()) {
    registerTranslationMenu(win as Window);
  }
  // Missing uv must not prevent opening the preferences page or finish startup.
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  registerTranslationMenu(win as Window);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterTranslationMenu(win);
}

function onShutdown(): void {
  addon.data.alive = false;
  unregisterAllTranslationMenus();
  detachBilingual();
  ztoolkit.unregisterAll();
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(
  type: string,
  data: { window: Window },
): Promise<void> {
  if (type === "load") await registerPrefsScripts(data.window);
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsEvent,
};
