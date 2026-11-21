import { refKey } from "#/schema/ids";
import type { Brief, Citation, DateValue, Event, Person, Ref } from "#/schema/types";

// GEDCOM 7.0 from shared-shape people (spec "`genealogy_export_gedcom`"). A pure function: the
// caller fetches the people and writes the text to a file.
//
// - One INDI per distinct ref, in input order. No merging across sources: the same person from
//   Geneanet and matchID stays two INDIs, each with its EXID.
// - Family events (anything carrying a spouse, and every `families[].events` entry) go under the
//   FAM only. A FAM is written for a couple with two included members (partners and children),
//   or one included member and family facts; links to people not included get no pointer and
//   are reported in `warnings`, so the file holds no pointer to a record it lacks.
// - 7.0 wants a payload or a substructure on every line: a detail-less event is written `Y`
//   where its tag allows it, and left out (and reported) where it does not.
// - Withheld people keep their name, ids, family links and a NOTE saying why; nothing else. A
//   masked one ("x x", no given name or surname) has no name to keep, so no NAME line.
// - Links to people not included are warned about, except to an unknown "?" partner or parent.

export type GedcomMeta = { date: string /* YYYY-MM-DD */; version: string };

export type GedcomStats = { people: number; families: number; sources: number };

export type GedcomResult = { text: string; stats: GedcomStats; warnings: string[] };

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const INDI_TAGS: Record<string, string> = {
  birth: "BIRT",
  baptism: "BAPM",
  death: "DEAT",
  burial: "BURI",
  occupation: "OCCU",
  residence: "RESI",
};

const FAM_TAGS: Record<string, string> = {
  marriage: "MARR",
  divorce: "DIV",
  engaged: "ENGA",
  "marriage bann": "MARB",
  "marriage contract": "MARC",
  "marriage license": "MARL",
  residence: "RESI",
};

/** Event tags whose payload is `[Y|<NULL>]`: `Y` says the event happened when nothing else does. */
const Y_TAGS = new Set([
  "BIRT",
  "BAPM",
  "DEAT",
  "BURI",
  "MARR",
  "DIV",
  "ENGA",
  "MARB",
  "MARC",
  "MARL",
]);

const PAGE_MAX = 200;

// ── lines ────────────────────────────────────────────────────────────────────

/** One line of a text payload; a payload starting with `@` is written `@@…`. */
const textLine = (level: number, tag: string, payload: string): string =>
  payload
    ? `${level} ${tag} ${payload.startsWith("@") ? `@${payload}` : payload}`
    : `${level} ${tag}`;

/** A text payload line by line: newlines become CONT lines. */
const textLines = (level: number, tag: string, value: string): string[] => {
  const [first = "", ...rest] = value.split(/\r\n|\r|\n/);
  return [textLine(level, tag, first), ...rest.map((l) => textLine(level + 1, "CONT", l))];
};

class Lines {
  readonly list: string[] = [];
  /** A line whose payload is a pointer or a fixed keyword, written as is. */
  raw(level: number, tag: string, payload?: string): void {
    this.list.push(payload ? `${level} ${tag} ${payload}` : `${level} ${tag}`);
  }
  text(level: number, tag: string, value: string): void {
    this.list.push(...textLines(level, tag, value));
  }
}

// ── dates ────────────────────────────────────────────────────────────────────

