import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { BUILD_INFO } from "#/build-info";
import { loadConfig } from "#/config";
import {
  binResponse,
  byOperation,
  connect,
  fixture,
  sentMessage,
  type Call,
  type FetchLike,
} from "#test/helpers";

const PERSON_27 = fixture("person-maudrenel1-27.bin");
// The captured person's index is the single varint byte after the field-2 tag (0x10) at offset
// 2, so any index below 128 can be swapped in without touching a length or the framing.
if (PERSON_27[2] !== 0x10 || PERSON_27[3] !== 27) throw new Error("fixture layout changed");

/** The captured maudrenel1:27 answer with its index replaced: one distinct person per index. */
const personAt = (index: number): Uint8Array => {
  if (index >= 128) throw new RangeError("index must fit one varint byte");
  const body = PERSON_27.slice();
  body[3] = index;
  return body;
};

const personRoute = (call: Call): Response => {
  const index = sentMessage(call).int(1) ?? -1;
  return binResponse(index >= 0 && index < 128 ? personAt(index) : new Uint8Array());
};

const routes: FetchLike = byOperation({
  person: personRoute,
  graph_v2: () => binResponse(fixture("graph-maudrenel1-27.bin")),
});

const ref = (id: string) => ({ source: "geneanet", id });

let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "genealogy-export-"));
  env = { GENEALOGY_EXPORT_DIR: dir };
});

const sidecar = (file: string): { refs: { source: string; id: string }[] } =>
  JSON.parse(readFileSync(`${file}.refs.json`, "utf8"));

const personOps = (calls: Call[]): number[] =>
  calls
    .filter((c) => c.url.searchParams.get("arbre") === "person")
    .map((c) => sentMessage(c).int(1) ?? -1);

