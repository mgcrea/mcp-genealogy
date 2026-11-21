import { describe, expect, it } from "vitest";

import type { Event } from "#/schema/types";
import { toPerson } from "#/sources/geneanet/adapter";
import { decodePerson } from "#/sources/geneanet/proto/messages";
import { ProtoMessage, unframeResponse } from "#/sources/geneanet/proto/wire";
import { htmlToText } from "#/sources/geneanet/shape";
import { fixture } from "#test/helpers";

const BASE = "https://gw.geneanet.org";
const load = (name: string): ProtoMessage => new ProtoMessage(unframeResponse(fixture(name)));

describe("htmlToText", () => {
  it("keeps line structure and decodes entities", () => {
    expect(htmlToText("<p>\nNée au lieu dit &#34;Roziers&#34;.<br>Fin</p>")).toBe(
      'Née au lieu dit "Roziers".\nFin',
    );
  });
});

// geneanet_get_person's answer; test/adapter.test.ts covers the adapter in depth.
describe("toPerson full (person-maudrenel1-27.bin)", () => {
  const p = toPerson(BASE, "maudrenel1", decodePerson(load("person-maudrenel1-27.bin")), "full");
  const ofType = (type: string): Event | undefined => p.events.find((e) => e.type === type);

  it("reads the vitals, with places", () => {
    expect(p).toMatchObject({
      ref: {
        source: "geneanet",
        id: "maudrenel1:27",
        url: "https://gw.geneanet.org/maudrenel1?lang=en&n=louvignes&p=marie+germaine",
      },
      tree: "maudrenel1",
      index: 27,
      name: "Marie Germaine LOUVIGNES",
      sex: "female",
      aliases: ["Cécilia"],
      directAncestorOfTreeRoot: true,
    });
    // ISO from the birth EVENT's raw date: the Person message only has "Nov. 22, 1870".
    expect(ofType("birth")).toMatchObject({
      date: { date: "1870-11-22" },
      place: { raw: "Cahuzac-sur-Vère, Tarn, Occitanie, France" },
    });
    expect(ofType("death")).toMatchObject({
      date: { date: "1944-11-16" },
      place: { raw: "Saint-Étienne, Loire, Auvergne-Rhône-Alpes, France" },
    });
  });

  it("collapses parents to briefs with ISO dates", () => {
    expect(p.parents?.[0]).toMatchObject({
      ref: { id: "maudrenel1:55" },
      name: "Jean François Paulin LOUVIGNES",
      born: "1841-02-13",
      bornAt: "Lisle-sur-Tarn, Tarn, Occitanie, France",
      died: "1907-02-10",
      diedAt: "Cahuzac-sur-Vère, Tarn, Occitanie, France",
    });
    expect(p.parents?.[1]?.ref.id).toBe("maudrenel1:28");
  });

  it("lists the union with its children", () => {
    const [fam] = p.families ?? [];
    expect(fam?.spouse).toMatchObject({ ref: { id: "maudrenel1:215" }, name: "Jean ROBERT" });
    // From marriage_date_raw (/1893/11/11#), not the display string "Nov. 11, 1893".
    expect(fam?.events[0]).toMatchObject({
      type: "marriage",
      date: { date: "1893-11-11" },
      place: { name: "Cahuzac-sur-Vère" },
    });
    expect(fam?.children?.map((c) => c.ref.id)).toEqual([
      "maudrenel1:229",
      "maudrenel1:230",
      "maudrenel1:20",
    ]);
  });

  it("returns events with notes as plain text", () => {
    expect(p.events[0]).toMatchObject({
      type: "birth",
      date: { date: "1870-11-22" },
      note: 'Née au lieu dit "Roziers".',
    });
    expect(ofType("marriage")).toMatchObject({
      date: { date: "1893-11-11" },
      with: { ref: { id: "maudrenel1:215" } },
    });
    expect(JSON.stringify(p)).not.toContain("<p>");
  });
});

describe("decodeEntities hardening", () => {
  it("leaves an out-of-range entity as written instead of throwing", () => {
    expect(htmlToText("<p>see &#1114112; and &#xFFFFFFFF;</p>")).toBe(
      "see &#1114112; and &#xFFFFFFFF;",
    );
  });
});
