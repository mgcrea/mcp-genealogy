import { describe, expect, it } from "vitest";

import { RecordsParseError, buildRecordsQuery, parseRecordsPage } from "#/records/search";
import { fixtureText } from "#test/helpers";

const SITE = "https://en.geneanet.org";
const TREES = "https://gw.geneanet.org";

describe("parseRecordsPage (records-louvignes-cahuzac.html)", () => {
  const page = parseRecordsPage(fixtureText("records-louvignes-cahuzac.html"), SITE, TREES);

  it("reads the total, not just the rows on the page", () => {
    expect(page.total).toBe(16);
    expect(page.hits).toHaveLength(11);
  });

  it("reads a family-tree hit, with what get_person needs", () => {
    expect(page.hits[0]).toEqual({
      kind: "family_tree",
      name: "LOUVIGNES Marie Germaine",
      spouse: "ROBERT Jean (1893)",
      source: "Family tree of maudrenel1",
      dates: ["Birth 1870", "Death 1944"],
      places: [
        { place: "Cahuzac-sur-Vère, Tarn, France", events: ["birth", "marriage"] },
        { place: "Saint-Étienne, Loire, France", events: ["death"] },
      ],
      url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=marie+germaine",
      tree: "maudrenel1",
      n: "louvignes",
      p: "marie germaine",
    });
  });

  it("joins a date range that wraps onto a second line", () => {
    expect(page.hits[1]).toMatchObject({
      kind: "society_index",
      name: "LOUVIGNES Jean François Pauline",
      dates: ["Marriage (between 1825 and 1875)"],
    });
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

describe("parseRecordsPage edge cases", () => {
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
