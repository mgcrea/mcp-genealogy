// Site-wide search (en.geneanet.org/fonds/individus/): the query it takes and
// the HTML it answers. No MCP knowledge here, so it is tested on its own
// against the real pages in test/fixtures/records-*.html.
//
// The page is server-rendered; there is no JSON behind it. The form's only
// background requests are a library hit count and an alert check, checked in
// Safari on 2026-11-20. Each hit is an
// `<a class="ligne-resultat" data-type-fonds="…">` with three column blocks:
// `content-individu` (name, spouse, relationship, source), `content-periode`
// (labelled dates) and `content-lieu` (places, each tagged with event icons).

import { decodeEntities } from "#/client/shape";

// ── Query ────────────────────────────────────────────────────────────────────

export type RecordsQuery = {
  lastname: string;
  firstname?: string;
  sex?: "male" | "female";
  places?: string[];
  radiusKm?: 5 | 10 | 15 | 30 | 100 | 200;
  from?: number;
  to?: number;
  dateOf?: "any" | "birth" | "marriage" | "death";
  dateMode?: "between" | "before" | "after";
  fatherLastname?: string;
  fatherFirstname?: string;
  motherLastname?: string;
  motherFirstname?: string;
  page: number;
  size: 10 | 20 | 30 | 40 | 50 | 100;
};

const PERIOD_OF = { any: "all", birth: "birth", marriage: "wedding", death: "death" } as const;

/** The form's own field names, so a URL from here also works pasted into a browser. */
export const buildRecordsQuery = (q: RecordsQuery): URLSearchParams => {
  const params = new URLSearchParams({ go: "1", nom: q.lastname });
  const set = (key: string, value: string | number | undefined): void => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  };
  set("prenom", q.firstname);
  set("sexe", q.sex === "male" ? 1 : q.sex === "female" ? 2 : undefined);
  (q.places ?? []).slice(0, 5).forEach((place, i) => set(`place__${i}__`, place));
  if (q.places?.length) set("voisinage", q.radiusKm);
  if (q.from !== undefined || q.to !== undefined) {
    set("periode_mode", PERIOD_OF[q.dateOf ?? "any"]);
    set("type_periode", q.dateMode ?? "between");
    set("from", q.from);
    set("to", q.to);
  }
  set("nom_pere", q.fatherLastname);
  set("prenom_pere", q.fatherFirstname);
  set("nom_mere", q.motherLastname);
  set("prenom_mere", q.motherFirstname);
  set("size", q.size);
  if (q.page > 1) set("page", q.page);
  return params;
};

// ── Results ──────────────────────────────────────────────────────────────────

/** `data-type-fonds`, renamed for a reader who does not speak Geneanet. */
const KINDS: Record<string, string> = {
  arbres_utilisateur: "family_tree",
  releves_cercles: "society_index",
  releves_collaboratifs: "collaborative_index",
  registres: "archival_register",
};

export type RecordHit = {
  kind: string;
  name: string;
  spouse?: string;
  relationship?: string;
  source?: string;
  dates: string[];
  places: { place: string; events: string[] }[];
  url: string;
  /** Family-tree hits only: what geneanet_get_person takes. */
  tree?: string;
  n?: string;
  p?: string;
  oc?: number;
};

export type RecordsPage = { total: number; hits: RecordHit[] };

/** Tags become spaces (they separate words), then the padding they leave inside brackets goes. */
const text = (html: string): string =>
  decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim();

/** The inner HTML of the first `<div class="… <cls> …">`, up to its matching close. */
const block = (html: string, cls: string): string => {
  const start = html.search(new RegExp(`<div[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`));
  if (start < 0) return "";
  const open = html.indexOf(">", start) + 1;
  let depth = 1;
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = open;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index);
  }
  return html.slice(open);
};

const paragraphs = (html: string): string[] =>
  [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1] ?? "");

