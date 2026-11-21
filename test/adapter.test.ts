import { describe, expect, it } from "vitest";

import type { Brief, Event, Person, Ref } from "#/schema/types";
import {
  geneanetCitation,
  toBrief,
  toGraph,
  toPerson,
  toSearchHits,
  toSummary,
} from "#/sources/geneanet/adapter";
import {
  decodeGraph,
  decodePerson,
  decodeSearchList,
  type Person as Decoded,
} from "#/sources/geneanet/proto/messages";
import { ProtoMessage, ProtoWriter, unframeResponse } from "#/sources/geneanet/proto/wire";
import { fixture } from "#test/helpers";

const BASE = "https://gw.geneanet.org";
const load = (name: string): ProtoMessage => new ProtoMessage(unframeResponse(fixture(name)));
const decoded = (name: string): Decoded => decodePerson(load(name));

type Rec = Record<string, unknown>;

const byIndex = (list: unknown, index: number): Rec | undefined =>
  (list as Rec[]).find((x) => x.index === index);

const URL_27 = "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=marie+germaine";

const ofType = (events: Event[], type: string): Event | undefined =>
  events.find((e) => e.type === type);

/** The born and died strings of every parent, spouse and child brief in a full record. */
const relativeDates = (file: string, tree: string): (string | undefined)[] => {
  const p = toPerson(BASE, tree, decoded(file), "full");
  const relatives: Brief[] = [
    ...(p.parents ?? []),
    ...(p.families ?? []).flatMap((f) => [...(f.spouse ? [f.spouse] : []), ...(f.children ?? [])]),
  ];
  return relatives.flatMap((b) => [b.born, b.died]);
};

describe("geneanetCitation", () => {
  it("names the tree and keeps the profile URL", () => {
    expect(geneanetCitation("maudrenel1", URL_27, "AD81")).toEqual({
      source: "geneanet",
      title: "Geneanet tree maudrenel1",
      url: URL_27,
      text: "AD81",
    });
    expect(geneanetCitation("maudrenel1", URL_27)).toEqual({
      source: "geneanet",
      title: "Geneanet tree maudrenel1",
      url: URL_27,
    });
  });
});

