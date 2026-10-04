/* GrokMate Mobile: app shell, chat, voice, timers, settings. */
import { CONFIG, PROVIDERS, DEFAULT_PROVIDER } from "./config.js";
import * as store from "./store.js";
import * as license from "./license.js";
import { runTurn, complete, listModels, LLMError } from "./llm.js";
import { runTool, timers, notes, fmtDuration, isIOS, datetime } from "./tools.js";
import { calculate, formatNumber } from "./mathx.js";
import { Listener, Speaker, sttSupported, ttsSupported } from "./voice.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};

const state = {
  settings: store.getSettings(),
  history: store.load("history", []),
  busy: false,
  abort: null,
  deferredInstall: null,
  ringing: null,
  wakeLock: null,
  audio: null,
};
const speaker = new Speaker();
let listener = null;

/* ================================================================== helpers */
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), ms);
}

function show(screen) {
  for (const s of ["screen-license", "screen-setup", "screen-chat"]) $(s).classList.toggle("hidden", s !== screen);
  document.body.dataset.screen = screen;
}

function openSheet(id) {
  if (id === "sheet-settings") fillSettings();
  if (id === "sheet-notes") renderNotes();
  $(id).classList.remove("hidden");
}
function closeSheets() { document.querySelectorAll(".sheet").forEach((s) => s.classList.add("hidden")); }

function providerInfo(name = state.settings.provider) {
  const base = PROVIDERS[name] || { name: "Custom (OpenAI-compatible)", base: state.settings.customBase, model: "", models: [] };
  const model = (state.settings.models || {})[name] || base.model;
  return { id: name, name: base.name, base: name === "custom" ? state.settings.customBase : base.base, model, models: base.models || [],
    key: store.getKey(name), headers: base.headers || {}, keyUrl: base.keyUrl, cost: base.cost || "", free: !!base.free,
    noTools: !!store.load("noTools", {})[name] };
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied."); }
  catch (e) {
    const ta = el("textarea", {}, text);
    document.body.append(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied."); } catch (e2) { toast("Couldn't copy. Long-press the text to copy it."); }
    ta.remove();
  }
}

async function shareText(title, text) {
  if (!navigator.share) return copyText(text);
  try { await navigator.share({ title: title || "GrokMate", text }); } catch (e) { /* cancelled */ }
}

/* First tap unlocks audio + speech on iOS/Android. */
function unlockAudio() {
  speaker.unlock();
  try {
    if (!state.audio) state.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audio.state === "suspended") state.audio.resume();
  } catch (e) { /* no audio */ }
}

/* ================================================================== license */
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  document.addEventListener("pointerdown", unlockAudio, { capture: true });
  wireStatic();
  applySettings();
  if (license.devBypassActive()) {
    toast("Developer bypass is ON (testing only).");
  } else if (!license.cached()) {
    show("screen-license");
    return;
  } else {
    license.recheckIfDue().then((r) => {
      if (r && r.revoked) { show("screen-license"); $("licMsg").textContent = r.message; }
    });
  }
  afterLicense();
}

function afterLicense() {
  const p = providerInfo();
  if (!p.key && !store.load("setupSkipped", false)) { showSetup(); return; }
  showChat();
}

async function onLicenseSubmit(e) {
  e.preventDefault();
  const key = $("licKey").value.trim();
  const btn = $("licBtn"), msg = $("licMsg");
  btn.disabled = true; msg.className = "msg"; msg.textContent = "Checking with Gumroad…";
  const r = await license.verify(key);
  btn.disabled = false;
  msg.textContent = r.message;
  if (r.ok) {
    msg.className = "msg ok";
    license.remember(key);
    setTimeout(afterLicense, 600);
  }
}

/* ================================================================== AI setup */
let setupProv = DEFAULT_PROVIDER;
function showSetup() {
  setupProv = state.settings.provider in PROVIDERS ? state.settings.provider : DEFAULT_PROVIDER;
  const list = $("providerList");
  list.textContent = "";
  for (const [id, p] of Object.entries(PROVIDERS)) {
    list.append(el("button", { class: "prov", type: "button", role: "radio", "aria-checked": String(id === setupProv), "data-prov": id,
      onclick: () => { setupProv = id; showSetupProv(); } },
      el("b", { text: p.name }), el("small", { class: p.free ? "free" : "", text: p.free ? "Free tier" : id === "xai" ? "Grok · pay xAI" : "Pay per use" })));
  }
  showSetupProv();
  show("screen-setup");
}

