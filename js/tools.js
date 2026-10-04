/* Tools the AI can call. Each returns {result, card}: "result" goes back to the
   AI, "card" is what the app shows (buttons the user taps, timers, weather...).
   Only things a phone browser really can do. Nothing here dials, texts, opens
   other apps or sets system alarms by itself. */
import { load, save, uid } from "./store.js";
import { calculate, formatNumber } from "./mathx.js";
import { buildICS, googleCalendarUrl, parseLocal, fileName } from "./ics.js";

const fn = (name, description, properties, required = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const TOOL_DEFS = [
  fn("set_timer", "Start a countdown timer on the phone. It rings with sound and vibration while GrokMate is open.",
    { seconds: { type: "integer", description: "Length in seconds (1 to 86400)" }, label: { type: "string", description: "Short name, e.g. pasta" } }, ["seconds"]),
  fn("list_timers", "List running timers with time left.", {}),
  fn("cancel_timer", "Cancel a timer by id, or all timers.", { id: { type: "string" }, all: { type: "boolean" } }),
  fn("add_note", "Save a note on this phone.", { text: { type: "string" }, title: { type: "string" } }, ["text"]),
  fn("list_notes", "List or search saved notes (newest first).", { query: { type: "string", description: "Optional words to search for" } }),
  fn("delete_note", "Delete a saved note by id (get ids from list_notes).", { id: { type: "string" } }, ["id"]),
  fn("create_reminder", "Make a calendar reminder the user adds to their phone calendar with one tap; the calendar alerts them even when GrokMate is closed.",
    {
      title: { type: "string" },
      start: { type: "string", description: "Local date and time, format YYYY-MM-DDTHH:MM (the user's own time zone)" },
      duration_minutes: { type: "integer", description: "Default 15" },
      alert_minutes_before: { type: "integer", description: "Default 0 (alert at the start time)" },
      notes: { type: "string" },
    }, ["title", "start"]),
  fn("quick_action", "Prepare a button the user taps to call, text, email, open maps, search the web or open a link. Never runs by itself.",
    {
      type: { type: "string", enum: ["call", "sms", "email", "maps", "search", "link"] },
      target: { type: "string", description: "Phone number, email address, place, search words or https link" },
      message: { type: "string", description: "Optional text body for sms or email" },
      subject: { type: "string", description: "Optional email subject" },
    }, ["type", "target"]),
  fn("get_weather", "Current weather and a 3-day forecast (Open-Meteo).",
    { location: { type: "string", description: "City or place. Leave empty to use the phone's location." } }),
  fn("copy_share", "Show Copy and Share buttons for a piece of text (the user taps them).",
    { text: { type: "string" }, title: { type: "string" } }, ["text"]),
  fn("get_datetime", "Current date and time, optionally in another time zone.",
    { timezone: { type: "string", description: "IANA zone like Europe/London. Empty = the phone's zone." } }),
  fn("date_diff", "Days between two dates (YYYY-MM-DD). 'from' defaults to today.",
    { from: { type: "string" }, to: { type: "string" } }, ["to"]),
  fn("calculate", "Exact arithmetic: + - * / ^ %, '15% of 80', sqrt, sin (degrees), log, ln, pi.",
    { expression: { type: "string" } }, ["expression"]),
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.function.name);

/* ------------------------------------------------------------------ timers */
export const timers = {
  all() { return load("timers", []); },
  saveAll(list) { save("timers", list); },
  add(seconds, label, now = Date.now()) {
    const t = { id: uid().slice(0, 6), label: (label || "").slice(0, 40), endsAt: now + seconds * 1000, seconds, done: false };
    const list = this.all().filter((x) => !x.done);
    list.push(t);
    this.saveAll(list);
    return t;
  },
  cancel(id) {
    const list = this.all();
    const keep = id ? list.filter((t) => t.id !== id) : [];
    this.saveAll(keep);
    return list.length - keep.length;
  },
  due(now = Date.now()) { return this.all().filter((t) => !t.done && t.endsAt <= now); },
  markDone(id) { this.saveAll(this.all().map((t) => (t.id === id ? Object.assign(t, { done: true }) : t))); },
  clearDone() { this.saveAll(this.all().filter((t) => !t.done)); },
};

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function spokenDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
  if (m) parts.push(`${m} minute${m > 1 ? "s" : ""}`);
  if (s) parts.push(`${s} second${s > 1 ? "s" : ""}`);
  return parts.join(" ") || "0 seconds";
}

/* ------------------------------------------------------------------- notes */
export const notes = {
  all() { return load("notes", []); },
  add(text, title) {
    const n = { id: uid().slice(0, 6), title: (title || "").slice(0, 80), text: String(text).slice(0, 5000), ts: Date.now() };
    const list = this.all();
    list.unshift(n);
    save("notes", list);
    return n;
  },
  search(q) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    return this.all().filter((n) => words.every((w) => (n.title + " " + n.text).toLowerCase().includes(w)));
  },
  remove(id) {
    const list = this.all();
    const keep = list.filter((n) => n.id !== id);
    save("notes", keep);
    return list.length !== keep.length;
  },
  exportText() {
    return this.all().map((n) => `${new Date(n.ts).toLocaleString()}${n.title ? " - " + n.title : ""}\n${n.text}\n`).join("\n");
  },
};

