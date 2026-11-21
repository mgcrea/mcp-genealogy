// A Geneanet `person` answer in the shared schema (spec: "The shared shape", "Geneanet tools").
//
// - Every relative is a `Brief` whose ref id is "<tree>:<index>".
// - Vitals are events: the date from the matching event's raw form (the Person message has the
//   display form only), the place and source from the Person message, which the event list can
//   lack when `eventsLimit` cut it short.
// - Every event cites the profile page, with the tree owner's source text when there is one.
// - `summary` keeps the four vitals, the unions, parents and spouses as briefs and a child count
//   per family; `full` adds the whole event list with notes and witnesses, children as briefs
//   and the notes.
//
// It also maps geneanet_get_tree's graph and geneanet_search_tree's hits: each node and person
// is a brief (ref, born/died from the life years, `withheld` from the hidden flag) plus its
// index, and the graph comes back as people with fatherIndex / motherIndex / parentIndexes /
// spouseOfIndexes already resolved, never as hashed node ids and edge lists to join.

import { geneanetRefId } from "#/schema/ids";
import type { Brief, Citation, Event, Person, Withheld } from "#/schema/types";
import { fromDisplayEn, fromLifeSpan, fromRaw, shortDate } from "#/sources/geneanet/dates";
import { splitPlace } from "#/sources/geneanet/places";
import type {
  Event as GwEvent,
  Family,
  Graph,
  GraphNode,
  Person as GwPerson,
  SearchHit,
  SearchRelative,
  Sex,
  SimplePerson,
  TreePerson,
} from "#/sources/geneanet/proto/messages";
import { decodeEntities, displayName, htmlToText, personUrl } from "#/sources/geneanet/shape";

export type Detail = Person["detail"];

type Rec = Record<string, unknown>;

/** Long notes are cut with an honest flag rather than silently. */
const NOTES_MAX_CHARS = 6000;

const text = (html: string | undefined): string | undefined =>
  (html && htmlToText(html)) || undefined;

const notesText = (html: string | undefined): string | undefined => {
  const t = text(html);
  if (!t || t.length <= NOTES_MAX_CHARS) return t;
  return `${t.slice(0, NOTES_MAX_CHARS)}\n[Cut at ${NOTES_MAX_CHARS} of ${t.length} characters; the profile URL has the rest.]`;
};

const date = (raw: string | undefined, display: string | undefined) =>
  fromRaw(raw, display ? decodeEntities(display) : undefined);

/**
 * Drop undefined, empty strings and empty arrays, so nothing spends tokens on them; `keep`
 * names the fields the schema requires even when empty.
 */
const compact = <T extends object>(o: T, keep: string[] = []): T =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([k, v]) =>
        keep.includes(k) || (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)),
    ),
  ) as T;

export const geneanetCitation = (tree: string, url: string, textValue?: string): Citation =>
  compact({ source: "geneanet" as const, title: `Geneanet tree ${tree}`, url, text: textValue });

export const toBrief = (base: string, tree: string, sp: SimplePerson): Brief =>
  compact({
    ref: {
      source: "geneanet" as const,
      id: geneanetRefId(tree, sp.index),
      url: personUrl(base, tree, sp.index, sp.key),
    },
    name: displayName(sp.firstname, sp.lastname),
    sex: sp.sex === "unknown" ? undefined : sp.sex,
    born: shortDate(date(sp.birthDateRaw, sp.birthDate)),
    bornAt: sp.birthPlace,
    died: shortDate(date(sp.deathDateRaw, sp.deathDate)),
    diedAt: sp.deathPlace,
    // Masked ("x x") or name only: either way the tree withholds this person (proto/README.md).
    withheld: sp.hidden || sp.restricted ? ("private" as const) : undefined,
  });

// ── events ───────────────────────────────────────────────────────────────────

/**
 * GeneWeb event types with a schema name; any other event keeps the name the tree gave it, lower
 * cased like every event type ("marriage bann", "recensement").
 */
const EVENT_TYPES: Record<number, string> = {
  0: "birth",
  1: "baptism",
  2: "death",
  3: "burial",
  39: "occupation",
  43: "residence",
  100: "marriage",
  104: "divorce",
  105: "separation",
  111: "residence",
};

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

type Ctx = { base: string; tree: string; url: string; full: boolean };

const cite = (ctx: Ctx, source: string | undefined): Citation[] => [
  geneanetCitation(ctx.tree, ctx.url, text(source)),
];

/** The event's own note, with GeneWeb's `reason` (e.g. a cause) in front when there is one. */
const eventNote = (e: GwEvent | undefined): string | undefined =>
  [e?.reason, notesText(e?.note)].filter(Boolean).join("\n") || undefined;

