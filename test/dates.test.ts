import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  fromDisplayEn,
  fromLifeSpan,
  fromRaw,
  fromWording,
  shortDate,
} from "#/sources/geneanet/dates";
import { decodePerson, type Person, type SimplePerson } from "#/sources/geneanet/proto/messages";
import { ProtoMessage, unframeResponse } from "#/sources/geneanet/proto/wire";
import { parseRecordsPage } from "#/sources/geneanet/records";
import { fixture, fixtureText } from "#test/helpers";

const person = (name: string): Person =>
  decodePerson(new ProtoMessage(unframeResponse(fixture(name))));

type Pair = [string | undefined, string | undefined];

const simplePairs = (s: SimplePerson): Pair[] => [
  [s.birthDateRaw, s.birthDate],
  [s.deathDateRaw, s.deathDate],
];

/** Every (raw, display) date pair a person record carries, relatives included. */
const datePairs = (p: Person): Pair[] => [
  ...p.events.flatMap((e): Pair[] => [
    [e.dateRaw, e.date],
    ...(e.spouse ? simplePairs(e.spouse) : []),
    ...e.witnesses.flatMap((w) => simplePairs(w.person)),
  ]),
  ...p.families.flatMap((f): Pair[] => [
    [f.marriageDateRaw, f.marriageDate],
    ...simplePairs(f.spouse),
    ...f.children.flatMap(simplePairs),
  ]),
  ...(p.father ? simplePairs(p.father) : []),
  ...(p.mother ? simplePairs(p.mother) : []),
];

const event = (p: Person, name: string) => {
  const e = p.events.find((x) => x.name === name);
  if (!e) throw new Error(`no ${name} event`);
  return fromRaw(e.dateRaw, e.date);
};

