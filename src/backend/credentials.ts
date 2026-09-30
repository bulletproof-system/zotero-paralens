import { ProviderId } from "./providers";

const ORIGIN = "https://paralens.invalid";
const REALM = "ParaLens translation API";

/** Uses Zotero's Gecko password manager, never Zotero.Prefs or logs. */
function findProviderLogin(provider: ProviderId): nsILoginInfo | undefined {
  return Services.logins
    .findLogins(ORIGIN, null as unknown as string, REALM)
    .find((login) => login.username === provider);
}

export async function hasAPIKey(provider: ProviderId): Promise<boolean> {
  await Services.logins.initializationPromise;
  return Boolean(findProviderLogin(provider));
}

/** Call only at job start; do not return the key to a preferences text field. */
export async function readAPIKey(
  provider: ProviderId,
): Promise<string | undefined> {
  await Services.logins.initializationPromise;
  return findProviderLogin(provider)?.password;
}

export async function saveAPIKey(
  provider: ProviderId,
  key: string,
): Promise<void> {
  if (!key.trim()) throw new Error("API Key 不能为空");
  await Services.logins.initializationPromise;
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo,
  );
  login.init(ORIGIN, null as unknown as string, REALM, provider, key.trim());
  const existing = findProviderLogin(provider);
  if (existing) Services.logins.modifyLogin(existing, login);
  else await Services.logins.addLoginAsync(login);
}

export async function deleteAPIKey(provider: ProviderId): Promise<void> {
  await Services.logins.initializationPromise;
  const existing = findProviderLogin(provider);
  if (existing) Services.logins.removeLogin(existing);
}
