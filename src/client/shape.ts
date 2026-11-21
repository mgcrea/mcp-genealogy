// The context-window layer. GeneWeb records repeat every relative in full
// (24 fields per parent, spouse, child and witness), carry each date three
// ways, and hold notes as HTML. Passed through, one person costs several times
// what it says, and the graph's hashed node ids and edge lists leave the model
// to do a join it can get wrong. So:
//
// - every relative collapses to `{ index, name, life }`, and `index` is what
//   the other tools take;
// - dates are ISO when GeneWeb's raw form is exact (`/1841/2/13#` → 1841-02-13),
//   and otherwise the site's own wording ("about 1768");
// - the graph comes back as people with fatherIndex / motherIndex /
//   spouseOfIndex already resolved, never as nodes and edges.

import type {
  Event,
  Family,
  Graph,
  GraphNode,
  Person,
  PersonKey,
  SearchHit,
  SearchRelative,
  Sex,
  SimplePerson,
  TreePerson,
} from "#/proto/messages";

type Rec = Record<string, unknown>;

/** Omit empty values so nothing spends tokens on nulls. */
const opt = (key: string, value: unknown): Rec =>
  value === undefined ||
  value === "" ||
  value === false ||
  (Array.isArray(value) && value.length === 0)
    ? {}
    : { [key]: value };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Notes are user-written: one out-of-range entity must not fail the whole record.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });

/** GeneWeb notes are HTML fragments. Keep the line structure, drop the markup. */
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Long notes are cut with an honest flag rather than silently. */
export const NOTES_MAX_CHARS = 6000;

const notesField = (key: string, html: string | undefined): Rec => {
  if (!html) return {};
  const text = htmlToText(html);
  if (!text) return {};
  if (text.length <= NOTES_MAX_CHARS) return { [key]: text };
  return {
    [key]: text.slice(0, NOTES_MAX_CHARS),
    [`${key}Truncated`]: `Cut at ${NOTES_MAX_CHARS} of ${text.length} characters; the profile URL has the rest.`,
  };
};

/**
 * GeneWeb's raw date is `/<year>/<month>/<day>#`, with 0 for an unknown part
 * (`/1896/0/0#` is "1896"). Only that exact, unqualified form becomes ISO;
 * anything else (a precision prefix, a range, a non-Gregorian calendar) keeps
 * the site's own wording, because guessing its grammar would put a wrong date
 * in front of the model with nothing to show it was a guess.
 */