const fullExtras = (ctx: Ctx, e: GwEvent | undefined): Partial<Event> =>
  ctx.full && e
    ? {
        note: eventNote(e),
        witnesses: e.witnesses.map((w) =>
          compact({
            ...toBrief(ctx.base, ctx.tree, w.person),
            role: WITNESS_ROLES[w.role] ?? "witness",
            note: w.note,
          }),
        ),
      }
    : {};

const toEvent = (ctx: Ctx, e: GwEvent): Event =>
  compact({
    type: EVENT_TYPES[e.type] ?? e.name.toLowerCase(),
    date: date(e.dateRaw, e.date),
    place: splitPlace(e.place),
    ...fullExtras(ctx, e),
    with: e.spouse ? toBrief(ctx.base, ctx.tree, e.spouse) : undefined,
    citations: cite(ctx, e.source),
  });

type Vital = { date?: string; place?: string; source?: string };

/** A vital from the Person message, completed by its event in the list when there is one. */
const vitalEvent = (
  ctx: Ctx,
  type: number,
  v: Vital,
  e: GwEvent | undefined,
): Event | undefined => {
  if (!e && !v.date && !v.place && !v.source) return undefined;
  return compact({
    type: EVENT_TYPES[type] as string,
    date: date(e?.dateRaw, v.date ?? e?.date),
    place: splitPlace(v.place ?? e?.place),
    ...fullExtras(ctx, e),
    citations: cite(ctx, v.source ?? e?.source),
  });
};

const VITALS = [0, 1, 2, 3] as const;

const personEvents = (ctx: Ctx, p: GwPerson): Event[] => {
  const vitalsOf: Record<(typeof VITALS)[number], Vital> = {
    0: p.birth,
    1: p.baptism,
    2: p.death,
    3: p.burial,
  };
  const firstOf = (type: number): GwEvent | undefined => p.events.find((e) => e.type === type);
  const vital = (type: (typeof VITALS)[number]): Event | undefined =>
    vitalEvent(ctx, type, vitalsOf[type], firstOf(type));

  if (!ctx.full) return VITALS.flatMap((t) => vital(t) ?? []);

  // The event list in its own order, each vital merged with the Person message's fields.
  const listed = p.events.map((e) =>
    (VITALS as readonly number[]).includes(e.type) && e === firstOf(e.type)
      ? (vital(e.type as (typeof VITALS)[number]) as Event)
      : toEvent(ctx, e),
  );
  // A vital the list lacks (cut by eventsLimit, or never listed) still comes back.
  const missing = (types: (typeof VITALS)[number][]): Event[] =>
    types.flatMap((t) => (firstOf(t) ? [] : (vital(t) ?? [])));
  return [...missing([0, 1]), ...listed, ...missing([2, 3])];
};

// ── families ─────────────────────────────────────────────────────────────────

/** MarriageType: 0 and 5 are married; the rest keep GeneWeb's word for the union, lower cased. */
const UNION_TYPES = [
  "marriage",
  "not married",
  "engaged",
  "not married",
  "no mention",
  "marriage",
  "marriage bann",
  "marriage contract",
  "marriage license",
  "pacs",
  "residence",
];
const SEPARATION_TYPES = [undefined, "divorce", "separation"];

const familyEvents = (ctx: Ctx, f: Family): Event[] => {
  const sources = [text(f.marriageSource), text(f.sources)].filter(Boolean).join("\n");
  const note = ctx.full ? notesText(f.notes) : undefined;
  const hasData = Boolean(
    f.marriageDate || f.marriageDateRaw || f.marriagePlace || sources || note,
  );
  // Married (0) and "no mention" (4) say nothing on their own; any other union type does.
  const union =
    hasData || ![0, 4].includes(f.marriageType)
      ? [
          compact({
            type: UNION_TYPES[f.marriageType] ?? "union",
            date: date(f.marriageDateRaw, f.marriageDate),
            place: splitPlace(f.marriagePlace),
            note,
            citations: [geneanetCitation(ctx.tree, ctx.url, sources || undefined)],
          }),
        ]
      : [];
  const separation = SEPARATION_TYPES[f.divorceType];
  return [
    ...union,
    ...(separation
      ? [
          compact({
            type: separation,
            date: date(f.divorceDateRaw, f.divorceDate),
            citations: cite(ctx, undefined),
          }),
        ]
      : []),
  ];
};

const toFamily = (ctx: Ctx, f: Family): NonNullable<Person["families"]>[number] => ({
  spouse: toBrief(ctx.base, ctx.tree, f.spouse),
  events: familyEvents(ctx, f),
  ...(ctx.full
    ? f.children.length > 0
      ? { children: f.children.map((c) => toBrief(ctx.base, ctx.tree, c)) }
      : {}
    : f.children.length > 0
      ? { childCount: f.children.length }
      : {}),
});

