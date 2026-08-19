/**
 * Server-side port of the AISIS HTML table parser that already lives in
 * the website itself (index.html: parseAisisHtml, parseDays,
 * scanBlendedDayLetters, militaryToMinutes, catalogKey, and the
 * group-by-code+section step inside the manual import's confirmAdd
 * handler).
 *
 * HONEST CAVEAT, worth knowing: the frontend version runs in the browser
 * and uses `DOMParser`, which doesn't exist in Node. There's no build
 * step in this project to share one literal copy of the code between a
 * plain <script> tag in index.html and a Node CommonJS module, so this
 * file is a deliberate, line-by-line port using `cheerio` (an HTML
 * parser for Node) instead of DOMParser. The PARSING RULES themselves —
 * which table cells map to which field, how day letters are read, how
 * military time is converted — are kept identical on purpose.
 *
 * IF YOU EVER CHANGE parseAisisHtml() IN index.html (e.g. because AISIS
 * changes its table markup), make the matching change here too. There
 * are only two places now, not the whole scattered mess this replaces.
 */

const cheerio = require("cheerio");

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SINGLE_LETTER_DAY = {M: "Mon", T: "Tue", W: "Wed", H: "Thu", F: "Fri", S: "Sat"};
const WORD_DAY = {
  MON: "Mon", MONDAY: "Mon",
  TU: "Tue", TUE: "Tue", TUES: "Tue", TUESDAY: "Tue",
  WED: "Wed", WEDNESDAY: "Wed",
  TH: "Thu", THU: "Thu", THUR: "Thu", THURS: "Thu", THURSDAY: "Thu",
  FRI: "Fri", FRIDAY: "Fri",
  SA: "Sat", SAT: "Sat", SATURDAY: "Sat",
  SU: "Sun", SUN: "Sun", SUNDAY: "Sun",
};

// Fallback for a blended run of single-letter codes with no delimiter at
// all, e.g. "MWF" or "TTH". Mirrors scanBlendedDayLetters() in index.html.
function scanBlendedDayLetters(token) {
  const out = [];
  let i = 0;
  while (i < token.length) {
    if (token[i] === "T" && token[i + 1] === "H") { out.push("Thu"); i += 2; }
    else if (SINGLE_LETTER_DAY[token[i]]) { out.push(SINGLE_LETTER_DAY[token[i]]); i++; }
    else i++;
  }
  return out;
}

// Mirrors parseDays() in index.html.
function parseDays(raw) {
  if (!raw) return [];
  const tokens = raw.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const out = [];
  tokens.forEach((tok) => {
    if (tok.length === 1) {
      if (SINGLE_LETTER_DAY[tok]) out.push(SINGLE_LETTER_DAY[tok]);
    } else if (WORD_DAY[tok]) {
      out.push(WORD_DAY[tok]);
    } else {
      out.push(...scanBlendedDayLetters(tok));
    }
  });
  return [...new Set(out)].filter((d) => DAY_ORDER.includes(d));
}

// Mirrors militaryToMinutes() in index.html.
function militaryToMinutes(str) {
  str = String(str).padStart(4, "0");
  const h = parseInt(str.slice(0, 2), 10);
  const m = parseInt(str.slice(2), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Mirrors catalogKey() in index.html — same normalization, so a row parsed
// here matches up with a row a human pasted in through the website's own
// manual-import panel.
function catalogKey(code, section) {
  return (code || "").trim().toUpperCase().replace(/\s+/g, " ") + "|" +
         (section || "").trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Parses AISIS's public classSkeds.do result table. Returns one staged row
 * per meeting line (a section with lecture+lab on different days/times
 * yields two rows sharing the same code+section) — mirrors
 * parseAisisHtml() in index.html exactly, cell-index for cell-index.
 */
function parseAisisHtml(html) {
  const $ = cheerio.load(html);
  const staged = [];

  $("tr").each((_, trEl) => {
    const $tr = $(trEl);
    const cells = $tr.find("td.text02").toArray();
    if (cells.length < 7) return; // header rows use text04, not a data row

    const cellText = (i) => {
      if (!cells[i]) return "";
      const $cell = $(cells[i]);
      // Match the frontend's innerHTML→text approach: turn <br> into
      // newlines BEFORE stripping tags, so multi-line time/room cells
      // still split into separate lines the same way.
      const html = $cell.html() || "";
      return html
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .trim();
    };

    const code = cellText(0);
    if (!code) return;
    const section = cellText(1);
    const title = cellText(2);
    const units = cellText(3);
    const timeRaw = cellText(4);
    const roomRaw = cellText(5);
    const instructor = cellText(6);
    const remarks = cellText(11);

    const timeLines = timeRaw.split("\n").map((s) => s.trim()).filter((s) => s && !/^\(.*\)$/.test(s));
    const roomLines = roomRaw.split("\n").map((s) => s.trim()).filter(Boolean);

    const pushRow = (days, start, end, room) => staged.push({
      code, section, title, units, days, start, end, room, instructor, remarks,
    });

    if (!timeLines.length) { pushRow([], null, null, roomLines[0] || ""); return; }

    timeLines.forEach((line, idx) => {
      const dayMatch = line.match(/^([A-Za-z-]+)/);
      const timeMatch = line.match(/(\d{3,4})\s*-\s*(\d{3,4})/);
      const days = dayMatch ? parseDays(dayMatch[1]) : [];
      const start = timeMatch ? militaryToMinutes(timeMatch[1]) : null;
      const end = timeMatch ? militaryToMinutes(timeMatch[2]) : null;
      const room = roomLines[idx] || roomLines[0] || "";
      pushRow(days, start, end, room);
    });
  });

  return staged;
}

/**
 * Groups staged meeting-rows sharing the same code+section into one
 * catalog entry — mirrors the grouping step inside the manual import's
 * confirmAdd handler in index.html (lecture+lab pairs / MWF+TH splits
 * bundle back into a single entry with a `meetings` array).
 */
function groupStagedRows(stagedRows) {
  const groups = new Map();
  stagedRows.forEach((r) => {
    const key = catalogKey(r.code, r.section);
    if (!groups.has(key)) {
      groups.set(key, {
        code: r.code, section: r.section, title: r.title, units: r.units,
        instructor: r.instructor, remarks: r.remarks, meetings: [],
      });
    } else {
      const g = groups.get(key);
      if (r.code) g.code = r.code;
      if (r.section) g.section = r.section;
      if (r.title) g.title = r.title;
      if (r.units) g.units = r.units;
      if (r.instructor) g.instructor = r.instructor;
      if (r.remarks) g.remarks = r.remarks;
    }
    groups.get(key).meetings.push({days: r.days, start: r.start, end: r.end, room: r.room});
  });
  return groups; // Map<catalogKey, entry>
}

module.exports = {parseAisisHtml, groupStagedRows, parseDays, militaryToMinutes, catalogKey};
