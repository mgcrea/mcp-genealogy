import { describe, expect, it } from "vitest";

import { writeGedcom } from "#/gedcom/write";
import type { Brief, Citation, DateValue, Event, Person, Ref } from "#/schema/types";
import { toPerson } from "#/sources/geneanet/adapter";
import { decodePerson } from "#/sources/geneanet/proto/messages";
import { ProtoMessage, unframeResponse } from "#/sources/geneanet/proto/wire";
import { fixture, fixtureText } from "#test/helpers";

const META = { date: "2026-11-21", version: "1.2.3" };
const BASE = "https://gw.geneanet.org";

const write = (people: Person[]) => writeGedcom({ people }, META);

const geneanetRef = (tree: string, index: number, slug = `p${index}`): Ref => ({
  source: "geneanet",
  id: `${tree}:${index}`,
  url: `${BASE}/${tree}?lang=en&${slug}`,
});

/** A person as a minimal record: ref, name, sex and a birth from a brief's `born`. */
const fromBrief = (b: Brief): Person => ({
  ref: b.ref,
  name: b.name,
  ...(b.sex ? { sex: b.sex } : {}),
  events: b.born ? [{ type: "birth", date: { date: b.born } }] : [],
  detail: "summary",
});

const person = (index: number, extra: Partial<Person> = {}): Person => ({
  ref: geneanetRef("t", index),
  name: `Person ${index}`,
  events: [],
  detail: "summary",
  ...extra,
});

const cite = (acte: string): Citation[] => [{ source: "geneanet", title: "T", acte }];

const brief = (p: Person): Brief => ({
  ref: p.ref,
  name: p.name,
  ...(p.sex ? { sex: p.sex } : {}),
});

/** A "? ?" relative, as the adapter names an unknown partner or parent. */
const unknown = (index: number): Brief => ({ ref: geneanetRef("t", index), name: "?" });

/** The lines of the record whose level-0 line is `head`, that line included. */
const record = (text: string, head: string): string[] => {
  const lines = text.split("\n");
  const start = lines.indexOf(head);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("0 "));
  return lines.slice(start, end);
};

/** Every pointer in the file names a record the file holds. */
const expectNoDanglingPointer = (text: string): void => {
  const defined = new Set([...text.matchAll(/^0 (@[A-Z]\d+@)/gm)].map((m) => m[1]));
  const used = [...text.matchAll(/^[1-9] [A-Z]+ (@[A-Z]\d+@)$/gm)].map((m) => m[1]);
  expect(used.length).toBeGreaterThan(0);
  for (const xref of used) expect(defined.has(xref)).toBe(true);
};

/** The DATE line and what follows it for a person with one birth dated `date`. */
const birthDate = (date: DateValue): string[] => {
  const lines = record(
    write([person(1, { events: [{ type: "birth", date }] })]).text,
    "0 @I1@ INDI",
  );
  const birt = lines.indexOf("1 BIRT");
  const next = lines.findIndex((l, i) => i > birt && l.startsWith("1 "));
  return lines.slice(birt + 1, next);
};

