// Geneanet dates into the shared DateValue. Three inputs, each with its own grammar:
//
// - GeneWeb's raw form (`date_raw` and friends on tree records), captured live and listed
//   in proto/README.md under "Raw dates": `[~?<>]/<y>/<m>/<d>#`, 0 for an unknown part, or
//   `/<y>/<m>/<d>#../<y>/<m>/<d>` for a range. The numbers are always Gregorian; a Julian
//   date says so only in its display form ("May 29, 1539 Julian").
// - The site-wide search's wording, one line per event: "Birth 1897",
//   "Marriage (between 1825 and 1875)".
// - The display form of search-result relatives, which for `lang=en` is month/day/year.
// - The life years a graph node or a tree search hit shows ("1841-1907", "ca 1768-1818"),
//   read straight into `Brief.born` / `Brief.died`.
//
// A form not seen in a real answer is not guessed at: it keeps the source's wording as
// `text`, with no `date`.

import type { DateValue } from "#/schema/types";

type Qualifier = NonNullable<DateValue["qualifier"]>;

const iso = (y: number, m: number, d: number): string | undefined => {
  if (y <= 0 || m > 12 || d > 31 || (m === 0 && d !== 0)) return undefined;
  const year = String(y).padStart(4, "0");
  if (m === 0) return year;
  const month = String(m).padStart(2, "0");
  return d === 0 ? `${year}-${month}` : `${year}-${month}-${String(d).padStart(2, "0")}`;
};

/** Gregorian to Julian through the Julian day number (Fliegel–Van Flandern). */
const julianOfGregorian = (y: number, m: number, d: number): [number, number, number] => {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  const jdn =
    d +
    Math.floor((153 * mm + 2) / 5) +
    365 * yy +
    Math.floor(yy / 4) -
    Math.floor(yy / 100) +
    Math.floor(yy / 400) -
    32045;
  const c = jdn + 32082;
  const dd = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * dd) / 4);
  const n = Math.floor((5 * e + 2) / 153);
  return [
    dd - 4800 + Math.floor(n / 10),
    n + 3 - 12 * Math.floor(n / 10),
    e - Math.floor((153 * n + 2) / 5) + 1,
  ];
};

const RAW =
  /^([~?<>]?)\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})#(?:\.\.\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})#?)?$/;

const RAW_PREFIX: Record<string, Qualifier> = {
  "~": "about",
  "?": "maybe",
  "<": "before",
  ">": "after",
};

const JULIAN = /\bjulian\b/i;
/** Calendar words the raw form cannot be trusted under (no such date was ever captured). */
const OTHER_CALENDAR =
  /\b(julien|french|fran[cç]ais|republican|r[ée]publicain|hebrew|h[ée]breu)\b/i;

const textOnly = (display: string | undefined): DateValue | undefined =>
  display ? { text: display } : undefined;

/**
 * A tree record's date: the raw form when it is one GeneWeb is known to write, else the
 * display wording as `text`. `display` is used for the calendar and the fallback only.
 */
