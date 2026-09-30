import { UVStatus } from "./backend/uv";
import { config } from "../package.json";
import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    uv?: UVStatus;
    backendProjectDir?: string;
    backendInstallError?: string;
    ztoolkit: ZToolkit;
    locale?: { current: any };
    prefs?: { window: Window };
  };
  public hooks: typeof hooks;
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

import { createZToolkit } from "./utils/ztoolkit";
export default Addon;
