import { describe, expect, it } from "vitest";

import { PersonCache } from "#/cache";
import { loadConfig } from "#/config";
import type { RefInput } from "#/schema/ids";
import type { Person } from "#/schema/types";
import { toPerson } from "#/sources/geneanet/adapter";
import { DeadlineError, GeneanetApiError } from "#/sources/geneanet/errors";
import { fetchPeople, isFailure } from "#/sources/geneanet/fetch";
import { GeneanetClient } from "#/sources/geneanet/geneanet";
import { decodePerson } from "#/sources/geneanet/proto/messages";
import { ProtoMessage, unframeResponse } from "#/sources/geneanet/proto/wire";
import {
  binResponse,
  byOperation,
  fixture,
  htmlResponse,
  sentMessage,
  type Call,
  type FetchLike,
} from "#test/helpers";

const BASE = "https://gw.geneanet.org";

/** The captured person each index answers with; any other index gets an empty body. */
const PEOPLE: Record<number, string> = {
  27: "person-maudrenel1-27.bin",
  87: "person-maudrenel1-87-about.bin",
  545: "person-maudrenel1-545-before.bin",
};

const personRoute = (call: Call): Response => {
  const name = PEOPLE[sentMessage(call).int(1) ?? -1];
  return binResponse(name ? fixture(name) : new Uint8Array());
};

const ref = (id: string): RefInput => ({ source: "geneanet", id });

type SetupOptions = { now?: () => number; maxRetries?: number; timeoutMs?: number };

const setup = (impl: FetchLike, cache = new PersonCache(), opts: SetupOptions = {}) => {
  const config = loadConfig({});
  const calls: Call[] = [];
  const client = new GeneanetClient({
    treeBaseUrl: config.treeBaseUrl,
    siteBaseUrl: config.siteBaseUrl,
    lang: config.lang,
    minIntervalMs: config.minIntervalMs,
    maxRetries: opts.maxRetries ?? 0,
    timeoutMs: opts.timeoutMs ?? config.timeoutMs,
    gate: async () => {},
    ...(opts.now ? { now: opts.now } : {}),
    fetch: (async (url: unknown, init?: unknown) => {
      const i = (init ?? {}) as RequestInit;
      const call = { url: new URL(String(url)), body: String(i.body ?? ""), method: "POST" };
      calls.push(call);
      return impl(url, init);
    }) as typeof fetch,
  });
  return { client, cache, calls, ops: () => calls.map((c) => c.url.searchParams.get("arbre")) };
};

const OPTS = { detail: "summary", max: 40, budgetMs: 45_000 } as const;

/** A request that never answers: it ends only when its signal aborts. */
const hang = (init: unknown): Promise<Response> =>
  new Promise((_, reject) => {
    const signal = (init as RequestInit).signal as AbortSignal;
    signal.addEventListener("abort", () => reject(signal.reason));
  });

/** Index 87 never answers; the others as personRoute. */
const hangOn87: FetchLike = async (url, init) => {
  const call = {
    url: new URL(String(url)),
    body: String((init as RequestInit).body),
    method: "POST",
  };
  return sentMessage(call).int(1) === 87 ? hang(init) : personRoute(call);
};

const fullPerson = (name: string): Person =>
  toPerson(
    BASE,
    "maudrenel1",
    decodePerson(new ProtoMessage(unframeResponse(fixture(name)))),
    "full",
  );

