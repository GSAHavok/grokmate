/* License gate: verifies the buyer's Gumroad license key once, then caches it. */
import { CONFIG } from "./config.js";
import { load, save, remove } from "./store.js";

const DAY = 86400000;

/* Gumroad's answer: {success, uses, purchase:{refunded, chargebacked, disputed, dispute_won, ...}}
   or {success:false, message} with HTTP 404 for unknown keys. */
export function judge(status, data) {
  data = data && typeof data === "object" ? data : {};
  if (!data.success) {
    if (status === 404 || status === 400) {
      return { ok: false, revoked: true,
        message: "That license key wasn't found for GrokMate. Copy it from your GrokMate download page." };
    }
    if (status >= 500 || status === 0 || status === 429) {
      return { ok: false, network: true, message: "Gumroad is busy right now. Try again in a minute." };
    }
    return { ok: false, revoked: true, message: data.message || "Gumroad didn't accept that key." };
  }
  const p = data.purchase || {};
  if (p.refunded) return { ok: false, revoked: true, message: "This purchase was refunded, so its license key no longer works." };
  if (p.chargebacked) return { ok: false, revoked: true, message: "This purchase was charged back, so its license key no longer works." };
  if (p.disputed && !p.dispute_won) return { ok: false, revoked: true, message: "This purchase is disputed, so its license key is paused. Contact the seller through Gumroad." };
  return { ok: true, message: "License verified. Welcome to GrokMate!" };
}

export async function verify(key, fetchImpl = fetch) {
  key = (key || "").trim();
  if (key.length < 8) return { ok: false, message: "Paste the full license key (it looks like XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX)." };
  const body = new URLSearchParams({
    product_id: CONFIG.GUMROAD_PRODUCT_ID,
    license_key: key,
    increment_uses_count: "false",
  });
  let res;
  try {
    res = await fetchImpl(CONFIG.GUMROAD_VERIFY_URL, { method: "POST", body });
  } catch (e) {
    return { ok: false, network: true, message: "Couldn't reach Gumroad. Check your internet connection and try again." };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return judge(res.status, data);
}

export function cached() {
  const c = load("license", null);
  return c && c.ok && c.key ? c : null;
}

export function remember(key) {
  const now = Date.now();
  save("license", { ok: true, key: key.trim(), verifiedAt: now, checkedAt: now });
}

export function forget() {
  remove("license");
}

export function devBypassActive(loc = location) {
  if (!CONFIG.DEV_BYPASS) return false;
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(loc.hostname);
  return localHost && new URLSearchParams(loc.search).get("dev") === "bypass";
}

/* Re-check a saved key now and then. Network trouble never locks you out;
   only a clear "refunded / charged back / not found" answer does. */
export async function recheckIfDue(fetchImpl = fetch) {
  const c = cached();
  if (!c) return { ok: false };
  if (Date.now() - (c.checkedAt || 0) < CONFIG.LICENSE_RECHECK_DAYS * DAY) return { ok: true, skipped: true };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: true, skipped: true };
  const r = await verify(c.key, fetchImpl);
  if (r.ok) { c.checkedAt = Date.now(); save("license", c); return r; }
  if (r.revoked) { forget(); return r; }
  return { ok: true, skipped: true };
}

export function maskKey(key) {
  key = key || "";
  return key.length <= 8 ? "••••" : key.slice(0, 4) + "…" + key.slice(-4);
}