export const isoFromRaw = (raw: string | undefined): string | undefined => {
  const m = raw?.match(/^\/(\d{1,4})\/(\d{1,2})\/(\d{1,2})#$/);
  if (!m) return undefined;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  if (y === "0") return undefined;
  const year = y.padStart(4, "0");
  if (mo === "0") return year;
  const month = mo.padStart(2, "0");
  return d === "0" ? `${year}-${month}` : `${year}-${month}-${d.padStart(2, "0")}`;
};

const bestDate = (raw: string | undefined, human: string | undefined): string | undefined =>
  isoFromRaw(raw) ?? (human ? decodeEntities(human) : undefined);

export const displayName = (firstname: string, lastname: string): string =>
  [firstname, lastname].filter((s) => s && s !== "?").join(" ") || "?";

const isUnknown = (firstname: string, lastname: string): boolean =>
  (firstname === "?" || firstname === "") && (lastname === "?" || lastname === "");

/** The public profile page, which is also where a human checks the data. */
export const profileUrl = (treeBaseUrl: string, tree: string, key: PersonKey): string => {
  const q = new URLSearchParams({ lang: "en", n: key.n, p: key.p });
  if (key.oc) q.set("oc", String(key.oc));
  return `${treeBaseUrl}/${encodeURIComponent(tree)}?${q.toString()}`;
};

const lifeHalf = (date: string | undefined, where: string | undefined): string =>
  [date, where].filter(Boolean).join(", ");

/** "1841-02-13, Lisle-sur-Tarn, Tarn – 1907-02-10, Cahuzac-sur-Vère, Tarn". */
const lifeLine = (
  born: string | undefined,
  bornAt: string | undefined,
  died: string | undefined,
  diedAt: string | undefined,
): string | undefined => {
  const b = lifeHalf(born, bornAt);
  const d = lifeHalf(died, diedAt);
  if (!b && !d) return undefined;
  return d ? `${b || "?"} – ${d}` : b;
};

/** A relative, collapsed: enough to recognise them, plus the index to fetch them. */
export const briefRelative = (sp: SimplePerson): Rec => ({
  index: sp.index,
  name: displayName(sp.firstname, sp.lastname),
  ...opt("unknown", isUnknown(sp.firstname, sp.lastname)),
  ...opt(
    "life",
    lifeLine(
      bestDate(sp.birthDateRaw, sp.birthDate),
      sp.birthPlace,
      bestDate(sp.deathDateRaw, sp.deathDate),
      sp.deathPlace,
    ),
  ),
  ...opt("private", sp.hidden),
});

const WITNESS_ROLES = [
  "witness",
  "godparent",
  "civil officer",
  "religious officer",
  "informant",
  "attending",
  "mentioned",
  "other",
];

const shapeEvent = (e: Event): Rec => ({
  event: e.name,
  ...opt("date", bestDate(e.dateRaw, e.date)),
  ...opt("place", e.place),
  ...opt("reason", e.reason),
  ...notesField("note", e.note),
  ...opt("source", e.source ? htmlToText(e.source) : undefined),
  ...(e.spouse ? { with: briefRelative(e.spouse) } : {}),
  ...opt(
    "witnesses",
    e.witnesses.map((w) => ({
      ...briefRelative(w.person),
      role: WITNESS_ROLES[w.role] ?? "witness",
      ...opt("note", w.note),
    })),
  ),
});

const MARRIAGE_TYPES = [
  "married",
  "not married",
  "engaged",
  "not married",
  "no mention",
  "married",
  "marriage bann",
  "marriage contract",
  "marriage license",
  "PACS",
  "residence",
];
const DIVORCE_TYPES = ["", "divorced", "separated"];

const shapeFamily = (f: Family): Rec => ({
  familyIndex: f.index,
  spouse: briefRelative(f.spouse),
  ...(f.marriageType !== 0 ? { union: MARRIAGE_TYPES[f.marriageType] ?? "unknown" } : {}),
  ...opt("married", bestDate(f.marriageDateRaw, f.marriageDate)),
  ...opt("marriagePlace", f.marriagePlace),
  ...opt("marriageSource", f.marriageSource ? htmlToText(f.marriageSource) : undefined),
  ...opt("separation", DIVORCE_TYPES[f.divorceType]),
  ...opt("separationDate", f.divorceDate),
  ...notesField("notes", f.notes),
  ...opt("sources", f.sources ? htmlToText(f.sources) : undefined),
  children: f.children.map(briefRelative),
});

const DEATH_STATUS = [
  "alive",
  "dead",
  "died young",
  "dead, date unknown",
  "unknown",
  "dead (long ago)",
];

/**
 * The Person message carries vital dates only in display form ("Mar. 20, 1797");
 * the matching event (birth = type 0, baptism 1, death 2, burial 3) has the raw
 * one, so an exact date is taken from there and reads the same as in `events`.
 */
const vital = (
  v: { date?: string; place?: string; source?: string },
  events: Event[],
  type: number,
): Rec | undefined => {
  const raw = events.find((e) => e.type === type)?.dateRaw;
  const out = {
    ...opt("date", bestDate(raw, v.date)),
    ...opt("place", v.place),
    ...opt("source", v.source ? htmlToText(v.source) : undefined),
  };
  return Object.keys(out).length ? out : undefined;
};

/** `get_person`: the whole record, with every relative collapsed to a brief. */
export const shapePerson = (treeBaseUrl: string, tree: string, p: Person): Rec => {
  const death = vital(p.death, p.events, 2);
  const status = DEATH_STATUS[p.death.type];
  return {
    tree,
    index: p.index,
    name: displayName(p.firstname, p.lastname),
    lastname: p.lastname,
    firstname: p.firstname,
    sex: p.sex,
    url: profileUrl(treeBaseUrl, tree, p.key),
    ...opt("publicName", p.publicName),
    ...opt("aliases", p.aliases),
    ...opt("firstnameAliases", p.firstnameAliases),
    ...opt("surnameAliases", p.surnameAliases),
    ...opt("qualifiers", p.qualifiers),
    ...opt("titles", p.titles),
    ...opt("occupation", p.occupation),
    ...opt("birth", vital(p.birth, p.events, 0)),
    ...opt("baptism", vital(p.baptism, p.events, 1)),
    // The status adds nothing next to a death date; without one it is the only signal.
    ...(death || status !== "dead"
      ? { death: { ...death, ...(status && status !== "dead" ? { status } : {}) } }
      : {}),
    ...opt("burial", vital(p.burial, p.events, 3)),
    ...(p.sosa === 0 ? { treeRoot: true } : p.sosa === 1 ? { directAncestorOfTreeRoot: true } : {}),
    ...(p.father || p.mother
      ? {
          parents: {
            ...(p.father ? { father: briefRelative(p.father) } : {}),
            ...(p.mother ? { mother: briefRelative(p.mother) } : {}),
          },
        }
      : {}),
    families: p.families.map(shapeFamily),
    events: p.events.map(shapeEvent),
    ...(p.eventsTotal > p.events.length
      ? {
          eventsTruncated: `Showing ${p.events.length} of ${p.eventsTotal} events; raise eventsLimit for the rest.`,
        }
      : {}),
    ...notesField("notes", p.notes),
    ...opt("sources", p.sources ? htmlToText(p.sources) : undefined),
  };
};

// ── graph ────────────────────────────────────────────────────────────────────

const briefTreePerson = (p: TreePerson): Rec => ({
  index: p.index,
  name: displayName(p.firstname, p.lastname),
  ...opt("unknown", isUnknown(p.firstname, p.lastname)),
  ...opt("sex", p.sex === "unknown" ? undefined : p.sex),
  ...opt("dates", p.dates && p.dates !== "-" ? p.dates : undefined),
  ...opt("private", p.hidden),
});

const parentRole = (sex: Sex): "fatherIndex" | "motherIndex" | "parentIndex" =>
  sex === "male" ? "fatherIndex" : sex === "female" ? "motherIndex" : "parentIndex";

/**
 * Resolve the graph into people.
 *
 * Ancestor edges run child → parent. Descendant edges follow upstream
 * GeneWeb's `build_graph_desc_v2`: for every family it emits the spouse (an
 * unknown "? ?" partner included) with one edge from the person, and each child
 * with one edge from each partner. So in the descendant half, a node with one
 * incoming edge is a spouse and a node with two is a child; nothing is
 * inferred from order, sex or family ids.
 */
export const shapeGraph = (treeBaseUrl: string, tree: string, g: Graph): Rec => {
  // The root is the one node no edge points at, in either half; the order the
  // nodes arrive in is not part of the contract.
  const targets = new Set([...g.ancestorEdges, ...g.descendantEdges].map((e) => e.to));
  const root =
    g.ancestors.find((n) => !targets.has(n.id)) ?? g.descendants.find((n) => !targets.has(n.id));
  if (!root) return { tree, found: false };

  const byId = new Map<number, GraphNode>();
  for (const n of [...g.ancestors, ...g.descendants]) byId.set(n.id, n);

  // Ancestors: breadth-first from the root, so generation is the shortest path.
  const parentsOf = new Map<number, number[]>();
  for (const e of g.ancestorEdges) parentsOf.set(e.from, [...(parentsOf.get(e.from) ?? []), e.to]);
  const ancestors: Rec[] = [];
  const seenAnc = new Set<number>([root.person.index]);
  const rootParents: Rec = {};
  let frontier = [root.id];
  for (let gen = 1; frontier.length > 0; gen += 1) {
    const next: number[] = [];
    for (const childId of frontier) {
      for (const parentId of parentsOf.get(childId) ?? []) {
        const parent = byId.get(parentId);
        if (!parent) continue;
        if (childId === root.id) rootParents[parentRole(parent.person.sex)] = parent.person.index;
        if (seenAnc.has(parent.person.index)) continue; // pedigree collapse: list once
        seenAnc.add(parent.person.index);
        const own: Rec = {};
        for (const grand of parentsOf.get(parentId) ?? []) {
          const gp = byId.get(grand);
          if (gp) own[parentRole(gp.person.sex)] = gp.person.index;
        }
        ancestors.push({ generation: gen, ...briefTreePerson(parent.person), ...own });
        next.push(parentId);
      }
    }
    frontier = next;
  }

  // Descendants. A node's incoming edges come from its parents (two partners
  // who are themselves linked by a spouse edge) and from anyone it married
  // (one edge each). Classifying by couples rather than by edge count keeps
  // the same spouse in two families, a widow remarrying her brother-in-law and
  // a marriage between cousins right: one node can be both a child and a spouse.
  const edgeSet = new Set(g.descendantEdges.map((e) => `${e.from}>${e.to}`));
  const linked = (a: number, b: number): boolean =>
    edgeSet.has(`${a}>${b}`) || edgeSet.has(`${b}>${a}`);
  const incoming = new Map<number, Set<number>>();
  const outgoing = new Map<number, number[]>();
  for (const e of g.descendantEdges) {
    incoming.set(e.to, (incoming.get(e.to) ?? new Set()).add(e.from));
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.to]);
  }
  const rolesOf = (id: number): { parents: number[]; spouses: number[] } => {
    const sources = [...(incoming.get(id) ?? [])];
    const parents = sources.filter((s) => sources.some((t) => t !== s && linked(s, t)));
    return { parents, spouses: sources.filter((s) => !parents.includes(s)) };
  };
  const indexOf = (id: number): number => byId.get(id)?.person.index ?? -1;

  const generationOf = new Map<number, number>([[root.id, 0]]);
  const descendants: Rec[] = [];
  const queue = [root.id];
  while (queue.length > 0) {
    const fromId = queue.shift() as number;
    for (const toId of outgoing.get(fromId) ?? []) {
      if (generationOf.has(toId)) continue;
      const node = byId.get(toId);
      if (!node) continue;
      const { parents, spouses } = rolesOf(toId);
      // A child waits until both parents are placed; it is reached again from the second one.
      if (parents.length > 0 && !parents.every((p) => generationOf.has(p))) continue;
      const gen =
        parents.length > 0
          ? Math.max(...parents.map((p) => generationOf.get(p) ?? 0)) + 1
          : (generationOf.get(fromId) ?? 0);
      generationOf.set(toId, gen);
      queue.push(toId);
      descendants.push({
        generation: gen,
        relation: parents.length > 0 ? "child" : "spouse",
        ...briefTreePerson(node.person),
        ...(parents.length > 0 ? { parentIndexes: parents.map(indexOf) } : {}),
        ...(spouses.length > 0 ? { spouseOfIndexes: spouses.map(indexOf) } : {}),
      });
    }
  }
  // Never drop people silently: a node the walk could not place is still reported.
  const unplaced = g.descendants.filter((n) => n.id !== root.id && !generationOf.has(n.id)).length;

  return {
    tree,
    root: {
      ...briefTreePerson(root.person),
      url: profileUrl(treeBaseUrl, tree, root.person.key),
      ...rootParents,
    },
    ancestors,
    descendants,
    ...(unplaced > 0
      ? {
          unplacedDescendants: `${unplaced} descendant node(s) had no resolvable parents and were left out.`,
        }
      : {}),
    siblings: g.siblings.map((s) => briefTreePerson(s.person)),
  };
};

