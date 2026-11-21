import { describe, expect, it } from "vitest";

import { parseRef } from "#/schema/ids";
import type { Ref } from "#/schema/types";
import { RecordsParseError, buildRecordsQuery, parseRecordsPage } from "#/sources/geneanet/records";
import { fixtureText } from "#test/helpers";

const SITE = "https://en.geneanet.org";
const TREES = "https://gw.geneanet.org";

describe("parseRecordsPage (records-louvignes-cahuzac.html)", () => {
  const page = parseRecordsPage(fixtureText("records-louvignes-cahuzac.html"), SITE, TREES);

  it("reads the total, not just the rows on the page", () => {
    expect(page.total).toBe(16);
    expect(page.hits).toHaveLength(11);
  });

  it("reads a family-tree hit, with its ref (holding its url) and what get_person needs", () => {
    expect(page.hits[0]).toEqual({
      kind: "family_tree",
      name: "LOUVIGNES Marie Germaine",
      spouse: "ROBERT Jean (1893)",
      source: "Family tree of maudrenel1",
      dates: [
        { event: "birth", date: { date: "1870" } },
        { event: "death", date: { date: "1944" } },
      ],
      places: [
        {
          place: { name: "Cahuzac-sur-Vère", raw: "Cahuzac-sur-Vère, Tarn, France" },
          events: ["birth", "marriage"],
        },
        {
          place: { name: "Saint-Étienne", raw: "Saint-Étienne, Loire, France" },
          events: ["death"],
        },
      ],
      ref: {
        source: "geneanet",
        id: "maudrenel1:louvignes/marie germaine/0",
        url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=marie+germaine",
      },
      tree: "maudrenel1",
      n: "louvignes",
      p: "marie germaine",
    });
  });

  it("gives every family-tree hit a key-form ref that parseRef accepts, and no other hit a ref", () => {
    const trees = page.hits.filter((h) => h.kind === "family_tree");
    expect(trees.length).toBeGreaterThan(0);
    for (const h of trees) {
      expect(parseRef(h.ref as Ref)).toEqual({
        source: "geneanet",
        tree: h.tree,
        n: h.n,
        p: h.p,
        oc: h.oc ?? 0,
      });
    }
    for (const other of page.hits.filter((h) => h.kind !== "family_tree")) {
      expect(other.ref).toBeUndefined();
    }
  });

  it("joins a date range that wraps onto a second line, and reads it as a DateValue", () => {
    expect(page.hits[1]).toMatchObject({
      kind: "society_index",
      name: "LOUVIGNES Jean François Pauline",
      dates: [{ event: "marriage", date: { date: "1825", qualifier: "between", dateTo: "1875" } }],
    });
  });

  it("marks no hit of this page as from the INSEE index or Premium-masked", () => {
    expect(page.hits.filter((h) => h.hint || h.withheld)).toEqual([]);
  });

  it("reads society and collaborative indexes, with their relationship to the searched name", () => {
    expect(page.hits[3]).toMatchObject({
      kind: "society_index",
      name: "LOUVIGNES Marie",
      spouse: "PONS François",
      relationship: "parent",
      source: "Relevés de mariages, Tarn",
      url: "https://en.geneanet.org/cercles/view/colgnecac81m/250773",
    });
    expect(page.hits.find((h) => h.kind === "collaborative_index")).toMatchObject({
      name: "LOUVIGNES Marie Germaine",
      source: "Marriages (Tarn, France)",
    });
    expect(page.hits.find((h) => h.kind === "society_index")?.tree).toBeUndefined();
  });

  it("reads archival-register hits", () => {
    expect(page.hits.find((h) => h.kind === "archival_register")).toMatchObject({
      name: "MAUREL Honorine",
      url: "https://en.geneanet.org/archival-registers/view/184693/73?individu_filter=9886151",
    });
  });
});

