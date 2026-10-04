/* Voice: push-to-talk speech recognition (Web Speech API) and spoken replies
   (speechSynthesis). Both are optional; typing always works. */

const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export const sttSupported = () => !!SR;
export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

export class Listener {
  constructor({ lang = "", onInterim = () => {}, onFinal = () => {}, onState = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { lang, onInterim, onFinal, onState, onError });
    this.rec = null;
    this.active = false;
    this.text = "";
  }

  start() {
    if (!SR || this.active) return false;
    const rec = new SR();
    rec.lang = this.lang || navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    this.text = "";
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
      }
      this.text = (final || interim).trim();
      this.onInterim(this.text);
    };
    rec.onerror = (e) => {
      const why = {
        "not-allowed": "Microphone permission is off. Allow the microphone for this site, or type instead (your keyboard's mic key works too).",
        "service-not-allowed": "Speech recognition isn't allowed here. Use your keyboard's mic (dictation) key instead.",
        "no-speech": "I didn't hear anything. Tap the mic and speak, or type.",
        "audio-capture": "No microphone found. Type instead.",
        network: "Speech recognition needs internet. Type instead, or try again.",
      }[e.error];
      if (e.error !== "aborted") this.onError(why || `Voice input problem (${e.error}). Type instead.`);
    };
    rec.onend = () => {
      const was = this.active;
      this.active = false;
      this.rec = null;
      this.onState(false);
      if (was && this.text) this.onFinal(this.text);
    };
    try {
      rec.start();
    } catch (e) {
      this.onError("Couldn't start voice input. Type instead.");
      return false;
    }
    this.rec = rec;
    this.active = true;
    this.onState(true);
    return true;
  }

  stop() { if (this.rec) { try { this.rec.stop(); } catch (e) { /* ignore */ } } }

  cancel() {
    if (this.rec) { this.text = ""; try { this.rec.abort(); } catch (e) { /* ignore */ } }
  }
}

/* Speaks text sentence by sentence while a reply streams in. */
export class Speaker {
  constructor() {
    this.enabled = true;
    this.voiceURI = "";
    this.rate = 1;
    this.buffer = "";
    this.unlocked = false;
  }

  voices() { return ttsSupported() ? speechSynthesis.getVoices() : []; }

  /* iOS only allows speech after a user tap: call this from a tap handler. */
  unlock() {
    if (this.unlocked || !ttsSupported()) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
      this.unlocked = true;
    } catch (e) { /* ignore */ }
  }

  say(text) {
    if (!this.enabled || !ttsSupported()) return;
    const clean = String(text || "").replace(/https?:\/\/\S+/g, "").replace(/[*_#`>|]/g, "").trim();
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    const v = this.voices().find((x) => x.voiceURI === this.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = this.rate || 1;
    speechSynthesis.speak(u);
  }

  /* Feed streamed text; speaks each finished sentence. */
  feed(delta) {
    this.buffer += delta;
    const re = /^([\s\S]*?[.!?…])(\s+|$)/;
    let m;
    while ((m = re.exec(this.buffer)) && m[2] !== "") {
      this.say(m[1]);
      this.buffer = this.buffer.slice(m[0].length);
    }
  }

  flush() { const rest = this.buffer; this.buffer = ""; this.say(rest); }

  stop() { this.buffer = ""; if (ttsSupported()) speechSynthesis.cancel(); }
}