// ── person ───────────────────────────────────────────────────────────────────

const DEATH_STATUS = [
  "alive",
  "dead",
  "died young",
  "dead, date unknown",
  "unknown",
  "dead (long ago)",
];

const HIDDEN_REASON =
  'Geneanet hides this person from visitors: the record comes back as "x x", with no names, dates or events of its own.';
const RESTRICTED_REASON =
  "Geneanet returned the name only: the tree hides this person's details from visitors.";
const INFERRED_REASON =
  "Geneanet returned the name only; the tree hides living or private people from visitors (inferred: the record itself does not say).";

const isEmpty = (p: GwPerson): boolean =>
  p.events.length === 0 &&
  [p.birth, p.baptism, p.death, p.burial].every((v) => !v.date && !v.place);

/**
 * Field 51 is the "x x" mask and field 50 the name-only one (proto/README.md, "Private
 * people"). With neither flag, an empty record whose death status is alive (0) or unknown (4)
 * is only probably private.
 */
const withheldOf = (p: GwPerson): { withheld?: Withheld; withheldReason?: string } => {
  if (p.hidden) return { withheld: "private", withheldReason: HIDDEN_REASON };
  if (!isEmpty(p)) return {};
  if (p.restricted) return { withheld: "private", withheldReason: RESTRICTED_REASON };
  if (p.death.type === 0 || p.death.type === 4) {
    return { withheld: "probably-private", withheldReason: INFERRED_REASON };
  }
  return {};
};

const known = (name: string): string | undefined => (name && name !== "?" ? name : undefined);

/**
 * Today's free-text extras that have no field of their own in the shared shape (titles and the
 * person-level sources) follow the notes, each under its own heading.
 */