describe("toPerson full (person-maudrenel1-27.bin)", () => {
  const p = toPerson(BASE, "maudrenel1", decoded("person-maudrenel1-27.bin"), "full");

  it("carries the ref, the name and the Geneanet extras", () => {
    expect(p).toMatchObject({
      ref: { source: "geneanet", id: "maudrenel1:27", url: URL_27 },
      name: "Marie Germaine LOUVIGNES",
      given: "Marie Germaine",
      surname: "LOUVIGNES",
      sex: "female",
      aliases: ["Cécilia"],
      tree: "maudrenel1",
      index: 27,
      directAncestorOfTreeRoot: true,
      detail: "full",
    });
    expect(p.withheld).toBeUndefined();
    // Death type 1 is plainly dead: no status next to the death date.
    expect(p.deathStatus).toBeUndefined();
  });

  it("reads the birth from the raw date, with a split place and the profile as citation", () => {
    expect(ofType(p.events, "birth")).toEqual({
      type: "birth",
      date: { date: "1870-11-22" },
      place: {
        name: "Cahuzac-sur-Vère",
        department: "Tarn",
        region: "Occitanie",
        country: "France",
        raw: "Cahuzac-sur-Vère, Tarn, Occitanie, France",
      },
      note: 'Née au lieu dit "Roziers".',
      citations: [{ source: "geneanet", title: "Geneanet tree maudrenel1", url: URL_27 }],
    });
  });

  it("puts the death in Saint-Étienne, Loire", () => {
    expect(ofType(p.events, "death")).toMatchObject({
      date: { date: "1944-11-16" },
      place: { name: "Saint-Étienne", department: "Loire", region: "Auvergne-Rhône-Alpes" },
    });
  });

  it("keeps the rest of the event list, typed where GeneWeb says so", () => {
    expect(p.events.map((e) => e.type)).toEqual([
      "birth",
      // Unmapped GeneWeb names, lower cased like every type.
      "marriage bann",
      "marriage",
      "recensement",
      "recensement",
      "recensement",
      "recensement",
      "residence",
      "death",
      "validation testament",
    ]);
    expect(ofType(p.events, "marriage")).toMatchObject({
      date: { date: "1893-11-11" },
      place: { name: "Cahuzac-sur-Vère" },
      with: { ref: { id: "maudrenel1:215" }, name: "Jean ROBERT" },
    });
    expect(ofType(p.events, "residence")?.note).toContain("Petites Sœurs des Pauvres");
    for (const e of p.events) expect(e.citations?.[0]?.url).toBe(URL_27);
  });

  it("gives parents as briefs, father first", () => {
    expect(p.parents).toEqual([
      {
        ref: {
          source: "geneanet",
          id: "maudrenel1:55",
          url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=jean+francois+paulin",
        },
        name: "Jean François Paulin LOUVIGNES",
        sex: "male",
        born: "1841-02-13",
        bornAt: "Lisle-sur-Tarn, Tarn, Occitanie, France",
        died: "1907-02-10",
        diedAt: "Cahuzac-sur-Vère, Tarn, Occitanie, France",
      },
      expect.objectContaining({ ref: expect.objectContaining({ id: "maudrenel1:28" }) }),
    ]);
  });

  it("carries each parent's sex, so one known parent is still a father or a mother", () => {
    expect(p.parents?.map((b) => b.sex)).toEqual(["male", "female"]);
  });

  it("lists the union with its marriage event and the children as briefs", () => {
    const [fam] = p.families ?? [];
    expect(fam?.spouse).toMatchObject({ ref: { id: "maudrenel1:215" }, name: "Jean ROBERT" });
    expect(fam?.events).toEqual([
      {
        type: "marriage",
        // From marriage_date_raw (/1893/11/11#), not the display string "Nov. 11, 1893".
        date: { date: "1893-11-11" },
        place: { name: "Cahuzac-sur-Vère" },
        citations: [{ source: "geneanet", title: "Geneanet tree maudrenel1", url: URL_27 }],
      },
    ]);
    expect(fam?.children?.map((c) => c.ref.id)).toEqual([
      "maudrenel1:229",
      "maudrenel1:230",
      "maudrenel1:20",
    ]);
    expect(fam?.childCount).toBeUndefined();
  });

  it("returns the notes as plain text", () => {
    expect(p.notes).toContain("Signe Cécilia Louvignes");
    expect(JSON.stringify(p)).not.toContain("<p>");
  });
});

describe("toPerson summary (person-maudrenel1-27.bin)", () => {
  const d = decoded("person-maudrenel1-27.bin");
  const summary = toPerson(BASE, "maudrenel1", d, "summary");
  const full = toPerson(BASE, "maudrenel1", d, "full");

  it("keeps the vitals only, with no notes, per-event notes or witnesses", () => {
    expect(summary.detail).toBe("summary");
    expect(summary.notes).toBeUndefined();
    expect(summary.events.map((e) => e.type)).toEqual(["birth", "death"]);
    expect(JSON.stringify(summary)).not.toContain('"note"');
    expect(JSON.stringify(summary)).not.toContain('"witnesses"');
    expect(ofType(summary.events, "birth")?.citations?.[0]?.url).toBe(URL_27);
  });

  it("counts children instead of listing them, and keeps the marriage", () => {
    const [fam] = summary.families ?? [];
    expect(fam?.childCount).toBe(3);
    expect(fam?.children).toBeUndefined();
    expect(fam?.events.map((e) => e.type)).toEqual(["marriage"]);
    expect(summary.parents?.map((b) => b.ref.id)).toEqual(["maudrenel1:55", "maudrenel1:28"]);
  });

  it("costs under a third of the full record", () => {
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 3);
  });
});