describe("fetchPeople", () => {
  it("fetches every person, in input order, one request each", async () => {
    const s = setup(byOperation({ person: personRoute }));
    const res = await fetchPeople(
      s,
      [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:545")],
      OPTS,
    );
    expect(res.people.map((p) => p.ref.id)).toEqual([
      "maudrenel1:27",
      "maudrenel1:87",
      "maudrenel1:545",
    ]);
    expect(res.people.every((p) => !isFailure(p) && p.detail === "summary")).toBe(true);
    expect(res.remaining).toEqual([]);
    expect(s.ops()).toEqual(["person", "person", "person"]);
  });

  it("puts every fetched person in the cache", async () => {
    const s = setup(byOperation({ person: personRoute }));
    await fetchPeople(s, [ref("maudrenel1:27")], OPTS);
    expect(s.cache.get(ref("maudrenel1:27"))?.name).toBe("Marie Germaine LOUVIGNES");
  });

  it("serves a cached full person without a request", async () => {
    const s = setup(byOperation({ person: personRoute }));
    const held = fullPerson("person-maudrenel1-27.bin");
    s.cache.put(held);
    const res = await fetchPeople(s, [ref("maudrenel1:27")], { ...OPTS, detail: "full" });
    expect(res.people).toEqual([held]);
    expect(s.calls).toHaveLength(0);
  });

  it("fetches again when only a summary is held and full is asked for", async () => {
    const s = setup(byOperation({ person: personRoute }));
    await fetchPeople(s, [ref("maudrenel1:27")], OPTS);
    const res = await fetchPeople(s, [ref("maudrenel1:27")], { ...OPTS, detail: "full" });
    expect(res.people[0]).toMatchObject({ detail: "full" });
    expect(s.calls).toHaveLength(2);
  });

  it("fetches again for full detail when the held record's events were cut short", async () => {
    const s = setup(byOperation({ person: personRoute }));
    s.cache.put({ ...fullPerson("person-maudrenel1-27.bin"), eventsTruncated: "Showing 1 of 9" });
    await fetchPeople(s, [ref("maudrenel1:27")], { ...OPTS, detail: "full" });
    expect(s.calls).toHaveLength(1);
  });

  it("reads a key-form ref and its index form in one batch with one person request", async () => {
    const s = setup(
      byOperation({
        person: personRoute,
        graph_v2: () => binResponse(fixture("graph-maudrenel1-27.bin")),
      }),
    );
    const key = ref("maudrenel1:louvignes/marie germaine/0");
    const res = await fetchPeople(s, [ref("maudrenel1:27"), key], OPTS);
    expect(res.people.map((p) => p.ref.id)).toEqual(["maudrenel1:27", "maudrenel1:27"]);
    expect(s.ops()).toEqual(["person", "graph_v2"]);
    expect(s.cache.canonical(key)).toEqual(ref("maudrenel1:27"));
  });

  it("serves cache hits outside the max", async () => {
    const s = setup(byOperation({ person: personRoute }));
    s.cache.put(fullPerson("person-maudrenel1-87-about.bin"));
    const res = await fetchPeople(s, [ref("maudrenel1:27"), ref("maudrenel1:87")], {
      ...OPTS,
      max: 1,
    });
    expect(res.people.map((p) => p.ref.id)).toEqual(["maudrenel1:27", "maudrenel1:87"]);
    expect(res.remaining).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it("asks once for a person named twice", async () => {
    const s = setup(byOperation({ person: personRoute }));
    const res = await fetchPeople(s, [ref("maudrenel1:27"), ref("maudrenel1:27")], OPTS);
    expect(res.people).toHaveLength(2);
    expect(s.calls).toHaveLength(1);
  });

  it("reports a missing person in place and reads the others", async () => {
    const s = setup(byOperation({ person: personRoute }));
    const res = await fetchPeople(
      s,
      [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:999")],
      OPTS,
    );
    expect(isFailure(res.people[0]!)).toBe(false);
    expect(isFailure(res.people[1]!)).toBe(false);
    expect(res.people[2]).toEqual({
      ref: { source: "geneanet", id: "maudrenel1:999", url: `${BASE}/maudrenel1?lang=en&i=999` },
      error: "Tree maudrenel1 has no person with index 999.",
      remedy: expect.stringContaining("geneanet_search_tree"),
    });
    expect(res.remaining).toEqual([]);
  });

  it("reports a ref it cannot read in place, without a request", async () => {
    const s = setup(byOperation({ person: personRoute }));
    const res = await fetchPeople(
      s,
      [ref("maudrenel1:x/y"), { source: "matchid", id: "abc" }],
      OPTS,
    );
    expect(res.people.map((p) => isFailure(p) && p.remedy !== undefined)).toEqual([true, true]);
    expect(s.calls).toHaveLength(0);
  });

  it("stops at max and hands the rest back", async () => {
    const s = setup(byOperation({ person: personRoute }));
    const refs = [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:545")];
    const res = await fetchPeople(s, refs, { ...OPTS, max: 2 });
    expect(res.people).toHaveLength(2);
    expect(res.remaining).toEqual([refs[2]]);
    expect(s.calls).toHaveLength(2);
  });

  it("stops scheduling once the time budget is spent", async () => {
    let t = 0;
    const s = setup(
      byOperation({
        person: (call) => {
          t += 46_000; // the first request alone overruns 45 s
          return personRoute(call);
        },
      }),
      new PersonCache(),
      { now: () => t },
    );
    const refs = [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:545")];
    const res = await fetchPeople(s, refs, OPTS);
    expect(res.people.map((p) => p.ref.id)).toEqual(["maudrenel1:27"]);
    expect(res.remaining).toEqual([refs[1], refs[2]]);
    expect(s.calls).toHaveLength(1);
  });

  it("cuts off a request still running at the deadline, handing it and the rest back", async () => {
    const s = setup(hangOn87, new PersonCache(), { now: () => 0 });
    const refs = [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:545")];
    const began = Date.now();
    const res = await fetchPeople(s, refs, { ...OPTS, deadlineMs: 1050 });
    expect(Date.now() - began).toBeLessThan(5000); // the deadline, not the 20 s timeout
    expect(res.people.map((p) => p.ref.id)).toEqual(["maudrenel1:27"]);
    expect(res.remaining).toEqual([refs[1], refs[2]]);
    expect(s.calls).toHaveLength(2);
  });

  it("sends nothing once the deadline is under a second away", async () => {
    let t = 0;
    const s = setup(
      byOperation({
        person: (call) => {
          t = 54_500;
          return personRoute(call);
        },
      }),
      new PersonCache(),
      { now: () => t },
    );
    const refs = [ref("maudrenel1:27"), ref("maudrenel1:87")];
    const res = await fetchPeople(s, refs, { ...OPTS, budgetMs: 60_000 });
    expect(res.people.map((p) => p.ref.id)).toEqual(["maudrenel1:27"]);
    expect(res.remaining).toEqual([refs[1]]);
    expect(s.calls).toHaveLength(1);
  });

  it("keeps an upstream timeout that is not the deadline as an in-place failure", async () => {
    const s = setup(hangOn87, new PersonCache(), { now: () => 0, timeoutMs: 50 });
    const refs = [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:545")];
    const res = await fetchPeople(s, refs, OPTS);
    expect(res.people[1]).toMatchObject({
      ref: { id: "maudrenel1:87" },
      error: expect.stringContaining("did not answer within 50 ms"),
    });
    expect(isFailure(res.people[2]!)).toBe(false);
    expect(res.remaining).toEqual([]);
  });

  it("projects a cached full person down to a summary for a summary request", async () => {
    const s = setup(byOperation({ person: personRoute }));
    s.cache.put(fullPerson("person-maudrenel1-27.bin"));
    const res = await fetchPeople(s, [ref("maudrenel1:27")], OPTS);
    const summary = toPerson(
      BASE,
      "maudrenel1",
      decodePerson(new ProtoMessage(unframeResponse(fixture("person-maudrenel1-27.bin")))),
      "summary",
    );
    expect(res.people).toEqual([summary]);
    expect(s.calls).toHaveLength(0);
  });

  it("resolves a key-form ref with one graph_v2, then aliases it", async () => {
    const s = setup(
      byOperation({
        graph_v2: () => binResponse(fixture("graph-maudrenel1-guilhaume-bykey.bin")),
        person: () => binResponse(fixture("person-maudrenel1-27.bin")),
      }),
    );
    const key = ref("maudrenel1:louvignes/guilhaume/0");
    const res = await fetchPeople(s, [key], OPTS);
    expect(s.ops()).toEqual(["graph_v2", "person"]);
    expect(sentMessage(s.calls[1]!).int(1)).toBe(85);
    const person = res.people[0] as Person;
    expect(s.cache.canonical(key)).toEqual({ source: "geneanet", id: person.ref.id });
    expect(person.ref.id).toMatch(/^maudrenel1:\d+$/);

    await fetchPeople(s, [key], OPTS);
    expect(s.calls).toHaveLength(2); // the alias and the cache answer the second time
  });

  it("skips graph_v2 for an aliased key whose person has expired", async () => {
    let t = 0;
    const cache = new PersonCache({ ttlMs: 1000, now: () => t });
    const s = setup(
      byOperation({
        graph_v2: () => binResponse(fixture("graph-maudrenel1-guilhaume-bykey.bin")),
        person: () => binResponse(fixture("person-maudrenel1-27.bin")),
      }),
      cache,
    );
    const key = ref("maudrenel1:louvignes/guilhaume/0");
    await fetchPeople(s, [key], OPTS);
    t = 5000;
    await fetchPeople(s, [key], OPTS);
    expect(s.ops()).toEqual(["graph_v2", "person", "person"]);
  });

  it("stops the batch on a Cloudflare challenge, reporting it in place once", async () => {
    let n = 0;
    const s = setup(
      byOperation({
        person: (call) =>
          ++n === 2 ? htmlResponse("<title>Just a moment...</title>", 403) : personRoute(call),
      }),
    );
    const refs = [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:545")];
    const res = await fetchPeople(s, refs, OPTS);
    expect(res.people).toHaveLength(2);
    expect(isFailure(res.people[0]!)).toBe(false);
    expect(res.people[1]).toMatchObject({
      ref: { id: "maudrenel1:87" },
      error: expect.any(String),
    });
    expect(res.remaining).toEqual([refs[2]]);
    expect(s.calls).toHaveLength(2);
  });

  it("reports progress after each person", async () => {
    const s = setup(byOperation({ person: personRoute }));
    s.cache.put(fullPerson("person-maudrenel1-27.bin"));
    const seen: [number, number][] = [];
    await fetchPeople(s, [ref("maudrenel1:27"), ref("maudrenel1:87"), ref("maudrenel1:999")], {
      ...OPTS,
      onProgress: (done, total) => {
        seen.push([done, total]);
      },
    });
    expect(seen).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });
});

describe("GeneanetClient.treeApi deadline", () => {
  const message = new Uint8Array([8, 27]);

  it("does not send when the deadline is under a second away", async () => {
    const s = setup(byOperation({ person: personRoute }), new PersonCache(), { now: () => 0 });
    await expect(
      s.client.treeApi("person", "maudrenel1", message, { deadline: 500 }),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(s.calls).toHaveLength(0);
  });

  it("does not retry when the backoff would cross the deadline", async () => {
    const s = setup(async () => new Response("busy", { status: 503 }), new PersonCache(), {
      now: () => 0,
      maxRetries: 2,
    });
    // The first backoff is 1 s, leaving 0.5 s: under the 1 s an attempt needs.
    await expect(
      s.client.treeApi("person", "maudrenel1", message, { deadline: 1500 }),
    ).rejects.toBeInstanceOf(DeadlineError);
    expect(s.calls).toHaveLength(1);
  });

  it("still retries when the backoff fits before the deadline", async () => {
    let n = 0;
    const s = setup(
      async () =>
        ++n === 1
          ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
          : binResponse(fixture("person-maudrenel1-27.bin")),
      new PersonCache(),
      { now: () => 0, maxRetries: 1 },
    );
    await s.client.treeApi("person", "maudrenel1", message, { deadline: 10_000 });
    expect(s.calls).toHaveLength(2);
  });

  it("keeps the plain error without a deadline", async () => {
    const s = setup(async () => new Response("busy", { status: 503 }), new PersonCache(), {
      now: () => 0,
    });
    const err = await s.client.treeApi("person", "maudrenel1", message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeneanetApiError);
    expect(err).not.toBeInstanceOf(DeadlineError);
  });
});