const fullNotes = (p: GwPerson): string | undefined =>
  [
    notesText(p.notes),
    p.titles.length > 0 ? `Titles: ${p.titles.join("; ")}` : undefined,
    text(p.sources) ? `Sources: ${text(p.sources)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n") || undefined;

export const toPerson = (base: string, tree: string, p: GwPerson, detail: Detail): Person => {
  const url = personUrl(base, tree, p.index, p.key);
  const ctx: Ctx = { base, tree, url, full: detail === "full" };
  const status = DEATH_STATUS[p.death.type];
  const aliases = ctx.full
    ? [
        ...new Set(
          [
            p.publicName,
            ...p.qualifiers,
            ...p.aliases,
            ...p.firstnameAliases,
            ...p.surnameAliases,
          ].filter((a): a is string => Boolean(a)),
        ),
      ]
    : [];
  return compact(
    {
      ref: { source: "geneanet" as const, id: geneanetRefId(tree, p.index), url },
      name: displayName(p.firstname, p.lastname),
      // A hidden person's "x x" is the mask, not a name.
      given: p.hidden ? undefined : known(p.firstname),
      surname: p.hidden ? undefined : known(p.lastname),
      sex: p.sex === "unknown" ? undefined : p.sex,
      aliases,
      occupation: p.occupation,
      events: personEvents(ctx, p),
      parents: [p.father, p.mother].flatMap((sp) => (sp ? [toBrief(base, tree, sp)] : [])),
      families: p.families.map((f) => toFamily(ctx, f)),
      notes: ctx.full ? fullNotes(p) : undefined,
      ...withheldOf(p),
      tree,
      index: p.index,
      ...(p.sosa === 0
        ? { treeRoot: true as const }
        : p.sosa === 1
          ? { directAncestorOfTreeRoot: true as const }
          : {}),
      eventsTruncated:
        ctx.full && p.eventsTotal > p.events.length
          ? `Showing ${p.events.length} of ${p.eventsTotal} events; geneanet_get_person with a larger eventsLimit returns the rest.`
          : undefined,
      // The status adds nothing next to "dead"; otherwise it is the only signal.
      deathStatus: status && status !== "dead" ? status : undefined,
      detail,
    },
    ["events"],
  ) as Person;
};

const VITAL_TYPES = ["birth", "baptism", "death", "burial"];

/** An event without its `full`-only fields (the owner's note and the witnesses). */
const withoutExtras = ({ note: _note, witnesses: _witnesses, ...e }: Event): Event => e;

/**
 * A union event whose only content was its note: `familyEvents` leaves it out of a summary
 * when its type says nothing on its own ("marriage", "no mention"). GeneWeb's other
 * "marriage" type (5) cannot be told apart once shaped, so a note-only union of that type is
 * dropped too.
 */
const noteOnlyUnion = (e: Event): boolean =>
  e.note !== undefined &&
  (e.type === "marriage" || e.type === "no mention") &&
  !e.date &&
  !e.place &&
  !e.citations?.some((c) => c.text);

/**
 * A full Person cut down to what `toPerson(..., "summary")` would have given: the four vitals
 * in order, no notes, witnesses or aliases, family events without notes, and a child count
 * instead of the children. For a cached full record answering a summary request.
 */
export const toSummary = (p: Person): Person => {
  if (p.detail === "summary") return p;
  // Overriding keys of the spread keeps their place, so the JSON reads in toPerson's order.
  return compact(
    {
      ...p,
      aliases: undefined,
      events: VITAL_TYPES.flatMap((t) => {
        const e = p.events.find((ev) => ev.type === t);
        return e ? [withoutExtras(e)] : [];
      }),
      families: p.families?.map(({ children, childCount: _childCount, ...f }) => ({
        ...f,
        events: f.events.filter((e) => !noteOnlyUnion(e)).map(withoutExtras),
        ...(children && children.length > 0 ? { childCount: children.length } : {}),
      })),
      notes: undefined,
      eventsTruncated: undefined,
      detail: "summary" as const,
    },
    ["events"],
  );
};

// ── graph (geneanet_get_tree) ────────────────────────────────────────────────

const isUnknown = (firstname: string, lastname: string): boolean =>
  (firstname === "?" || firstname === "") && (lastname === "?" || lastname === "");

/** A graph node as a brief, plus the index the graph's links point at. */
const graphNode = (base: string, tree: string, p: TreePerson): Rec =>
  compact({
    ref: {
      source: "geneanet" as const,
      id: geneanetRefId(tree, p.index),
      url: personUrl(base, tree, p.index, p.key),
    },
    index: p.index,
    name: displayName(p.firstname, p.lastname),
    unknown: isUnknown(p.firstname, p.lastname) ? (true as const) : undefined,
    sex: p.sex === "unknown" ? undefined : p.sex,
    ...fromLifeSpan(p.dates),
    withheld: p.hidden ? ("private" as const) : undefined,
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
export const toGraph = (base: string, tree: string, g: Graph): Rec => {
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
        ancestors.push({ generation: gen, ...graphNode(base, tree, parent.person), ...own });
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
        ...graphNode(base, tree, node.person),
        ...(parents.length > 0 ? { parentIndexes: parents.map(indexOf) } : {}),
        ...(spouses.length > 0 ? { spouseOfIndexes: spouses.map(indexOf) } : {}),
      });
    }
  }
  // Never drop people silently: a node the walk could not place is still reported.
  const unplaced = g.descendants.filter((n) => n.id !== root.id && !generationOf.has(n.id)).length;

  return {
    tree,
    root: { ...graphNode(base, tree, root.person), ...rootParents },
    ancestors,
    descendants,
    ...(unplaced > 0
      ? {
          unplacedDescendants: `${unplaced} descendant node(s) had no resolvable parents and were left out.`,
        }
      : {}),
    siblings: g.siblings.map((s) => graphNode(base, tree, s.person)),
  };
};

// ── search within a tree (geneanet_search_tree) ──────────────────────────────

/** A search hit's relative as a brief. */
const searchBrief = (base: string, tree: string, r: SearchRelative, lang: string): Brief =>
  compact({
    ref: {
      source: "geneanet" as const,
      id: geneanetRefId(tree, r.index),
      url: personUrl(base, tree, r.index, r.key),
    },
    name: displayName(r.firstname, r.lastname),
    sex: r.sex === "unknown" ? undefined : r.sex,
    born: shortDate(fromDisplayEn(r.birthDate, lang)),
    bornAt: r.birthPlace,
    died: shortDate(fromDisplayEn(r.deathDate, lang)),
    diedAt: r.deathPlace,
  });

export const toSearchHits = (
  base: string,
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
  persons: hits.map((h) =>
    compact({
      ref: {
        source: "geneanet" as const,
        id: geneanetRefId(tree, h.index),
        url: h.path ? `${base}/${h.path}` : personUrl(base, tree, h.index, h.key),
      },
      index: h.index,
      name: displayName(h.firstname, h.lastname),
      sex: h.sex === "unknown" ? undefined : h.sex,
      ...fromLifeSpan(h.dates),
      father: h.father ? searchBrief(base, tree, h.father, lang) : undefined,
      mother: h.mother ? searchBrief(base, tree, h.mother, lang) : undefined,
      spouses: h.spouses.map((s) => searchBrief(base, tree, s, lang)),
    }),
  ),
});