function showSetupProv() {
  document.querySelectorAll("#providerList .prov").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.prov === setupProv)));
  const p = PROVIDERS[setupProv];
  $("setupProvName").textContent = p.name;
  $("setupCost").textContent = p.cost;
  $("setupGetKey").href = p.keyUrl;
  $("setupKey").value = store.getKey(setupProv);
  $("setupMsg").textContent = "";
}

async function testProvider(p) {
  const out = await complete({ base: p.base, key: p.key, model: p.model, headers: p.headers,
    messages: [{ role: "user", content: "Reply with the single word OK." }], tools: null });
  return out.text.trim() || "(empty reply)";
}

async function onSetupSave() {
  const key = $("setupKey").value.trim();
  const msg = $("setupMsg");
  if (!key) { msg.className = "msg"; msg.textContent = "Paste your API key first."; return; }
  store.setKey(setupProv, key);
  state.settings = store.setSettings({ provider: setupProv });
  msg.className = "msg"; msg.textContent = "Testing…";
  $("setupSave").disabled = true;
  try {
    await testProvider(providerInfo(setupProv));
    msg.className = "msg ok"; msg.textContent = "Connected!";
    setTimeout(showChat, 500);
  } catch (e) {
    msg.className = "msg"; msg.textContent = e.message || String(e);
  } finally { $("setupSave").disabled = false; }
}

/* ================================================================== chat UI */
function showChat() {
  show("screen-chat");
  renderHistory();
  updatePill();
  updateInstall();
  renderTimerBar();
}

function updatePill() {
  const p = providerInfo();
  const pill = $("modelPill");
  pill.classList.toggle("ok", !!p.key && !state.busy);
  pill.classList.toggle("busy", state.busy);
  $("modelName").textContent = p.key ? p.model || p.name : "No AI key";
}

function scrollDown() { const log = $("log"); log.scrollTop = log.scrollHeight; }

function bubble(role, text) {
  return el("div", { class: `bubble ${role}`, text: String(text || "").replace(/\*\*(.+?)\*\*/g, "$1") });
}

function renderHistory() {
  const log = $("log");
  log.querySelectorAll(".msgrow").forEach((n) => n.remove());
  $("empty").classList.toggle("hidden", state.history.length > 0);
  for (const m of state.history) log.append(renderEntry(m));
  scrollDown();
}

function renderEntry(m) {
  const row = el("div", { class: "msgrow" });
  if (m.text || m.role === "user") row.append(bubble(m.role === "error" ? "error" : m.role, m.text));
  for (const c of m.cards || []) { const n = renderCard(c); if (n) row.append(n); }
  return row;
}

function saveHistory() {
  if (state.history.length > 300) state.history = state.history.slice(-300);
  if (!store.save("history", state.history)) {
    state.history = state.history.slice(-60); // storage full: keep the newest
    store.save("history", state.history);
  }
}

function contextMessages() {
  return state.history.filter((m) => m.role === "user" || m.role === "assistant").slice(-CONFIG.CONTEXT_MESSAGES)
    .map((m) => ({ role: m.role, content: (m.text || "") + (m.toolNotes && m.toolNotes.length ? `\n(tools used: ${m.toolNotes.join("; ")})` : "") || "(no text)" }));
}

/* ------------------------------------------------------------------ cards */
function cardShell(icon, title, cls = "") {
  const c = el("div", { class: `tcard ${cls}` });
  c.append(el("div", { class: "t-head" }, el("span", { text: icon }), el("span", { text: title })));
  return c;
}