/** `"1897-04-03"` → `"3 APR 1897"`, `"1897-04"` → `"APR 1897"`, `"1897"` → `"1897"`. */
const gedcomDay = (iso: string): string | undefined => {
  const m = /^(\d{1,4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso);
  if (!m?.[1]) return undefined;
  const year = String(Number(m[1]));
  if (!m[2]) return year;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return undefined;
  if (!m[3]) return `${month} ${year}`;
  const day = Number(m[3]);
  return day >= 1 && day <= 31 ? `${day} ${month} ${year}` : undefined;
};

/** The date in words, as `Brief.born` writes it: "about 1768", "between 1825 and 1875". */
const wording = (d: DateValue): string | undefined => {
  if (d.text) return d.text;
  if (!d.date) return undefined;
  const calendar = d.calendar ? ` (${d.calendar} calendar)` : "";
  switch (d.qualifier) {
    case undefined:
      return `${d.date}${calendar}`;
    case "between":
      return `between ${d.date}${d.dateTo ? ` and ${d.dateTo}` : ""}${calendar}`;
    case "or":
      return `${d.date} or${d.dateTo ? ` ${d.dateTo}` : ""}${calendar}`;
    case "from":
      return `from ${d.date}${d.dateTo ? ` to ${d.dateTo}` : ""}${calendar}`;
    default:
      return `${d.qualifier} ${d.date}${calendar}`;
  }
};

type GedcomDate = { value?: string; phrase?: string; note?: string };

/**
 * A DateValue in 7.0 syntax. `maybe` and `or` have no GEDCOM form: the bare date with the
 * wording as a PHRASE. Text with no date, or a French or Hebrew date, becomes a NOTE: 7.0's DATE
 * payload must be a date. CAL and EST are never written.
 */
const gedcomDate = (d: DateValue | undefined): GedcomDate => {
  if (!d) return {};
  const words = wording(d);
  const asNote = (): GedcomDate => (words ? { note: `Date: ${words}` } : {});
  if (!d.date || d.calendar === "french" || d.calendar === "hebrew") return asNote();
  const day = gedcomDay(d.date);
  const dayTo = d.dateTo === undefined ? undefined : gedcomDay(d.dateTo);
  if (!day || (d.dateTo !== undefined && !dayTo)) return asNote();

  const cal = d.calendar === "julian" ? "JULIAN " : "";
  const from = `${cal}${day}`;
  const to = dayTo && `${cal}${dayTo}`;
  const withText = (value: string): GedcomDate => ({
    value,
    ...(d.text ? { phrase: d.text } : {}),
  });
  switch (d.qualifier) {
    case undefined:
      return withText(from);
    case "about":
      return withText(`ABT ${from}`);
    case "before":
      return withText(`BEF ${from}`);
    case "after":
      return withText(`AFT ${from}`);
    case "between":
      return to ? withText(`BET ${from} AND ${to}`) : { value: from, phrase: words };
    case "from":
      return withText(to ? `FROM ${from} TO ${to}` : `FROM ${from}`);
    case "to":
      return withText(`TO ${from}`);
    case "maybe":
    case "or":
      return { value: from, phrase: words };
  }
};

/** Whether the event has a substructure to write: a date (or its note), a place, a note or a source. */
const hasDetail = (e: Event): boolean => {
  const date = gedcomDate(e.date);
  return Boolean(
    date.value || date.note || e.place?.raw || e.place?.name || e.note || e.citations?.length,
  );
};

/**
 * 7.0: "A structure must have either a non-empty payload or at least 1 substructure." An event
 * with no detail is written `Y` when its tag allows it; a bare RESI, OCCU or EVEN is left out.
 */
const writable = (tag: string, e: Event, payload?: string): boolean =>
  Boolean(payload) || Y_TAGS.has(tag) || hasDetail(e);

/** A family event's tag: its own, or EVEN with a TYPE. */
const famTag = (e: Event): string => FAM_TAGS[e.type] ?? "EVEN";

// ── sources ──────────────────────────────────────────────────────────────────

const treeOf = (ref: Ref): string | undefined => {
  const colon = ref.id.indexOf(":");
  return ref.source === "geneanet" && colon > 0 ? ref.id.slice(0, colon) : undefined;
};

/** A URI naming a source, and for Geneanet the tree: EXID TYPE and the SOUR record's NOTE. */
const sourceUri = (source: Ref["source"], tree?: string): string => {
  switch (source) {
    case "geneanet":
      return tree ? `https://gw.geneanet.org/${tree}` : "https://gw.geneanet.org";
    case "matchid":
      return "https://deces.matchid.io";
    case "geni":
      return "https://www.geni.com";
    case "familysearch":
      return "https://www.familysearch.org";
  }
};

type SourceRecord = { xref: string; title?: string; uri: string };

/** The PAGE of a citation: its acte, else its page, else its text cut to 200 characters. */
const page = (c: Citation): string | undefined => {
  const value = c.acte || c.page || c.text;
  if (!value) return undefined;
  const chars = [...value];
  return chars.length > PAGE_MAX ? `${chars.slice(0, PAGE_MAX - 1).join("")}…` : value;
};

// ── families ─────────────────────────────────────────────────────────────────

/** An event and the person whose record it came from (for its citations' SOUR record). */
type Fact = { event: Event; owner: Ref };

type Couple = {
  partners: string[]; // ref keys, one or two
  children: string[]; // ref keys
  facts: Fact[];
  xref?: string;
};

type Sex = Person["sex"];

/** Two facts are one when type, date and place agree; their citations and notes are pooled. */
const factKey = (e: Event): string => JSON.stringify([e.type, e.date ?? null, e.place ?? null]);

const addFact = (couple: Couple, fact: Fact): void => {
  const same = couple.facts.find((f) => factKey(f.event) === factKey(fact.event));
  if (!same) {
    couple.facts.push({ event: { ...fact.event }, owner: fact.owner });
    return;
  }
  const seen = new Set((same.event.citations ?? []).map((c) => JSON.stringify(c)));
  const extra = (fact.event.citations ?? []).filter((c) => !seen.has(JSON.stringify(c)));
  // The pooled citations take the first fact's owner, which only picks a Geneanet SOUR
  // record's tree: two partners of one couple come from the same tree.
  if (extra.length > 0) same.event.citations = [...(same.event.citations ?? []), ...extra];
  const notes = [same.event.note, fact.event.note].filter((n): n is string => Boolean(n));
  if (notes.length > 0) same.event.note = [...new Set(notes)].join("\n\n");
};

/** The display name of a person the source masks: "x x", not a name. */
const MASK = "x x";

/**
 * `Given /Surname/`, or the display name when neither part is known; nothing for a withheld
 * person behind the mask (an INDI without NAME is valid 7.0, and its NOTE says why).
 */
const nameOf = (p: Person): string | undefined => {
  if (p.given || p.surname)
    return [p.given, p.surname && `/${p.surname}/`].filter(Boolean).join(" ");
  return p.withheld && p.name === MASK ? undefined : p.name;
};

// ── writer ───────────────────────────────────────────────────────────────────

export const writeGedcom = (input: { people: Person[] }, meta: GedcomMeta): GedcomResult => {
  // People: one per ref key, first occurrence wins.
  const people = new Map<string, { person: Person; xref: string }>();
  for (const person of input.people) {
    const key = refKey(person.ref);
    if (!people.has(key)) people.set(key, { person, xref: `@I${people.size + 1}@` });
  }
  const included = (key: string): boolean => people.has(key);

  // Sex of everyone mentioned, the person's own record first, briefs filling the gaps.
  const sexes = new Map<string, Sex>();
  for (const [key, { person }] of people) if (person.sex) sexes.set(key, person.sex);
  const noteSex = (b: Brief): void => {
    const key = refKey(b.ref);
    if (b.sex && !sexes.has(key)) sexes.set(key, b.sex);
  };

  // Links to people not included, per person: ref key → label, in order.
  const skipped = new Map<string, Map<string, string>>();
  const skip = (from: string, to: Brief, relation: string): void => {
    const key = refKey(to.ref);
    // A "? ?" partner or parent (named "?") is nobody: there is no one to have left out.
    if (included(key) || to.name === "?") return;
    const links = skipped.get(from) ?? new Map<string, string>();
    if (!links.has(key)) links.set(key, `${relation} ${to.name}`);
    skipped.set(from, links);
  };

  const couples = new Map<string, Couple>();
  const coupleOf = (a: string, b: string | undefined): Couple => {
    const partners = b === undefined || b === a ? [a] : [a, b].toSorted();
    const key = partners.length === 1 ? `${a}\u0000` : partners.join("\u0000");
    let couple = couples.get(key);
    if (!couple) {
      couple = { partners, children: [], facts: [] };
      couples.set(key, couple);
    }
    return couple;
  };
  const addChild = (couple: Couple, child: string): void => {
    if (!couple.children.includes(child)) couple.children.push(child);
  };

  for (const [key, { person }] of people) {
    const parents = person.parents ?? [];
    parents.forEach(noteSex);
    for (const p of parents) skip(key, p, "parent");
    if (parents.length > 0) {
      const [a, b] = parents.map((p) => refKey(p.ref));
      addChild(coupleOf(a as string, b), key);
    }

    // A withheld person's own record contributes links only, never facts.
    const ownFacts = !person.withheld;
    // A full record lists its family events among its own, each with its spouse, in the
    // record's order; `families[].events` repeats some of them and `addFact` pools those.
    for (const event of person.events) {
      if (!event.with) continue;
      noteSex(event.with);
      skip(key, event.with, "spouse");
      if (ownFacts) addFact(coupleOf(key, refKey(event.with.ref)), { event, owner: person.ref });
    }
    for (const family of person.families ?? []) {
      if (family.spouse) {
        noteSex(family.spouse);
        skip(key, family.spouse, "spouse");
      }
      const couple = coupleOf(key, family.spouse && refKey(family.spouse.ref));
      for (const child of family.children ?? []) {
        noteSex(child);
        skip(key, child, "child");
        addChild(couple, refKey(child.ref));
      }
      if (!ownFacts) continue;
      for (const event of family.events) addFact(couple, { event, owner: person.ref });
    }
  }

  // A child placed under one parent alone also listed under that parent's couple: keep the couple.
  for (const single of couples.values()) {
    if (single.partners.length !== 1) continue;
    const [parent] = single.partners;
    single.children = single.children.filter(
      (child) =>
        ![...couples.values()].some(
          (c) =>
            c.partners.length === 2 &&
            c.partners.includes(parent as string) &&
            c.children.includes(child),
        ),
    );
  }

  // Facts with nothing to write are left out, each counted against the record it came from.
  const emptyEvents = new Map<string, string[]>();
  const leaveOut = (owner: Ref, e: Event): void => {
    const key = refKey(owner);
    emptyEvents.set(key, [...(emptyEvents.get(key) ?? []), e.type]);
  };
  for (const couple of couples.values()) {
    couple.facts = couple.facts.filter((f) => {
      const keep = writable(famTag(f.event), f.event);
      if (!keep) leaveOut(f.owner, f.event);
      return keep;
    });
  }

  // A family is written when it links two included people, or holds facts of an included one
  // (a marriage to someone not in the export keeps its date, place and sources; the absent
  // partner gets no pointer). Xrefs follow the order the families were met.
  const families: Couple[] = [];
  for (const couple of couples.values()) {
    const members = [...couple.partners, ...couple.children].filter(included);
    if (members.length === 0 || (members.length < 2 && couple.facts.length === 0)) continue;
    couple.xref = `@F${families.length + 1}@`;
    families.push(couple);
  }

  const sources = new Map<string, SourceRecord>();
  const sourceXref = (c: Citation, owner: Ref): string => {
    const key = JSON.stringify([c.source, c.title ?? ""]);
    let record = sources.get(key);
    if (!record) {
      const tree = c.source === "geneanet" ? treeOf(owner) : undefined;
      record = { xref: `@S${sources.size + 1}@`, title: c.title, uri: sourceUri(c.source, tree) };
      sources.set(key, record);
    }
    return record.xref;
  };

  const out = new Lines();

  const writeEvent = (level: number, tag: string, fact: Fact, payload?: string): void => {
    const { event } = fact;
    if (payload) out.text(level, tag, payload);
    else out.raw(level, tag, hasDetail(event) ? undefined : "Y");
    if (tag === "EVEN") out.text(level + 1, "TYPE", event.type);
    const date = gedcomDate(event.date);
    if (date.value) {
      out.raw(level + 1, "DATE", date.value);
      if (date.phrase) out.text(level + 2, "PHRASE", date.phrase);
    }
    const place = event.place?.raw || event.place?.name;
    if (place) out.text(level + 1, "PLAC", place);
    if (date.note) out.text(level + 1, "NOTE", date.note);
    if (event.note) out.text(level + 1, "NOTE", event.note);
    for (const c of event.citations ?? []) {
      out.raw(level + 1, "SOUR", sourceXref(c, fact.owner));
      const p = page(c);
      if (p) out.text(level + 2, "PAGE", p);
      if (c.url) out.text(level + 2, "NOTE", c.url);
    }
  };

  // ── HEAD ──
  out.raw(0, "HEAD");
  out.raw(1, "GEDC");
  out.raw(2, "VERS", "7.0");
  out.raw(1, "SOUR", "mcp-genealogy");
  out.text(2, "VERS", meta.version);
  const today = gedcomDay(meta.date);
  if (today) out.raw(1, "DATE", today);

  // ── INDI ──
  for (const [key, { person, xref }] of people) {
    out.raw(0, xref, "INDI");
    const name = nameOf(person);
    if (name) out.text(1, "NAME", name);
    if (!person.withheld) {
      if (person.sex) out.raw(1, "SEX", person.sex === "male" ? "M" : "F");
      const own = person.events.filter((e) => !e.with);
      // One occupation event takes the person's occupation as its text; with several, each is
      // an OCCU of its own date, place and sources, and the occupation is written once apart.
      const occupationEvents = own.filter((e) => e.type === "occupation").length;
      const occupationPayload = occupationEvents === 1 ? person.occupation : undefined;
      for (const event of own) {
        const tag = INDI_TAGS[event.type] ?? "EVEN";
        const payload = tag === "OCCU" ? occupationPayload : undefined;
        if (writable(tag, event, payload))
          writeEvent(1, tag, { event, owner: person.ref }, payload);
        else leaveOut(person.ref, event);
      }
      if (person.occupation && !occupationPayload) out.text(1, "OCCU", person.occupation);
    }
    for (const f of families) if (f.children.includes(key)) out.raw(1, "FAMC", f.xref);
    for (const f of families) if (f.partners.includes(key)) out.raw(1, "FAMS", f.xref);
    out.text(1, "EXID", person.ref.id);
    out.raw(2, "TYPE", sourceUri(person.ref.source, treeOf(person.ref)));
    if (person.withheld) {
      out.text(
        1,
        "NOTE",
        `Withheld by ${person.ref.source}: ${person.withheldReason || "private"}`,
      );
    } else if (person.notes) {
      out.text(1, "NOTE", person.notes);
    }
  }

  // ── FAM ──
  for (const family of families) {
    out.raw(0, family.xref as string, "FAM");
    for (const fact of family.facts) writeEvent(1, famTag(fact.event), fact);
    // HUSB/WIFE by sex; a partner of unknown sex takes the slot the other leaves free.
    const [a, b] = family.partners as [string, string | undefined];
    const sexA = sexes.get(a);
    const sexB = b === undefined ? undefined : sexes.get(b);
    const aIsWife = sexA === "female" || (sexA === undefined && sexB === "male");
    const [husband, wife] = aIsWife ? [b, a] : [a, b];
    if (husband !== undefined && included(husband)) out.raw(1, "HUSB", people.get(husband)?.xref);
    if (wife !== undefined && included(wife)) out.raw(1, "WIFE", people.get(wife)?.xref);
    for (const child of family.children) {
      if (included(child)) out.raw(1, "CHIL", people.get(child)?.xref);
    }
  }

  // ── SOUR ──
  for (const source of sources.values()) {
    out.raw(0, source.xref, "SOUR");
    if (source.title) out.text(1, "TITL", source.title);
    out.text(1, "NOTE", source.uri);
  }
  out.raw(0, "TRLR");

  const warnings = [...people].flatMap(([key, { person }]) => {
    const who = `${person.name} (${key})`;
    const links = [...(skipped.get(key)?.values() ?? [])];
    const empty = emptyEvents.get(key) ?? [];
    return [
      ...(links.length > 0
        ? [
            `${who}: ${links.length === 1 ? "1 link to a person" : `${links.length} links to people`} not in the export left out: ${links.join(", ")}.`,
          ]
        : []),
      ...(empty.length > 0
        ? [
            `${who}: ${empty.length === 1 ? "1 event" : `${empty.length} events`} with no date, place, note or source left out: ${empty.join(", ")}.`,
          ]
        : []),
    ];
  });

  return {
    text: `${out.list.join("\n")}\n`,
    stats: { people: people.size, families: families.length, sources: sources.size },
    warnings,
  };
};
