// Request encoders and response decoders for the GeneWeb messages the tools
// use. Field numbers are Geneanet's (see proto/README.md for where they differ
// from upstream GeneWeb), checked against the real responses in
// test/fixtures/*.bin. Decoders return every field the tools might show; the
// shaping layer (sources/geneanet/shape.ts) decides what reaches the model.

import { ProtoMessage, ProtoWriter } from "#/sources/geneanet/proto/wire";

export type Sex = "male" | "female" | "unknown";

const SEX: Record<number, Sex> = { 0: "male", 1: "female", 2: "unknown" };
const sexOf = (value: number | undefined): Sex => SEX[value ?? 2] ?? "unknown";

/** GeneWeb's person key: lower-cased surname, first names, and occurrence number. */
export type PersonKey = { n: string; p: string; oc: number };

// ── Requests ─────────────────────────────────────────────────────────────────

/** `IdentifierPerson`: an internal index, or the n/p/oc key. */
export type PersonRef = { index: number } | PersonKey;

const identifierPerson = (ref: PersonRef): ProtoWriter => {
  const w = new ProtoWriter();
  if ("index" in ref) return w.int(1, ref.index);
  return w.string(2, ref.n).string(3, ref.p).int(4, ref.oc);
};

/** `IndexPerson`, the `person` operation's request. */
export const encodePersonRequest = (opts: {
  index: number;
  eventsLimit: number;
  witnessedEventsLimit: number;
}): Uint8Array =>
  new ProtoWriter()
    .int(1, opts.index)
    .int(3, opts.eventsLimit)
    .int(4, opts.witnessedEventsLimit)
    .finish();

/**
 * `GraphTreeParams`, the `graph_v2` operation's request. GeneWeb counts the root
 * as a generation: `nb_asc: 1` returns the person alone, `nb_asc: 3` adds
 * parents and grandparents. Callers pass generations BEYOND the root.
 */
export const encodeGraphRequest = (opts: {
  person: PersonRef;
  ancestorGenerations: number;
  descendantGenerations: number;
}): Uint8Array =>
  new ProtoWriter()
    .message(1, identifierPerson(opts.person))
    .int(2, opts.ancestorGenerations + 1)
    .int(3, opts.descendantGenerations + 1)
    .finish();

/** `PersonSearchListParams`, the `person_search_list` operation's request. */
export const encodeSearchRequest = (opts: {
  lastname?: string;
  firstname?: string;
  limit: number;
}): Uint8Array =>
  new ProtoWriter().string(1, opts.lastname).string(2, opts.firstname).int(3, opts.limit).finish();

// ── Shared ───────────────────────────────────────────────────────────────────

/** The `Error` message: GeneWeb answers a failed call with fields 998/999 only. */
export const decodeApiError = (m: ProtoMessage): { code: number; message?: string } | undefined =>
  m.has(998)
    ? { code: m.int(998) ?? 0, ...(m.string(999) ? { message: m.string(999) as string } : {}) }
    : undefined;

/** `SimplePerson`: the summary GeneWeb attaches for parents, spouses and children. */
export type SimplePerson = {
  index: number;
  sex: Sex;
  lastname: string;
  firstname: string;
  key: PersonKey;
  birthDate?: string;
  birthDateRaw?: string;
  birthPlace?: string;
  deathDate?: string;
  deathDateRaw?: string;
  deathPlace?: string;
  sosa?: string;
  /** Shown as "x x" (field 23 or 24). */
  hidden: boolean;
  /** Name shown, details withheld from visitors (field 22; set for "x x" people too). */
  restricted: boolean;
};

const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined || value === "" ? {} : { [key]: value }) as { [P in K]?: V };

export const decodeSimplePerson = (m: ProtoMessage): SimplePerson => ({
  index: m.int(1) ?? -1,
  sex: sexOf(m.int(2)),
  lastname: m.string(3) ?? "",
  firstname: m.string(4) ?? "",
  key: { n: m.string(5) ?? "", p: m.string(6) ?? "", oc: m.int(7) ?? 0 },
  ...opt("birthDate", m.string(8)),
  ...opt("birthPlace", m.string(9)),
  ...opt("deathDate", m.string(10)),
  ...opt("deathPlace", m.string(11)),
  ...opt("birthDateRaw", m.string(15)),
  ...opt("deathDateRaw", m.string(16)),
  ...opt("sosa", m.string(17)),
  hidden: m.bool(23) === true || m.bool(24) === true,
  restricted: m.bool(22) === true,
});

// ── person ───────────────────────────────────────────────────────────────────

