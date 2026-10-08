// Node-only facade for the native Gecko hidden process API.
const assert = require("node:assert/strict");
exports.installMockProcess = function installMockProcess() {
  global.Components = {
    interfaces: { nsIFile: "file", nsIProcess: "process" },
    classes: {
      "@mozilla.org/file/local;1": {
        createInstance: () => ({
          initWithPath(path) {
            this.path = path;
          },
        }),
      },
      "@mozilla.org/process/util;1": {
        createInstance: () => ({
          init(file) {
            this.file = file;
          },
          runwAsync(args, length, observer) {
            assert.equal(this.startHidden, true);
            assert.equal(this.noShell, true);
            assert.equal(length, args.length);
            const finish = (code) => {
              this.exitValue = code;
              observer.observe(null, "process-finished");
            };
            Promise.resolve()
              .then(() => Zotero.Utilities.Internal.exec(this.file.path, args))
              .then(
                (result) => finish(result === true ? 0 : 1),
                () => finish(1),
              );
          },
        }),
      },
    },
  };
};
