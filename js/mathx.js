/* Safe calculator (no eval). Supports + - * / ^ % ( ), unary minus, "x" for times,
   "15% of 80", constants pi and e, and functions sqrt abs round floor ceil
   sin cos tan asin acos atan log (base 10) ln exp min max. Angles in degrees. */

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: (d) => Math.sin(d * Math.PI / 180), cos: (d) => Math.cos(d * Math.PI / 180),
  tan: (d) => Math.tan(d * Math.PI / 180), asin: (x) => Math.asin(x) * 180 / Math.PI,
  acos: (x) => Math.acos(x) * 180 / Math.PI, atan: (x) => Math.atan(x) * 180 / Math.PI,
  log: Math.log10, ln: Math.log, exp: Math.exp, min: Math.min, max: Math.max,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  let s = String(src || "").toLowerCase()
    .replace(/[×x](?=\s*[\d(.])/g, "*").replace(/÷/g, "/").replace(/−/g, "-")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, "($1/100)*")
    .replace(/\bof\b/g, "*").replace(/\btimes\b/g, "*").replace(/\bplus\b/g, "+")
    .replace(/\bminus\b/g, "-").replace(/\bdivided by\b/g, "/").replace(/\bsquared\b/g, "^2");
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[\d.]/.test(c)) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?/.exec(s.slice(i));
      if (!m) throw new Error("bad number");
      out.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[a-z]/.test(c)) {
      const m = /^[a-z]+/.exec(s.slice(i))[0];
      if (m in FUNCS) out.push({ t: "fn", v: m });
      else if (m in CONSTS) out.push({ t: "num", v: CONSTS[m] });
      else throw new Error(`unknown word "${m}"`);
      i += m.length; continue;
    }
    if ("+-*/^%(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected "${c}"`);
  }
  return out;
}

export function calculate(expr) {
  const toks = tokenize(expr);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { const t = toks[p]; if (!t || t.v !== v) throw new Error(`expected "${v}"`); p++; };
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error("incomplete expression");
    if (t.t === "num") return t.v;
    if (t.t === "fn") {
      eat("(");
      const args = [expr0()];
      while (peek() && peek().v === ",") { p++; args.push(expr0()); }
      eat(")");
      return FUNCS[t.v](...args);
    }
    if (t.v === "(") { const v = expr0(); eat(")"); return v; }
    if (t.v === "-") return -power();
    if (t.v === "+") return power();
    throw new Error(`unexpected "${t.v}"`);
  }
  function postfix() {
    let v = primary();
    while (peek() && peek().v === "%" && !(toks[p + 1] && (toks[p + 1].t === "num" || toks[p + 1].v === "("))) { p++; v /= 100; }
    return v;
  }
  function power() {
    const b = postfix();
    if (peek() && peek().v === "^") { p++; return Math.pow(b, unary()); }
    return b;
  }
  function unary() {
    if (peek() && peek().v === "-") { p++; return -unary(); }
    if (peek() && peek().v === "+") { p++; return unary(); }
    return power();
  }
  function term() {
    let v = unary();
    while (peek() && ["*", "/", "%"].includes(peek().v)) {
      const op = toks[p++].v;
      const r = unary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function expr0() {
    let v = term();
    while (peek() && (peek().v === "+" || peek().v === "-")) {
      const op = toks[p++].v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const v = expr0();
  if (p < toks.length) throw new Error(`unexpected "${toks[p].v}"`);
  if (!Number.isFinite(v)) throw new Error("the answer isn't a finite number");
  return v;
}

export function formatNumber(v) {
  if (Number.isInteger(v)) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const r = Math.round(v * 1e10) / 1e10;
  return r.toLocaleString("en-US", { maximumFractionDigits: 10 });
}
