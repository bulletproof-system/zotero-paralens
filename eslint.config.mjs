// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";
import globals from "globals";

export default zotero({
  overrides: [
    {
      files: ["scripts/**/*.mjs", "eslint.config.mjs"],
      languageOptions: {
        globals: globals.nodeBuiltin,
      },
    },
    {
      files: ["scripts/**/*.cjs", "test/**/*.cjs"],
      languageOptions: {
        globals: globals.node,
      },
    },
    {
      // Node tests install writable doubles for the Zotero runtime.
      files: ["test/**/*.cjs"],
      languageOptions: {
        globals: {
          Zotero: "writable",
          IOUtils: "writable",
        },
      },
    },
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
  ],
});