describe("toSummary", () => {
  // Every captured person: the projection must give exactly what toPerson's summary gives.
  it.each([
    ["maudrenel1", "person-maudrenel1-27.bin"],
    ["maudrenel1", "person-maudrenel1-87-about.bin"],
    ["maudrenel1", "person-maudrenel1-545-before.bin"],
    ["gchene2", "person-gchene2-15894-after.bin"],
    ["gchene2", "person-gchene2-52355-month.bin"],
    ["zzzzzzz", "person-private-masked.bin"],
    ["pmft", "person-pmft-31878-between.bin"],
    ["pmft", "person-pmft-33212-maybe.bin"],
    ["pmft", "person-pmft-9543-julian.bin"],
  ])("cuts the full %s record in %s down to its summary", (tree, name) => {
    const d = decoded(name);
    const summary = toPerson(BASE, tree, d, "summary");
    // Same JSON, key order included: the cached projection reads like a fetched summary.
    expect(JSON.stringify(toSummary(toPerson(BASE, tree, d, "full")))).toBe(
      JSON.stringify(summary),
    );
  });

  it("drops a union whose only content was its note, as a summary does", () => {
    const d = decoded("person-maudrenel1-27.bin");
    const [fam] = d.families;
    const bare = {
      ...d,
      families: [
        {
          ...fam!,
          marriageType: 0,
          marriageDate: undefined,
          marriageDateRaw: undefined,
          marriagePlace: undefined,
          marriageSource: undefined,
          sources: undefined,
          notes: "Mariage religieux seulement.",
        },
      ],
    } as Decoded;
    const full = toPerson(BASE, "maudrenel1", bare, "full");
    expect(full.families?.[0]?.events.map((e) => e.type)).toEqual(["marriage"]);
    expect(toSummary(full)).toEqual(toPerson(BASE, "maudrenel1", bare, "summary"));
  });

  it("leaves a summary as it is", () => {
    const summary = toPerson(BASE, "maudrenel1", decoded("person-maudrenel1-27.bin"), "summary");
    expect(toSummary(summary)).toBe(summary);
  });
});

describe("toPerson on other date forms", () => {
  it("keeps a Julian baptism in its calendar and witnesses with their roles", () => {
    const p = toPerson(BASE, "pmft", decoded("person-pmft-9543-julian.bin"), "full");
    const baptism = ofType(p.events, "baptism");
    expect(baptism?.date).toEqual({ date: "1539-05-29", calendar: "julian" });
    expect(baptism?.witnesses?.map((w) => [w.name, w.role])).toEqual([
      ["Guillaume PIVAN", "godparent"],
      ["Jean HUCHET", "witness"],
      ["Renée Reginalde DELEFAY", "witness"],
    ]);
    expect(baptism?.witnesses?.[0]?.born).toBe("about 1500");
  });

  it("reads a month-only marriage on the family", () => {
    const p = toPerson(BASE, "gchene2", decoded("person-gchene2-52355-month.bin"), "summary");
    expect(p.families?.[0]?.events[0]).toMatchObject({
      type: "marriage",
      date: { date: "1767-11" },
    });
    expect(p.deathStatus).toBe("dead, date unknown");
  });

  it("writes relatives' dates in the short form", () => {
    // Child 9543: raw /1539/6/8#, displayed "05/29/1539 (Julian)".
    expect(relativeDates("person-pmft-33212-maybe.bin", "pmft")).toContain("1539-05-29 (julian)");
    // Father 33212: ?/1557/1/16#.
    expect(relativeDates("person-pmft-9543-julian.bin", "pmft")).toContain("maybe 1557-01-16");
    // Father 15895: >/1813/6/16#; mother 15896: ~/1755/0/0#.
    const dupont = relativeDates("person-gchene2-15894-after.bin", "gchene2");
    expect(dupont).toContain("after 1813-06-16");
    expect(dupont).toContain("about 1755");
  });
});

