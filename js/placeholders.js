/* Safety net for models that "fake" a web search in their reply text, e.g.
   "[Search the web for spinach dip recipes]". GrokMate has no search tool the AI
   can run, so these become a tappable "Search the web: …" link instead of raw text. */

const VERB = String.raw`(?:(?:i(?:'|’)ll|i will|let me|let's)\s+)?(?:web[\s_-]*search|search[\s_-]*(?:the[\s_-]*)?web|search(?:ing|ed)?|look(?:ing)?\s+up|look\s+online|googl(?:e|ing)|browse|browsing|bing)`;
const WHERE = String.raw`(?:\s+(?:on\s+|in\s+)?(?:the\s+)?(?:web|internet|online|google|bing|duckduckgo))?`;
const FOR = String.raw`(?:\s+(?:for|about|on))?`;
const SRC = String.raw`\[\s*(?:🔎|🔍)?\s*${VERB}${WHERE}${FOR}\s*(?:[:：\-–—=]\s*)?(?:\(\s*)?(?:query\s*[:=]\s*)?([^\[\]\n]{1,200}?)\s*\)?\s*\](?!\()`;

function cleanQuery(q) {
  let s = String(q || "").trim();
  for (let i = 0; i < 3; i++) s = s.replace(/^["“”'‘’`«»(\s]+|["“”'‘’`«»)\s]+$/g, "").replace(/[.…,;:!?\s]+$/, "");
  return /^(?:for|about|on|it|that|this|the web|web|online|the internet|internet)?$/i.test(s) ? "" : s;
}

/* Split text into [{type:"text", text}, {type:"search", query, raw}] parts. */
export function splitSearchPlaceholders(text) {
  text = String(text || "").replace(new RegExp(String.raw`\[\s*(?:🔎|🔍)?\s*${VERB}${WHERE}\s*\](?!\()`, "gi"), "");
  const re = new RegExp(SRC, "gi");
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const query = cleanQuery(m[1]);
    if (m.index > last) parts.push({ type: "text", text: text.slice(last, m.index) });
    parts.push(query ? { type: "search", query, raw: m[0] } : { type: "drop", raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

export function hasSearchPlaceholder(text) {
  return splitSearchPlaceholders(text).some((p) => p.type === "search");
}

/* Text with the placeholders removed (for speech and for the AI's context). */
export function stripSearchPlaceholders(text) {
  return splitSearchPlaceholders(text).filter((p) => p.type === "text").map((p) => p.text).join("")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* While a reply streams, hide a half-written "[Search the web for spin" at the end. */
export function hideOpenPlaceholder(text) {
  return String(text || "").replace(new RegExp(String.raw`\[\s*(?:🔎|🔍)?\s*${VERB}[^\[\]\n]*$`, "i"), "");
}