describe("fromRaw", () => {
  it("reads exact, month and year precision", () => {
    expect(fromRaw("/1841/2/13#", "Feb. 13, 1841")).toEqual({ date: "1841-02-13" });
    expect(fromRaw("/1896/0/0#", "1896")).toEqual({ date: "1896" });
    expect(fromRaw("/1896/3/0#", "Mar., 1896")).toEqual({ date: "1896-03" });
  });

  it("keeps the display as text when there is no raw form, or one it does not know", () => {
    expect(fromRaw(undefined, "about 1768")).toEqual({ text: "about 1768" });
    expect(fromRaw("garbage", "x")).toEqual({ text: "x" });
    expect(fromRaw("/0/0/0#", "0")).toEqual({ text: "0" });
    expect(fromRaw(undefined, undefined)).toBeUndefined();
    expect(fromRaw("", "")).toBeUndefined();
  });

  it("reads a month-year (gchene2 52355: /1767/11/0# is 'Nov., 1767')", () => {
    const p = person("person-gchene2-52355-month.bin");
    expect(event(p, "Marriage")).toEqual({ date: "1767-11" });
  });

  it("reads about (~) on a year and on a full date", () => {
    const p = person("person-maudrenel1-87-about.bin");
    expect(event(p, "birth")).toEqual({ date: "1768", qualifier: "about" });
    expect(fromRaw("~/1798/8/23#", "about 08/23/1798")).toEqual({
      date: "1798-08-23",
      qualifier: "about",
    });
  });

  it("reads before (<)", () => {
    const p = person("person-maudrenel1-545-before.bin");
    expect(event(p, "death")).toEqual({ date: "1791", qualifier: "before" });
  });

  it("reads after (>) with a full date", () => {
    const p = person("person-gchene2-15894-after.bin");
    expect(event(p, "death")).toEqual({ date: "1851-06-17", qualifier: "after" });
  });

  it("reads maybe (?), which the site words 'possibly'", () => {
    const p = person("person-pmft-33212-maybe.bin");
    expect(event(p, "death")).toEqual({ date: "1557-01-16", qualifier: "maybe" });
  });

  it("reads a range (a..b), whose second bound has no #", () => {
    const p = person("person-pmft-31878-between.bin");
    const ranges = p.events
      .filter((e) => e.name === "Residence")
      .map((e) => fromRaw(e.dateRaw, e.date));
    expect(ranges).toEqual([
      { date: "1514", qualifier: "between", dateTo: "1514" },
      { date: "1521", qualifier: "between", dateTo: "1523" },
    ]);
  });

  it("gives a Julian date in its own calendar (the raw form is its Gregorian equivalent)", () => {
    const p = person("person-pmft-9543-julian.bin");
    // raw /1539/6/8#, display "May 29, 1539 Julian".
    expect(event(p, "baptism")).toEqual({ date: "1539-05-29", calendar: "julian" });
    // A relative's display: raw /1571/1/22#, "01/12/1571 (Julian)".
    const child = p.families[0]?.children.find((c) => c.index === 51125);
    expect(fromRaw(child?.birthDateRaw, child?.birthDate)).toEqual({
      date: "1571-01-12",
      calendar: "julian",
    });
    // pmft 31878's child: raw /1523/3/2#, "02/20/1523 (Julian)".
    expect(fromRaw("/1523/3/2#", "02/20/1523 (Julian)")).toEqual({
      date: "1523-02-20",
      calendar: "julian",
    });
  });

  it("keeps text for calendar forms never captured (partial Julian, French, Hebrew)", () => {
    // Synthetic: no such raw date was found live, so none is converted.
    expect(fromRaw("/1539/0/0#", "1539 Julian")).toEqual({ text: "1539 Julian" });
    expect(fromRaw("/1794/4/4#", "Germinal 15, year II (French)")).toEqual({
      text: "Germinal 15, year II (French)",
    });
    expect(fromRaw("/1794/4/4#", "15 Nisan 5554 (Hebrew)")).toEqual({
      text: "15 Nisan 5554 (Hebrew)",
    });
  });

  it("parses every dated raw form in the captured records, without falling back to text", () => {
    const files = readdirSync(new URL("./fixtures/", import.meta.url)).filter(
      (f) => f.startsWith("person-") && f.endsWith(".bin"),
    );
    let checked = 0;
    for (const file of files) {
      const body = fixture(file);
      if (body.length < 100) continue; // empty answer or an error message
      for (const [raw, display] of datePairs(person(file))) {
        if (!raw) continue;
        const d = fromRaw(raw, display);
        expect(d?.date, `${file}: ${raw} | ${display}`).toBeDefined();
        expect(d?.text, `${file}: ${raw} | ${display}`).toBeUndefined();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("fromWording", () => {
  it("reads an event and a year", () => {
    expect(fromWording("Birth 1897")).toEqual({ event: "birth", date: { date: "1897" } });
  });

  it("reads qualifiers", () => {
    expect(fromWording("Birth about 1768")).toEqual({
      event: "birth",
      date: { date: "1768", qualifier: "about" },
    });
    expect(fromWording("Death before 1900")).toEqual({
      event: "death",
      date: { date: "1900", qualifier: "before" },
    });
  });

  it("reads a range in brackets, whatever its span", () => {
    expect(fromWording("Marriage (between 1825 and 1875)")).toEqual({
      event: "marriage",
      date: { date: "1825", qualifier: "between", dateTo: "1875" },
    });
    expect(fromWording("Death (between 1900 and 2025)")).toEqual({
      event: "death",
      date: { date: "1900", qualifier: "between", dateTo: "2025" },
    });
  });

  it("keeps wording it cannot read as text", () => {
    expect(fromWording("Mention 18th century")).toEqual({
      event: "mention",
      date: { text: "18th century" },
    });
    // The Premium mask (spec-alignment rule 8) and a date in words keep the event clean.
    expect(fromWording("Birth XXXX")).toEqual({ event: "birth", date: { text: "XXXX" } });
    expect(fromWording("Death unknown")).toEqual({ event: "death", date: { text: "unknown" } });
    expect(fromWording("Marriage (XXXX)")).toEqual({
      event: "marriage",
      date: { text: "(XXXX)" },
    });
    expect(fromWording("Census XXXX")).toEqual({ event: "census", date: { text: "XXXX" } });
    expect(fromWording("Residence unknown")).toEqual({
      event: "residence",
      date: { text: "unknown" },
    });
    expect(fromWording("Census 1896")).toEqual({ event: "census", date: { date: "1896" } });
    expect(fromWording("Birth")).toEqual({ event: "birth" });
    expect(fromWording("Date 1527")).toEqual({ event: "date", date: { date: "1527" } });
  });

  it("reads every date line of real results pages", () => {
    const dates = ["records-louvignes-cahuzac.html", "records-louvignes-deaths-insee.html"].flatMap(
      (file) =>
        parseRecordsPage(
          fixtureText(file),
          "https://en.geneanet.org",
          "https://gw.geneanet.org",
        ).hits.flatMap((h) => h.dates),
    );
    expect(dates.length).toBeGreaterThan(20);
    for (const p of dates) {
      expect(["birth", "death", "marriage", "date"], JSON.stringify(p)).toContain(p.event);
      expect(p.date?.date, JSON.stringify(p)).toBeDefined();
      expect(p.date?.text, JSON.stringify(p)).toBeUndefined();
    }
    // A hit with no event label: Geneanet's own generic label is "Date".
    expect(fromWording("between 1750 and 1875")).toEqual({
      event: "date",
      date: { date: "1750", qualifier: "between", dateTo: "1875" },
    });
  });
});

describe("fromDisplayEn", () => {
  it("reads the en site's month/day/year", () => {
    expect(fromDisplayEn("02/13/1841", "en")).toEqual({ date: "1841-02-13" });
  });

  it("reads the qualified and Julian forms the en site shows for relatives", () => {
    expect(fromDisplayEn("about 1768", "en")).toEqual({ date: "1768", qualifier: "about" });
    expect(fromDisplayEn("before 1791", "en")).toEqual({ date: "1791", qualifier: "before" });
    expect(fromDisplayEn("between 1772 and 1774", "en")).toEqual({
      date: "1772",
      qualifier: "between",
      dateTo: "1774",
    });
    expect(fromDisplayEn("05/29/1539 (Julian)", "en")).toEqual({
      date: "1539-05-29",
      calendar: "julian",
    });
  });

  it("leaves another language's numeric order, and anything unknown, as text", () => {
    expect(fromDisplayEn("13/02/1841", "fr")).toEqual({ text: "13/02/1841" });
    expect(fromDisplayEn("vers 1768", "fr")).toEqual({ text: "vers 1768" });
    expect(fromDisplayEn("13/02/1841", "en")).toEqual({ text: "13/02/1841" });
    expect(fromDisplayEn(undefined, "en")).toBeUndefined();
  });
});

describe("fromLifeSpan", () => {
  it("splits the life years a tree node or search hit shows", () => {
    expect(fromLifeSpan("1841-1907")).toEqual({ born: "1841", died: "1907" });
    expect(fromLifeSpan("1895-1895")).toEqual({ born: "1895", died: "1895" });
    expect(fromLifeSpan("1809-")).toEqual({ born: "1809" });
    expect(fromLifeSpan("-1907")).toEqual({ died: "1907" });
  });

  it("reads the circa and death-only forms seen next to their full dates", () => {
    // Index 87 of maudrenel1 shows "ca 1768-1818"; its brief elsewhere reads "about 1768".
    expect(fromLifeSpan("ca 1768-1818")).toEqual({ born: "about 1768", died: "1818" });
    // Index 545 shows "†< 1791"; its brief elsewhere reads "before 1791".
    expect(fromLifeSpan("†< 1791")).toEqual({ died: "before 1791" });
    // Other death forms were never seen: kept as written, but still a death.
    expect(fromLifeSpan("†> 1791")).toEqual({ died: "†> 1791" });
    expect(fromLifeSpan("† 1791")).toEqual({ died: "† 1791" });
    expect(fromLifeSpan("†1791")).toEqual({ died: "†1791" });
  });

  it("keeps anything else as the site wrote it, in born", () => {
    expect(fromLifeSpan("1841/1907")).toEqual({ born: "1841/1907" });
    expect(fromLifeSpan("vers 1768-1818")).toEqual({ born: "vers 1768-1818" });
    expect(fromLifeSpan("-")).toEqual({});
    expect(fromLifeSpan(undefined)).toEqual({});
  });
});

describe("shortDate", () => {
  it("gives the ISO date alone", () => {
    expect(shortDate({ date: "1897-04-03" })).toBe("1897-04-03");
  });

  it("puts a single-date qualifier in front", () => {
    expect(shortDate({ date: "1768", qualifier: "about" })).toBe("about 1768");
    expect(shortDate({ date: "1557-01-16", qualifier: "maybe" })).toBe("maybe 1557-01-16");
    expect(shortDate({ date: "1791", qualifier: "before" })).toBe("before 1791");
    expect(shortDate({ date: "1539", qualifier: "after" })).toBe("after 1539");
    expect(shortDate({ date: "1875", qualifier: "to" })).toBe("to 1875");
  });

  it("words two-date forms", () => {
    expect(shortDate({ date: "1825", qualifier: "between", dateTo: "1875" })).toBe(
      "between 1825 and 1875",
    );
    expect(shortDate({ date: "1825", qualifier: "from", dateTo: "1875" })).toBe(
      "from 1825 to 1875",
    );
    expect(shortDate({ date: "1768", qualifier: "or", dateTo: "1769" })).toBe("1768 or 1769");
    expect(shortDate({ date: "1825", qualifier: "from" })).toBe("from 1825");
  });

  it("appends a non-Gregorian calendar", () => {
    expect(shortDate({ date: "1539-05-29", calendar: "julian" })).toBe("1539-05-29 (julian)");
    expect(shortDate({ date: "1539", qualifier: "about", calendar: "julian" })).toBe(
      "about 1539 (julian)",
    );
  });

  it("falls back to the text, and to nothing", () => {
    expect(shortDate({ text: "18th century" })).toBe("18th century");
    expect(shortDate(undefined)).toBeUndefined();
    expect(shortDate({})).toBeUndefined();
  });
});