describe("writeGedcom goldens", () => {
  it("one-person.ged: the maudrenel1:27 record with its two parents and her marriage", () => {
    const marie = toPerson(
      BASE,
      "maudrenel1",
      decodePerson(new ProtoMessage(unframeResponse(fixture("person-maudrenel1-27.bin")))),
      "full",
    );
    const parents = (marie.parents ?? []).map(fromBrief);
    expect(parents).toHaveLength(2);

    const out = write([marie, ...parents]);
    expect(out.text).toBe(fixtureText("gedcom/one-person.ged"));
    // Her parents' family, and her marriage to Jean ROBERT kept with her alone in it.
    expect(out.stats).toEqual({ people: 3, families: 2, sources: 1 });
    expectNoDanglingPointer(out.text);
    // Her husband and three children are not in the export: one aggregate line.
    expect(out.warnings).toEqual([
      "4 links to people not in the export left out: 3 child, 1 spouse.",
    ]);
  });

  it("mixed-sources.ged: the same Georges from Geneanet and matchID stays two people", () => {
    const geneanet: Person = {
      ref: {
        source: "geneanet",
        id: "rlouvignes:1204",
        url: "https://gw.geneanet.org/rlouvignes?lang=en&n=louvignes&p=georges",
      },
      name: "Georges LOUVIGNES",
      given: "Georges",
      surname: "LOUVIGNES",
      sex: "male",
      events: [
        {
          type: "birth",
          date: { date: "1929", qualifier: "about" },
          citations: [
            {
              source: "geneanet",
              title: "Geneanet tree rlouvignes",
              url: "https://gw.geneanet.org/rlouvignes?lang=en&n=louvignes&p=georges",
            },
          ],
        },
      ],
      detail: "summary",
    };
    const insee: Citation = {
      source: "matchid",
      title: "INSEE, fichier des personnes décédées 2009",
      acte: "03",
      text: "line 71182",
      url: "https://deces.matchid.io/id/qlOMgl94qBBi",
    };
    const matchid: Person = {
      ref: {
        source: "matchid",
        id: "qlOMgl94qBBi",
        url: "https://deces.matchid.io/id/qlOMgl94qBBi",
      },
      name: "Georges LOUVIGNES",
      given: "Georges",
      surname: "LOUVIGNES",
      sex: "male",
      events: [
        {
          type: "birth",
          date: { date: "1929-10-22" },
          place: { name: "Beauvais-sur-Tescou", insee: "81024" },
          citations: [insee],
        },
        {
          type: "death",
          date: { date: "2009-01-25" },
          place: { name: "Lafrançaise" },
          citations: [insee],
        },
      ],
      detail: "summary",
    };

    const out = write([geneanet, matchid]);
    expect(out.text).toBe(fixtureText("gedcom/mixed-sources.ged"));
    expect(out.stats).toEqual({ people: 2, families: 0, sources: 2 });
    expect(out.warnings).toEqual([]);
  });
});