export const fromRaw = (
  raw: string | undefined,
  display: string | undefined,
): DateValue | undefined => {
  const m = raw?.match(RAW);
  if (!m) return textOnly(display);
  if (display && OTHER_CALENDAR.test(display)) return textOnly(display);
  const [, prefix = "", ...nums] = m;
  const [y1, m1, d1, y2, m2, d2] = nums.map((n) => (n === undefined ? undefined : Number(n)));
  const range = y2 !== undefined;
  if (range && prefix) return textOnly(display);

  const julian = display !== undefined && JULIAN.test(display);
  const bound = (y = 0, mo = 0, d = 0): string | undefined => {
    if (!julian) return iso(y, mo, d);
    // Only a full date converts exactly; a Julian year or month alone was never captured.
    if (y <= 0 || mo === 0 || d === 0) return undefined;
    return iso(...julianOfGregorian(y, mo, d));
  };

  const date = bound(y1, m1, d1);
  const dateTo = range ? bound(y2, m2, d2) : undefined;
  if (!date || (range && !dateTo)) return textOnly(display);
  const qualifier: Qualifier | undefined = range ? "between" : RAW_PREFIX[prefix];
  return {
    date,
    ...(qualifier ? { qualifier } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(julian ? { calendar: "julian" as const } : {}),
  };
};

// ── English wording ──────────────────────────────────────────────────────────

const WORD_QUALIFIER: Record<string, Qualifier> = {
  about: "about",
  possibly: "maybe",
  maybe: "maybe",
  before: "before",
  after: "after",
};

/**
 * One English date phrase: `D`, `<about|possibly|maybe|before|after> D` or
 * `between D and D`, where `readDate` turns one date into ISO (or refuses it).
 */
const fromPhrase = (
  phrase: string,
  readDate: (s: string) => string | undefined,
): DateValue | undefined => {
  const between = phrase.match(/^between (\S+) and (\S+)$/i);
  if (between) {
    const date = readDate(between[1] ?? "");
    const dateTo = readDate(between[2] ?? "");
    return date && dateTo ? { date, qualifier: "between", dateTo } : undefined;
  }
  const qualified = phrase.match(/^(about|possibly|maybe|before|after) (\S+)$/i);
  if (qualified) {
    const date = readDate(qualified[2] ?? "");
    const qualifier = WORD_QUALIFIER[(qualified[1] ?? "").toLowerCase()];
    return date && qualifier ? { date, qualifier } : undefined;
  }
  const date = readDate(phrase);
  return date ? { date } : undefined;
};

const readYear = (s: string): string | undefined =>
  /^\d{1,4}$/.test(s) ? iso(Number(s), 0, 0) : undefined;

/**
 * The site's event labels: Birth, Death, Marriage and Date seen live (2026-11-21), Baptism,
 * Burial and Mention from the plan. "Date" is Geneanet's own generic label.
 */
const LABEL = /^(birth|baptism|marriage|death|burial|mention|date)\b\s*(.*)$/i;
/** Where a date starts after a label not in LABEL: a bracket, a digit, a qualifier or a mask. */
const DATE_START = /\(|\d|\bX{2,}\b|\b(about|possibly|maybe|before|after|between)\b/i;

/** Split a line into its label and its date wording, either of which may be empty. */
const splitLabel = (line: string): [string, string] => {
  const known = line.match(LABEL);
  if (known) return [known[1] ?? "", known[2] ?? ""];
  const start = line.search(DATE_START);
  if (start >= 0) return [line.slice(0, start).trim(), line.slice(start).trim()];
  // An unknown label and a date in words: the first word is the label, the rest is kept as text.
  const space = line.indexOf(" ");
  return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
};

/**
 * One line of a site-search hit's dates. The event is the label in front ("Birth",
 * "Marriage"), lower-cased; a line with no label gets Geneanet's own generic "date".
 * Wording after the label that is not a known date form (the Premium mask "XXXX",
 * "18th century") is kept as `text`.
 */
export const fromWording = (line: string): { event: string; date?: DateValue } => {
  const [label, wording] = splitLabel(line.replace(/\s+/g, " ").trim());
  const event = label.toLowerCase() || "date";
  if (!wording) return { event };
  const phrase = wording.replace(/^\((.*)\)$/, "$1").trim();
  return { event, date: fromPhrase(phrase, readYear) ?? { text: wording } };
};

/** One en display date: month/day/year, or a year. */
const readEnDate = (s: string): string | undefined => {
  const mdy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return mdy ? iso(Number(mdy[3]), Number(mdy[1]), Number(mdy[2])) : readYear(s);
};

/**
 * A search-result relative's display date. Only the en site's forms are read: its
 * numbers are month/day/year ("02/13/1841" is raw /1841/2/13# in the same record), and
 * a Julian date carries " (Julian)" with the numbers in that calendar. Any other
 * language keeps the display as `text`, since its numeric order is not known here.
 */
export const fromDisplayEn = (date: string | undefined, lang: string): DateValue | undefined => {
  if (!date) return undefined;
  if (lang !== "en") return { text: date };
  const julian = date.match(/^(.*) \(Julian\)$/);
  const parsed = fromPhrase(julian?.[1] ?? date, readEnDate);
  if (!parsed) return { text: date };
  return julian ? { ...parsed, calendar: "julian" } : parsed;
};

// ── Life years ───────────────────────────────────────────────────────────────

/** One half of a life span: a year, or "ca <year>" (seen as "ca 1768", which reads "about 1768"). */
const lifeYear = (half: string): string | undefined => {
  const m = half.match(/^(ca )?(\d{1,4})$/);
  const year = m ? readYear(m[2] ?? "") : undefined;
  return year && m?.[1] ? `about ${year}` : year;
};

/**
 * The life years a graph node or a tree search hit shows, as `Brief.born` / `Brief.died`. Forms
 * seen live (2026-11-21), each next to the same person's full dates: "1841-1907", "1809-",
 * "ca 1768-1818" (about 1768) and "†< 1791" (died before 1791). Any other "†" form is kept as
 * the site wrote it, in `died`; anything else as written, in `born`.
 */
export const fromLifeSpan = (dates: string | undefined): { born?: string; died?: string } => {
  const s = dates?.replace(/\s+/g, " ").trim();
  if (!s || s === "-") return {};
  const span = s.match(/^([^-]*)-([^-]*)$/);
  if (span) {
    const [b = "", d = ""] = [span[1]?.trim(), span[2]?.trim()];
    const born = lifeYear(b);
    const died = lifeYear(d);
    if ((!b || born) && (!d || died))
      return { ...(born ? { born } : {}), ...(died ? { died } : {}) };
  }
  // "†" marks a death: never put one in born. Only "†< <year>" was seen; other forms keep the text.
  if (s.startsWith("†")) {
    const year = readYear(s.match(/^†< (\d{1,4})$/)?.[1] ?? "");
    return { died: year ? `before ${year}` : s };
  }
  return { born: s };
};

// ── Short form ───────────────────────────────────────────────────────────────

/**
 * `Brief.born` / `Brief.died`: the ISO date alone, `"<qualifier> <date>"`, the two-date
 * forms in words ("between 1825 and 1875", "from 1825 to 1875", "1768 or 1769"), with a
 * non-Gregorian calendar appended ("1539-05-29 (julian)"); the text when there is no date.
 */
export const shortDate = (d: DateValue | undefined): string | undefined => {
  if (!d?.date) return d?.text || undefined;
  const { date, dateTo, qualifier } = d;
  let base: string;
  if (qualifier === "between") base = dateTo ? `between ${date} and ${dateTo}` : `between ${date}`;
  else if (qualifier === "from") base = dateTo ? `from ${date} to ${dateTo}` : `from ${date}`;
  else if (qualifier === "or") base = dateTo ? `${date} or ${dateTo}` : date;
  else base = qualifier ? `${qualifier} ${date}` : date;
  return d.calendar ? `${base} (${d.calendar})` : base;
};