// ── search within a tree ─────────────────────────────────────────────────────

/**
 * Search results carry no raw dates, only the display form, which for
 * `lang=en` is month/day/year: "02/13/1841" is raw /1841/2/13# in the same
 * record (checked on 2026-11-20). Only that language and that exact shape are
 * converted; any other language's numeric order is left as the site wrote it.
 */
export const isoFromDisplay = (date: string | undefined, lang: string): string | undefined => {
  const m = lang === "en" ? date?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) : null;
  return m ? `${m[3]}-${m[1]}-${m[2]}` : date;
};

const briefSearchRelative = (r: SearchRelative, lang: string): Rec => ({
  index: r.index,
  name: displayName(r.firstname, r.lastname),
  ...opt(
    "life",
    lifeLine(
      isoFromDisplay(r.birthDate, lang),
      r.birthPlace,
      isoFromDisplay(r.deathDate, lang),
      r.deathPlace,
    ),
  ),
});

export const shapeSearchHits = (
  treeBaseUrl: string,
  tree: string,
  hits: SearchHit[],
  lang = "en",
  limit?: number,
): Rec => ({
  tree,
  count: hits.length,
  ...(limit !== undefined && hits.length >= limit
    ? { limitReached: "There may be more matches: raise limit or narrow the names." }
    : {}),
  persons: hits.map((h) => ({
    index: h.index,
    name: displayName(h.firstname, h.lastname),
    ...opt("sex", h.sex === "unknown" ? undefined : h.sex),
    ...opt("dates", h.dates),
    ...(h.father ? { father: briefSearchRelative(h.father, lang) } : {}),
    ...(h.mother ? { mother: briefSearchRelative(h.mother, lang) } : {}),
    ...opt(
      "spouses",
      h.spouses.map((s) => briefSearchRelative(s, lang)),
    ),
    url: h.path ? `${treeBaseUrl}/${h.path}` : profileUrl(treeBaseUrl, tree, h.key),
  })),
});