/* ----------------------------------------------------------- quick actions */
export function isIOS(ua = navigator.userAgent) {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
}

const SEARCH = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
};

export function actionLink({ type, target, message, subject }, { search = "google", ios = isIOS() } = {}) {
  target = String(target || "").trim();
  const enc = encodeURIComponent;
  switch (type) {
    case "call": {
      const num = target.replace(/[^\d+*#]/g, "");
      if (num.replace(/\D/g, "").length < 3) throw new Error("That doesn't look like a phone number.");
      return { href: `tel:${num}`, label: `Call ${target}` };
    }
    case "sms": {
      const num = target.replace(/[^\d+]/g, "");
      if (num.replace(/\D/g, "").length < 3) throw new Error("That doesn't look like a phone number.");
      const body = message ? (ios ? "&" : "?") + "body=" + enc(message) : "";
      return { href: `sms:${num}${body}`, label: `Text ${target}` };
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) throw new Error("That doesn't look like an email address.");
      const q = [];
      if (subject) q.push("subject=" + enc(subject));
      if (message) q.push("body=" + enc(message));
      return { href: `mailto:${target}${q.length ? "?" + q.join("&") : ""}`, label: `Email ${target}` };
    }
    case "maps":
      return { href: ios ? `https://maps.apple.com/?q=${enc(target)}` : `https://www.google.com/maps/search/?api=1&query=${enc(target)}`, label: `Map: ${target}` };
    case "search":
      return { href: (SEARCH[search] || SEARCH.google) + enc(target), label: `Search: ${target}` };
    case "link": {
      let u;
      try { u = new URL(/^https?:\/\//i.test(target) ? target : "https://" + target); } catch (e) { throw new Error("That isn't a valid web link."); }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web links can be opened.");
      return { href: u.href, label: `Open ${u.hostname}` };
    }
    default:
      throw new Error("Unknown action.");
  }
}

/* ----------------------------------------------------------------- weather */
const WMO = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers",
  82: "violent showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm",
  96: "thunderstorm with hail", 99: "thunderstorm with hail",
};
export const weatherText = (code) => WMO[code] || "unknown";

async function getJSON(url, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`weather service error ${r.status}`);
  return r.json();
}

function currentPosition(geo) {
  return new Promise((resolve, reject) => {
    if (!geo) return reject(new Error("Location isn't available here. Say a city name instead."));
    geo.getCurrentPosition((p) => resolve(p.coords),
      () => reject(new Error("I couldn't get your location (permission denied or off). Say a city name instead.")),
      { timeout: 10000, maximumAge: 600000 });
  });
}

export async function weather(location, { units = "metric", fetchImpl = fetch, geo = (typeof navigator !== "undefined" ? navigator.geolocation : null) } = {}) {
  let place, lat, lon;
  if (location && location.trim()) {
    const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(location.trim())}`, fetchImpl);
    const hit = g.results && g.results[0];
    if (!hit) throw new Error(`I couldn't find a place called ${location}.`);
    lat = hit.latitude; lon = hit.longitude;
    place = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");
  } else {
    const c = await currentPosition(geo);
    lat = c.latitude; lon = c.longitude; place = "your location";
  }
  const imp = units === "imperial";
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: "auto", forecast_days: "3",
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    temperature_unit: imp ? "fahrenheit" : "celsius", wind_speed_unit: imp ? "mph" : "kmh",
  });
  const w = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`, fetchImpl);
  const cur = w.current || {};
  const d = w.daily || {};
  const u = imp ? "°F" : "°C";
  const days = (d.time || []).map((t, i) => ({
    date: t, text: weatherText(d.weather_code[i]), max: Math.round(d.temperature_2m_max[i]),
    min: Math.round(d.temperature_2m_min[i]), rain_chance: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
  }));
  return {
    place, unit: u, wind_unit: imp ? "mph" : "km/h",
    now: { temp: Math.round(cur.temperature_2m), feels_like: Math.round(cur.apparent_temperature), text: weatherText(cur.weather_code),
      humidity: cur.relative_humidity_2m, wind: Math.round(cur.wind_speed_10m), code: cur.weather_code },
    days,
  };
}

/* ---------------------------------------------------------------- datetime */
export function datetime(tz, now = new Date()) {
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); zone = tz; } catch (e) { throw new Error(`Unknown time zone "${tz}".`); }
  }
  return { text: new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: zone }, opts)).format(now), timezone: zone, iso_utc: now.toISOString() };
}

function dayNumber(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) throw new Error(`Use dates like 2026-12-25 (got "${s}").`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
}

export function dateDiff(from, to, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const days = dayNumber(to) - dayNumber(from || today);
  return { from: from || today, to, days, weeks: Math.round((days / 7) * 10) / 10 };
}

/* -------------------------------------------------------------- dispatcher */
export async function runTool(name, args, ctx = {}) {
  args = args && typeof args === "object" ? args : {};
  const settings = ctx.settings || {};
  try {
    switch (name) {
      case "set_timer": {
        const secs = Math.round(Number(args.seconds));
        if (!(secs >= 1 && secs <= 86400)) throw new Error("Timers can be 1 second to 24 hours.");
        const t = timers.add(secs, args.label);
        ctx.onTimersChanged && ctx.onTimersChanged();
        return {
          result: { ok: true, id: t.id, label: t.label, length: spokenDuration(secs), note: "Rings only while GrokMate is open on screen." },
          card: { type: "timer", id: t.id, label: t.label, seconds: secs },
        };
      }
      case "list_timers": {
        const now = Date.now();
        const list = timers.all().filter((t) => !t.done).map((t) => ({ id: t.id, label: t.label, left: spokenDuration(Math.round((t.endsAt - now) / 1000)) }));
        return { result: { ok: true, timers: list }, card: list.length ? { type: "timers" } : null };
      }
      case "cancel_timer": {
        const n = args.all || !args.id ? timers.cancel(null) : timers.cancel(String(args.id));
        ctx.onTimersChanged && ctx.onTimersChanged();
        return { result: { ok: true, cancelled: n }, card: null };
      }
      case "add_note": {
        if (!String(args.text || "").trim()) throw new Error("The note is empty.");
        const n = notes.add(args.text, args.title);
        return { result: { ok: true, id: n.id }, card: { type: "note", note: n } };
      }
      case "list_notes": {
        const list = notes.search(args.query).slice(0, 20);
        return {
          result: { ok: true, count: list.length, notes: list.map((n) => ({ id: n.id, title: n.title, text: n.text.slice(0, 300), saved: new Date(n.ts).toLocaleString() })) },
          card: { type: "notes", ids: list.map((n) => n.id), query: args.query || "" },
        };
      }
      case "delete_note": {
        const ok = notes.remove(String(args.id || ""));
        if (!ok) throw new Error("No note with that id. List notes first.");
        return { result: { ok: true }, card: { type: "info", text: "Note deleted." } };
      }
      case "create_reminder": {
        const start = parseLocal(args.start);
        if (!start) throw new Error('I need the time as YYYY-MM-DDTHH:MM, e.g. "2026-10-05T17:00".');
        const minutes = Math.min(1440, Math.max(1, Math.round(Number(args.duration_minutes) || 15)));
        const before = Math.min(10080, Math.max(0, Math.round(Number(args.alert_minutes_before) || 0)));
        const title = String(args.title || "Reminder").slice(0, 120);
        const ics = buildICS({ title, start, minutes, alertBefore: before, notes: args.notes || "", uid: uid() });
        const past = start.getTime() < Date.now() - 60000;
        return {
          result: { ok: true, when: start.toLocaleString(), needs_tap: "The user must tap 'Add to calendar' to save it.", in_the_past: past },
          card: { type: "reminder", title, start: start.toISOString(), minutes, before, ics, file: fileName(title), gcal: googleCalendarUrl({ title, start, minutes, notes: args.notes }) },
        };
      }
      case "quick_action": {
        const link = actionLink(args, { search: settings.search });
        return { result: { ok: true, shown_as_button: link.label, note: "Nothing happens until the user taps the button." }, card: { type: "action", href: link.href, label: link.label, kind: args.type } };
      }
      case "get_weather": {
        const w = await weather(args.location, { units: settings.units, fetchImpl: ctx.fetch || fetch, geo: ctx.geo });
        return { result: Object.assign({ ok: true }, w), card: { type: "weather", w } };
      }
      case "copy_share": {
        const text = String(args.text || "");
        if (!text) throw new Error("Nothing to copy.");
        return { result: { ok: true, note: "Copy and Share buttons shown; the user taps them." }, card: { type: "copy", text, title: args.title || "" } };
      }
      case "get_datetime":
        return { result: Object.assign({ ok: true }, datetime(args.timezone)), card: null };
      case "date_diff":
        return { result: Object.assign({ ok: true }, dateDiff(args.from, args.to)), card: null };
      case "calculate": {
        const v = calculate(args.expression);
        return { result: { ok: true, expression: args.expression, value: formatNumber(v) }, card: { type: "math", expression: String(args.expression), value: formatNumber(v) } };
      }
      default:
        return { result: { ok: false, error: `Unknown tool ${name}` }, card: null };
    }
  } catch (e) {
    return { result: { ok: false, error: e.message || String(e) }, card: { type: "error", text: e.message || String(e) } };
  }
}