describe("parseRecordsPage (records-louvignes-deaths-insee.html: deaths 1970-2005)", () => {
  const page = parseRecordsPage(fixtureText("records-louvignes-deaths-insee.html"), SITE, TREES);
  const insee = page.hits.filter((h) => h.source === "Fichier des décès de l'INSEE");

  it("points the INSEE death index hits to matchID, and only them", () => {
    expect(page.total).toBe(32);
    expect(insee).toHaveLength(9);
    expect(page.hits.filter((h) => h.hint === "matchid")).toEqual(insee);
  });

  it("reads an INSEE hit's places, with the INSEE code, and its Premium date range", () => {
    expect(insee[0]).toEqual({
      kind: "society_index",
      name: "LOUVIGNES Michel Jean Joseph",
      source: "Fichier des décès de l'INSEE",
      dates: [{ event: "date", date: { date: "1875", qualifier: "between", dateTo: "2025" } }],
      places: [
        {
          place: { name: "Salvagnac", insee: "81276", raw: "Salvagnac, 81276, Tarn, France" },
          events: ["birth"],
        },
        {
          place: { name: "Lavaur", insee: "81140", raw: "Lavaur, 81140, Tarn, France" },
          events: ["death"],
        },
      ],
      url: "https://en.geneanet.org/cercles/view/colgnecminsee/23224406",
      hint: "matchid",
    });
  });

  it("keeps a family-tree place's postal code out of insee", () => {
    const juliette = page.hits.find((h) => h.tree === "adages");
    expect(juliette).toMatchObject({
      kind: "family_tree",
      name: "LOUVIGNES Juliette Henriette Jeanne",
    });
    expect(juliette?.url).toBeUndefined();
    expect(juliette?.places.map((p) => p.place)).toContainEqual({
      name: "Albi",
      code: "81000",
      raw: "Albi, 81000, Tarn, France",
    });
    const places = page.hits.filter((h) => !h.hint).flatMap((h) => h.places.map((p) => p.place));
    expect(places.some((p) => p.code)).toBe(true);
    expect(places.filter((p) => p.insee)).toEqual([]);
  });

  it("reads INSEE codes on the INSEE index hits", () => {
    expect(insee.flatMap((h) => h.places.map((p) => p.place))).toContainEqual({
      name: "Lisle-sur-Tarn",
      insee: "81145",
      raw: "Lisle-sur-Tarn, 81145, Tarn, France",
    });
    expect(insee.every((h) => h.places.every((p) => !p.place.code))).toBe(true);
  });

  it("keeps the url of hits with no ref", () => {
    expect(insee.every((h) => h.url && !h.ref)).toBe(true);
  });

  it("names the cemetery surveys", () => {
    expect(page.hits.filter((h) => h.kind === "cemetery").length).toBeGreaterThan(0);
  });
});

/** The first row of a real page, with its name or a date replaced by the Premium mask. */
const masked = (from: RegExp, to: string) => {
  const html = fixtureText("records-louvignes-cahuzac.html");
  const end = html.indexOf("</a>") + "</a>".length;
  return parseRecordsPage(html.slice(0, end).replace(from, to), SITE, TREES).hits[0];
};

describe("parseRecordsPage edge cases", () => {
  it("marks a hit whose name or dates show the XXXX mask as withheld: premium", () => {
    expect(masked(/>1870</, ">XXXX<")).toMatchObject({
      dates: [{ event: "birth", date: { text: "XXXX" } }, { event: "death" }],
      withheld: "premium",
    });
    expect(masked(/Marie Germaine {4}</, "XXXX <")).toMatchObject({
      name: "LOUVIGNES XXXX",
      withheld: "premium",
    });
  });

  it("reads the nothing-found page as zero results", () => {
    expect(parseRecordsPage(fixtureText("records-empty.html"), SITE, TREES)).toEqual({
      total: 0,
      hits: [],
    });
  });

  it("reads a localised result count", () => {
    const html = '<span data-nb-results="12,345"> 12,345 results </span>';
    expect(parseRecordsPage(html, SITE, TREES).total).toBe(12345);
  });

  it("throws on a page it does not recognise, rather than reporting zero", () => {
    expect(() => parseRecordsPage("<html><body>Maintenance</body></html>", SITE, TREES)).toThrow(
      RecordsParseError,
    );
  });
});

describe("buildRecordsQuery", () => {
  it("maps arguments onto the form's own field names", () => {
    const q = buildRecordsQuery({
      lastname: "LOUVIGNES",
      firstname: "Marie",
      sex: "female",
      places: ["Cahuzac-sur-Vère", "Gaillac"],
      radiusKm: 30,
      from: 1800,
      to: 1900,
      dateOf: "marriage",
      fatherLastname: "LOUVIGNES",
      page: 2,
      size: 50,
    });
    expect(Object.fromEntries(q)).toEqual({
      go: "1",
      nom: "LOUVIGNES",
      prenom: "Marie",
      sexe: "2",
      place__0__: "Cahuzac-sur-Vère",
      place__1__: "Gaillac",
      voisinage: "30",
      periode_mode: "wedding",
      type_periode: "between",
      from: "1800",
      to: "1900",
      nom_pere: "LOUVIGNES",
      size: "50",
      page: "2",
    });
  });

  it("drops a radius without places, and the period block without years", () => {
    expect(
      Object.fromEntries(buildRecordsQuery({ lastname: "X", radiusKm: 30, page: 1, size: 20 })),
    ).toEqual({
      go: "1",
      nom: "X",
      size: "20",
    });
  });
});