function renderCard(c) {
  if (!c) return null;
  switch (c.type) {
    case "timer": {
      const t = timers.all().find((x) => x.id === c.id);
      const card = cardShell("⏱", c.label ? `Timer · ${c.label}` : "Timer");
      const main = el("div", { class: "t-main", "data-timer": c.id, text: t && !t.done ? fmtDuration((t.endsAt - Date.now()) / 1000) : "Done" });
      card.append(main, el("div", { class: "small muted", text: "Rings while GrokMate is open on screen." }));
      if (t && !t.done) card.append(el("div", { class: "t-actions" }, el("button", { class: "btn small", type: "button", text: "Cancel",
        onclick: (e) => { timers.cancel(c.id); renderTimerBar(); main.textContent = "Cancelled"; e.target.remove(); } })));
      return card;
    }
    case "timers": {
      const list = timers.all().filter((t) => !t.done);
      const card = cardShell("⏱", "Timers");
      card.append(list.length ? el("ul", {}, list.map((t) => el("li", { "data-timer-li": t.id, text: `${t.label || "Timer"}: ${fmtDuration((t.endsAt - Date.now()) / 1000)} left` })))
        : el("div", { class: "muted", text: "No timers running." }));
      return card;
    }
    case "note": {
      const card = cardShell("📝", "Note saved");
      card.append(el("div", { class: "note-text", text: (c.note.title ? c.note.title + "\n" : "") + c.note.text }));
      card.append(el("div", { class: "t-actions" },
        el("button", { class: "btn small", type: "button", text: "Copy", onclick: () => copyText(c.note.text) }),
        el("button", { class: "btn small", type: "button", text: "All notes", onclick: () => openSheet("sheet-notes") })));
      return card;
    }
    case "notes": {
      const all = notes.all();
      const list = c.ids.map((id) => all.find((n) => n.id === id)).filter(Boolean);
      const card = cardShell("📝", c.query ? `Notes matching "${c.query}"` : "Notes");
      card.append(list.length ? el("ul", {}, list.slice(0, 8).map((n) => el("li", { text: (n.title ? n.title + ": " : "") + n.text.slice(0, 140) })))
        : el("div", { class: "muted", text: "No notes found." }));
      card.append(el("div", { class: "t-actions" }, el("button", { class: "btn small", type: "button", text: "Open notes", onclick: () => openSheet("sheet-notes") })));
      return card;
    }
    case "reminder": {
      const start = new Date(c.start);
      const card = cardShell("📅", "Calendar reminder");
      card.append(el("div", { class: "t-main", text: c.title }),
        el("div", { class: "muted", text: start.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + (c.before ? ` · alert ${c.before} min before` : " · alert at start") }),
        el("div", { class: "t-actions" },
          el("button", { class: "btn small primary", type: "button", text: "Add to calendar", "data-ics": c.file, onclick: () => download(c.file, c.ics, "text/calendar") }),
          el("a", { class: "btn small", href: c.gcal, target: "_blank", rel: "noopener noreferrer", text: "Google Calendar" })),
        el("div", { class: "small muted", text: "Tap Add to calendar and open the file (or use Google Calendar). Your calendar alerts you, even when GrokMate is closed." }));
      return card;
    }
    case "action": {
      const card = cardShell({ call: "📞", sms: "💬", email: "✉️", maps: "🗺️", search: "🔎", link: "🔗" }[c.kind] || "👉", "Tap to open");
      const web = /^https?:/i.test(c.href);
      card.append(el("div", { class: "t-actions" }, el("a", { class: "btn primary", href: c.href, target: web ? "_blank" : null, rel: web ? "noopener noreferrer" : null, text: c.label, "data-action": c.kind })));
      return card;
    }
    case "weather": {
      const w = c.w;
      const card = cardShell("🌤", `Weather · ${w.place}`);
      card.append(el("div", { class: "wx" }, el("div", { class: "wx-temp", text: `${w.now.temp}${w.unit}` }),
        el("div", {}, el("div", { text: w.now.text }), el("div", { class: "small muted", text: `Feels ${w.now.feels_like}${w.unit} · wind ${w.now.wind} ${w.wind_unit} · humidity ${w.now.humidity}%` }))));
      card.append(el("div", { class: "wx-days" }, w.days.map((d, i) => el("div", {},
        el("b", { text: i === 0 ? "Today" : new Date(d.date + "T12:00").toLocaleDateString([], { weekday: "short" }) }), el("br"),
        `${d.max}° / ${d.min}°`, el("br"), el("span", { class: "muted", text: d.text + (d.rain_chance != null ? ` · ${d.rain_chance}%` : "") })))));
      return card;
    }
    case "copy": {
      const card = cardShell("📋", c.title || "Copy & share");
      card.append(el("div", { class: "note-text", text: c.text }), el("div", { class: "t-actions" },
        el("button", { class: "btn small primary", type: "button", text: "Copy", onclick: () => copyText(c.text) }),
        navigator.share ? el("button", { class: "btn small", type: "button", text: "Share", onclick: () => shareText(c.title, c.text) }) : null));
      return card;
    }
    case "math": {
      const card = cardShell("🧮", "Calculator");
      card.append(el("div", { class: "small muted", text: c.expression }), el("div", { class: "t-main", text: `= ${c.value}` }));
      return card;
    }
    case "info": { const card = cardShell("ℹ️", "GrokMate"); card.append(el("div", { text: c.text })); return card; }
    case "error": { const card = cardShell("⚠️", "Couldn't do that", "err"); card.append(el("div", { text: c.text })); return card; }
    default: return null;
  }
}

/* ------------------------------------------------------------------ sending */
function setBusy(b) {
  state.busy = b;
  $("sendBtn").classList.toggle("stop", b);
  $("sendBtn").setAttribute("aria-label", b ? "Stop" : "Send");
  updatePill();
}

function autoGrow() { const t = $("input"); t.style.height = "auto"; t.style.height = Math.min(140, t.scrollHeight) + "px"; }

