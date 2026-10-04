/* Calendar (.ics) reminders: the phone's own calendar shows the alert, even when
   GrokMate is closed. */

function pad(n) { return String(n).padStart(2, "0"); }

export function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function escapeText(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/* Lines longer than 75 octets are folded (RFC 5545 3.1). */
export function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (parts.length ? 74 : 75)) { parts.push(cur); cur = ""; }
    cur += ch;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

/* "2026-10-05T17:00" (local time, no zone) -> Date. Also accepts full ISO with zone. */
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || "").trim());
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

export function buildICS({ title, start, minutes = 15, alertBefore = 0, notes = "", uid, now = new Date() }) {
  const end = new Date(start.getTime() + Math.max(1, minutes) * 60000);
  const before = Math.max(0, Math.round(alertBefore));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GrokMate Mobile//Reminders//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@grokmate.mobile`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeText(title || "Reminder")}`,
  ];
  if (notes) lines.push(`DESCRIPTION:${escapeText(notes)}`);
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeText(title || "Reminder")}`,
    before ? `TRIGGER:-PT${before}M` : "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl({ title, start, minutes = 15, notes = "" }) {
  const end = new Date(start.getTime() + Math.max(1, minutes) * 60000);
  const q = new URLSearchParams({ action: "TEMPLATE", text: title || "Reminder", dates: `${utcStamp(start)}/${utcStamp(end)}`, details: notes || "Added by GrokMate" });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export function fileName(title) {
  const base = String(title || "reminder").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${base || "reminder"}.ics`;
}