export type Event = {
  name: string;
  /** EventType: 0 birth, 1 baptism, 2 death, 3 burial, 100 marriage, … (api_saisie_read.proto). */
  type: number;
  date?: string;
  dateRaw?: string;
  place?: string;
  reason?: string;
  note?: string;
  source?: string;
  spouse?: SimplePerson;
  witnesses: { role: number; person: SimplePerson; note?: string }[];
};

const decodeEvent = (m: ProtoMessage): Event => ({
  name: m.string(1) ?? "",
  type: m.int(2) ?? -1,
  ...opt("date", m.string(3)),
  ...opt("place", m.string(7)),
  ...opt("reason", m.string(8)),
  ...opt("note", m.string(9)),
  ...opt("source", m.string(10)),
  ...opt("dateRaw", m.string(13)),
  ...(m.message(11) ? { spouse: decodeSimplePerson(m.message(11) as ProtoMessage) } : {}),
  witnesses: m.messages(12).map((w) => ({
    role: w.int(1) ?? 0,
    person: decodeSimplePerson(w.message(2) ?? new ProtoMessage(new Uint8Array())),
    ...opt("note", w.string(3)),
  })),
});

export type Family = {
  index: number;
  spouse: SimplePerson;
  marriageDate?: string;
  marriageDateRaw?: string;
  marriagePlace?: string;
  marriageSource?: string;
  marriageType: number;
  divorceType: number;
  divorceDate?: string;
  divorceDateRaw?: string;
  notes?: string;
  sources?: string;
  children: SimplePerson[];
};

const decodeFamily = (m: ProtoMessage): Family => ({
  index: m.int(1) ?? -1,
  spouse: decodeSimplePerson(m.message(2) ?? new ProtoMessage(new Uint8Array())),
  ...opt("marriageDate", m.string(3)),
  ...opt("marriagePlace", m.string(7)),
  ...opt("marriageSource", m.string(8)),
  marriageType: m.int(9) ?? 0,
  divorceType: m.int(10) ?? 0,
  ...opt("divorceDate", m.string(11)),
  ...opt("divorceDateRaw", m.string(20)),
  ...opt("notes", m.string(16)),
  ...opt("sources", m.string(17)),
  ...opt("marriageDateRaw", m.string(19)),
  children: m.messages(18).map(decodeSimplePerson),
});

/** `SaisieRead.Person`, the `person` operation's answer. */
export type Person = {
  index: number;
  sex: Sex;
  lastname: string;
  firstname: string;
  key: PersonKey;
  publicName?: string;
  aliases: string[];
  qualifiers: string[];
  firstnameAliases: string[];
  surnameAliases: string[];
  birth: { date?: string; place?: string; source?: string };
  baptism: { date?: string; place?: string; source?: string };
  death: { date?: string; place?: string; source?: string; type: number };
  burial: { date?: string; place?: string; source?: string };
  occupation?: string;
  notes?: string;
  sources?: string;
  titles: string[];
  father?: SimplePerson;
  mother?: SimplePerson;
  families: Family[];
  events: Event[];
  eventsTotal: number;
  sosa: number;
  /** Shown to visitors as "x x" with nothing else (field 51; 52 by analogy with SimplePerson 24). */
  hidden: boolean;
  /** Name shown, details withheld from visitors (field 50). See proto/README.md. */
  restricted: boolean;
};

const place = (
  m: ProtoMessage,
  date: number,
  where: number,
  src: number,
): { date?: string; place?: string; source?: string } => ({
  ...opt("date", m.string(date)),
  ...opt("place", m.string(where)),
  ...opt("source", m.string(src)),
});

export const decodePerson = (m: ProtoMessage): Person => {
  const events = m.message(47);
  return {
    index: m.int(2) ?? -1,
    sex: sexOf(m.int(3)),
    lastname: m.string(4) ?? "",
    firstname: m.string(5) ?? "",
    key: { n: m.string(6) ?? "", p: m.string(7) ?? "", oc: m.int(8) ?? 0 },
    ...opt("publicName", m.string(9)),
    aliases: m.strings(10),
    qualifiers: m.strings(11),
    firstnameAliases: m.strings(12),
    surnameAliases: m.strings(13),
    birth: place(m, 15, 18, 19),
    baptism: place(m, 20, 23, 24),
    death: { ...place(m, 25, 28, 29), type: m.int(30) ?? 4 },
    burial: place(m, 31, 34, 35),
    ...opt("occupation", m.string(36)),
    ...opt("notes", m.string(37)),
    ...opt("sources", m.string(38)),
    titles: m.strings(40),
    ...(m.message(43) ? { father: decodeSimplePerson(m.message(43) as ProtoMessage) } : {}),
    ...(m.message(44) ? { mother: decodeSimplePerson(m.message(44) as ProtoMessage) } : {}),
    families: m.messages(45).map(decodeFamily),
    events: events ? events.messages(1).map(decodeEvent) : [],
    eventsTotal: events?.int(3) ?? 0,
    sosa: m.int(46) ?? 2,
    hidden: m.bool(51) === true || m.bool(52) === true,
    restricted: m.bool(50) === true,
  };
};