async function send(text) {
  text = String(text || "").trim();
  if (!text || state.busy) return;
  $("input").value = ""; autoGrow();
  speaker.stop();
  $("empty").classList.add("hidden");
  const history = contextMessages();
  const user = { role: "user", text, ts: Date.now() };
  state.history.push(user);
  $("log").append(renderEntry(user));
  const entry = { role: "assistant", text: "", cards: [], toolNotes: [], ts: Date.now() };
  const row = el("div", { class: "msgrow" });
  const b = bubble("assistant typing", "");
  row.append(b);
  $("log").append(row);
  scrollDown();

  const p = providerInfo();
  const runOne = async (name, args) => {
    const r = await runTool(name, args, { settings: state.settings, onTimersChanged: renderTimerBar });
    if (r.card) { entry.cards.push(r.card); const n = renderCard(r.card); if (n) row.append(n); scrollDown(); }
    entry.toolNotes.push(`${name} ${JSON.stringify(r.result).slice(0, 200)}`);
    return r.result;
  };

  // No AI key, or offline: handle simple things right here.
  if (!p.key || navigator.onLine === false) {
    const local = await localCommand(text, runOne);
    entry.text = local || (p.key
      ? "You're offline. I can still set timers, take notes, tell the time and do maths."
      : "I need an AI key for that. Tap the AI button at the top to add one (Gemini and Groq have free tiers). Timers, notes, time and maths work without one.");
    b.classList.remove("typing"); b.textContent = entry.text;
    speaker.say(entry.text);
    state.history.push(entry); saveHistory(); scrollDown();
    return;
  }

  setBusy(true);
  state.abort = new AbortController();
  let shown = "";
  try {
    const out = await runTurn({
      provider: p, history, userText: text, settings: state.settings, signal: state.abort.signal,
      maxRounds: CONFIG.MAX_TOOL_ROUNDS,
      hooks: {
        onRoundStart: (round) => { if (round > 0 && shown) { shown += "\n"; } },
        onText: (d) => { shown += d; b.textContent = shown.replace(/\*\*(.+?)\*\*/g, "$1"); if (!/^\s*TOOL:/m.test(shown)) speaker.feed(d); scrollDown(); },
        onReplaceText: (t) => { shown = t; b.textContent = t; },
        runTool: runOne,
        onToolsUnsupported: () => {
          const nt = store.load("noTools", {}); nt[p.id] = true; store.save("noTools", nt);
          toast("This model doesn't support tools. Using text mode.");
        },
      },
    });
    entry.text = (out.text || shown).trim();
    b.textContent = entry.text.replace(/\*\*(.+?)\*\*/g, "$1");
    if (!entry.text) b.remove();
    speaker.flush();
  } catch (e) {
    speaker.stop();
    if (e && e.name === "AbortError") {
      entry.text = shown.trim() ? shown.trim() + " …" : "(stopped)";
      b.textContent = entry.text;
    } else {
      b.remove();
      const err = { role: "error", text: e instanceof LLMError || e.message ? e.message : String(e), ts: Date.now() };
      row.append(bubble("error", err.text));
      entry.text = shown.trim();
      state.history.push(entry.text || entry.cards.length ? entry : null, err);
      state.history = state.history.filter(Boolean);
      saveHistory(); setBusy(false); scrollDown();
      return;
    }
  } finally {
    b.classList.remove("typing");
    state.abort = null;
  }
  state.history.push(entry);
  saveHistory();
  setBusy(false);
  scrollDown();
}

