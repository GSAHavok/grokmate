/* Tiny localStorage wrapper. Everything GrokMate Mobile saves stays on this device. */

const P = "gm.";

export function load(name, fallback) {
  try {
    const raw = localStorage.getItem(P + name);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function save(name, value) {
  try {
    localStorage.setItem(P + name, JSON.stringify(value));
    return true;
  } catch (e) {
    return false; // storage full or blocked (private mode)
  }
}

export function remove(name) {
  try { localStorage.removeItem(P + name); } catch (e) { /* ignore */ }
}

export function uid() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const DEFAULT_SETTINGS = Object.freeze({
  provider: "xai",
  models: {},          // per-provider model override
  customBase: "",      // only for provider "custom"
  speak: true,         // read replies aloud
  voiceURI: "",
  rate: 1,
  sttLang: "",         // "" = phone language
  units: "metric",     // metric | imperial
  search: "google",    // google | duckduckgo | bing
  toolMode: "auto",    // auto = function calling, text = text fallback
  keepAwake: true,     // keep the screen on while a timer runs
});

export function getSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, load("settings", {}));
}

export function setSettings(patch) {
  const s = Object.assign(getSettings(), patch);
  save("settings", s);
  return s;
}

export function getKey(provider) {
  return (load("keys", {})[provider] || "").trim();
}

export function setKey(provider, key) {
  const keys = load("keys", {});
  if (key) keys[provider] = key.trim(); else delete keys[provider];
  save("keys", keys);
}
