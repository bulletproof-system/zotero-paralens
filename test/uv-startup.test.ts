import { executeHidden } from "../src/backend/process";
import { inspectUV } from "../src/backend/uvRuntime";
import { isBackendInstalled } from "../src/backend/installationStatus";
import { assert } from "chai";
import { getPref, setPref } from "../src/utils/prefs";
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
    const executed = await executeHidden(exe, ["--version"]);
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

  it("starts console executables and their child without a visible Windows console", async function () {
    const mockUV = Services.env.get("PARALENS_TEST_INSTALL_UV");
    if (Services.appinfo.OS !== "WINNT" || !mockUV) this.skip();
    const record = PathUtils.join(
      PathUtils.parent(mockUV),
      "hidden-process.txt",
    );
    assert.isFalse(await IOUtils.exists(record));
    assert.isTrue(await executeHidden(mockUV, ["--hidden-probe", record]));
    assert.deepEqual((await IOUtils.readUTF8(record)).trim().split(/\r?\n/), [
      "parent:false",
      "child:false",
    ]);
    let rejected = false;
    try {
      await executeHidden(mockUV, ["--exit-error"]);
    } catch {
      rejected = true;
    }
    assert.isTrue(rejected, "Nonzero native exits must not look successful");
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
          const concurrency = win!.document.getElementById(
            "paralens-concurrency",
          ) as HTMLInputElement;
          const qps = win!.document.getElementById(
            "paralens-qps",
          ) as HTMLInputElement;
          assert.equal(
            concurrency.value,
            String(getPref("translationConcurrency")),
          );
          assert.equal(qps.value, String(getPref("translationQps")));
          assert.equal(concurrency.max, "16");
          assert.equal(qps.max, "10");
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
            async (file, args) => (await executeHidden(file, args)) === true,
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

  it("rejects invalid performance settings and persists independent concurrency and QPS", async function () {
    const old = [getPref("translationConcurrency"), getPref("translationQps")];
    const pane = Zotero.PreferencePanes.pluginPanes.find(
      (p) => p.pluginID === config.addonID,
    );
    const win = Zotero.Utilities.Internal.openPreferences(pane!.id!)!;
    try {
      let concurrency: HTMLInputElement | null = null;
      for (let i = 0; i < 40; i++) {
        concurrency = win.document.getElementById(
          "paralens-concurrency",
        ) as HTMLInputElement | null;
        if (concurrency?.value) break;
        await Zotero.Promise.delay(100);
      }
      assert.isNotNull(concurrency);
      const qps = win.document.getElementById(
        "paralens-qps",
      ) as HTMLInputElement;
      const save = win.document.getElementById(
        "paralens-save",
      ) as HTMLButtonElement;
      const status = win.document.getElementById("paralens-save-status")!;
      concurrency!.value = "17";
      save.click();
      for (let i = 0; i < 30 && !/整数/.test(status.textContent || ""); i++)
        await Zotero.Promise.delay(100);
      assert.match(status.textContent || "", /整数/);
      assert.equal(getPref("translationConcurrency"), old[0]);
      concurrency!.value = "6";
      qps.value = "3";
      save.click();
      for (
        let i = 0;
        i < 30 && !/Settings saved|设置已保存/.test(status.textContent || "");
        i++
      )
        await Zotero.Promise.delay(100);
      assert.match(status.textContent || "", /Settings saved|设置已保存/);
      assert.equal(getPref("translationConcurrency"), 6);
      assert.equal(getPref("translationQps"), 3);
    } finally {
      win.close();
      setPref("translationConcurrency", old[0]);
      setPref("translationQps", old[1]);
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
        async (file, args) => (await executeHidden(file, args)) === true,
      ),
      "This test must use a prepared isolated venv",
    );
    const oldUV = instance.data.uv;
    const mockUV = Services.env.get("PARALENS_TEST_INSTALL_UV");
    const record = Services.env.get("PARALENS_TEST_INSTALL_ARGS");
    if (!mockUV || !record) this.skip();
    let win: Window | undefined;
    try {
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
      assert.isFalse(
        await IOUtils.exists(record),
        "Opening settings must not install dependencies",
      );
      (
        win!.document.getElementById("paralens-uv-path") as HTMLInputElement
      ).value = mockUV;
      button()!.click();
      for (
        let i = 0;
        i < 80 && (!button()!.hidden || !(await IOUtils.exists(record)));
        i++
      )
        await Zotero.Promise.delay(100);
      assert.isTrue(
        await IOUtils.exists(record),
        "Only an explicit click should run uv sync",
      );
      const syncArgs = (await IOUtils.readUTF8(record)).trim().split(/\r?\n/);
      assert.deepEqual(syncArgs, [
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