/* Simple commands that work without an AI key or internet. */
async function localCommand(text, runOne) {
  const t = text.toLowerCase().trim().replace(/[?!.]+$/, "");
  const dur = (s) => {
    let secs = 0;
    const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/g;
    let m;
    while ((m = re.exec(s))) secs += parseFloat(m[1]) * (m[2][0] === "h" ? 3600 : m[2][0] === "m" ? 60 : 1);
    return Math.round(secs);
  };
  if (/\btimer\b|\bcountdown\b/.test(t) && dur(t)) {
    const secs = dur(t);
    const r = await runOne("set_timer", { seconds: secs, label: "" });
    return r.ok ? `Timer set for ${fmtDuration(secs)}. It rings while GrokMate is open.` : r.error;
  }
  let m = /^(?:note|take a note|add a note|remember)[:,]?\s+(?:that\s+)?(.+)$/i.exec(text.trim());
  if (m) { await runOne("add_note", { text: m[1] }); return "Saved to your notes."; }
  if (/^(?:list|show)(?: my)? notes$/.test(t)) { const r = await runOne("list_notes", {}); return r.count ? `You have ${r.count} note${r.count > 1 ? "s" : ""}.` : "You have no notes yet."; }
  if (/what(?:'s| is) the (?:time|date)|what time is it|what day is it|today's date/.test(t)) return datetime().text + ".";
  m = /^(?:what(?:'s| is)|calculate|calc)?\s*([\d\s+\-*/^%().,x×÷]+|[\d.]+\s*%\s*of\s*[\d.]+)$/i.exec(t);
  if (m && /\d/.test(m[1]) && /[+\-*/^%x×÷]/.test(m[1])) {
    try { const v = calculate(m[1]); await runOne("calculate", { expression: m[1].trim() }); return `That's ${formatNumber(v)}.`; } catch (e) { /* not maths */ }
  }
  if (/what can you do|^help$/.test(t)) {
    return "I chat by voice or text and can set timers, save notes, make calendar reminders, check the weather, prepare call, text, email, maps and search buttons, copy and share text, and do maths. Timers ring while I'm open; reminders go into your calendar.";
  }
  return "";
}

/* ================================================================== timers */
function renderTimerBar() {
  const bar = $("timerBar");
  const list = timers.all().filter((t) => !t.done);
  bar.textContent = "";
  bar.classList.toggle("hidden", !list.length);
  for (const t of list) {
    bar.append(el("div", { class: "tchip", "data-chip": t.id }, el("span", { text: t.label || "Timer" }),
      el("b", { "data-left": t.id, text: fmtDuration((t.endsAt - Date.now()) / 1000) }),
      el("button", { type: "button", "aria-label": "Cancel timer", text: "✕", onclick: () => { timers.cancel(t.id); renderTimerBar(); } })));
  }
  updateWakeLock(list.length > 0);
}

function tick() {
  const now = Date.now();
  for (const t of timers.all()) {
    if (t.done) continue;
    const left = fmtDuration((t.endsAt - now) / 1000);
    document.querySelectorAll(`[data-left="${t.id}"],[data-timer="${t.id}"]`).forEach((n) => { n.textContent = left; });
  }
  for (const t of timers.due(now)) {
    timers.markDone(t.id);
    document.querySelectorAll(`[data-timer="${t.id}"]`).forEach((n) => { n.textContent = "Done"; });
    if (now - t.endsAt < 5 * 60000) ring(t);
    else toast(`Timer "${t.label || "timer"}" finished at ${new Date(t.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} while GrokMate was closed.`, 6000);
    renderTimerBar();
  }
  timers.clearDone();
}

function beep() {
  const ctx = state.audio;
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    for (const [i, f] of [[0, 880], [0.22, 1175]].entries()) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f[1];
      const t0 = ctx.currentTime + f[0];
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.2);
      void i;
    }
  } catch (e) { /* ignore */ }
}

function ring(t) {
  stopRing();
  $("ringLabel").textContent = t.label ? `${t.label} · ${fmtDuration(t.seconds)}` : `${fmtDuration(t.seconds)} timer`;
  $("ring").classList.remove("hidden");
  window.__gmRings = (window.__gmRings || 0) + 1; // for tests
  const pulse = () => { beep(); if (navigator.vibrate) navigator.vibrate([300, 150, 300]); };
  pulse();
  state.ringing = { iv: setInterval(pulse, 1200), stopAt: setTimeout(stopRing, 60000) };
  if (state.settings.speak) speaker.say(t.label ? `Your ${t.label} timer is done.` : "Your timer is done.");
}

function stopRing() {
  if (state.ringing) { clearInterval(state.ringing.iv); clearTimeout(state.ringing.stopAt); state.ringing = null; }
  if (navigator.vibrate) navigator.vibrate(0);
  $("ring").classList.add("hidden");
}

async function updateWakeLock(want) {
  want = want && state.settings.keepAwake && "wakeLock" in navigator && document.visibilityState === "visible";
  try {
    if (want && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
    } else if (!want && state.wakeLock) {
      await state.wakeLock.release(); state.wakeLock = null;
    }
  } catch (e) { state.wakeLock = null; }
}