describe("genealogy_export_gedcom", () => {
  it("writes one GEDCOM file with a sidecar and returns its path, not its contents", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:27")] });
    expect(res).toMatchObject({ isToolError: false, people: 1 });
    expect(res.remaining).toBeUndefined();
    const file = String(res.file);
    expect(file.startsWith(`${dir}/`)).toBe(true);
    expect(basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}-louvignes\.ged$/);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("0 HEAD\n")).toBe(true);
    expect(text).toContain(`2 VERS ${BUILD_INFO.version}`);
    expect(JSON.stringify(res)).not.toContain("0 HEAD");
    expect(sidecar(file).refs).toEqual([ref("maudrenel1:27")]);
  });

  it("writes a key-form ref and the index form it resolves to as one person", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27"), ref("maudrenel1:louvignes/marie germaine/0")],
    });
    expect(res).toMatchObject({ isToolError: false, people: 1 });
    expect(sidecar(String(res.file)).refs).toEqual([ref("maudrenel1:27")]);
  });

  it("fetches at most 40 people per call and grows the same file with append", async () => {
    const h = await connect(env, routes);
    const people = Array.from({ length: 45 }, (_, i) => ref(`maudrenel1:${60 + i}`));
    const first = await h.call("genealogy_export_gedcom", { people });
    expect(first).toMatchObject({ isToolError: false, people: 40 });
    expect(first.remaining).toEqual(people.slice(40));
    expect(String(first.note)).toContain("append");
    expect((first.warnings as string[]).some((w) => w.includes("5 people"))).toBe(true);
    const file = String(first.file);
    expect(readFileSync(file, "utf8").match(/^0 @I\d+@ INDI$/gm)).toHaveLength(40);

    const second = await h.call("genealogy_export_gedcom", { people, file, append: true });
    expect(second).toMatchObject({ isToolError: false, file, people: 45 });
    expect(second.remaining).toBeUndefined();
    expect(readFileSync(file, "utf8").match(/^0 @I\d+@ INDI$/gm)).toHaveLength(45);
    expect(personOps(h.calls())).toHaveLength(45);
  });

  it("keeps the people already in a file when appending others", async () => {
    const h = await connect(env, routes);
    const first = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:60")] });
    const file = String(first.file);
    const second = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:61")],
      file,
      append: true,
    });
    expect(second).toMatchObject({ file, people: 2 });
    expect(sidecar(file).refs).toEqual([ref("maudrenel1:60"), ref("maudrenel1:61")]);
  });

  it("keeps the file's detail when an append gives none", async () => {
    const h = await connect(env, routes);
    const first = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      detail: "full",
    });
    const file = String(first.file);
    expect(sidecar(file)).toMatchObject({ detail: "full" });
    const second = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:61")],
      file,
      append: true,
    });
    expect(second).toMatchObject({ isToolError: false, people: 2 });
    expect(second.note).toBeUndefined();
    expect(sidecar(file)).toMatchObject({ detail: "full" });
    // A full record's notes: event notes and the person's own.
    const text = readFileSync(file, "utf8");
    expect(text).toContain('2 NOTE Née au lieu dit "Roziers".');
    expect(text.match(/^1 NOTE 1893 : /gm)).toHaveLength(2);
  });

  it("re-renders the whole file when an append asks for another detail, and says so", async () => {
    const h = await connect(env, routes);
    const first = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      detail: "full",
    });
    const file = String(first.file);
    const second = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:61")],
      file,
      append: true,
      detail: "summary",
    });
    expect(second).toMatchObject({ isToolError: false, people: 2 });
    expect(second.note).toBe('The whole file was re-rendered at detail "summary" (it was "full").');
    expect(sidecar(file)).toMatchObject({ detail: "summary" });
    expect(readFileSync(file, "utf8")).not.toContain("Roziers");
  });

  it("fails clearly when the pedigree request used up the time budget", async () => {
    let t = 0;
    const slowGraph = byOperation({
      person: personRoute,
      graph_v2: () => {
        t += 50_000; // the graph answered after 50 s
        return binResponse(fixture("graph-maudrenel1-27.bin"));
      },
    });
    const h = await connect(env, slowGraph, { now: () => t });
    const res = await h.call("genealogy_export_gedcom", {
      pedigree: { source: "geneanet", tree: "maudrenel1", index: 27, ancestors: 1 },
    });
    expect(res).toMatchObject({
      isToolError: true,
      error: "Geneanet was too slow to answer the pedigree request; try again.",
    });
    expect(personOps(h.calls())).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("overwrites a named file when append is not set", async () => {
    const h = await connect(env, routes);
    const first = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:60")] });
    const file = String(first.file);
    const second = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:61")],
      file,
    });
    expect(second).toMatchObject({ file, people: 1 });
    expect(sidecar(file).refs).toEqual([ref("maudrenel1:61")]);
  });

  it("exports a pedigree from one graph request: the root and its parents", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      pedigree: { source: "geneanet", tree: "maudrenel1", index: 27, ancestors: 1, descendants: 0 },
    });
    expect(res).toMatchObject({ isToolError: false, people: 3 });
    const ops = h.calls().map((c) => c.url.searchParams.get("arbre"));
    expect(ops[0]).toBe("graph_v2");
    expect(personOps(h.calls())).toEqual([27, 55, 28]);
    expect(sidecar(String(res.file)).refs.map((r) => r.id)).toEqual([
      "maudrenel1:27",
      "maudrenel1:55",
      "maudrenel1:28",
    ]);
  });

  it("adds spouses and children with the default descendants: 1", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      pedigree: { source: "geneanet", tree: "maudrenel1", index: 27, ancestors: 1 },
    });
    const graph = sentMessage(h.calls()[0] as Call);
    expect([graph.int(2), graph.int(3)]).toEqual([2, 2]);
    // The captured graph's descendants: spouse 215, children 229, 230 and 20. Only indexes
    // below 128 have a person body here, so 215, 229 and 230 come back as warnings.
    expect(personOps(h.calls())).toEqual([27, 55, 28, 215, 229, 230, 20]);
    expect(res).toMatchObject({ isToolError: false, people: 4 });
    expect(res.warnings as string[]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^maudrenel1:215: /)]),
    );
    expect(String(res.note)).toContain("holds 4 of 7 people");
  });

  it("says how many people an append left out of the file", async () => {
    const people = Array.from({ length: 40 }, (_, i) => ref(`maudrenel1:${60 + i}`));
    const first = await (await connect(env, routes)).call("genealogy_export_gedcom", { people });
    const file = String(first.file);
    expect(first).toMatchObject({ people: 40 });
    expect(first.note).toBeUndefined();

    // A new server starts with an empty cache: the 40 held people are refetched first.
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:100")],
      file,
      append: true,
    });
    expect(res).toMatchObject({ isToolError: false, file, people: 40 });
    expect(res.remaining).toEqual([ref("maudrenel1:100")]);
    expect(String(res.note)).toContain("The file holds 40 of 41 people");
    expect(String(res.note)).toContain("append: true");
  });

  it("names a new export -2 when the name is taken", async () => {
    const h = await connect(env, routes);
    const first = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:27")] });
    const second = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:27")] });
    expect(String(second.file)).toBe(String(first.file).replace(/\.ged$/, "-2.ged"));
    expect(existsSync(String(first.file))).toBe(true);
  });

  it("creates the export folder on first use", async () => {
    const nested = join(dir, "a", "b");
    const h = await connect({ GENEALOGY_EXPORT_DIR: nested }, routes);
    const res = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:27")] });
    expect(String(res.file).startsWith(`${nested}/`)).toBe(true);
  });

  it("never writes outside the export folder", async () => {
    const h = await connect(env, routes);
    for (const file of ["../x.ged", join(tmpdir(), "x.ged"), "sub/x.ged", "x.txt", ".ged"]) {
      const res = await h.call("genealogy_export_gedcom", {
        people: [ref("maudrenel1:27")],
        file,
      });
      expect(res, file).toMatchObject({ isToolError: true });
      expect(res.remedy, file).toBeTruthy();
    }
    expect(h.calls()).toHaveLength(0);
  });

  it("refuses a file name that is a symbolic link", async () => {
    const outside = mkdtempSync(join(tmpdir(), "genealogy-outside-"));
    symlinkSync(join(outside, "target.ged"), join(dir, "link.ged"));
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      file: "link.ged",
    });
    expect(res).toMatchObject({ isToolError: true });
    expect(String(res.error)).toContain("symbolic link");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("never replaces a .ged it did not write, even without append", async () => {
    writeFileSync(join(dir, "other.ged"), "0 HEAD\n0 TRLR\n");
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      file: "other.ged",
    });
    expect(res).toMatchObject({ isToolError: true });
    expect(res.remedy).toBeTruthy();
    expect(readFileSync(join(dir, "other.ged"), "utf8")).toBe("0 HEAD\n0 TRLR\n");
    expect(readdirSync(dir)).toEqual(["other.ged"]);
  });

  it("leaves no temporary file behind", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:27")] });
    const name = basename(String(res.file));
    expect(readdirSync(dir).toSorted()).toEqual([name, `${name}.refs.json`]);
  });

  it("accepts a bare file name inside the export folder", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      file: "family.ged",
    });
    expect(res).toMatchObject({ isToolError: false, file: join(dir, "family.ged") });
  });

  it("rejects append without file, and appending to a file it did not write", async () => {
    const h = await connect(env, routes);
    const noFile = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      append: true,
    });
    expect(noFile).toMatchObject({ isToolError: true });
    expect(noFile.remedy).toBeTruthy();

    writeFileSync(join(dir, "other.ged"), "0 HEAD\n0 TRLR\n");
    const foreign = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      file: "other.ged",
      append: true,
    });
    expect(foreign).toMatchObject({ isToolError: true });
    expect(readFileSync(join(dir, "other.ged"), "utf8")).toBe("0 HEAD\n0 TRLR\n");
  });

  it("requires exactly one of people and pedigree", async () => {
    const h = await connect(env, routes);
    const neither = await h.call("genealogy_export_gedcom", {});
    expect(neither).toMatchObject({ isToolError: true });
    const both = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27")],
      pedigree: { source: "geneanet", tree: "maudrenel1", index: 27 },
    });
    expect(both).toMatchObject({ isToolError: true });
    expect(h.calls()).toHaveLength(0);
  });

  it("explains that matchID refs cannot be exported yet", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [{ source: "matchid", id: "abc123" }],
    });
    expect(res).toMatchObject({ isToolError: true });
    expect(res.remedy).toBeTruthy();
  });

  it("reports people that could not be read as warnings", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", {
      people: [ref("maudrenel1:27"), ref("maudrenel1:999")],
    });
    expect(res).toMatchObject({ isToolError: false, people: 1 });
    expect((res.warnings as string[]).some((w) => w.includes("maudrenel1:999"))).toBe(true);
  });

  it("writes nothing when no person could be read", async () => {
    const h = await connect(env, routes);
    const res = await h.call("genealogy_export_gedcom", { people: [ref("maudrenel1:999")] });
    expect(res).toMatchObject({ isToolError: true });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("GENEALOGY_EXPORT_DIR", () => {
  it("expands ~ to the home folder", () => {
    expect(loadConfig({ GENEALOGY_EXPORT_DIR: "~/x" }).exportDir).toBe(join(homedir(), "x"));
  });

  it("defaults to the app support folder", () => {
    expect(loadConfig({}).exportDir).toBe(
      join(homedir(), "Library", "Application Support", "mcp-genealogy", "exports"),
    );
  });

  it("drops a relative path with a note rather than guessing a base", () => {
    const config = loadConfig({ GENEALOGY_EXPORT_DIR: "exports" });
    expect(config.exportDir).toBe(loadConfig({}).exportDir);
    expect(config.adjusted.join(" ")).toContain("GENEALOGY_EXPORT_DIR");
  });

  it("is reported by genealogy_status", async () => {
    const res = await (await connect(env)).call("genealogy_status");
    expect(res.exportDir).toBe(dir);
  });
});
