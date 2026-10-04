/* GrokMate Mobile configuration. Plain constants: edit here, nothing else. */

export const CONFIG = Object.freeze({
  VERSION: "1.0.0",
  // Gumroad product that sells GrokMate (combined PC + mobile listing).
  GUMROAD_PRODUCT_ID: "7B2ojeO8ghmsuaqetQ6JRg==",
  GUMROAD_VERIFY_URL: "https://api.gumroad.com/v2/licenses/verify",
  GUMROAD_LIBRARY_URL: "https://app.gumroad.com/library",
  // Re-check a saved license this often (when online) so refunded keys stop working.
  LICENSE_RECHECK_DAYS: 7,
  // Testing only. MUST stay false in production. Even when true it only works on
  // http://localhost or 127.0.0.1 with ?dev=bypass in the address.
  DEV_BYPASS: false,
  // How many earlier messages are sent to the AI with each question.
  CONTEXT_MESSAGES: 16,
  MAX_TOOL_ROUNDS: 5,
  NOT_AFFILIATED: "Independent project. Not affiliated with xAI.",
});

/* AI providers. All use the OpenAI-compatible chat completions API and allow
   browser (CORS) requests. "models" are suggestions; "Load models" asks the
   provider for its current list. */
export const PROVIDERS = Object.freeze({
  xai: {
    name: "xAI Grok", base: "https://api.x.ai/v1", model: "grok-4.3",
    models: ["grok-4.3", "grok-4.7", "grok-4.20-0309-non-reasoning"],
    keyUrl: "https://console.x.ai/", cost: "Paid. xAI bills you per use.", free: false,
  },
  gemini: {
    name: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash",
    models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
    keyUrl: "https://aistudio.google.com/apikey", cost: "Free tier available (daily limits).", free: true,
  },
  groq: {
    name: "Groq", base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    keyUrl: "https://console.groq.com/keys", cost: "Free tier available (rate limits).", free: true,
  },
  openrouter: {
    name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "openrouter/auto",
    models: ["openrouter/auto"],
    keyUrl: "https://openrouter.ai/keys", cost: "Pay per use; some free models.", free: false,
    headers: { "X-Title": "GrokMate Mobile" },
  },
  openai: {
    name: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-5-mini",
    models: ["gpt-5-mini"],
    keyUrl: "https://platform.openai.com/api-keys", cost: "Paid. OpenAI bills you per use.", free: false,
  },
});

export const DEFAULT_PROVIDER = "xai";