/* ================================================================== voice */
function setupVoice() {
  const mic = $("micBtn");
  if (!sttSupported()) mic.classList.add("unsupported");
  listener = new Listener({
    lang: state.settings.sttLang,
    onInterim: (t) => { $("input").value = t; autoGrow(); },
    onFinal: (t) => { $("input").value = ""; send(t); },
    onState: (on) => { mic.classList.toggle("listening", on); mic.setAttribute("aria-label", on ? "Listening… release to send" : "Hold to talk"); if (on) speaker.stop(); },
    onError: (m) => hint(m),
  });
  let t0 = 0;
  mic.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    unlockAudio();
    if (!sttSupported()) {
      hint("Voice input isn't available in this browser. Tap the message box and use your keyboard's mic key to dictate.");
      $("input").focus();
      return;
    }
    if (listener.active) { listener.stop(); return; }
    if (state.busy) { state.abort && state.abort.abort(); }
    listener.lang = state.settings.sttLang;
    if (listener.start()) t0 = Date.now();
  });
  const release = () => { if (listener.active && t0 && Date.now() - t0 > 450) listener.stop(); t0 = 0; };
  mic.addEventListener("pointerup", release);
  mic.addEventListener("pointercancel", release);
  mic.addEventListener("contextmenu", (e) => e.preventDefault());
}

function hint(m) {
  const h = $("voiceHint");
  h.textContent = m;
  h.classList.remove("hidden");
  clearTimeout(hint.t);
  hint.t = setTimeout(() => h.classList.add("hidden"), 7000);
}

function applySettings() {
  const s = state.settings;
  speaker.enabled = !!s.speak;
  speaker.voiceURI = s.voiceURI;
  speaker.rate = Number(s.rate) || 1;
  const mute = $("muteBtn");
  mute.setAttribute("aria-pressed", String(!s.speak));
  mute.setAttribute("aria-label", s.speak ? "Mute spoken replies" : "Unmute spoken replies");
}