describe("writeGedcom file shape", () => {
  it("is LF-only UTF-8 text without a BOM, from HEAD to TRLR", () => {
    const { text } = write([person(1)]);
    expect(
      text.startsWith("0 HEAD\n1 GEDC\n2 VERS 7.0\n1 SOUR mcp-genealogy\n2 VERS 1.2.3\n"),
    ).toBe(true);
    expect(text).toContain("\n1 DATE 21 NOV 2026\n");
    expect(text.endsWith("\n0 TRLR\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).not.toMatch(/PLAC\n2 FORM|\bCAL\b|\bEST\b/);
  });

  it("writes the same ref once", () => {
    const out = write([person(1), person(1, { name: "Again" })]);
    expect(out.stats.people).toBe(1);
    expect(out.text).not.toContain("@I2@");
  });
});

describe("writeGedcom families", () => {
  it("links a child to an included parent and warns about the other, with no dangling pointer", () => {
    const father = person(1, { name: "Father", sex: "male" });
    const mother = person(2, { name: "Mother", sex: "female" });
    const child = person(3, { name: "Child", parents: [brief(father), brief(mother)] });

    const out = write([child, father]);
    expect(record(out.text, "0 @F1@ FAM")).toEqual(["0 @F1@ FAM", "1 HUSB @I2@", "1 CHIL @I1@"]);
    expect(out.warnings).toEqual(["1 link to a person not in the export left out: 1 parent."]);
    expectNoDanglingPointer(out.text);
  });

  it("keeps a marriage to a spouse not included, with no pointer to the spouse", () => {
    const wife = person(1, { sex: "female" });
    const husband = person(2, { name: "Husband", sex: "male" });
    const other = person(3, { name: "Other", sex: "male" });
    const marriage: Event = {
      type: "marriage",
      date: { date: "1893-11-11" },
      place: { name: "Cahuzac-sur-Vère" },
      citations: cite("12"),
    };
    const out = write([
      {
        ...wife,
        families: [
          { spouse: brief(husband), events: [marriage] },
          // No facts and no included child: nothing to keep.
          { spouse: brief(other), events: [] },
        ],
      },
    ]);
    expect(out.stats.families).toBe(1);
    expect(record(out.text, "0 @F1@ FAM")).toEqual([
      "0 @F1@ FAM",
      "1 MARR",
      "2 DATE 11 NOV 1893",
      "2 PLAC Cahuzac-sur-Vère",
      "2 SOUR @S1@",
      "3 PAGE 12",
      "1 WIFE @I1@",
    ]);
    expect(record(out.text, "0 @I1@ INDI")).toContain("1 FAMS @F1@");
    expectNoDanglingPointer(out.text);
    expect(out.warnings).toEqual(["2 links to people not in the export left out: 2 spouse."]);
  });

  it("writes a marriage with no detail as MARR Y", () => {
    const out = write([
      person(1, { families: [{ spouse: brief(person(2)), events: [{ type: "marriage" }] }] }),
    ]);
    expect(record(out.text, "0 @F1@ FAM")).toEqual(["0 @F1@ FAM", "1 MARR Y", "1 HUSB @I1@"]);
  });

  it("puts a summary child (parents only, childCount upstream) in the right family", () => {
    const father = person(1, { name: "Father", sex: "male" });
    const mother = person(2, { name: "Mother", sex: "female" });
    const child = person(3, { name: "Child", parents: [brief(father), brief(mother)] });
    const out = write([
      { ...father, families: [{ spouse: brief(mother), events: [], childCount: 1 }] },
      { ...mother, families: [{ spouse: brief(father), events: [], childCount: 1 }] },
      child,
    ]);
    expect(out.stats.families).toBe(1);
    expect(record(out.text, "0 @F1@ FAM")).toEqual([
      "0 @F1@ FAM",
      "1 HUSB @I1@",
      "1 WIFE @I2@",
      "1 CHIL @I3@",
    ]);
    expect(record(out.text, "0 @I3@ INDI")).toContain("1 FAMC @F1@");
    expect(out.warnings).toEqual([]);
  });

  it("gives a partner of unknown sex the free slot", () => {
    const wife = person(1, { sex: "female" });
    const other = person(2);
    const out = write([{ ...wife, families: [{ spouse: brief(other), events: [] }] }, other]);
    expect(record(out.text, "0 @F1@ FAM")).toEqual(["0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I1@"]);
  });

  it("writes a full-detail marriage once, under the family, with both spouses' citations", () => {
    const marie = toPerson(
      BASE,
      "maudrenel1",
      decodePerson(new ProtoMessage(unframeResponse(fixture("person-maudrenel1-27.bin")))),
      "full",
    );
    const spouse = marie.families?.[0]?.spouse as Brief;
    const jeanCitation: Citation = {
      source: "geneanet",
      title: "Geneanet tree maudrenel1",
      url: spouse.ref.url,
    };
    const marriage = marie.families?.[0]?.events[0] as Event;
    const jean: Person = {
      ...fromBrief(spouse),
      families: [
        {
          spouse: brief(marie),
          events: [{ ...marriage, citations: [jeanCitation] }],
        },
      ],
    };

    const out = write([marie, jean]);
    const indi = record(out.text, "0 @I1@ INDI");
    expect(indi).not.toContain("1 MARR");
    expect(indi).not.toContain("1 MARB");
    expect(indi).toContain("1 FAMS @F1@");
    expect(out.text.match(/^1 MARR$/gm)).toHaveLength(1);
    expect(record(out.text, "0 @F1@ FAM")).toEqual([
      "0 @F1@ FAM",
      "1 MARB",
      "2 DATE 29 OCT 1893",
      "2 PLAC Féneyrols, Tarn-et-Garonne, Occitanie, France",
      "2 SOUR @S1@",
      `3 NOTE ${marie.ref.url}`,
      "1 MARR",
      "2 DATE 11 NOV 1893",
      "2 PLAC Cahuzac-sur-Vère",
      "2 SOUR @S1@",
      `3 NOTE ${marie.ref.url}`,
      "2 SOUR @S1@",
      `3 NOTE ${spouse.ref.url}`,
      "1 HUSB @I2@",
      "1 WIFE @I1@",
    ]);
  });

  it("keeps a withheld person's family links", () => {
    const father = person(1, { name: "Father", sex: "male", withheld: "private" });
    const child = person(2, { name: "Child", parents: [brief(father)] });
    const out = write([father, child]);
    expect(record(out.text, "0 @I1@ INDI")).toContain("1 FAMS @F1@");
    expect(record(out.text, "0 @F1@ FAM")).toEqual(["0 @F1@ FAM", "1 HUSB @I1@", "1 CHIL @I2@"]);
  });
});

describe("writeGedcom people", () => {
  it("writes a withheld person as name, ids and why, nothing else", () => {
    const out = write([
      person(1, {
        name: "Jeanne DUPONT",
        given: "Jeanne",
        surname: "DUPONT",
        sex: "female",
        withheld: "probably-private",
        withheldReason: "Geneanet returned the name only.",
        occupation: "teacher",
        notes: "secret",
        events: [{ type: "birth", date: { date: "1990" } }],
      }),
      person(2, { withheld: "private" }),
    ]);
    expect(record(out.text, "0 @I1@ INDI")).toEqual([
      "0 @I1@ INDI",
      "1 NAME Jeanne /DUPONT/",
      "1 EXID t:1",
      "2 TYPE https://gw.geneanet.org/t",
      "1 NOTE Withheld by geneanet: Geneanet returned the name only.",
    ]);
    expect(record(out.text, "0 @I2@ INDI")).toContain("1 NOTE Withheld by geneanet: private");
  });

  it("writes no NAME for a person behind the x x mask (person-private-masked.bin)", () => {
    const d = decodePerson(new ProtoMessage(unframeResponse(fixture("person-private-masked.bin"))));
    const masked = toPerson(BASE, "zzzzzzz", d, "full");
    const out = write([masked]);
    const indi = record(out.text, "0 @I1@ INDI");
    expect(indi.some((l) => l.startsWith("1 NAME"))).toBe(false);
    expect(indi).toContain("1 EXID zzzzzzz:7");
    expect(indi.at(-1)).toMatch(/^1 NOTE Withheld by geneanet: Geneanet hides this person/);
    // A name-only withheld person keeps the name the source gave.
    const named = write([person(2, { name: "Jeanne DUPONT", withheld: "private" })]);
    expect(named.text).toContain("1 NAME Jeanne DUPONT\n");
  });

  it("does not warn about an unknown ? partner or parent left out", () => {
    const out = write([
      person(1, {
        parents: [unknown(2), brief(person(3, { name: "Mother" }))],
        families: [{ spouse: unknown(4), events: [], children: [brief(person(5))] }],
      }),
    ]);
    expect(out.warnings).toEqual([
      "2 links to people not in the export left out: 1 parent, 1 child.",
    ]);
  });

  it("counts what it left out across people, one line per kind, most first", () => {
    const out = write([
      person(1, {
        parents: [brief(person(3, { name: "Mother" }))],
        families: [{ spouse: brief(person(4)), events: [], children: [brief(person(5))] }],
        events: [{ type: "residence" }],
      }),
      person(2, {
        families: [{ spouse: brief(person(6)), events: [], children: [brief(person(7))] }],
        events: [{ type: "residence" }, { type: "occupation" }],
      }),
    ]);
    expect(out.warnings).toEqual([
      "5 links to people not in the export left out: 2 spouse, 2 child, 1 parent.",
      "3 events with no date, place, note or source left out: 2 residence, 1 occupation.",
    ]);
  });

  it("writes two births of one person as two BIRT, each with its citation", () => {
    const out = write([
      person(1, {
        events: [
          { type: "birth", date: { date: "1768" }, citations: cite("1") },
          { type: "birth", date: { date: "1769" }, citations: cite("2") },
        ],
      }),
    ]);
    expect(out.text.match(/^1 BIRT$/gm)).toHaveLength(2);
    expect(out.text).toContain("1 BIRT\n2 DATE 1768\n2 SOUR @S1@\n3 PAGE 1\n");
    expect(out.text).toContain("1 BIRT\n2 DATE 1769\n2 SOUR @S1@\n3 PAGE 2\n");
    expect(out.stats.sources).toBe(1);
  });

  it("maps event types to tags, unknown ones to EVEN with a TYPE", () => {
    const out = write([
      person(1, {
        occupation: "cultivateur",
        events: [
          { type: "baptism" },
          { type: "burial" },
          { type: "occupation" },
          { type: "residence", date: { date: "1900" } },
          { type: "recensement", date: { date: "1901" } },
          { type: "marriage", date: { date: "1902" } },
          // Nothing to write and no Y form: left out, and said so.
          { type: "residence" },
          { type: "recensement" },
        ],
      }),
    ]);
    const indi = record(out.text, "0 @I1@ INDI");
    expect(indi.filter((l) => l.startsWith("1 ") || l.startsWith("2 TYPE"))).toEqual([
      "1 NAME Person 1",
      // 7.0: a structure has a payload or a substructure, so a detail-less event says Y.
      "1 BAPM Y",
      "1 BURI Y",
      "1 OCCU cultivateur",
      "1 RESI",
      "1 EVEN",
      "2 TYPE recensement",
      // A marriage with no spouse cannot be a family event: kept, as an individual event.
      "1 EVEN",
      "2 TYPE marriage",
      "1 EXID t:1",
      "2 TYPE https://gw.geneanet.org/t",
    ]);
    expect(out.warnings).toEqual([
      "2 events with no date, place, note or source left out: 1 residence, 1 recensement.",
    ]);
  });

  it("writes several occupation events each as its own OCCU, the occupation once apart", () => {
    const out = write([
      person(1, {
        occupation: "cultivateur",
        events: [
          { type: "occupation", date: { date: "1872" }, citations: cite("1") },
          { type: "occupation", date: { date: "1881" }, place: { name: "Albi" } },
          { type: "occupation" },
        ],
      }),
    ]);
    const indi = record(out.text, "0 @I1@ INDI");
    expect(indi.slice(2, -2)).toEqual([
      "1 OCCU",
      "2 DATE 1872",
      "2 SOUR @S1@",
      "3 PAGE 1",
      "1 OCCU",
      "2 DATE 1881",
      "2 PLAC Albi",
      "1 OCCU cultivateur",
    ]);
    expect(out.warnings).toEqual([
      "1 event with no date, place, note or source left out: 1 occupation.",
    ]);
  });

  it("writes the occupation alone when no event carries it", () => {
    const out = write([person(1, { occupation: "tisserand" })]);
    expect(record(out.text, "0 @I1@ INDI")).toContain("1 OCCU tisserand");
  });

  it("splits newlines into CONT lines and escapes a leading @", () => {
    const out = write([
      person(1, {
        notes: "line1\nline2\n\n@home",
        events: [{ type: "birth", place: { name: "@home" } }],
      }),
    ]);
    const indi = record(out.text, "0 @I1@ INDI");
    expect(indi).toContain("2 PLAC @@home");
    expect(indi.slice(-4)).toEqual(["1 NOTE line1", "2 CONT line2", "2 CONT", "2 CONT @@home"]);
  });

  it("writes PLAC as the original string, else the name", () => {
    const out = write([
      person(1, {
        events: [
          {
            type: "birth",
            place: { name: "Cahuzac-sur-Vère", department: "Tarn", raw: "Cahuzac-sur-Vère, Tarn" },
          },
          { type: "death", place: { name: "Albi", insee: "81004" } },
        ],
      }),
    ]);
    expect(out.text).toContain("1 BIRT\n2 PLAC Cahuzac-sur-Vère, Tarn\n");
    expect(out.text).toContain("1 DEAT\n2 PLAC Albi\n");
  });
});

describe("writeGedcom citations", () => {
  it("writes PAGE from acte, else page, else text cut to 200 characters", () => {
    const long = "x".repeat(300);
    const out = write([
      person(1, {
        events: [
          {
            type: "birth",
            citations: [
              { source: "matchid", title: "A", acte: "12", page: "p", text: "t" },
              { source: "geneanet", title: "B", page: "f. 3", text: "t" },
              { source: "geneanet", title: "B", text: long },
              { source: "geneanet", title: "B" },
            ],
          },
        ],
      }),
    ]);
    const pages = out.text.match(/^3 PAGE .*$/gm) ?? [];
    expect(pages.slice(0, 2)).toEqual(["3 PAGE 12", "3 PAGE f. 3"]);
    expect(Array.from((pages[2] as string).slice("3 PAGE ".length))).toHaveLength(200);
    expect(pages).toHaveLength(3);
    expect(out.stats.sources).toBe(2);
    expect(record(out.text, "0 @S1@ SOUR")).toEqual([
      "0 @S1@ SOUR",
      "1 TITL A",
      "1 NOTE https://deces.matchid.io",
    ]);
    expect(record(out.text, "0 @S2@ SOUR")).toEqual([
      "0 @S2@ SOUR",
      "1 TITL B",
      "1 NOTE https://gw.geneanet.org/t",
    ]);
  });
});

describe("writeGedcom dates", () => {
  it("writes ISO dates as day, month and year as precise as known", () => {
    expect(birthDate({ date: "1897-04-03" })).toEqual(["2 DATE 3 APR 1897"]);
    expect(birthDate({ date: "1897-12" })).toEqual(["2 DATE DEC 1897"]);
    expect(birthDate({ date: "1897" })).toEqual(["2 DATE 1897"]);
  });

  it("writes the qualifiers in 7.0 syntax", () => {
    expect(birthDate({ date: "1768", qualifier: "about" })).toEqual(["2 DATE ABT 1768"]);
    expect(birthDate({ date: "1768-05", qualifier: "before" })).toEqual(["2 DATE BEF MAY 1768"]);
    expect(birthDate({ date: "1768", qualifier: "after" })).toEqual(["2 DATE AFT 1768"]);
    expect(birthDate({ date: "1825", qualifier: "between", dateTo: "1875" })).toEqual([
      "2 DATE BET 1825 AND 1875",
    ]);
    // No second bound: the bare date, the wording as given, no invented "?".
    expect(birthDate({ date: "1825", qualifier: "between" })).toEqual([
      "2 DATE 1825",
      "3 PHRASE between 1825",
    ]);
    expect(birthDate({ date: "1900", qualifier: "from", dateTo: "1910" })).toEqual([
      "2 DATE FROM 1900 TO 1910",
    ]);
    expect(birthDate({ date: "1900", qualifier: "from" })).toEqual(["2 DATE FROM 1900"]);
    expect(birthDate({ date: "1910", qualifier: "to" })).toEqual(["2 DATE TO 1910"]);
  });

  it("writes maybe and or as the bare date with a PHRASE", () => {
    expect(birthDate({ date: "1768", qualifier: "maybe" })).toEqual([
      "2 DATE 1768",
      "3 PHRASE maybe 1768",
    ]);
    expect(birthDate({ date: "1768", qualifier: "or", dateTo: "1769" })).toEqual([
      "2 DATE 1768",
      "3 PHRASE 1768 or 1769",
    ]);
    expect(birthDate({ date: "1768", qualifier: "or" })).toEqual([
      "2 DATE 1768",
      "3 PHRASE 1768 or",
    ]);
    expect(birthDate({ date: "1768", qualifier: "maybe", text: "peut-être 1768" })).toEqual([
      "2 DATE 1768",
      "3 PHRASE peut-être 1768",
    ]);
  });

  it("writes a Julian date with the 7.0 calendar word", () => {
    expect(birthDate({ date: "1539-05-29", calendar: "julian" })).toEqual([
      "2 DATE JULIAN 29 MAY 1539",
    ]);
    expect(
      birthDate({ date: "1600", dateTo: "1601", qualifier: "between", calendar: "julian" }),
    ).toEqual(["2 DATE BET JULIAN 1600 AND JULIAN 1601"]);
  });

  it("keeps the source's wording as a PHRASE next to a date, or as a NOTE without one", () => {
    expect(birthDate({ date: "1768", text: "vers la Saint-Jean 1768" })).toEqual([
      "2 DATE 1768",
      "3 PHRASE vers la Saint-Jean 1768",
    ]);
    expect(birthDate({ text: "an 8" })).toEqual(["2 NOTE Date: an 8"]);
    expect(birthDate({ date: "0008-02-18", calendar: "french", text: "18 brumaire an 8" })).toEqual(
      ["2 NOTE Date: 18 brumaire an 8"],
    );
  });
});
