import { describe, expect, it } from "vitest";

import { geneanetKeyRefId, geneanetRefId, parseRef, refKey, type RefInput } from "#/schema/ids";
import { ArgumentError } from "#/tools/util";

describe("parseRef", () => {
  it("reads a Geneanet tree index id", () => {
    expect(parseRef({ source: "geneanet", id: "maudrenel1:27" })).toEqual({
      source: "geneanet",
      tree: "maudrenel1",
      index: 27,
    });
  });

  it("reads a Geneanet n/p/oc key id", () => {
    expect(parseRef({ source: "geneanet", id: "maudrenel1:louvignes/marie germaine/0" })).toEqual({
      source: "geneanet",
      tree: "maudrenel1",
      n: "louvignes",
      p: "marie germaine",
      oc: 0,
    });
  });

  it("passes a matchID id through", () => {
    expect(parseRef({ source: "matchid", id: "qlOMgl94qBBi" })).toEqual({
      source: "matchid",
      id: "qlOMgl94qBBi",
    });
  });

  it.each<[RefInput, string]>([
    [{ source: "geneanet", id: "bad tree:1" }, "tree name with a space"],
    [{ source: "geneanet", id: "27" }, "no tree"],
    [{ source: "geneanet", id: "t:-1" }, "negative index"],
    [{ source: "geneanet", id: "t:007" }, "leading zeros in the index"],
    [{ source: "geneanet", id: "t:1.5" }, "fractional index"],
    [{ source: "geneanet", id: "t:" }, "empty person part"],
    [{ source: "geneanet", id: "t:louvignes/marie" }, "key without occurrence"],
    [{ source: "geneanet", id: "t:louvignes/marie/-1" }, "negative occurrence"],
    [{ source: "geneanet", id: "t:louvignes/marie/01" }, "leading zeros in the occurrence"],
    [{ source: "geneanet", id: "t://0" }, "key with empty names"],
    [{ source: "matchid", id: "" }, "empty matchID id"],
    [{ source: "matchid", id: "a b" }, "matchID id with a space"],
    [{ source: "geni", id: "profile-1" }, "source not fetchable yet"],
    [{ source: "familysearch", id: "ABCD-123" }, "source not fetchable yet"],
    [{ source: "foo", id: "1" } as unknown as RefInput, "unknown source"],
  ])("rejects %j (%s) with a remedy", (ref) => {
    let caught: unknown;
    try {
      parseRef(ref);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArgumentError);
    expect((caught as ArgumentError).remedy).toMatch(/<tree>:<index>/);
  });
});

describe("ref id builders", () => {
  it("round-trip a tree index id", () => {
    const id = geneanetRefId("maudrenel1", 27);
    expect(id).toBe("maudrenel1:27");
    expect(parseRef({ source: "geneanet", id })).toEqual({
      source: "geneanet",
      tree: "maudrenel1",
      index: 27,
    });
  });

  it("round-trip a key id", () => {
    const key = { n: "louvignes", p: "marie germaine", oc: 2 };
    const id = geneanetKeyRefId("maudrenel1", key);
    expect(id).toBe("maudrenel1:louvignes/marie germaine/2");
    expect(parseRef({ source: "geneanet", id })).toEqual({
      source: "geneanet",
      tree: "maudrenel1",
      ...key,
    });
  });
});

describe("refKey", () => {
  it("prefixes the id with its source", () => {
    expect(refKey({ source: "geneanet", id: "maudrenel1:27" })).toBe("geneanet:maudrenel1:27");
    expect(refKey({ source: "matchid", id: "qlOMgl94qBBi" })).toBe("matchid:qlOMgl94qBBi");
  });
});