/* ================================================================== settings */
function fillVoices() {
  const sel = $("setVoice");
  const cur = state.settings.voiceURI;
  sel.textContent = "";
  sel.append(el("option", { value: "", text: "Phone default" }));
  const lang = (state.settings.sttLang || navigator.language || "en").slice(0, 2);
  const voices = speaker.voices().slice().sort((a, b) => (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || a.name.localeCompare(b.name));
  for (const v of voices) sel.append(el("option", { value: v.voiceURI, text: `${v.name} (${v.lang})`, selected: v.voiceURI === cur }));
}

function fillSettings() {
  const s = state.settings;
  const sel = $("setProvider");
  sel.textContent = "";
  for (const [id, p] of Object.entries(PROVIDERS)) sel.append(el("option", { value: id, text: p.name + (p.free ? " (free tier)" : ""), selected: id === s.provider }));
  sel.append(el("option", { value: "custom", text: "Custom (OpenAI-compatible)", selected: s.provider === "custom" }));
  fillProviderFields();
  $("setToolMode").value = s.toolMode;
  $("setSpeak").checked = !!s.speak;
  $("setRate").value = s.rate;
  $("rateVal").textContent = `${Number(s.rate).toFixed(1)}×`;
  $("setLang").value = s.sttLang;
  $("setUnits").value = s.units;
  $("setSearch").value = s.search;
  $("setAwake").checked = !!s.keepAwake;
  fillVoices();
  $("voiceSupport").textContent = [
    sttSupported() ? "Voice input: available (hold the mic button)." : "Voice input: not available in this browser. Use your keyboard's mic key to dictate.",
    ttsSupported() ? "" : "Spoken replies: not available in this browser.",
    isIOS() && isStandalone() ? "On iPhone, voice input from the Home Screen app can be unreliable; if it fails, open GrokMate in Safari or use keyboard dictation." : "",
  ].filter(Boolean).join(" ");
  const c = license.cached();
  $("licStatus").textContent = license.devBypassActive() ? "Developer bypass (testing only)." : c ? `Verified on this phone (${license.maskKey(c.key)}), ${new Date(c.verifiedAt).toLocaleDateString()}.` : "Not verified.";
  updateInstall();
}

function fillProviderFields() {
  const id = $("setProvider").value;
  const p = providerInfo(id);
  $("customBaseRow").classList.toggle("hidden", id !== "custom");
  $("setBase").value = state.settings.customBase || "";
  $("setModel").value = p.model || "";
  const dl = $("modelList");
  dl.textContent = "";
  for (const m of p.models) dl.append(el("option", { value: m }));
  $("setKey").value = p.key;
  $("setKey").type = "password";
  $("setCost").textContent = p.cost + (p.noTools ? " Tools: text mode (this model didn't accept function calling)." : "");
  $("setGetKey").classList.toggle("hidden", !p.keyUrl);
  if (p.keyUrl) $("setGetKey").href = p.keyUrl;
  $("setMsg").textContent = "";
}

function saveProviderFields() {
  const id = $("setProvider").value;
  const models = Object.assign({}, state.settings.models);
  const model = $("setModel").value.trim();
  if (model) models[id] = model; else delete models[id];
  let customBase = state.settings.customBase;
  if (id === "custom") {
    customBase = $("setBase").value.trim();
    if (customBase && !/^https:\/\//i.test(customBase)) { $("setMsg").className = "msg"; $("setMsg").textContent = "The base URL must start with https://"; return false; }
  }
  store.setKey(id, $("setKey").value);
  state.settings = store.setSettings({ provider: id, models, customBase });
  const nt = store.load("noTools", {}); delete nt[id]; store.save("noTools", nt);
  updatePill();
  return true;
}

function wireSettings() {
  $("setProvider").addEventListener("change", () => { state.settings = store.setSettings({ provider: $("setProvider").value }); fillProviderFields(); updatePill(); });
  $("setModel").addEventListener("change", saveProviderFields);
  $("setKey").addEventListener("change", saveProviderFields);
  $("setBase").addEventListener("change", saveProviderFields);
  $("setKeyShow").addEventListener("click", () => { const k = $("setKey"); k.type = k.type === "password" ? "text" : "password"; });
  $("testKey").addEventListener("click", async () => {
    const msg = $("setMsg");
    if (!saveProviderFields()) return;
    const p = providerInfo();
    if (!p.key) { msg.className = "msg"; msg.textContent = "Paste your API key first."; return; }
    msg.className = "msg"; msg.textContent = "Testing…";
    try { await testProvider(p); msg.className = "msg ok"; msg.textContent = `Connected to ${p.name} (${p.model}).`; }
    catch (e) { msg.className = "msg"; msg.textContent = e.message; }
  });
  $("loadModels").addEventListener("click", async () => {
    saveProviderFields();
    const p = providerInfo();
    const msg = $("setMsg");
    if (!p.key) { msg.className = "msg"; msg.textContent = "Add your API key first."; return; }
    msg.className = "msg"; msg.textContent = "Loading models…";
    try {
      const list = await listModels({ base: p.base, key: p.key, headers: p.headers });
      const dl = $("modelList"); dl.textContent = "";
      for (const m of list) dl.append(el("option", { value: m }));
      msg.className = "msg ok"; msg.textContent = `${list.length} models loaded. Tap the Model box to pick one.`;
    } catch (e) { msg.className = "msg"; msg.textContent = e.message; }
  });
  $("setToolMode").addEventListener("change", (e) => { state.settings = store.setSettings({ toolMode: e.target.value }); });
  $("setSpeak").addEventListener("change", (e) => { state.settings = store.setSettings({ speak: e.target.checked }); applySettings(); });
  $("setVoice").addEventListener("change", (e) => { state.settings = store.setSettings({ voiceURI: e.target.value }); applySettings(); });
  $("setRate").addEventListener("input", (e) => { $("rateVal").textContent = `${Number(e.target.value).toFixed(1)}×`; state.settings = store.setSettings({ rate: Number(e.target.value) }); applySettings(); });
  $("testVoice").addEventListener("click", () => { unlockAudio(); const was = speaker.enabled; speaker.enabled = true; speaker.say("Hi, I'm GrokMate. This is my voice."); speaker.enabled = was; });
  $("setLang").addEventListener("change", (e) => { state.settings = store.setSettings({ sttLang: e.target.value }); fillVoices(); });
  $("setUnits").addEventListener("change", (e) => { state.settings = store.setSettings({ units: e.target.value }); });
  $("setSearch").addEventListener("change", (e) => { state.settings = store.setSettings({ search: e.target.value }); });
  $("setAwake").addEventListener("change", (e) => { state.settings = store.setSettings({ keepAwake: e.target.checked }); renderTimerBar(); });
  $("clearChat").addEventListener("click", () => {
    if (!confirm("Delete all chats on this phone? Notes are kept.")) return;
    state.history = []; store.remove("history"); renderHistory(); toast("All chats deleted.");
  });
  $("licRemove").addEventListener("click", () => {
    if (!confirm("Remove the license from this phone? You'll need the key again to unlock GrokMate.")) return;
    license.forget(); closeSheets(); show("screen-license");
  });
}

/* ================================================================== notes */
function renderNotes() {
  const q = $("noteSearch").value;
  const list = q ? notes.search(q) : notes.all();
  const ul = $("noteList");
  ul.textContent = "";
  if (!list.length) ul.append(el("li", { class: "muted", text: q ? "No notes match." : "No notes yet. Say \"note: …\" or add one above." }));
  for (const n of list) {
    ul.append(el("li", { "data-note": n.id },
      el("div", { class: "nt" }, (n.title ? n.title + "\n" : "") + n.text, el("span", { class: "nd", text: new Date(n.ts).toLocaleString() })),
      el("button", { class: "icon-btn small", type: "button", "aria-label": "Copy note", text: "⧉", onclick: () => copyText(n.text) }),
      el("button", { class: "icon-btn small", type: "button", "aria-label": "Delete note", text: "🗑", onclick: () => { if (confirm("Delete this note?")) { notes.remove(n.id); renderNotes(); } } })));
  }
}

function wireNotes() {
  $("noteForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("noteNew").value.trim(); if (!v) return; notes.add(v); $("noteNew").value = ""; renderNotes(); });
  $("noteSearch").addEventListener("input", renderNotes);
  $("exportTxt").addEventListener("click", () => download("grokmate-notes.txt", notes.exportText(), "text/plain"));
  $("exportJson").addEventListener("click", () => download("grokmate-notes.json", JSON.stringify(notes.all(), null, 2), "application/json"));
  $("shareNotes").addEventListener("click", () => shareText("GrokMate notes", notes.exportText() || "(no notes)"));
}

/* ================================================================== install */
function updateInstall() {
  const bar = $("installBar"), help = $("installHelp"), b2 = $("installBtn2");
  const dismissed = store.load("installDismissed", false);
  if (isStandalone()) {
    bar.classList.add("hidden"); b2.classList.add("hidden");
    help.textContent = "GrokMate is installed on this device.";
    return;
  }
  if (state.deferredInstall) {
    $("installText").textContent = "Install GrokMate on your Home Screen for one-tap access.";
    $("installBtn").classList.remove("hidden");
    bar.classList.toggle("hidden", dismissed);
    b2.classList.remove("hidden");
    help.textContent = "Adds GrokMate to your Home Screen like an app.";
  } else if (isIOS()) {
    $("installText").textContent = "Install: tap the Share button, then \"Add to Home Screen\".";
    $("installBtn").classList.add("hidden");
    bar.classList.toggle("hidden", dismissed);
    b2.classList.add("hidden");
    help.textContent = "iPhone/iPad: open GrokMate in Safari, tap Share (square with an arrow), then \"Add to Home Screen\".";
  } else {
    bar.classList.add("hidden"); b2.classList.add("hidden");
    help.textContent = "Android: Chrome menu (⋮) → \"Install app\" or \"Add to Home screen\". iPhone: Safari → Share → \"Add to Home Screen\".";
  }
}

async function doInstall() {
  const d = state.deferredInstall;
  if (!d) return;
  d.prompt();
  try { await d.userChoice; } catch (e) { /* ignore */ }
  state.deferredInstall = null;
  updateInstall();
}

/* ================================================================== wiring */
function wireStatic() {
  $("licForm").addEventListener("submit", onLicenseSubmit);
  $("libLink").href = CONFIG.GUMROAD_LIBRARY_URL;
  $("setupSave").addEventListener("click", onSetupSave);
  $("setupShow").addEventListener("click", () => { const k = $("setupKey"); k.type = k.type === "password" ? "text" : "password"; });
  $("setupSkip").addEventListener("click", () => { store.save("setupSkipped", true); showChat(); });
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { e.preventDefault(); closeSheets(); openSheet(o.dataset.open); return; }
    if (e.target.closest("[data-close]") || e.target.classList.contains("sheet")) closeSheets();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.busy) { state.abort && state.abort.abort(); return; }
    send($("input").value);
  });
  $("input").addEventListener("input", autoGrow);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !/Android|iPhone|iPad/.test(navigator.userAgent)) { e.preventDefault(); $("composer").requestSubmit(); }
  });
  $("chips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) send(c.textContent); });
  $("muteBtn").addEventListener("click", () => {
    state.settings = store.setSettings({ speak: !state.settings.speak });
    applySettings();
    if (!state.settings.speak) speaker.stop();
    toast(state.settings.speak ? "Spoken replies on." : "Spoken replies muted.");
  });
  $("ringStop").addEventListener("click", stopRing);
  $("installBtn").addEventListener("click", doInstall);
  $("installBtn2").addEventListener("click", doInstall);
  $("installClose").addEventListener("click", () => { store.save("installDismissed", true); updateInstall(); });
  $("aboutVersion").textContent = `version ${CONFIG.VERSION}`;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); state.deferredInstall = e; updateInstall(); });
  window.addEventListener("appinstalled", () => { state.deferredInstall = null; toast("GrokMate installed."); updateInstall(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { tick(); renderTimerBar(); } });
  if (ttsSupported()) speechSynthesis.addEventListener ? speechSynthesis.addEventListener("voiceschanged", fillVoices) : (speechSynthesis.onvoiceschanged = fillVoices);
  wireSettings();
  wireNotes();
  setupVoice();
  setInterval(tick, 250);
}

boot();
