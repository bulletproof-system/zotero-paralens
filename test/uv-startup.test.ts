import { inspectUV } from "../src/backend/uvRuntime";
import { isBackendInstalled } from "../src/backend/installationStatus";
import { assert } from "chai";
import { config } from "../package.json";

describe("ParaLens uv startup", function () {
  it("completes startup and records uv detection status", function () {
    const instance = Zotero[config.addonInstance] as {
      data: {
        initialized: boolean;
        uv?: { available: boolean; path?: string };
      };
    };
    assert.isTrue(instance.data.initialized);
    assert.isTrue(
      Zotero.PreferencePanes.pluginPanes.some(
        (pane) => pane.pluginID === config.addonID,
      ),
    );
    assert.isBoolean(instance.data.uv?.available);
    assert.isNotNull(
      Zotero.getMainWindow().document.getElementById("paralens-translate-pdf"),
      "Menu must exist even if plugin is installed after the main window opens",
    );
    if (instance.data.uv?.available)
      assert.match(instance.data.uv.path ?? "", /uv(?:\.exe)?$/i);
  });

  it("installs the bundled backend to the writable Zotero profile", async function () {
    const instance = Zotero[config.addonInstance] as {
      data: { backendProjectDir?: string; backendInstallError?: string };
    };
    assert.isUndefined(instance.data.backendInstallError);
    const dir = PathUtils.join(PathUtils.profileDir, "paralens", "backend");
    assert.equal(instance.data.backendProjectDir, dir);
    for (const name of ["pyproject.toml", "worker.py", "mapping_adapter.py"]) {
      assert.isTrue(
        await IOUtils.exists(PathUtils.join(dir, name)),
        `missing ${name}`,
      );
    }
  });
  it("recognizes an installed Windows user uv with a native path", async function () {
    if (Services.appinfo.OS !== "WINNT") return;
    const home = Services.env.get("USERPROFILE");
    if (!home) return;
    const exe = PathUtils.join(home, ".local", "bin", "uv.exe");
    if (!(await IOUtils.exists(exe))) return;
    const executed = await Zotero.Utilities.Internal.exec(exe, ["--version"]);
    assert.equal(
      executed,
      true,
      `uv executable probe failed: ${executed instanceof Error ? executed.name : String(executed)}`,
    );
    const status = await inspectUV();
    assert.isTrue(
      status.available,
      "An installed and executable uv must be detected",
    );
    assert.isTrue(status.path?.toLowerCase().endsWith("uv.exe"));
  });
  it("renders the uv and API provider settings page", async function () {
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (p) => p.pluginID === config.addonID,
    );
    assert.isString(pane?.id);
    const win = Zotero.Utilities.Internal.openPreferences(pane!.id!);
    assert.isNotNull(win);
    try {
      for (let i = 0; i < 40; i++) {
        const select = win!.document.getElementById(
          "paralens-provider",
        ) as HTMLSelectElement | null;
        if (select?.options.length) {
          assert.isAbove(select.options.length, 2);
          assert.isNotNull(win!.document.getElementById("paralens-uv-status"));
          const backend = win!.document.getElementById(
            "paralens-backend",
          ) as HTMLSelectElement;
          const install = win!.document.getElementById(
            "paralens-backend-install",
          ) as HTMLButtonElement;
          assert.equal(backend.value, "babeldoc");
          assert.deepEqual(
            Array.from(backend.options, (option) => option.value),
            ["babeldoc"],
          );
          const project = (
            Zotero[config.addonInstance] as {
              data: { backendProjectDir?: string };
            }
          ).data.backendProjectDir;
          const installed = await isBackendInstalled(
            project,
            Services.appinfo.OS === "WINNT",
            (file) => IOUtils.exists(file),
            async (file, args) =>
              (await Zotero.Utilities.Internal.exec(file, args)) === true,
          );
          const backendStatus = win!.document.getElementById(
            "paralens-backend-status",
          );
          for (let j = 0; j < 30 && !backendStatus?.textContent; j++)
            await Zotero.Promise.delay(100);
          assert.isNotEmpty(backendStatus?.textContent);
          assert.equal(install.hidden, installed);
          (
            win!.document.getElementById("paralens-save") as HTMLButtonElement
          ).click();
          for (let j = 0; j < 30; j++) {
            const message =
              win!.document.getElementById("paralens-save-status")
                ?.textContent || "";
            if (/Settings saved|设置已保存/.test(message)) return;
            await Zotero.Promise.delay(100);
          }
          assert.fail("ParaLens settings were not saved");
        }
        await Zotero.Promise.delay(100);
      }
      assert.fail("ParaLens preference panel did not initialize");
    } finally {
      win?.close();
    }
  });
  it("offers installation when the selected backend is not installed", async function () {
    const instance = Zotero[config.addonInstance] as {
      data: { backendProjectDir?: string };
    };
    const oldDir = instance.data.backendProjectDir;
    // Only change the in-memory probe path; do not modify a real venv.
    instance.data.backendProjectDir = PathUtils.join(
      PathUtils.profileDir,
      "paralens",
      "missing-backend-for-ui-test",
    );
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (entry) => entry.pluginID === config.addonID,
    );
    let win: Window | undefined;
    try {
      win = Zotero.Utilities.Internal.openPreferences(pane!.id!) as Window;
      const install = () =>
        win!.document.getElementById(
          "paralens-backend-install",
        ) as HTMLButtonElement | null;
      const status = () =>
        win!.document.getElementById("paralens-backend-status")?.textContent ||
        "";
      for (let i = 0; i < 50 && (!install() || !status()); i++)
        await Zotero.Promise.delay(100);
      assert.isNotNull(install());
      assert.isFalse(
        install()!.hidden,
        "Missing backend must show the Install button",
      );
      assert.isFalse(
        install()!.disabled,
        "Install must be available for retry",
      );
      assert.match(status(), /未安装|not installed/);
    } finally {
      win?.close();
      instance.data.backendProjectDir = oldDir;
    }
  });

  it("installs a missing backend only after clicking Install", async function () {
    const instance = Zotero[config.addonInstance] as {
      data: { backendProjectDir?: string; uv?: { available: boolean } };
    };
    const installedDir = instance.data.backendProjectDir;
    assert.isString(installedDir);
    assert.isTrue(
      await isBackendInstalled(
        installedDir,
        Services.appinfo.OS === "WINNT",
        (file) => IOUtils.exists(file),
        async (file, args) =>
          (await Zotero.Utilities.Internal.exec(file, args)) === true,
      ),
      "This test must use a prepared isolated venv",
    );
    const oldUV = instance.data.uv;
    const internal = Zotero.Utilities.Internal;
    const originalExec = internal.exec;
    const syncArgs: string[][] = [];
    // Never actually run uv sync or download packages during a GUI test.
    const intercept = (async (...args: Parameters<typeof originalExec>) => {
      const [, argv] = args;
      if (Array.isArray(argv) && argv[0] === "sync") {
        syncArgs.push(argv);
        return true;
      }
      return originalExec.apply(internal, args);
    }) as typeof originalExec;
    let win: Window | undefined;
    try {
      internal.exec = intercept;
      assert.strictEqual(
        internal.exec,
        intercept,
        "uv sync must be intercepted before clicking",
      );
      instance.data.backendProjectDir = PathUtils.join(
        PathUtils.profileDir,
        "paralens",
        "missing-before-install-click",
      );
      const pane = Zotero.PreferencePanes.pluginPanes.find(
        (entry) => entry.pluginID === config.addonID,
      );
      win = Zotero.Utilities.Internal.openPreferences(pane!.id!) as Window;
      const button = () =>
        win!.document.getElementById(
          "paralens-backend-install",
        ) as HTMLButtonElement | null;
      for (
        let i = 0;
        i < 50 && (!button() || button()!.hidden || button()!.disabled);
        i++
      )
        await Zotero.Promise.delay(100);
      assert.isNotNull(button());
      assert.isFalse(button()!.hidden);
      assert.isFalse(button()!.disabled);
      assert.equal(
        syncArgs.length,
        0,
        "Opening settings must not install dependencies",
      );
      button()!.click();
      for (let i = 0; i < 80 && (!button()!.hidden || !syncArgs.length); i++)
        await Zotero.Promise.delay(100);
      assert.equal(
        syncArgs.length,
        1,
        "Only an explicit click should run uv sync",
      );
      assert.deepEqual(syncArgs[0], [
        "sync",
        "--project",
        installedDir,
        "--python",
        "3.12",
      ]);
      assert.isTrue(
        button()!.hidden,
        "Install hides after the pinned venv is runnable",
      );
      assert.isFalse(button()!.disabled);
      assert.isFalse(
        (win!.document.getElementById("paralens-backend") as HTMLSelectElement)
          .disabled,
      );
      assert.equal(instance.data.backendProjectDir, installedDir);
    } finally {
      win?.close();
      internal.exec = originalExec;
      instance.data.backendProjectDir = installedDir;
      instance.data.uv = oldUV;
    }
  });

  it("can store and remove a disposable secret with Gecko's login manager", async function () {
    const origin = "https://paralens.invalid";
    const realm = "ParaLens translation API";
    const username = "__paralens_test_only__";
    const logins = Services.logins;
    await logins.initializationPromise;
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo,
    );
    login.init(
      origin,
      null as unknown as string,
      realm,
      username,
      "dummy-test-value",
    );
    const find = () =>
      logins
        .findLogins(origin, null as unknown as string, realm)
        .find((entry) => entry.username === username);
    if (find())
      throw new Error(
        "Test credential unexpectedly exists; refusing to overwrite it",
      );
    await logins.addLoginAsync(login);
    try {
      assert.equal(find()?.password, "dummy-test-value");
    } finally {
      const saved = find();
      if (saved) logins.removeLogin(saved);
    }
  });
});
