import { describe, expect, it } from "vitest";

import { PersonCache } from "#/cache";
import type { Person } from "#/schema/types";

const person = (
  id: string,
  detail: Person["detail"] = "full",
  name = "Marie LOUVIGNES",
): Person => ({
  ref: { source: "geneanet", id, url: `https://gw.geneanet.org/t?i=${id}` },
  name,
  events: [],
  detail,
});

describe("PersonCache", () => {
  it("returns what was put, by ref", () => {
    const cache = new PersonCache();
    const p = person("t:27");
    cache.put(p);
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBe(p);
    expect(cache.get({ source: "geneanet", id: "t:28" })).toBeUndefined();
  });

  it("keeps sources apart", () => {
    const cache = new PersonCache();
    cache.put(person("t:27"));
    expect(cache.get({ source: "matchid", id: "t:27" })).toBeUndefined();
  });

  it("never replaces a full record with a summary", () => {
    const cache = new PersonCache();
    const full = person("t:27", "full");
    cache.put(full);
    cache.put(person("t:27", "summary"));
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBe(full);
  });

  it("replaces a summary with a full record", () => {
    const cache = new PersonCache();
    cache.put(person("t:27", "summary"));
    const full = person("t:27", "full");
    cache.put(full);
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBe(full);
  });

  it("replaces a full record with a newer full one", () => {
    const cache = new PersonCache();
    cache.put(person("t:27", "full", "Old"));
    cache.put(person("t:27", "full", "New"));
    expect(cache.get({ source: "geneanet", id: "t:27" })?.name).toBe("New");
  });

  it("keeps a complete full record over a full one whose events were cut short", () => {
    const cache = new PersonCache();
    const complete = person("t:27", "full");
    cache.put(complete);
    cache.put({ ...person("t:27", "full"), eventsTruncated: "Showing 5 of 9 events" });
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBe(complete);
  });

  it("replaces a cut-short full record with any newer full one", () => {
    const cache = new PersonCache();
    cache.put({ ...person("t:27", "full"), eventsTruncated: "Showing 5 of 9 events" });
    const newer = { ...person("t:27", "full"), eventsTruncated: "Showing 8 of 9 events" };
    cache.put(newer);
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBe(newer);
  });

  it("resolves a key-form ref through its alias to the index-form person", () => {
    const cache = new PersonCache();
    const p = person("t:27");
    cache.put(p);
    cache.alias({ source: "geneanet", id: "t:a/b/0" }, { source: "geneanet", id: "t:27" });
    expect(cache.get({ source: "geneanet", id: "t:a/b/0" })).toBe(p);
    expect(cache.canonical({ source: "geneanet", id: "t:a/b/0" })).toEqual({
      source: "geneanet",
      id: "t:27",
    });
  });

  it("gives an unaliased ref back as it came", () => {
    const cache = new PersonCache();
    expect(cache.canonical({ source: "geneanet", id: "t:27" })).toEqual({
      source: "geneanet",
      id: "t:27",
    });
  });

  it("evicts the least recently read person past max", () => {
    const cache = new PersonCache({ max: 2 });
    cache.put(person("t:1"));
    cache.put(person("t:2"));
    cache.get({ source: "geneanet", id: "t:1" }); // t:2 is now the least recently read
    cache.put(person("t:3"));
    expect(cache.get({ source: "geneanet", id: "t:2" })).toBeUndefined();
    expect(cache.get({ source: "geneanet", id: "t:1" })).toBeDefined();
    expect(cache.get({ source: "geneanet", id: "t:3" })).toBeDefined();
  });

  it("forgets a person past ttlMs", () => {
    let now = 0;
    const cache = new PersonCache({ ttlMs: 1000, now: () => now });
    cache.put(person("t:27"));
    now = 1000;
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBeDefined();
    now = 1001;
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBeUndefined();
  });

  it("lets a summary replace an expired full record", () => {
    let now = 0;
    const cache = new PersonCache({ ttlMs: 1000, now: () => now });
    cache.put(person("t:27", "full"));
    now = 2000;
    const summary = person("t:27", "summary");
    cache.put(summary);
    expect(cache.get({ source: "geneanet", id: "t:27" })).toBe(summary);
  });
});
