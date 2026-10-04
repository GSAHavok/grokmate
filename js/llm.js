/* OpenAI-compatible chat completions client with streaming and tool calling.
   The API key goes only to the provider's own address. */
import { TOOL_DEFS, TOOL_NAMES } from "./tools.js";

export class LLMError extends Error {
  constructor(message, status = 0, raw = "") { super(message); this.status = status; this.raw = raw; }
}

export function endpoint(base, path = "chat/completions") {
  return String(base || "").trim().replace(/\/+$/, "") + "/" + path;
}

/* Persona: same voice as GrokMate on the PC (v2 CHAT_SYSTEM_PROMPT), adapted for a phone. */
export function systemPrompt({ now = new Date(), textTools = false, lang = "" } = {}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  let p = `You are GrokMate, a friendly voice assistant running on the user's phone.
Your replies are often spoken aloud, so:
- Answer in 1 to 3 short sentences unless the user asks for detail.
- No markdown tables, code blocks or emoji. Avoid reading out URLs.
- Be warm, direct and accurate. If you don't know, say so.
Right now it is ${local} (local ${iso}, time zone ${zone}).${lang ? ` The user's language is ${lang}.` : ""}

You have phone tools: timers, notes, calendar reminders, quick-action buttons (call, text, email, maps, web search, links), weather, copy/share, date/time and a calculator. Use them instead of guessing: always use calculate for arithmetic, get_weather for weather, and create_reminder for anything at a specific time.
Be honest about limits:
- Timers ring only while GrokMate is open on screen. For anything that must alert later or when the app is closed, make a calendar reminder; the user taps "Add to calendar" to save it.
- Calls, texts, emails, maps and searches appear as buttons; nothing happens until the user taps.
- You cannot control other apps, set system alarms, read contacts, messages or other apps, or listen in the background. Say so if asked.
- You only know what tools return and your training; for live facts beyond weather, offer a web search button.
After a tool runs, confirm briefly in plain words (for example "Timer set for 10 minutes.").`;
  if (textTools) {
    p += `

TOOLS (text mode): to use a tool, write a line exactly like
TOOL: tool_name {"arg": "value"}
and nothing else in that message. You will get the result back, then answer the user.
Available tools and arguments:
${TOOL_DEFS.map((t) => `- ${t.function.name}: ${t.function.description} Args: ${JSON.stringify(Object.keys(t.function.parameters.properties))}`).join("\n")}`;
  }
  return p;
}

/* Parse "TOOL: name {json}" lines from a text-mode reply. */
export function parseTextTools(text) {
  const calls = [];
  const clean = String(text || "").replace(/^\s*TOOL:\s*([a-z_]+)\s*(\{.*\})?\s*$/gim, (m, name, json) => {
    if (!TOOL_NAMES.includes(name)) return m;
    let args = {};
    try { args = json ? JSON.parse(json) : {}; } catch (e) { args = {}; }
    calls.push({ id: "txt" + calls.length, name, arguments: JSON.stringify(args) });
    return "";
  }).trim();
  return { calls, clean };
}

function friendlyError(status, msg) {
  // xAI and Gemini answer a bad key with HTTP 400 ("Incorrect API key provided", "Please pass a valid API key").
  const badKey = status === 400 && /api[ _-]?key|incorrect key|invalid key|unauthori[sz]ed/i.test(msg || "");
  if (status === 401 || status === 403 || badKey) return "Your AI key was rejected. Check it in Settings (copy it again from the provider's website).";
  if (status === 404) return `The provider doesn't know that model or address. Pick another model in Settings. (${msg})`;
  if (status === 429) return "The AI provider says you're over your limit (free tiers have rate and daily limits). Wait a bit, or use another provider.";
  if (status >= 500) return "The AI provider is having trouble right now. Try again in a moment.";
  return msg || `The AI provider returned an error (${status}).`;
}

async function readError(res) {
  let raw = "";
  try { raw = await res.text(); } catch (e) { /* ignore */ }
  let msg = "";
  try {
    let j = JSON.parse(raw);
    if (Array.isArray(j)) j = j[0];
    msg = (j.error && (j.error.message || j.error)) || j.message || "";
    if (typeof msg !== "string") msg = JSON.stringify(msg);
  } catch (e) { msg = raw.slice(0, 200); }
  return new LLMError(friendlyError(res.status, msg), res.status, msg);
}

/* Streams one completion. Calls onText(delta) as text arrives.
   Resolves to {text, toolCalls:[{id,name,arguments}], finish}. */