const treeRef = (url: string, treeHost: string): Pick<RecordHit, "tree" | "n" | "p" | "oc"> => {
  try {
    const u = new URL(url);
    if (u.host !== treeHost) return {};
    const tree = u.pathname.split("/")[1];
    const n = u.searchParams.get("n");
    const p = u.searchParams.get("p");
    if (!tree || !n || !p) return {};
    const oc = Number(u.searchParams.get("oc") ?? 0);
    return { tree, n, p, ...(oc ? { oc } : {}) };
  } catch {
    return {};
  }
};

const parseHit = (anchor: string, siteBaseUrl: string, treeHost: string): RecordHit => {
  const href = decodeEntities(anchor.match(/\bhref="([^"]*)"/)?.[1] ?? "");
  const url = new URL(href, siteBaseUrl).toString();
  const type = anchor.match(/\bdata-type-fonds="([^"]*)"/)?.[1] ?? "unknown";

  const individu = paragraphs(block(anchor, "content-individu"));
  const [nameHtml = "", ...rest] = individu;
  const hit: RecordHit = {
    kind: KINDS[type] ?? type,
    name: text(nameHtml),
    // A range wraps onto a second <p> ("Marriage (between 1825" / "and 1875)"):
    // a line starting in lower case continues the one before it.
    dates: paragraphs(block(anchor, "content-periode"))
      .map(text)
      .filter(Boolean)
      .reduce<string[]>((lines, line) => {
        const last = lines.length - 1;
        if (last >= 0 && /^[a-z)]/.test(line)) lines[last] = `${lines[last]} ${line}`;
        else lines.push(line);
        return lines;
      }, []),
    places: [...block(anchor, "content-lieu").matchAll(/<p[^>]*ligne-lieu[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => ({
        place: text(m[1]?.match(/title-lieu[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? ""),
        events: [...(m[1] ?? "").matchAll(/\btitle="([^"]+)"/g)].map((t) =>
          decodeEntities(t[1] ?? "").toLowerCase(),
        ),
      }))
      .filter((p) => p.place),
    url,
    ...treeRef(url, treeHost),
  };
  for (const para of rest) {
    const line = text(para);
    const labelled = line.match(/^([^:]{1,40}?)\s*:\s*(.+)$/);
    if (labelled) {
      const [, label = "", value = ""] = labelled;
      const key = label.toLowerCase();
      if (key === "spouse") hit.spouse = value;
      else if (key === "relationship") hit.relationship = value.toLowerCase();
      else if (key === "archives") hit.source = value;
      else hit.source = hit.source ? `${hit.source}; ${line}` : line;
    } else if (line) {
      hit.source = hit.source ? `${hit.source}; ${line}` : line;
    }
  }
  return hit;
};

export class RecordsParseError extends Error {
  override readonly name = "RecordsParseError";
}

/**
 * Parse one results page. Throws when the page has neither a result count nor
 * the "nothing found" message, so a redesign surfaces as an error instead of a
 * quiet "0 results".
 */
export const parseRecordsPage = (
  html: string,
  siteBaseUrl: string,
  treeBaseUrl: string,
): RecordsPage => {
  const treeHost = new URL(treeBaseUrl).host;
  const hits = [...html.matchAll(/<a\s[^>]*class="ligne-resultat[^"]*"[^>]*>[\s\S]*?<\/a>/g)].map(
    (m) => parseHit(m[0], siteBaseUrl, treeHost),
  );
  // Digits only, so a localised "12,345" or "12 345" still reads as a number.
  const count = html.match(/data-nb-results="([\d,.\s\u00a0\u202f]+)"/)?.[1]?.replace(/\D/g, "");
  if (count) return { total: Number(count), hits };
  if (hits.length === 0 && /No individuals were found|no-results-explained/.test(html)) {
    return { total: 0, hits };
  }
  throw new RecordsParseError(
    `The search page had ${hits.length} result rows but no result count; its markup has changed.`,
  );
};
