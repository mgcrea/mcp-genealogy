import { describe, expect, it } from "vitest";

import { htmlToText, isoFromRaw, shapeGraph, shapePerson, shapeSearchHits } from "#/client/shape";
import { decodeGraph, decodePerson, decodeSearchList } from "#/proto/messages";
import { ProtoMessage, unframeResponse } from "#/proto/wire";
import { fixture } from "#test/helpers";

const BASE = "https://gw.geneanet.org";
const load = (name: string): ProtoMessage => new ProtoMessage(unframeResponse(fixture(name)));

type Rec = Record<string, unknown>;

const byIndex = (list: unknown, index: number): Rec | undefined =>
  (list as Rec[]).find((x) => x.index === index);

describe("isoFromRaw", () => {
  it("turns GeneWeb's exact raw dates into ISO, trimming unknown parts", () => {
    expect(isoFromRaw("/1870/11/22#")).toBe("1870-11-22");
    expect(isoFromRaw("/1841/2/13#")).toBe("1841-02-13");
    expect(isoFromRaw("/1896/0/0#")).toBe("1896");
    expect(isoFromRaw("/1896/3/0#")).toBe("1896-03");
  });

  it("leaves anything it cannot read exactly to the site's wording", () => {
    expect(isoFromRaw(undefined)).toBeUndefined();
    expect(isoFromRaw("~/1768/0/0#")).toBeUndefined();
    expect(isoFromRaw("/0/0/0#")).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("keeps line structure and decodes entities", () => {
    expect(htmlToText("<p>\nNée au lieu dit &#34;Roziers&#34;.<br>Fin</p>")).toBe(
      'Née au lieu dit "Roziers".\nFin',
    );
  });
});

describe("shapePerson (person-maudrenel1-27.bin)", () => {
  const p = shapePerson(BASE, "maudrenel1", decodePerson(load("person-maudrenel1-27.bin")));

  it("reads the vitals, with places", () => {
    expect(p).toMatchObject({
      tree: "maudrenel1",
      index: 27,
      name: "Marie Germaine LOUVIGNES",
      sex: "female",
      qualifiers: ["Cécilia"],
      // ISO from the birth EVENT's raw date: the Person message only has "Nov. 22, 1870".
      birth: { date: "1870-11-22", place: "Cahuzac-sur-Vère, Tarn, Occitanie, France" },
      death: { date: "1944-11-16", place: "Saint-Étienne, Loire, Auvergne-Rhône-Alpes, France" },
      directAncestorOfTreeRoot: true,
      url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=marie+germaine",
    });
  });

  it("collapses parents to briefs with ISO dates", () => {
    expect((p.parents as Rec).father).toEqual({
      index: 55,
      name: "Jean François Paulin LOUVIGNES",
      life: "1841-02-13, Lisle-sur-Tarn, Tarn, Occitanie, France – 1907-02-10, Cahuzac-sur-Vère, Tarn, Occitanie, France",
    });
    expect(((p.parents as Rec).mother as Rec).index).toBe(28);
  });

  it("lists the union with its children", () => {
    const [fam] = p.families as Rec[];
    expect(fam).toMatchObject({
      familyIndex: 23,
      spouse: { index: 215, name: "Jean ROBERT" },
      // From marriage_date_raw (/1893/11/11#), not the display string "Nov. 11, 1893".
      married: "1893-11-11",
      marriagePlace: "Cahuzac-sur-Vère",
    });
    expect(((fam?.children ?? []) as Rec[]).map((c) => c.index)).toEqual([229, 230, 20]);
  });

  it("returns events with notes as plain text", () => {
    const events = p.events as Rec[];
    expect(events[0]).toMatchObject({
      event: "birth",
      date: "1870-11-22",
      note: 'Née au lieu dit "Roziers".',
    });
    expect(events.find((e) => e.event === "Marriage")).toMatchObject({
      date: "1893-11-11",
      with: { index: 215 },
    });
    expect(JSON.stringify(p)).not.toContain("<p>");
  });
});

describe("shapeGraph (graph-maudrenel1-27.bin: 2 generations up, 1 down)", () => {
  const g = shapeGraph(BASE, "maudrenel1", decodeGraph(load("graph-maudrenel1-27.bin")));

  it("puts the parents on the root", () => {
    expect(g.root).toMatchObject({ index: 27, fatherIndex: 55, motherIndex: 28 });
  });

  it("resolves ancestors to generations with father and mother indexes", () => {
    expect(byIndex(g.ancestors, 55)).toMatchObject({
      generation: 1,
      name: "Jean François Paulin LOUVIGNES",
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
      shapeGraph(BASE, "t", {
        ancestors: [],
        ancestorEdges: [],
        descendants: [],
        descendantEdges: [],
        siblings: [],
      }),
    ).toEqual({ tree: "t", found: false });
  });
});

describe("shapeSearchHits", () => {
  it("reads Geneanet's search records with parents and spouses", () => {
    const res = shapeSearchHits(
      BASE,
      "maudrenel1",
      decodeSearchList(load("search-maudrenel1-louvignes.bin")),
    );
    const guilhaume = (res.persons as Rec[]).find((p) => p.index === 85);
    expect(guilhaume).toMatchObject({
      name: "Guilhaume LOUVIGNES",
      dates: "1797-1870",
      father: {
        index: 87,
        name: "Jean Guilhaume LOUVIGNES",
        // "11/24/1818" on the en site is month/day/year.
        life: "about 1768 – 1818-11-24, Gaillac, Tarn, Occitanie, France",
      },
      mother: { index: 88, name: "Jeanne SICARD" },
      spouses: [{ index: 86, name: "Antoinette BRASSIE" }],
      url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=guilhaume",
    });
  });

  it("leaves another language's numeric dates as the site wrote them", () => {
    const res = shapeSearchHits(
      BASE,
      "maudrenel1",
      decodeSearchList(load("search-maudrenel1-louvignes.bin")),
      "fr",
    );
    const guilhaume = (res.persons as Rec[]).find((p) => p.index === 85);
    expect(((guilhaume?.father ?? {}) as Rec).life).toContain("11/24/1818");
  });

  it("returns accented names as sent (the request framing carries UTF-8)", () => {
    const res = shapeSearchHits(
      BASE,
      "bcampedel",
      decodeSearchList(load("search-bcampedel-jerome.bin")),
    );
    expect((res.persons as Rec[])[0]).toMatchObject({ name: "Jérôme LOUVIGNES" });
  });
});

const person = (index: number, sex: "male" | "female") => ({
  id: index,
  person: {
    index,
    sex,
    lastname: "X",
    firstname: String(index),
    key: { n: "x", p: String(index), oc: 0 },
    sosa: 2,
    hidden: false,
  },
});

const graph = (
  nodes: number[],
  sexes: Record<number, "male" | "female">,
  edges: [number, number][],
) =>
  shapeGraph(BASE, "t", {
    ancestors: [person(1, sexes[1] ?? "male")],
    ancestorEdges: [],
    descendants: nodes.map((i) => person(i, sexes[i] ?? "male")),
    descendantEdges: edges.map(([from, to]) => ({ from, to })),
    siblings: [],
  });

describe("shapeGraph descendant roles on awkward families", () => {
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

describe("decodeEntities hardening", () => {
  it("leaves an out-of-range entity as written instead of throwing", () => {
    expect(htmlToText("<p>see &#1114112; and &#xFFFFFFFF;</p>")).toBe(
      "see &#1114112; and &#xFFFFFFFF;",
    );
  });
});