export async function complete({ base, key, model, messages, tools = null, signal, headers = {}, onText = () => {}, fetchImpl = fetch }) {
  const body = { model, messages, stream: true };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  let res;
  try {
    res = await fetchImpl(endpoint(base), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Authorization: `Bearer ${key}` }, headers),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new LLMError("Can't reach the AI provider. Check your internet connection.", 0);
  }
  if (!res.ok) throw await readError(res);

  let text = "";
  let finish = null;
  const calls = [];
  const addCallDelta = (d) => {
    let slot = null;
    if (typeof d.index === "number") slot = calls[d.index] || (calls[d.index] = { id: "", name: "", arguments: "" });
    else if (d.id && !calls.find((c) => c.id === d.id)) { slot = { id: "", name: "", arguments: "" }; calls.push(slot); }
    else slot = (d.id && calls.find((c) => c.id === d.id)) || calls[calls.length - 1] || (calls[0] = { id: "", name: "", arguments: "" });
    if (d.id) slot.id = d.id;
    if (d.function) {
      if (d.function.name) slot.name += d.function.name;
      if (d.function.arguments) slot.arguments += typeof d.function.arguments === "string" ? d.function.arguments : JSON.stringify(d.function.arguments);
    }
  };
  const handle = (obj) => {
    const ch = obj.choices && obj.choices[0];
    if (!ch) { if (obj.error) throw new LLMError(friendlyError(0, obj.error.message || String(obj.error))); return; }
    const delta = ch.delta || ch.message || {};
    if (delta.content) { text += delta.content; onText(delta.content); }
    if (Array.isArray(delta.tool_calls)) delta.tool_calls.forEach(addCallDelta);
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("application/json")) {
    handle(await res.json()); // provider ignored stream=true
  } else {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }
        if (!data) continue;
        let obj;
        try { obj = JSON.parse(data); } catch (e) { continue; }
        handle(obj);
      }
    }
    try { reader.cancel(); } catch (e) { /* ignore */ }
  }
  const toolCalls = calls.filter((c) => c && c.name).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || "{}" }));
  return { text, toolCalls, finish };
}

export async function listModels({ base, key, headers = {}, fetchImpl = fetch }) {
  const res = await fetchImpl(endpoint(base, "models"), { headers: Object.assign({ Authorization: `Bearer ${key}` }, headers) });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : j.data || j.models || [];
  return arr.map((m) => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean).sort();
}

export function safeArgs(s) {
  if (s && typeof s === "object") return s;
  try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}

/* One user turn: stream, run tools, loop until the model answers in words.
   hooks: onText(delta), onToolCard(card), onRoundStart(), runTool(name,args) */
export async function runTurn({ provider, history, userText, settings, hooks, signal, maxRounds = 5, fetchImpl = fetch }) {
  const textMode = settings.toolMode === "text" || provider.noTools;
  const messages = [{ role: "system", content: systemPrompt({ textTools: textMode, lang: settings.sttLang }) }, ...history, { role: "user", content: userText }];
  let finalText = "";
  let useText = textMode;
  for (let round = 0; round < maxRounds; round++) {
    hooks.onRoundStart && hooks.onRoundStart(round);
    let out;
    try {
      out = await complete({ base: provider.base, key: provider.key, model: provider.model, messages, signal, headers: provider.headers,
        tools: useText ? null : TOOL_DEFS, onText: hooks.onText, fetchImpl });
    } catch (e) {
      // Some models/providers reject tool definitions: retry once in text mode.
      if (!useText && round === 0 && e instanceof LLMError && [400, 404, 422].includes(e.status) && /tool|function/i.test(e.raw || e.message)) {
        useText = true;
        messages[0] = { role: "system", content: systemPrompt({ textTools: true, lang: settings.sttLang }) };
        hooks.onToolsUnsupported && hooks.onToolsUnsupported();
        round--;
        continue;
      }
      throw e;
    }
    let calls = out.toolCalls;
    let said = out.text;
    if (useText) {
      const parsed = parseTextTools(out.text);
      calls = parsed.calls;
      said = parsed.clean;
      if (calls.length && hooks.onReplaceText) hooks.onReplaceText(said);
    }
    finalText = said || finalText;
    if (!calls.length) return { text: finalText, rounds: round + 1 };

    if (useText) {
      messages.push({ role: "assistant", content: out.text });
      const results = [];
      for (const c of calls) {
        const r = await hooks.runTool(c.name, safeArgs(c.arguments));
        results.push(`${c.name}: ${JSON.stringify(r)}`);
      }
      messages.push({ role: "user", content: `TOOL RESULTS (not from the user):\n${results.join("\n")}\nNow answer the user briefly.` });
    } else {
      messages.push({ role: "assistant", content: out.text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
      for (const c of calls) {
        const r = await hooks.runTool(c.name, safeArgs(c.arguments));
        messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(r) });
      }
    }
  }
  return { text: finalText || "Done.", rounds: maxRounds };
}