// ── graph_v2 ─────────────────────────────────────────────────────────────────

/** `PersonTree`: the light record on every graph node. */
export type TreePerson = {
  index: number;
  sex: Sex;
  lastname: string;
  firstname: string;
  key: PersonKey;
  dates?: string;
  sosa: number;
  hidden: boolean;
};

export type GraphNode = { id: number; person: TreePerson; ifam?: number };
export type GraphEdge = { from: number; to: number };

export type Graph = {
  ancestors: GraphNode[];
  ancestorEdges: GraphEdge[];
  descendants: GraphNode[];
  descendantEdges: GraphEdge[];
  siblings: GraphNode[];
};

const decodeTreePerson = (m: ProtoMessage): TreePerson => ({
  index: m.int(1) ?? -1,
  sex: sexOf(m.int(2)),
  lastname: m.string(3) ?? "",
  firstname: m.string(4) ?? "",
  key: { n: m.string(5) ?? "", p: m.string(6) ?? "", oc: m.int(7) ?? 0 },
  ...opt("dates", m.string(8)),
  sosa: m.int(10) ?? 2,
  hidden: m.bool(13) === true || m.bool(14) === true,
});

const decodeNode = (m: ProtoMessage): GraphNode => ({
  id: m.int(1) ?? 0,
  person: decodeTreePerson(m.message(2) ?? new ProtoMessage(new Uint8Array())),
  ...opt("ifam", m.int(3)),
});

const decodeEdge = (m: ProtoMessage): GraphEdge => ({ from: m.int(1) ?? 0, to: m.int(2) ?? 0 });

/** `GraphTree`, the `graph_v2` operation's answer. */
export const decodeGraph = (m: ProtoMessage): Graph => ({
  ancestors: m.messages(1).map(decodeNode),
  ancestorEdges: m.messages(2).map(decodeEdge),
  descendants: m.messages(3).map(decodeNode),
  descendantEdges: m.messages(4).map(decodeEdge),
  // 5 is every sibling; 6 and 7 are the same people split by birth order.
  siblings: m.messages(5).map(decodeNode),
});

// ── person_search_list ───────────────────────────────────────────────────────

export type SearchRelative = {
  index: number;
  sex: Sex;
  lastname: string;
  firstname: string;
  key?: PersonKey;
  birthDate?: string;
  birthPlace?: string;
  deathDate?: string;
  deathPlace?: string;
};

export type SearchHit = {
  index: number;
  sex: Sex;
  lastname: string;
  firstname: string;
  dates?: string;
  key: PersonKey;
  spouses: SearchRelative[];
  father?: SearchRelative;
  mother?: SearchRelative;
  /** The profile's query string, e.g. `maudrenel1?lang=en&n=louvignes&p=guilhaume`. */
  path?: string;
};

const decodeKey = (m: ProtoMessage | undefined): PersonKey | undefined =>
  m ? { n: m.string(1) ?? "", p: m.string(2) ?? "", oc: m.int(3) ?? 0 } : undefined;

const decodeRelative = (m: ProtoMessage): SearchRelative => {
  const key = decodeKey(m.message(11));
  return {
    index: m.int(1) ?? -1,
    sex: sexOf(m.int(2)),
    lastname: m.string(3) ?? "",
    firstname: m.string(4) ?? "",
    ...(key ? { key } : {}),
    ...opt("birthDate", m.string(5)),
    ...opt("birthPlace", m.string(6)),
    ...opt("deathDate", m.string(7)),
    ...opt("deathPlace", m.string(8)),
  };
};

/** Geneanet's `PersonSearchList`; see proto/README.md for how it differs from upstream. */
export const decodeSearchList = (m: ProtoMessage): SearchHit[] =>
  m.messages(1).map((hit) => ({
    index: hit.int(1) ?? -1,
    sex: sexOf(hit.int(2)),
    lastname: hit.string(3) ?? "",
    firstname: hit.string(4) ?? "",
    ...opt("dates", hit.string(5)),
    key: decodeKey(hit.message(11)) ?? { n: "", p: "", oc: 0 },
    spouses: hit.messages(8).flatMap((fam) => {
      const spouse = fam.message(1);
      return spouse ? [decodeRelative(spouse)] : [];
    }),
    ...(hit.message(12) ? { father: decodeRelative(hit.message(12) as ProtoMessage) } : {}),
    ...(hit.message(13) ? { mother: decodeRelative(hit.message(13) as ProtoMessage) } : {}),
    ...opt("path", hit.string(14)),
  }));
