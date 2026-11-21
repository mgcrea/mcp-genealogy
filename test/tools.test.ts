import { describe, expect, it } from "vitest";

import { loadConfig } from "#/config";
import {
  binResponse,
  byOperation,
  connect,
  fixture,
  fixtureText,
  htmlResponse,
  sentMessage,
  type Call,
} from "#test/helpers";

const ALL_TOOLS = [
  "genealogy_export_gedcom",
  "genealogy_status",
  "geneanet_get_people",
  "geneanet_get_person",
  "geneanet_get_tree",
  "geneanet_search_records",
  "geneanet_search_tree",
];

type Rec = Record<string, unknown>;

describe("tool registration", () => {
  // Nothing is gated: no tool needs credentials and none writes to a source.
  // Pinning the exact set keeps adding one, and above all adding a write tool,
  // a deliberate act with a visible diff.
  it("registers the same seven tools with no configuration at all", async () => {
    expect(await (await connect({})).toolNames()).toEqual(ALL_TOOLS);
  });

  it("registers the same set with every setting given", async () => {
    const h = await connect({ GENEANET_TREE: "maudrenel1", GENEANET_MIN_INTERVAL_MS: "2000" });
    expect(await h.toolNames()).toEqual(ALL_TOOLS);
  });

  // The export writes a file in the export folder; every other tool only reads. Pinning the
  // writers keeps adding another one a deliberate act with a visible diff.
  it("marks every tool read-only except the GEDCOM export", async () => {
    const tools = (await (await connect({})).client.listTools()).tools;
    const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writers).toEqual(["genealogy_export_gedcom"]);
    expect(tools.find((t) => t.name === "genealogy_export_gedcom")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    for (const tool of (await (await connect({})).client.listTools()).tools) {
      expect(tool.title, tool.name).toMatch(
        tool.name.startsWith("genealogy_") ? /^Genealogy: / : /^Geneanet: /,
      );
    }
  });

  it("describes every input field, since that is all a model reads before choosing", async () => {
    for (const tool of (await (await connect({})).client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe("genealogy_status", () => {
  it("answers with no configuration and no network", async () => {
    const h = await connect({});
    const res = await h.call("genealogy_status");
    expect((res.sources as Rec).geneanet).toMatchObject({
      credentialsNeeded: false,
      defaultTree: null,
      minIntervalMs: 1000,
    });
    expect(res.adjustedSettings).toBeUndefined();
    expect(h.calls()).toHaveLength(0);
  });

  it("reports settings it had to clamp instead of failing to start", async () => {
    const res = await (
      await connect({ GENEANET_MIN_INTERVAL_MS: "10", GENEANET_TREE: "a/b" })
    ).call("genealogy_status");
    expect(((res.sources as Rec).geneanet as Rec).minIntervalMs).toBe(500);
    const notes = (res.adjustedSettings as string[]).join(" ");
    expect(notes).toContain("GENEANET_MIN_INTERVAL_MS=10 is out of range; using 500");
    expect(notes).toContain("GENEANET_TREE=a/b is not a tree name");
  });

  it("probes both routes on request", async () => {
    const h = await connect({ GENEANET_TREE: "maudrenel1" }, async (url) =>
      new URL(String(url)).host === "en.geneanet.org"
        ? htmlResponse(fixtureText("records-louvignes-cahuzac.html"))
        : binResponse(fixture("search-maudrenel1-louvignes.bin")),
    );
    const res = await h.call("genealogy_status", { check: true });
    expect(((res.sources as Rec).geneanet as Rec).checks).toEqual({
      siteSearch: "ok (16 results for MARTIN)",
      treeApi: "ok (tree maudrenel1 answered)",
    });
  });
});

describe("geneanet_search_tree", () => {
  it("POSTs person_search_list to the tree API with the framed params", async () => {
    const h = await connect(
      {},
      byOperation({
        person_search_list: () => binResponse(fixture("search-maudrenel1-louvignes.bin")),
      }),
    );
    const res = await h.call("geneanet_search_tree", {
      tree: "maudrenel1",
      lastname: "louvignes",
      limit: 10,
    });
    expect(res.isToolError).toBe(false);
    expect(res.count).toBe(6);
    expect((res.persons as Rec[])[0]).toMatchObject({
      ref: { source: "geneanet", id: "maudrenel1:85" },
      father: { ref: { id: "maudrenel1:87" }, born: "about 1768" },
    });
    const [call] = h.calls();
    expect(call?.method).toBe("POST");
    expect(call?.url.toString()).toBe(
      "https://gw.geneanet.org/setup/api/?arbre=person_search_list&sourcename=maudrenel1&lang=en&type=",
    );
    const sent = sentMessage(call as Call);
    expect(sent.string(1)).toBe("louvignes");
    expect(sent.int(3)).toBe(10);
  });

  it("needs a tree when GENEANET_TREE is unset, and says where to find one", async () => {
    const h = await connect({});
    const res = await h.call("geneanet_search_tree", { lastname: "x" });
    expect(res.isToolError).toBe(true);
    expect(String(res.remedy)).toContain("geneanet_search_records");
    expect(h.calls()).toHaveLength(0);
  });

  it("falls back to GENEANET_TREE", async () => {
    const h = await connect(
      { GENEANET_TREE: "maudrenel1" },
      byOperation({
        person_search_list: () => binResponse(fixture("search-maudrenel1-louvignes.bin")),
      }),
    );
    expect((await h.call("geneanet_search_tree", { lastname: "louvignes" })).tree).toBe(
      "maudrenel1",
    );
  });

  it("refuses an empty search", async () => {
    const res = await (await connect({ GENEANET_TREE: "t" })).call("geneanet_search_tree", {});
    expect(res.isToolError).toBe(true);
  });

  it("rejects a tree name with a path in it before sending anything", async () => {
    const h = await connect({});
    const res = await h.call("geneanet_search_tree", { tree: "../setup", lastname: "x" });
    expect(res.rejected).toBe(true);
    expect(h.calls()).toHaveLength(0);
  });

  it("maps 'Basename not found' to a not-found with the fix", async () => {
    const h = await connect({}, async () => binResponse(fixture("person-nosuchtree.bin"), 400));
    const res = await h.call("geneanet_search_tree", { tree: "nosuchtree", lastname: "x" });
    expect(res).toMatchObject({ isToolError: true, status: 404 });
    expect(String(res.error)).toContain('no Geneanet tree named "nosuchtree"');
  });
});

describe("geneanet_get_person", () => {
  it("reads by index in one request", async () => {
    const h = await connect(
      {},
      byOperation({ person: () => binResponse(fixture("person-maudrenel1-27.bin")) }),
    );
    const res = await h.call("geneanet_get_person", { tree: "maudrenel1", index: 27 });
    expect(res).toMatchObject({
      ref: { source: "geneanet", id: "maudrenel1:27" },
      index: 27,
      name: "Marie Germaine LOUVIGNES",
      detail: "full",
      isToolError: false,
    });
    expect(h.calls()).toHaveLength(1);
    const sent = sentMessage(h.calls()[0] as Call);
    expect([sent.int(1), sent.int(3), sent.int(4)]).toEqual([27, 50, 50]);
  });

  it("resolves n/p/oc through a one-node graph first", async () => {
    const h = await connect(
      {},
      byOperation({
        graph_v2: () => binResponse(fixture("graph-maudrenel1-guilhaume-bykey.bin")),
        person: () => binResponse(fixture("person-maudrenel1-27.bin")),
      }),
    );
    await h.call("geneanet_get_person", { tree: "maudrenel1", n: "louvignes", p: "guilhaume" });
    const [lookup, read] = h.calls();
    const id = sentMessage(lookup as Call).message(1);
    expect([id?.string(2), id?.string(3), id?.int(4)]).toEqual(["louvignes", "guilhaume", 0]);
    expect(sentMessage(read as Call).int(1)).toBe(85);
  });

  it("leaves the person it returns in the server's cache", async () => {
    const h = await connect(
      {},
      byOperation({ person: () => binResponse(fixture("person-maudrenel1-27.bin")) }),
    );
    await h.call("geneanet_get_person", { tree: "maudrenel1", index: 27 });
    expect(h.cache.get({ source: "geneanet", id: "maudrenel1:27" })).toMatchObject({
      name: "Marie Germaine LOUVIGNES",
      detail: "full",
    });
  });

  it("aliases the n/p/oc key it was asked by to the index form it resolved", async () => {
    const h = await connect(
      {},
      byOperation({
        graph_v2: () => binResponse(fixture("graph-maudrenel1-guilhaume-bykey.bin")),
        person: () => binResponse(fixture("person-maudrenel1-27.bin")),
      }),
    );
    const res = await h.call("geneanet_get_person", {
      tree: "maudrenel1",
      n: "louvignes",
      p: "guilhaume",
    });
    const key = { source: "geneanet" as const, id: "maudrenel1:louvignes/guilhaume/0" };
    expect(h.cache.canonical(key)).toEqual({
      source: "geneanet",
      id: (res.ref as { id: string }).id,
    });
    expect(h.cache.get(key)?.name).toBe(res.name);
  });

  it("answers a person this session already read from the cache", async () => {
    const h = await connect(
      {},
      byOperation({ person: () => binResponse(fixture("person-maudrenel1-27.bin")) }),
    );
    const first = await h.call("geneanet_get_person", { tree: "maudrenel1", index: 27 });
    const again = await h.call("geneanet_get_person", { tree: "maudrenel1", index: 27 });
    expect(again).toEqual(first);
    expect(h.calls()).toHaveLength(1);
  });

  it("turns the API's empty answer into a not-found", async () => {
    const h = await connect({}, byOperation({ person: () => binResponse(new Uint8Array()) }));
    const res = await h.call("geneanet_get_person", { tree: "maudrenel1", index: 999999 });
    expect(res).toMatchObject({ isToolError: true, status: 404 });
  });

  it("needs an index or both n and p", async () => {
    const res = await (await connect({})).call("geneanet_get_person", { tree: "t", n: "x" });
    expect(res.isToolError).toBe(true);
    expect(String(res.error)).toContain("index");
  });
});

describe("geneanet_get_people", () => {
  const PEOPLE: Record<number, string> = {
    27: "person-maudrenel1-27.bin",
    87: "person-maudrenel1-87-about.bin",
  };
  const personRoute = (call: Call): Response => {
    const name = PEOPLE[sentMessage(call).int(1) ?? -1];
    return binResponse(name ? fixture(name) : new Uint8Array());
  };

  it("rejects an empty list and more than 40 indexes", async () => {
    const h = await connect({});
    const many = Array.from({ length: 41 }, (_, i) => i);
    expect((await h.call("geneanet_get_people", { tree: "t", indexes: [] })).rejected).toBe(true);
    expect((await h.call("geneanet_get_people", { tree: "t", indexes: many })).rejected).toBe(true);
    expect(h.calls()).toHaveLength(0);
  });

  it("answers summary people by default", async () => {
    const h = await connect({}, byOperation({ person: personRoute }));
    const res = await h.call("geneanet_get_people", { tree: "maudrenel1", indexes: [27, 87] });
    expect(res).toMatchObject({ tree: "maudrenel1", detail: "summary", isToolError: false });
    const people = res.people as Rec[];
    expect(people.map((p) => (p.ref as Rec).id)).toEqual(["maudrenel1:27", "maudrenel1:87"]);
    expect(people.every((p) => p.detail === "summary")).toBe(true);
    expect(res.remaining).toBeUndefined();
  });

  it("reports a failed person in place and still succeeds", async () => {
    const h = await connect({}, byOperation({ person: personRoute }));
    const res = await h.call("geneanet_get_people", { tree: "maudrenel1", indexes: [27, 999] });
    expect(res.isToolError).toBe(false);
    expect((res.people as Rec[])[1]).toMatchObject({
      ref: { source: "geneanet", id: "maudrenel1:999" },
      error: expect.stringContaining("999"),
    });
  });

  it("is a tool error only when nobody could be read", async () => {
    const h = await connect({}, byOperation({ person: personRoute }));
    const res = await h.call("geneanet_get_people", { tree: "maudrenel1", indexes: [998, 999] });
    expect(res.isToolError).toBe(true);
    expect((res.people as Rec[]).map((p) => typeof p.error)).toEqual(["string", "string"]);
  });

  it("hands back the indexes it did not reach, with a note", async () => {
    let n = 0;
    const h = await connect(
      {},
      byOperation({
        person: (call) =>
          ++n === 2 ? htmlResponse("<title>Just a moment...</title>", 403) : personRoute(call),
      }),
    );
    const res = await h.call("geneanet_get_people", {
      tree: "maudrenel1",
      indexes: [27, 87, 545, 12],
    });
    expect(res.isToolError).toBe(false);
    expect(res.remaining).toEqual([545, 12]);
    expect(String(res.note)).toContain("remaining");
  });

  it("sends a progress notification after each person when asked", async () => {
    const h = await connect({}, byOperation({ person: personRoute }));
    const seen: { progress: number; total?: number }[] = [];
    await h.client.callTool(
      { name: "geneanet_get_people", arguments: { tree: "maudrenel1", indexes: [27, 87] } },
      { onprogress: (p) => seen.push({ progress: p.progress, total: p.total }) },
    );
    expect(seen).toEqual([
      { progress: 1, total: 2 },
      { progress: 2, total: 2 },
    ]);
  });
});

describe("geneanet_get_tree", () => {
  it("sends generations counted beyond the root", async () => {
    const h = await connect(
      {},
      byOperation({ graph_v2: () => binResponse(fixture("graph-maudrenel1-27.bin")) }),
    );
    const res = await h.call("geneanet_get_tree", {
      tree: "maudrenel1",
      index: 27,
      ancestors: 2,
      descendants: 1,
    });
    expect(res.root).toMatchObject({
      ref: { source: "geneanet", id: "maudrenel1:27" },
      index: 27,
      born: "1870",
      died: "1944",
    });
    const sent = sentMessage(h.calls()[0] as Call);
    expect([sent.message(1)?.int(1), sent.int(2), sent.int(3)]).toEqual([27, 3, 2]);
  });

  it("caps depth in the schema", async () => {
    const res = await (
      await connect({})
    ).call("geneanet_get_tree", { tree: "t", index: 1, ancestors: 11 });
    expect(res.rejected).toBe(true);
  });
});

describe("geneanet_search_records", () => {
  it("POSTs the form fields to /fonds/individus/ with an empty body", async () => {
    const h = await connect({}, async () =>
      htmlResponse(fixtureText("records-louvignes-cahuzac.html")),
    );
    const res = await h.call("geneanet_search_records", {
      lastname: "LOUVIGNES",
      places: ["Cahuzac-sur-Vère"],
      radiusKm: 30,
      from: 1800,
      to: 1900,
      size: 10,
    });
    expect(res).toMatchObject({ total: 16, page: 1, nextPage: 2, isToolError: false });
    expect((res.results as Rec[])[0]).toMatchObject({
      kind: "family_tree",
      ref: { source: "geneanet", id: "maudrenel1:louvignes/marie germaine/0" },
      dates: [{ event: "birth", date: { date: "1870" } }, { event: "death" }],
      tree: "maudrenel1",
    });
    const [call] = h.calls();
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe("");
    expect(call?.url.pathname).toBe("/fonds/individus/");
    expect(call?.url.searchParams.get("nom")).toBe("LOUVIGNES");
    expect(call?.url.searchParams.get("place__0__")).toBe("Cahuzac-sur-Vère");
    expect(String(res.searchUrl)).toContain(
      "https://en.geneanet.org/fonds/individus/?go=1&nom=LOUVIGNES",
    );
  });

  it("names Cloudflare when it is Cloudflare that answered", async () => {
    const h = await connect({}, async () =>
      htmlResponse("<title>Just a moment...</title>", 403, { "cf-mitigated": "challenge" }),
    );
    const res = await h.call("geneanet_search_records", { lastname: "X" });
    expect(res).toMatchObject({ isToolError: true, status: 403 });
    expect(String(res.error)).toContain("Cloudflare");
    expect(String(res.remedy)).toContain("Safari");
  });

  it("reports a markup change as an error, never as zero results", async () => {
    const h = await connect({}, async () => htmlResponse("<html>new design</html>"));
    const res = await h.call("geneanet_search_records", { lastname: "X" });
    expect(res).toMatchObject({ isToolError: true, status: 502 });
  });

  it("requires a surname, as Geneanet does", async () => {
    expect((await (await connect({})).call("geneanet_search_records", {})).rejected).toBe(true);
  });
});

describe("retries", () => {
  it("retries a 503 and then succeeds", async () => {
    let n = 0;
    const h = await connect({ GENEANET_MAX_RETRIES: "1" }, async () => {
      n += 1;
      return n === 1
        ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
        : binResponse(fixture("search-maudrenel1-louvignes.bin"));
    });
    const res = await h.call("geneanet_search_tree", { tree: "maudrenel1", lastname: "louvignes" });
    expect(res.isToolError).toBe(false);
    expect(h.calls()).toHaveLength(2);
  });
});

describe("timeouts", () => {
  it("maps a body that stalls past the deadline to a clear error, without retrying", async () => {
    const h = await connect(
      { GENEANET_MAX_RETRIES: "2" },
      async () =>
        new Response(
          new ReadableStream({
            pull: (c) => c.error(new DOMException("The operation timed out.", "TimeoutError")),
          }),
          { status: 200 },
        ),
    );
    const res = await h.call("geneanet_search_tree", { tree: "maudrenel1", lastname: "x" });
    expect(res).toMatchObject({ isToolError: true, status: 0 });
    expect(String(res.error)).toContain("did not answer within 20000 ms");
    expect(h.calls()).toHaveLength(1);
  });
});

describe("single-request deadline", () => {
  // Each read of this clock moves it 30 s on: the deadline taken at the call's start (+55 s)
  // is too close by the time the request would go out, so a tool that passes one never sends it.
  it.each([
    ["geneanet_search_tree", { tree: "t", lastname: "x" }],
    ["geneanet_get_person", { tree: "t", index: 1 }],
    ["geneanet_get_tree", { tree: "t", index: 1 }],
    ["geneanet_search_records", { lastname: "x" }],
  ])("%s stops at ~55 s with a try-again remedy", async (name, args) => {
    let t = 0;
    const h = await connect({}, undefined, {
      now: () => {
        t += 30_000;
        return t;
      },
    });
    const res = await h.call(name, args);
    expect(res).toMatchObject({ isToolError: true, status: 0 });
    expect(String(res.error)).toContain("No time left before this call's deadline");
    expect(String(res.remedy)).toMatch(/slow.*try again/);
    expect(h.calls()).toHaveLength(0);
  });
});

describe("geneanet_search_tree limit", () => {
  it("says when the limit may have cut results off", async () => {
    const h = await connect(
      {},
      byOperation({
        person_search_list: () => binResponse(fixture("search-maudrenel1-louvignes.bin")),
      }),
    );
    const res = await h.call("geneanet_search_tree", {
      tree: "maudrenel1",
      lastname: "louvignes",
      limit: 6,
    });
    expect(res.limitReached).toBeDefined();
  });
});

describe("loadConfig", () => {
  it("never throws on bad values (rule 2)", () => {
    const c = loadConfig({
      GENEANET_TREE_API_URL: "not a url",
      GENEANET_TIMEOUT_MS: "soon",
      GENEANET_MAX_RETRIES: "99",
    });
    expect(c.treeBaseUrl).toBe("https://gw.geneanet.org");
    expect(c.timeoutMs).toBe(20_000);
    expect(c.maxRetries).toBe(5);
    expect(c.adjusted).toHaveLength(3);
  });
});
