const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const outfile = path.resolve(".scaffold/credentials-tests.cjs");
buildSync({
  entryPoints: ["src/backend/credentials.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const { hasAPIKey, readAPIKey, saveAPIKey, deleteAPIKey } = require(outfile);
function fixture(modern = true, asyncMutations = modern) {
  const state = {
    entries: [],
    searches: [],
    legacyCalls: 0,
    modifies: 0,
    mutationError: undefined,
  };
  const manager = {
    initializationPromise: Promise.resolve(),
    findLogins(origin, action, realm) {
      state.legacyCalls++;
      if (modern) throw Error("findLogins was removed");
      assert.equal(origin, "https://paralens.invalid");
      assert.equal(action, null);
      assert.equal(realm, "ParaLens translation API");
      return state.entries;
    },
    async addLoginAsync(login) {
      state.entries.push(login);
    },
  };
  const modify = (existing, replacement) => {
    state.modifies++;
    state.entries.splice(state.entries.indexOf(existing), 1, replacement);
  };
  const remove = (existing) => {
    state.entries.splice(state.entries.indexOf(existing), 1);
  };
  if (asyncMutations) {
    // Current Gecko exposes no synchronous mutation methods. Defer the
    // mutations so callers that forget to await them also fail the test.
    manager.modifyLoginAsync = async (existing, replacement) => {
      await new Promise(setImmediate);
      if (state.mutationError) throw state.mutationError;
      modify(existing, replacement);
    };
    manager.removeLoginAsync = async (existing) => {
      await new Promise(setImmediate);
      if (state.mutationError) throw state.mutationError;
      remove(existing);
    };
  } else {
    manager.modifyLogin = modify;
    manager.removeLogin = remove;
  }
  if (modern)
    manager.searchLoginsAsync = async (criteria) => {
      state.searches.push(criteria);
      assert.deepEqual(criteria, {
        origin: "https://paralens.invalid",
        httpRealm: "ParaLens translation API",
      });
      return state.entries;
    };
  global.Services = { logins: manager };
  global.Ci = { nsILoginInfo: "login" };
  global.Cc = {
    "@mozilla.org/login-manager/loginInfo;1": {
      createInstance: () => ({
        init(origin, action, realm, username, password) {
          Object.assign(this, { origin, action, realm, username, password });
        },
      }),
    },
  };
  return state;
}
test("current Gecko credentials await async queries and mutations and keep provider keys separate", async () => {
  const state = fixture();
  assert.equal(await hasAPIKey("openai"), false);
  await saveAPIKey("openai", " first-key ");
  await saveAPIKey("deepseek", "other-key");
  assert.equal(await readAPIKey("openai"), "first-key");
  assert.equal(await readAPIKey("deepseek"), "other-key");
  await saveAPIKey("openai", "replacement-key");
  assert.equal(state.modifies, 1);
  assert.equal(state.entries.length, 2);
  assert.equal(await readAPIKey("openai"), "replacement-key");
  await deleteAPIKey("openai");
  assert.equal(await hasAPIKey("openai"), false);
  assert.equal(await readAPIKey("deepseek"), "other-key");
  assert.equal(state.legacyCalls, 0);
  assert(state.searches.length > 0);
});
test("older login managers retain credential access through the compatibility fallback", async () => {
  const state = fixture(false);
  await saveAPIKey("openai", "legacy-key");
  assert.equal(await readAPIKey("openai"), "legacy-key");
  await saveAPIKey("openai", "updated-legacy-key");
  assert.equal(await readAPIKey("openai"), "updated-legacy-key");
  assert.equal(state.modifies, 1);
  await deleteAPIKey("openai");
  assert.equal(await hasAPIKey("openai"), false);
  assert(state.legacyCalls > 0);
});
test("login managers with async search and sync mutations retain credential access", async () => {
  const state = fixture(true, false);
  await saveAPIKey("openai", "first-key");
  await saveAPIKey("openai", "updated-key");
  assert.equal(await readAPIKey("openai"), "updated-key");
  await deleteAPIKey("openai");
  assert.equal(await hasAPIKey("openai"), false);
  assert.equal(state.legacyCalls, 0);
});
test("async mutation failures reject without reporting success or changing the saved key", async () => {
  const state = fixture();
  await saveAPIKey("openai", "existing-key");
  const failure = new Error("Login storage unavailable");
  state.mutationError = failure;
  await assert.rejects(saveAPIKey("openai", "replacement-key"), failure);
  await assert.rejects(deleteAPIKey("openai"), failure);
  assert.equal(await readAPIKey("openai"), "existing-key");
});
