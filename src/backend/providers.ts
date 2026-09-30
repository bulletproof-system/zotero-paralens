/** Only provider metadata is stored in Zotero preferences; never credentials. */
export type ProviderId = "openai" | "openrouter" | "deepseek" | "custom";

export interface ProviderPreset {
  id: ProviderId;
  name: string;
  baseURL: string;
  suggestedModel: string;
}

/** All presets use BabelDOC 0.5.20's OpenAI-compatible Chat Completions client. */
export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    suggestedModel: "gpt-4.1-mini",
  },
  {
    id: "openrouter",
    name: "OpenRouter (多模型聚合)",
    baseURL: "https://openrouter.ai/api/v1",
    suggestedModel: "",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    suggestedModel: "deepseek-flash",
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口 / LiteLLM",
    baseURL: "",
    suggestedModel: "",
  },
];

export function getProvider(value: string): ProviderPreset {
  return PROVIDERS.find((provider) => provider.id === value) ?? PROVIDERS[0];
}

/** Never silently send a private PDF or key to an unencrypted remote host. */
export function validateBaseURL(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入有效的 API Base URL");
  }
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("远程 API 必须使用 HTTPS（本机回环地址可使用 HTTP）");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址中不能包含账号、密钥、查询参数或片段");
  }
  return url.toString().replace(/\/$/, "");
}

export function resolveProviderConfig(
  providerId: string,
  model: string,
  customBaseURL: string,
): { provider: ProviderId; model: string; baseURL: string } {
  const preset = getProvider(providerId);
  const selectedModel = model.trim() || preset.suggestedModel;
  if (!selectedModel || /\s/.test(selectedModel)) {
    throw new Error("请填写该服务支持的模型 ID");
  }
  const validated = validateBaseURL(
    preset.id === "custom" ? customBaseURL : preset.baseURL,
  );
  // The worker uses OpenAI chat.completions.create, which appends
  // /chat/completions to this base URL. A full /v1/responses endpoint is
  // not a base URL. Use its parent on the same origin; preserve the value
  // the user entered in preferences for display/editing.
  const baseURL =
    preset.id === "custom"
      ? validated.replace(/\/v1\/responses$/i, "/v1")
      : validated;
  return { provider: preset.id, model: selectedModel, baseURL };
}