describe("divorce", () => {
  it("reads divorce_date_raw (Family field 20) into the divorce event's DateValue", () => {
    // No captured family is divorced; the message is built with GeneWeb's field numbers.
    const family = new ProtoWriter()
      .int(1, 3)
      .message(2, new ProtoWriter().int(1, 9).string(3, "ROBERT").string(4, "Jean"))
      .int(10, 1)
      .string(11, "May 3, 1900")
      .string(20, "/1900/5/3#");
    const bytes = new ProtoWriter().int(2, 1).message(45, family).finish();
    const d = decodePerson(new ProtoMessage(bytes));
    expect(d.families[0]?.divorceDateRaw).toBe("/1900/5/3#");
    const p = toPerson(BASE, "t", d, "summary");
    expect(p.families?.[0]?.events).toEqual([
      {
        type: "divorce",
        date: { date: "1900-05-03" },
        citations: [expect.objectContaining({ source: "geneanet" })],
      },
    ]);
  });
});

/**
 * Every string in a raw protobuf message, nested messages included: a length-delimited value
 * is a string when it is UTF-8 without control characters, else a message to walk into.
 */
const protoStrings = (buf: Uint8Array): string[] => {
  const out: string[] = [];
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = buf[pos] as number;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
  };
  while (pos < buf.length) {
    const wire = varint() % 8;
    if (wire === 0) {
      varint();
      continue;
    }
    expect(wire).toBe(2);
    const len = varint();
    const value = buf.subarray(pos, pos + len);
    pos += len;
    let text: string | undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      text = undefined;
    }
    // oxlint-disable-next-line no-control-regex -- control bytes are what tell a message apart.
    if (text !== undefined && !/[\u0000-\u001f]/.test(text)) out.push(text);
    else out.push(...protoStrings(value));
  }
  return out;
};

describe("withheld", () => {
  const hidden = decoded("person-private-masked.bin");

  it("holds no real name, place or tree: the masked fixture is anonymised", () => {
    // Captured from a public tree, then every relative's names, keys and places and the tree
    // name were replaced in place with placeholders of the same byte length (proto/README.md).
    const strings = protoStrings(unframeResponse(fixture("person-private-masked.bin")));
    expect(strings.length).toBeGreaterThan(50);
    const placeholder = /^(|x|zzzzzzz|[A-Da-d][A-Da-d ]*|[Xx0][Xx0 ,-]*|[0-9/#]+)$/;
    expect(strings.filter((s) => !placeholder.test(s))).toEqual([]);
    expect(hidden.father).toMatchObject({ lastname: "AAAAAAA", key: { n: "aaaaaaa" } });
    expect(hidden.mother?.firstname).toBe("Bbbbbbbbb Bbbbb Bbbbb");
    expect(hidden.families[0]?.spouse).toMatchObject({ lastname: "CCCCCCC", firstname: "Ccccccc" });
    // Dates and flags are as captured.
    expect(hidden.father?.birthDateRaw).toBe("/1898/4/5#");
    expect(hidden.families[0]?.children.every((c) => c.hidden)).toBe(true);
  });

  it("gives a masked person and masked relatives an index url, since their key is empty", () => {
    const p = toPerson(BASE, "zzzzzzz", hidden, "full");
    expect(p.ref.url).toBe(`${BASE}/zzzzzzz?lang=en&i=7`);
    expect(p.families?.[0]?.children?.map((c) => c.ref.url)).toEqual(
      [0, 8101, 8102, 8103].map((i) => `${BASE}/zzzzzzz?lang=en&i=${i}`),
    );
    expect(p.parents?.[0]?.ref.url).toBe(`${BASE}/zzzzzzz?lang=en&n=aaaaaaa&p=aaaa+aaaaaa+aaaaa`);
  });

  it("marks a person Geneanet masks as private, with the reason (person-private-masked.bin)", () => {
    const p = toPerson(BASE, "zzzzzzz", hidden, "full");
    expect(p).toMatchObject({ name: "x x", withheld: "private" });
    expect(p.given).toBeUndefined();
    expect(p.withheldReason).toBe(
      'Geneanet hides this person from visitors: the record comes back as "x x", with no names, dates or events of its own.',
    );
    expect(p.events).toEqual([]);
    // Its children are masked too; its parents and spouse are not.
    const [fam] = p.families ?? [];
    expect(fam?.spouse?.withheld).toBeUndefined();
    expect(fam?.children?.map((c) => c.withheld)).toEqual([
      "private",
      "private",
      "private",
      "private",
    ]);
    expect(p.parents?.every((b) => b.withheld === undefined)).toBe(true);
  });

  it("marks a name-only record the source flags as private too", () => {
    const p = toPerson(BASE, "zzzzzzz", { ...hidden, hidden: false, restricted: true }, "full");
    expect(p.withheld).toBe("private");
    expect(p.withheldReason).toMatch(/name only/);
  });

  it("infers probably-private for an empty record with no flag, alive or unknown", () => {
    const bare = { ...hidden, hidden: false, restricted: false };
    for (const type of [0, 4]) {
      const p = toPerson(BASE, "zzzzzzz", { ...bare, death: { type } }, "summary");
      expect(p.withheld).toBe("probably-private");
      expect(p.withheldReason).toBe(
        "Geneanet returned the name only; the tree hides living or private people from visitors (inferred: the record itself does not say).",
      );
    }
    const dead = toPerson(BASE, "zzzzzzz", { ...bare, death: { type: 1 } }, "summary");
    expect(dead.withheld).toBeUndefined();
  });

  it("leaves a public record alone", () => {
    const p: Person = toPerson(
      BASE,
      "maudrenel1",
      decoded("person-maudrenel1-87-about.bin"),
      "full",
    );
    expect(p.withheld).toBeUndefined();
    expect(p.withheldReason).toBeUndefined();
  });

  it("flags a name-only relative's brief as private too", () => {
    // No fixture holds a relative with field 22 alone (the name-only capture was not kept).
    const brief = toBrief(BASE, "t", {
      index: 1,
      sex: "female",
      lastname: "DOE",
      firstname: "Jane",
      key: { n: "doe", p: "jane", oc: 0 },
      hidden: false,
      restricted: true,
    });
    expect(brief).toMatchObject({ name: "Jane DOE", sex: "female", withheld: "private" });
    expect(brief.born).toBeUndefined();
  });

  it("flags a hidden relative's brief", () => {
    const child = hidden.families[0]?.children[0];
    expect(child && toBrief(BASE, "zzzzzzz", child)).toMatchObject({
      ref: { source: "geneanet", id: "zzzzzzz:0" },
      name: "x x",
      withheld: "private",
    });
  });
});

describe("toGraph (graph-maudrenel1-27.bin: 2 generations up, 1 down)", () => {
  const g = toGraph(BASE, "maudrenel1", decodeGraph(load("graph-maudrenel1-27.bin")));

  it("puts the parents on the root", () => {
    expect(g.root).toMatchObject({
      ref: { source: "geneanet", id: "maudrenel1:27", url: URL_27 },
      index: 27,
      born: "1870",
      died: "1944",
      fatherIndex: 55,
      motherIndex: 28,
    });
  });

  it("gives every node a ref and life years, and no display dates", () => {
    const nodes = [
      g.root,
      ...(g.ancestors as Rec[]),
      ...(g.descendants as Rec[]),
      ...(g.siblings as Rec[]),
    ] as Rec[];
    // The root, 6 ancestors, the spouse and 3 children, 1 sibling.
    expect(nodes).toHaveLength(12);
    for (const n of nodes) {
      const ref = n.ref as Ref;
      expect(ref.id).toMatch(/^maudrenel1:\d+$/);
      expect(ref.id).toBe(`maudrenel1:${String(n.index)}`);
      expect(ref.url).toMatch(/^https:\/\/gw\.geneanet\.org\/maudrenel1\?lang=en&n=/);
      expect(n.dates).toBeUndefined();
      expect(n.withheld).toBeUndefined();
    }
    // "1809-": a birth year alone.
    expect(byIndex(g.ancestors, 86)).toMatchObject({ born: "1809" });
    expect(byIndex(g.ancestors, 86)?.died).toBeUndefined();
  });

  it("resolves ancestors to generations with father and mother indexes", () => {
    expect(byIndex(g.ancestors, 55)).toMatchObject({
      generation: 1,
      name: "Jean François Paulin LOUVIGNES",
      born: "1841",
      died: "1907",
      fatherIndex: 85,
      motherIndex: 86,
    });
    expect(byIndex(g.ancestors, 29)).toMatchObject({ generation: 2, sex: "male" });
    expect((g.ancestors as Rec[]).length).toBe(6);
  });

  it("tells the spouse from the children by couples, not order", () => {
    expect(byIndex(g.descendants, 215)).toMatchObject({
      relation: "spouse",
      spouseOfIndexes: [27],
      generation: 0,
    });
    for (const child of [229, 230, 20]) {
      expect(byIndex(g.descendants, child)).toMatchObject({
        relation: "child",
        generation: 1,
        parentIndexes: expect.arrayContaining([27, 215]),
      });
    }
  });

  it("lists siblings, and leaks no node ids or edges", () => {
    expect((g.siblings as Rec[]).map((s) => s.index)).toEqual([1357]);
    const text = JSON.stringify(g);
    expect(text).not.toContain("221708822");
    expect(text).not.toContain("edges");
  });

  it("reports an empty graph as not found", () => {
    expect(
      toGraph(BASE, "t", {
        ancestors: [],
        ancestorEdges: [],
        descendants: [],
        descendantEdges: [],
        siblings: [],
      }),
    ).toEqual({ tree: "t", found: false });
  });
});

describe("toSearchHits", () => {
  it("reads Geneanet's search records with parents and spouses", () => {
    const res = toSearchHits(
      BASE,
      "maudrenel1",
      decodeSearchList(load("search-maudrenel1-louvignes.bin")),
    );
    const guilhaume = (res.persons as Rec[]).find((p) => p.index === 85);
    expect(guilhaume).toMatchObject({
      ref: {
        source: "geneanet",
        id: "maudrenel1:85",
        url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=guilhaume",
      },
      name: "Guilhaume LOUVIGNES",
      born: "1797",
      died: "1870",
      mother: { ref: { id: "maudrenel1:88" }, name: "Jeanne SICARD", sex: "female" },
      spouses: [{ ref: { id: "maudrenel1:86" }, name: "Antoinette BRASSIE", born: "1809-02-02" }],
    });
    expect(guilhaume?.father).toEqual({
      ref: {
        source: "geneanet",
        id: "maudrenel1:87",
        url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=jean+guilhaume",
      },
      name: "Jean Guilhaume LOUVIGNES",
      sex: "male",
      born: "about 1768",
      // "11/24/1818" on the en site is month/day/year.
      died: "1818-11-24",
      diedAt: "Gaillac, Tarn, Occitanie, France",
    });
    expect(guilhaume?.url).toBeUndefined();
    expect(guilhaume?.dates).toBeUndefined();
  });

  it("splits each person's life years like a tree node's", () => {
    const res = toSearchHits(
      BASE,
      "maudrenel1",
      decodeSearchList(load("search-maudrenel1-louvignes.bin")),
    );
    const of = (index: number) => (res.persons as Rec[]).find((p) => p.index === index);
    expect(of(87)).toMatchObject({ born: "about 1768", died: "1818" });
    expect(of(545)).toMatchObject({ died: "before 1791" });
    expect(of(545)?.born).toBeUndefined();
  });

  it("leaves another language's numeric dates as the site wrote them", () => {
    const res = toSearchHits(
      BASE,
      "maudrenel1",
      decodeSearchList(load("search-maudrenel1-louvignes.bin")),
      "fr",
    );
    const guilhaume = (res.persons as Rec[]).find((p) => p.index === 85);
    expect(guilhaume?.father).toMatchObject({ died: "11/24/1818" });
  });

  it("returns accented names as sent (the request framing carries UTF-8)", () => {
    const res = toSearchHits(
      BASE,
      "bcampedel",
      decodeSearchList(load("search-bcampedel-jerome.bin")),
    );
    expect((res.persons as Rec[])[0]).toMatchObject({
      name: "Jérôme LOUVIGNES",
      // The site's own path keeps the occurrence the key would have to rebuild.
      ref: {
        id: "bcampedel:378",
        url: "https://gw.geneanet.org/bcampedel?lang=en&n=louvignes&oc=1&p=jerome",
      },
    });
  });
});

const person = (index: number, sex: "male" | "female", hidden = false) => ({
  id: index,
  person: {
    index,
    sex,
    lastname: "X",
    firstname: String(index),
    key: { n: "x", p: String(index), oc: 0 },
    sosa: 2,
    hidden,
  },
});

const graph = (
  nodes: number[],
  sexes: Record<number, "male" | "female">,
  edges: [number, number][],
) =>
  toGraph(BASE, "t", {
    ancestors: [person(1, sexes[1] ?? "male")],
    ancestorEdges: [],
    descendants: nodes.map((i) => person(i, sexes[i] ?? "male")),
    descendantEdges: edges.map(([from, to]) => ({ from, to })),
    siblings: [],
  });

describe("toGraph descendant roles on awkward families", () => {
  // Built the way upstream build_graph_desc_v2 builds them: person -> spouse
  // once per family, both partners -> each child. Node id = person here.

  it("keeps a spouse who is in two families with the root a spouse", () => {
    // 1 married 2 twice; one child per family (3, 4).
    const g = graph([1, 2, 3, 4], { 2: "female" }, [
      [1, 2],
      [1, 3],
      [2, 3],
      [1, 2],
      [1, 4],
      [2, 4],
    ]);
    expect(byIndex(g.descendants, 2)).toMatchObject({
      relation: "spouse",
      generation: 0,
      spouseOfIndexes: [1],
    });
    expect(byIndex(g.descendants, 3)).toMatchObject({ relation: "child", generation: 1 });
    expect(byIndex(g.descendants, 4)).toMatchObject({ relation: "child", generation: 1 });
  });

  it("gives a cousin marriage both roles, at the right generation", () => {
    // 1+2 have children 3 and 4; 3+5 have 6, 4+7 have 8; cousins 6 and 8 marry.
    const g = graph([1, 2, 3, 4, 5, 6, 7, 8], { 2: "female", 5: "female", 8: "female" }, [
      [1, 2],
      [1, 3],
      [2, 3],
      [1, 4],
      [2, 4],
      [3, 5],
      [3, 6],
      [5, 6],
      [4, 7],
      [4, 8],
      [7, 8],
      [6, 8],
    ]);
    expect(byIndex(g.descendants, 8)).toMatchObject({
      relation: "child",
      generation: 2,
      parentIndexes: expect.arrayContaining([4, 7]),
      spouseOfIndexes: [6],
    });
    expect(byIndex(g.descendants, 6)).toMatchObject({ relation: "child", generation: 2 });
  });

  it("counts nodes it could not place instead of dropping them silently", () => {
    // 9 claims two linked parents that are not in the graph.
    const g = graph([1, 9], {}, [
      [1, 9],
      [5, 6],
      [5, 9],
      [6, 9],
    ]);
    expect(String(g.unplacedDescendants)).toContain("1 descendant");
  });
});

describe("toGraph withheld", () => {
  it("marks a node the tree hides as withheld: private", () => {
    // No graph fixture holds a hidden node; the flag is decoded from fields 13/14.
    const g = toGraph(BASE, "t", {
      ancestors: [person(1, "male"), person(2, "female", true)],
      ancestorEdges: [{ from: 1, to: 2 }],
      descendants: [],
      descendantEdges: [],
      siblings: [],
    });
    expect(byIndex(g.ancestors, 2)).toMatchObject({
      ref: { source: "geneanet", id: "t:2" },
      withheld: "private",
    });
    expect(byIndex(g.ancestors, 2)?.private).toBeUndefined();
    expect((g.root as Rec).withheld).toBeUndefined();
  });
});
