# Genealogy records MCP, phase (a): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `mcp-geneanet` into `mcp-genealogy` phase (a): the shared person/event/date/place/citation schema, Geneanet answering in it, `geneanet_get_people` (bulk), `withheld`, an in-memory cache, `genealogy_export_gedcom` (GEDCOM 7.0 file), and `genealogy_status`.

**Architecture:** Today's Geneanet code moves under `src/sources/geneanet/` unchanged, then gains an adapter that maps its decoded protobuf/HTML into `src/schema/` types. Tools return schema types. A process-wide LRU cache holds every shaped person by global id; the GEDCOM writer is a pure function over cached people, and the export tool resolves ids through cache → fetcher.

**Tech Stack:** TypeScript (ESM, `#/*` imports), `@modelcontextprotocol/server` 2.4, Zod 4, vitest, oxlint/oxfmt, tsdown. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-21-genealogy-records-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Read-only: no write tool is registered, ever. Every tool keeps `annotations: { readOnlyHint: true, openWorldHint: true }`.
- Existing `geneanet_*` tool names and `GENEANET_*` env vars are unchanged.
- Every tool call finishes inside ~55 s: batches cap at 40 people and stop scheduling new requests after a 45 s wall-clock budget, returning the rest in `remaining`.
- Geneanet pacing stays one shared gate, 1 req/s default, floor 500 ms (`src/config.ts`).
- Compact JSON, empty values omitted (`opt()` pattern); no indentation.
- No guessed values: `acte`/`page`/`register` only from a source field with that meaning; a date form not recognised keeps `text` only; a `between` spanning more than 30 years keeps `text` only.
- Tests run against real captured fixtures in `test/fixtures` (never reformatted: it is in `.oxfmtrc.json` `ignorePatterns`); no live calls in the suite. New fixtures are captured live with a throwaway script, saved byte for byte.
- Titles: `geneanet_*` tools start `Geneanet: `, `genealogy_*` tools start `Genealogy: `.
- CI-facing files (workflow, scripts) stay portable (BSD tools, no GNU-only flags).
- `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` green at the end of every task.

## Review Focus

1. **The same person under two id forms in one export** (`geneanet:t:27` and `geneanet:t:louvignes/marie germaine/0`) must become one `INDI`, not two. Owner: Task 7 (cache alias) and Task 10 (export test).
2. **One bad index in a batch** (unknown, or private) must not fail the other 39: it comes back as `{id, error}` or with `withheld`. Owner: Task 8.
3. **Odd place strings** (`"Paris 14e, 75114, Paris, Île-de-France, France"`, `"Tarn"`, `", , France"`, a trailing comma) must never shift a part into the wrong slot. Owner: Task 4.
4. **Links to people outside the export** must not leave a dangling `@I…@` pointer: dropped, counted in `droppedLinks`. Owner: Task 9.
5. **A slow upstream during a batch** (retries, 20 s timeouts) must not push the call past the client's timeout: the 45 s budget stops scheduling and returns `remaining`. Owner: Task 8.

---

### Task 0: Branch, worktree, rename identity, `genealogy_status`

**Files:**
- Modify: `.gitignore` (add `.claude/worktrees`), `package.json` (name `@mgcrea/mcp-genealogy`, bin `genealogy-mcp`, description, keywords add `genealogy`, `matchid`), `src/build-info.ts` (fallback name), `scripts/docker-build.sh` (image `mgcrea/mcp-genealogy`), `README.md` (title and intro only; full rewrite in Task 11), `.github/workflows/ci.yml` (smoke-test grep `"name":"(geneanet|genealogy)_…"` and expected list), `src/tools/index.ts`
- Rename: `src/tools/status.ts` → registers `genealogy_status` instead of `geneanet_auth_status`
- Test: `test/tools.test.ts`

**Interfaces:**
- Produces: `registerStatusTools(server, client, ctx)` registering `genealogy_status` with the same `check` input. Output: `{ sources: { geneanet: {credentialsNeeded:false, defaultTree, lang, minIntervalMs, treeApi, site, checks?} }, exportDir?, adjustedSettings? }` (`exportDir` added in Task 10).

- [ ] **Step 1:** Commit `.gitignore` with `.claude/worktrees` on `main`, then create the worktree `.claude/worktrees/genealogy-a` on branch `feat/genealogy-phase-a` and `pnpm install` there. All later tasks run in the worktree.
- [ ] **Step 2: Failing tests.** In `test/tools.test.ts`: `ALL_TOOLS` becomes `["genealogy_status","geneanet_get_person","geneanet_get_tree","geneanet_search_records","geneanet_search_tree"]`; the title test becomes: `expect(tool.title).toMatch(tool.name.startsWith("genealogy_") ? /^Genealogy: / : /^Geneanet: /)`; the existing auth_status tests call `genealogy_status` and read `res.sources.geneanet.*`.
- [ ] **Step 3:** Run `pnpm test`. Expected: FAIL on the tool set and status tests.
- [ ] **Step 4:** Implement the rename and `genealogy_status` (title `Genealogy: Status`; description names each source's checks).
- [ ] **Step 5:** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`. Expected: all pass.
- [ ] **Step 6:** Commit `feat: rename to mcp-genealogy, genealogy_status replaces geneanet_auth_status`.

### Task 1: Move Geneanet code under `src/sources/geneanet/`

Pure move. No behaviour change, no test assertion change.

**Files:**
- Move: `src/client/{geneanet,errors,log}.ts` → `src/sources/geneanet/` (`log.ts` → `src/log.ts`, it is shared), `src/proto/*` → `src/sources/geneanet/proto/`, `src/records/search.ts` → `src/sources/geneanet/records.ts`, `src/client/shape.ts` → `src/sources/geneanet/shape.ts`
- Modify: every importer (`src/server.ts`, `src/tools/*.ts`, `test/*.ts`)

- [ ] **Step 1:** `git mv` the files; fix imports.
- [ ] **Step 2:** `pnpm typecheck && pnpm test`. Expected: same test count as before the move, all pass.
- [ ] **Step 3:** Commit `refactor: move Geneanet code under src/sources/geneanet`.

### Task 2: Schema types and ids

**Files:**
- Create: `src/schema/types.ts`, `src/schema/ids.ts`
- Test: `test/schema-ids.test.ts`

**Interfaces:**
- Produces (`types.ts`): `DateValue`, `Place`, `Citation`, `Event`, `Brief`, `Withheld`, `Person`, exactly as in the spec's "Shared schema" block. `Person` also allows the Geneanet extras `tree?: string; index?: number; treeRoot?: true; directAncestorOfTreeRoot?: true; eventsTruncated?: string; deathStatus?: string; detail: "summary" | "full" | "record"` (`record` = a search hit with no fetchable record).
- Produces (`ids.ts`):
  ```ts
  type ParsedId =
    | { source: "geneanet"; tree: string; index: number }
    | { source: "geneanet"; tree: string; n: string; p: string; oc: number }
    | { source: "geneanet-record"; hash: string }
    | { source: "matchid"; id: string };
  parseId(id: string): ParsedId            // throws ArgumentError with a remedy on anything else
  geneanetId(tree: string, index: number): string
  geneanetKeyId(tree: string, key: PersonKey): string
  recordId(url: string): string            // "geneanet:record:" + first 8 hex of sha1(url), node:crypto
  matchidId(id: string): string
  ```

- [ ] **Step 1: Failing tests.** `parseId("geneanet:maudrenel1:27")` → `{source:"geneanet",tree:"maudrenel1",index:27}`; `parseId("geneanet:maudrenel1:louvignes/marie germaine/0")` → key form with `oc: 0`; `parseId("geneanet:record:3f9a1c07")` → record form; `parseId("matchid:qlOMgl94qBBi")`; round-trips of each builder; `recordId("https://example.org/x")` matches `/^geneanet:record:[0-9a-f]{8}$/` and is stable; `parseId("geneanet:bad tree:1")`, `parseId("foo:1")`, `parseId("geneanet:t:-1")` throw `ArgumentError`. Tree names validate with `TREE_NAME` from `src/config.ts`.
- [ ] **Step 2:** `pnpm vitest run test/schema-ids.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement both files.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: shared schema types and global ids`.

### Task 3: Dates (GeneWeb raw, Geneanet wording)

**Files:**
- Create: `src/sources/geneanet/dates.ts`, `scripts/capture.ts` (throwaway capture helper, kept for future captures; not part of the build)
- Create fixtures: `test/fixtures/person-<tree>-<index>-<form>.bin`, one per raw-date form found
- Test: `test/dates.test.ts`
- Modify: `src/sources/geneanet/shape.ts` (`isoFromRaw` replaced by `fromRaw`)

**Interfaces:**
- Produces:
  ```ts
  fromRaw(raw: string | undefined, display: string | undefined): DateValue | undefined
  fromWording(line: string): { event: string; date?: DateValue } // one site-search "dates" line
  fromDisplayEn(date: string | undefined, lang: string): DateValue | undefined // today's MM/DD/YYYY rule
  ```

- [ ] **Step 1: Capture.** Write `scripts/capture.ts`: given `op`, `tree` and a request (index, or search names), call `GeneanetClient.treeApi` and write the raw HTTP body (before unframing) to `test/fixtures/<name>.bin`, plus the site-search HTML for a query. Run it with `pnpm tsx scripts/capture.ts …`. Using `geneanet_search_tree` on large public trees (e.g. `maudrenel1`, or others found through `geneanet_search_records`), find and capture people whose dates show each of: about, maybe, before, after, between/range, "or", a Julian or French-republican date, a year-only, a month-year. Write down, in `proto/README.md` under a new "Raw dates" heading, every `date_raw` form seen next to its display form. Stop after 30 minutes of searching; any form not found stays unparsed (`text`).
- [ ] **Step 2: Failing tests**, using only forms captured in Step 1 plus these pinned ones: `fromRaw("/1841/2/13#", "Feb. 13, 1841")` → `{iso:"1841-02-13"}`; `fromRaw("/1896/0/0#", …)` → `{iso:"1896"}`; `fromRaw("/1896/3/0#", …)` → `{iso:"1896-03"}`; `fromRaw(undefined, "about 1768")` → `{text:"about 1768"}`; `fromRaw("garbage", "x")` → `{text:"x"}`; each captured qualifier form → its `qualifier`/`to`/`calendar`. `fromWording("Birth 1897")` → `{event:"birth", date:{iso:"1897"}}`; `fromWording("Birth about 1768")` → `about`; `fromWording("Death before 1900")` → `before`; `fromWording("Marriage (between 1825 and 1875)")` → `{event:"marriage", date:{iso:"1825", qualifier:"between", to:"1875"}}`; `fromWording("Death (between 1900 and 2025)")` → `{event:"death", date:{text:"between 1900 and 2025"}}` (span > 30); `fromWording("Mention 18th century")` → `{event:"mention", date:{text:"18th century"}}`. `fromDisplayEn("02/13/1841","en")` → `{iso:"1841-02-13"}`; `fromDisplayEn("13/02/1841","fr")` → `{text:"13/02/1841"}`.
- [ ] **Step 3:** Run `pnpm vitest run test/dates.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement. `text` is present only when `iso` is absent or the display wording says more than `iso` + qualifier (e.g. a phrase).
- [ ] **Step 5:** Run. Expected: PASS. Full suite still green (shape tests that asserted ISO strings are updated to `DateValue` in Task 5, so keep `isoFromRaw` exported until then).
- [ ] **Step 6:** Commit `feat: parse GeneWeb raw dates and Geneanet search wording into DateValue`.

### Task 4: Places

**Files:**
- Create: `src/sources/geneanet/places.ts`
- Test: `test/places.test.ts`

**Interfaces:**
- Produces: `splitPlace(raw: string | undefined): Place | undefined`

Algorithm (spec "Place rules"): trim; split on `,`, trim each part; drop trailing empty parts; if no non-empty part, `undefined`. Remove the first part matching `/^(\d{5}|2[AB]\d{3})$/` into `insee`. Then with remaining parts `r` (length `k`): `name = r[0]`; if `k >= 4`: `country = r[k-1]`, `region = r[k-2]`, `department = r[k-3]`; if `k === 3`: `department = r[1]`, `country = r[2]` _(call: three parts is town, department, country in Geneanet's data)_; if `k === 2`: `department = r[1]`. Parts between `name` and `department` when `k > 4` are not dropped: `text` keeps the original string. Empty parts keep their slot but are omitted from the output.

- [ ] **Step 1: Failing tests:** `"Cahuzac-sur-Vère, Tarn, Occitanie, France"` → `{name:"Cahuzac-sur-Vère", department:"Tarn", region:"Occitanie", country:"France"}`; `"Beauvais-sur-Tescou, 82014, Tarn-et-Garonne, Occitanie, France"` → adds `insee:"82014"`; `"Ajaccio, 2A004, Corse-du-Sud, Corse, France"` → `insee:"2A004"`; `"Paris 14e, 75114, Paris, Île-de-France, France"` → `{name:"Paris 14e", insee:"75114", department:"Paris", region:"Île-de-France", country:"France"}`; `"Tarn"` → `{name:"Tarn"}`; `"Lisle-sur-Tarn, Tarn"` → `{name, department}`; `", , France"` → `{name:"", …}` is not allowed: expect `{name:"France", text:", , France"}` _(call: a string with no locality keeps its only part as name and the original as text)_; `"Albi, Tarn, Occitanie, France,"` same as without the trailing comma; `"A, B, C, D, E, F"` → `{name:"A", department:"D", region:"E", country:"F", text:"A, B, C, D, E, F"}`; `""` and `undefined` → `undefined`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat: split Geneanet place strings into Place`.

### Task 5: Geneanet person adapter, `withheld`, `geneanet_get_person` on the schema

**Files:**
- Create: `src/sources/geneanet/adapter.ts`
- Create fixture: `test/fixtures/person-<tree>-<index>-private.bin` (and the `graph_v2` around it if needed)
- Modify: `src/sources/geneanet/proto/messages.ts` (decode any visibility field found), `src/tools/trees.ts` (`geneanet_get_person`), `src/sources/geneanet/shape.ts` (keep only what the adapter still uses)
- Test: `test/adapter.test.ts`, update `test/shape.test.ts` / `test/tools.test.ts` assertions for `get_person`

**Interfaces:**
- Consumes: `fromRaw`, `splitPlace`, ids builders, schema types.
- Produces:
  ```ts
  toPerson(base: string, tree: string, p: DecodedPerson, detail: "summary" | "full"): Person
  toBrief(tree: string, sp: SimplePerson): Brief
  geneanetCitation(tree: string, url: string, text?: string): Citation
  // { source:"geneanet", title:`Geneanet tree ${tree}`, url, text }
  ```

Mapping rules: vitals become `events` with `type` birth/baptism/death/burial (date from the matching raw event, as today's `vital()` does), place via `splitPlace`, `citations: [geneanetCitation(tree, profileUrl, sourceText)]` (the citation is always present: the profile URL is the citation even with no source text). Event types: GeneWeb type 0–3 as above, 100 → `marriage`, divorce → `divorce`, occupation/residence where GeneWeb's type says so, else `other` with `label` = the event name. Families: `{spouse: toBrief, union?, children: toBrief[], events?: [marriage event with place and citation]}`. When the death status is not plainly "dead" (alive, died young, …), `Person.deathStatus` carries today's wording _(call: keep today's signal, flat; no event is invented for it)_. `summary` drops events other than the four vitals and marriage, `notes`, witnesses, per-event notes. `withheld`:
- `"private"` when the record carries a visibility signal found in Step 1;
- else `"probably-private"` when the record has no dates, no places, no events, and `death.type` is 0 (alive) or 4 (unknown), with `withheldReason: "Geneanet returned the name only; the tree hides living or private people from visitors (inferred: the record itself does not say)."`;
- `Brief.withheld = "private"` when `SimplePerson.hidden`.

- [ ] **Step 1: Capture a private person.** Find a tree node with `private: true` in `geneanet_get_tree` output (descendant generations of a recent root are likely), capture its `person` response, and dump every top-level field number and value (as done for `person-maudrenel1-27.bin`: fields 1, 39, 48, 50–52 are undecoded today). Compare with the public fixture. If a field differs in a way that marks visibility, decode it in `decodePerson` as `visible: boolean` and use it for `"private"`; record the finding in `proto/README.md`.
- [ ] **Step 2: Failing tests** against `person-maudrenel1-27.bin`: `toPerson(..., "full")` has `id:"geneanet:maudrenel1:27"`, `name:"Marie Germaine LOUVIGNES"`, an event `{type:"birth", date:{iso:"1870-11-22"}, place:{name:"Cahuzac-sur-Vère", department:"Tarn", region:"Occitanie", country:"France"}}` whose `citations[0].url` is the profile URL, and a death event in Saint-Étienne, Loire; parents as `Brief`s with `id` and `born` as `DateValue`; `summary` has no `notes` and only vital + marriage events; `JSON.stringify(summary).length < JSON.stringify(full).length / 3` _(spec: aim under a third)_; the private fixture → `withheld` per Step 1's finding, with `withheldReason`.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement the adapter; `geneanet_get_person` returns `toPerson(…, "full")` and puts it in the cache (Task 7 adds the cache; until then, no-op).
- [ ] **Step 5:** Update `get_person` assertions in existing tests to the new shape. Run full suite. Expected: PASS.
- [ ] **Step 6:** Commit `feat: geneanet_get_person answers in the shared schema, with withheld`.

### Task 6: Tree, tree search and site search on the schema

**Files:**
- Modify: `src/sources/geneanet/adapter.ts` (graph and search mapping), `src/sources/geneanet/records.ts` (hit shape), `src/tools/trees.ts`, `src/tools/records.ts`
- Test: `test/adapter.test.ts`, `test/records.test.ts`, `test/tools.test.ts`

**Interfaces:**
- Produces:
  - `geneanet_get_tree`: every node gains `id` and `withheld` (from `hidden`); `dates` becomes `born?`/`died?` `DateValue`s parsed from the node's display `dates` (`"1841-1907"` style: years only → `{iso}`; anything else → `{text}`). Graph resolution (`shapeGraph`) is otherwise unchanged.
  - `geneanet_search_tree`: persons gain `id`; `father`/`mother`/`spouses` become `Brief`s (dates via `fromDisplayEn`).
  - `geneanet_search_records`: each hit becomes `{id, kind, name, spouse?, relationship?, events: [{type?, label, date?: DateValue, place?: Place}], citation: Citation, url, tree?, n?, p?, oc?}`. `id` = `geneanetKeyId` for family-tree hits, `recordId(url)` otherwise. Dates from `fromWording`; each place via `splitPlace`, attached to the event its icon names (birth/marriage/death), else listed as `{label:"place", place}`. Citation: `{source:"geneanet", title: hit.source ?? kind, url}`. Every non-tree hit is also cached as a `Person` with `detail:"record"` (Task 7).

- [ ] **Step 1: Failing tests** against existing fixtures: `graph-maudrenel1-27.bin` nodes carry `id` matching `/^geneanet:maudrenel1:\d+$/`; a hidden node has `withheld:"private"`; `search-maudrenel1-louvignes.bin` persons carry `id` and their `father.born` is a `DateValue`; `records-louvignes-cahuzac.html` family-tree hits have key-form ids that `parseId` accepts, non-tree hits have `geneanet:record:` ids, and a "Marriage (between 1825 and 1875)" hit (as captured in the fixture) has `{iso:"1825", qualifier:"between", to:"1875"}`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: tree, tree search and site search answer in the shared schema`.

### Task 7: Cache

**Files:**
- Create: `src/cache.ts`
- Modify: `src/server.ts` (one `PersonCache` per server, passed in `ToolContext`), `src/tools/index.ts` (`ToolContext` gains `cache`), tools that produce persons (`get_person`, `search_records`)
- Test: `test/cache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  class PersonCache {
    constructor(opts?: { max?: number; ttlMs?: number; now?: () => number }) // 5000, 3_600_000
    get(id: string): Person | undefined          // resolves aliases
    put(p: Person): void                         // keyed by p.id; never replaces "full" with "summary"
    alias(from: string, to: string): void        // key-form id → index-form id
    canonical(id: string): string                // id after aliases
  }
  ```
  LRU via `Map` insertion order (delete + set on read). Expired entries are dropped on read.

- [ ] **Step 1: Failing tests:** put/get round-trip; `put(summary)` after `put(full)` keeps full; `put(full)` after `put(summary)` replaces; `alias("geneanet:t:a/b/0","geneanet:t:27")` then `get("geneanet:t:a/b/0")` returns the index-form person and `canonical` returns `"geneanet:t:27"`; over `max` evicts least recently read; past `ttlMs` (injected `now`) returns `undefined`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and wire.
- [ ] **Step 4:** Run full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: in-memory person cache with id aliases`.

### Task 8: Fetcher and `geneanet_get_people`

**Files:**
- Create: `src/sources/geneanet/fetch.ts`
- Modify: `src/tools/trees.ts` (register `geneanet_get_people`; `get_person` reuses the fetcher), `test/tools.test.ts` (`ALL_TOOLS` gains `geneanet_get_people`), `.github/workflows/ci.yml` (expected list)
- Test: `test/fetch.test.ts`, `test/tools.test.ts`

**Interfaces:**
- Consumes: `PersonCache`, `toPerson`, `parseId`, `GeneanetClient`.
- Produces:
  ```ts
  type FetchResult = { people: Person[]; errors: { id: string; error: string; remedy?: string }[]; remaining: string[] };
  fetchPeople(
    deps: { client: GeneanetClient; cache: PersonCache; base: string; now?: () => number },
    ids: string[],                       // any geneanet id form; record ids come from cache only
    opts: { detail: "summary" | "full"; max: number; budgetMs: number; onProgress?: (done: number, total: number) => void },
  ): Promise<FetchResult>
  ```
  Order: cache hits first (free, not counted against `max`), then fetch in input order. A key-form id costs one `graph_v2` (as `indexFor` does today) and registers an alias. Stop scheduling when `max` fetches are done or `now() - start > budgetMs`; unprocessed ids go to `remaining`. A `GeneanetApiError` per id lands in `errors` (404 → the existing `notFound` message and remedy); a `BlockedError` stops the batch (every later id to `remaining`) and is reported once in `errors`. A `geneanet:record:` id not in cache → error "Search hits are only held for an hour; run the search again."
- `geneanet_get_people` input: `tree` (as `treeArg`), `indexes: number[]` (1–40, ints ≥ 0), `detail` (`"summary"` default). Calls `fetchPeople` with `max: 40`, `budgetMs: 45_000`. Output: `{tree, detail, people, errors?, remaining?}`; `remaining` as indexes, with a one-line note to call again with them. Progress: when the request has a progress token, send `notifications/progress` after each person (use the SDK 2.4 handler's second argument; check its type for the notification sender).

- [ ] **Step 1: Failing tests** in `test/fetch.test.ts` with a mocked client (use `connect()` + `byOperation` from `test/helpers.ts`, `person` route serving `person-maudrenel1-27.bin`): 3 indexes, all fetched, 3 `person` requests; a cached full person costs no request; index 999 answering an empty body → `errors[0].id === "geneanet:maudrenel1:999"` while the others succeed _(Review Focus 2)_; `max: 2` with 3 uncached → `remaining` has the third; an injected `now` that jumps 46 s after the first fetch → the rest in `remaining` _(Review Focus 5)_; a key-form id → one `graph_v2` then one `person`, and `cache.canonical(keyId)` is the index id; a 403 Cloudflare challenge on the second → `errors` has it once, third in `remaining`. In `test/tools.test.ts`: `geneanet_get_people` rejects 41 indexes and an empty list (schema), and returns `detail:"summary"` people by default.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: geneanet_get_people, bulk reads within the time budget`.

### Task 9: GEDCOM 7.0 writer

**Files:**
- Create: `src/gedcom/write.ts`, `test/fixtures/gedcom/*.ged` (golden files)
- Test: `test/gedcom.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ExportInput = { people: Person[]; same: string[][]; anchor?: string };
  type ExportStats = { people: number; families: number; citations: number; droppedLinks: number };
  writeGedcom(input: ExportInput, meta: { date: string /* YYYY-MM-DD */; version: string }): { text: string; stats: ExportStats }
  ```

Rules (spec "`genealogy_export_gedcom`"), the ones a writer must not guess:
- Header: `0 HEAD` / `1 GEDC` / `2 VERS 7.0` / `1 SOUR mcp-genealogy` / `2 VERS <version>` / `1 DATE <D MON YYYY>` / `1 PLAC` / `2 FORM City, INSEE, Department, Region, Country`. Ends with `0 TRLR`. LF line endings, UTF-8, no BOM.
- Xrefs: `@I1@…` in output order (anchor first, then input order), `@F1@…`, `@S1@…`.
- A `same` group → one `INDI`: `NAME` from its first member; every member's events, each keeping its own citations; one `EXID` per member. Two disagreeing births stay two `BIRT`s.
- `NAME` as `Given /Surname/`.
- Dates: `about` → `ABT`, `before` → `BEF`, `after` → `AFT`, `between` → `BET x AND y`, `from` → `FROM x TO y`; `maybe` and `or` have no GEDCOM form: write the `iso` date bare with a `PHRASE` holding the source wording (`text`, else `"maybe 1768"` / `"1768 or 1769"`). `CAL` and `EST` are never written. Calendar: `JULIAN`/`FRENCH_R`/`HEBREW` prefix. A `DateValue` with only `text` → an empty `2 DATE` with `3 PHRASE <text>` (7.0's DateValue may be empty). Months as `JAN…DEC`.
- `PLAC` = `name, insee, department, region, country` with empty slots kept (`"Cahuzac-sur-Vère, , Tarn, Occitanie, France"`).
- Citations: `SOUR @Sx@` (one record per distinct `source`+`title`, with `TITL`), `3 PAGE <locator> <url>` per spec: locator = `acte`/`page`/`register` joined with `, ` (prefixed `acte ` for acte), else `text` cut to 200 characters, then the URL in `<…>`.
- `FAM` per distinct couple among included people (from `families` and from `parents`), `HUSB`/`WIFE` by sex (unknown sex takes the free slot), `CHIL` only for included people, `MARR` with its events. Any link to a person not included is skipped and counted in `droppedLinks` _(Review Focus 4)_.
- `withheld` → `INDI` with `NAME` and `1 NOTE Withheld by <source>: <withheldReason or "private">`, nothing else.
- Text values: newlines → `CONT` lines; a value starting with `@` is written `@@…`.
- `EXID` `TYPE`: `https://gw.geneanet.org` for `geneanet` and `geneanet-record`, `https://deces.matchid.io` for `matchid`.

- [ ] **Step 1: Failing tests:** build `Person`s with the Task 5 adapter from `person-maudrenel1-27.bin` (full) plus two hand-written `Person`s: a `matchid`-sourced one (birth `1929-10-22` Beauvais-sur-Tescou insee 81024, death `2009-01-25` Lafrançaise, citation `{source:"matchid", title:"INSEE, fichier des personnes décédées 2009", acte:"03", register:"INSEE 2009, line 71182", url:"https://deces.matchid.io/id/qlOMgl94qBBi"}`) and a Geneanet one for the same Georges with birth `{iso:"1929", qualifier:"about"}`. Assert against golden files: `one-person.ged` (the maudrenel1 person, with parents included as `Person`s built from its own briefs → one `FAM`); `same-group.ged` (`same: [[geneanet Georges, matchid Georges]]` → one `INDI` with two `BIRT`s, one `ABT 1929`, one `22 OCT 1929`, two `EXID`s, the matchID `PAGE` = `acte 03, INSEE 2009, line 71182 <https://deces.matchid.io/id/qlOMgl94qBBi>`); plus unit assertions: a child whose other parent is not included → no dangling pointer and `droppedLinks === 1`; a note with `"line1\nline2"` → `CONT`; a value `"@home"` → `@@home`; a withheld person → name and note only; `between 1825 and 1875` → `BET 1825 AND 1875`; `maybe 1768` → `DATE 1768` + `PHRASE`.
- [ ] **Step 2:** Write the golden files by hand from the rules above, then run. Expected: FAIL (writer missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Check `same-group.ged` once by feeding its `DATE` values to Filiation's `FuzzyDate+GEDCOM` parser tests, or by reading it against the GEDCOM 7.0 spec's DATE grammar; note which in the commit message.
- [ ] **Step 5:** Commit `feat: GEDCOM 7.0 writer`.

### Task 10: `genealogy_export_gedcom` and `GENEALOGY_EXPORT_DIR`

**Files:**
- Create: `src/tools/export.ts`
- Modify: `src/config.ts` (`exportDir`, from `GENEALOGY_EXPORT_DIR`, default `~/Documents/Genealogy Exports`, `~` expanded with `os.homedir()`), `src/tools/index.ts`, `src/tools/status.ts` (report `exportDir`), `test/tools.test.ts` (`ALL_TOOLS` gains `genealogy_export_gedcom`), `.github/workflows/ci.yml`, `.env.example`
- Test: `test/export.test.ts`

**Interfaces:**
- Consumes: `fetchPeople`, `PersonCache`, `writeGedcom`, `parseId`.
- Input: `ids: string[]` (1–500), `same?: string[][]` (every id in `same` must also be in `ids`, else `ArgumentError`), `anchor?: string` (must be in `ids`), `detail` (`"summary"` default), `filename?` (`/^[\w .,()-]+\.ged$/`, no path separators).
- Behaviour: canonicalise every id through the cache (so two forms of one person collapse, _Review Focus 1_); `fetchPeople(…, {max: 40, budgetMs: 45_000})` for the missing ones; if `remaining` or `errors` is non-empty, write nothing and return `{written:false, resolved, remaining, errors}` with a note to call again with the same arguments. Otherwise write `<exportDir>/<filename or default>` (default `<anchor or first person's surname, lower-case, ascii>-<YYYY-MM-DD>.ged`; an existing file gets `-2`, `-3`…), creating the directory. Return `{written:true, path, ...stats, detail, ...(detail==="summary" ? {note:"Summary detail: vital events, occupations and families only."} : {})}`.
- Title `Genealogy: Export GEDCOM`; description says the file goes to the export folder, that pointing `GENEALOGY_EXPORT_DIR` at Filiation's granted folder lets a Filiation agent read it, and that people are fetched at most 40 per call.

- [ ] **Step 1: Failing tests** (export dir = a `mkdtemp` folder via `GENEALOGY_EXPORT_DIR`): exporting `["geneanet:maudrenel1:27"]` writes one file whose text starts `0 HEAD` and returns `people:1`; exporting `["geneanet:maudrenel1:27", "geneanet:maudrenel1:louvignes/marie germaine/0"]` (the second resolving to index 27 via the `graph-maudrenel1-*` fixture) → `people:1` _(Review Focus 1)_; 45 uncached ids → `written:false`, 5 in `remaining`, no file; a second call with the same ids → `written:true`; `same` naming an id not in `ids` → error with remedy; `filename:"../x.ged"` rejected; same filename twice → second gets `-2`; `loadConfig({GENEALOGY_EXPORT_DIR:"~/x"}).exportDir` is `${homedir()}/x`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: genealogy_export_gedcom writes GEDCOM 7.0 to the export folder`.

### Task 11: "Same person in other trees" recon (timeboxed), docs, live check

**Files:**
- Modify: `README.md` (rewrite around sources: Geneanet now, matchID and Geni next; the shared schema; ids table; export folder and Filiation; terms of use kept), `proto/README.md` (raw dates, visibility, other-trees finding), `.env.example`, `.studio`-style build note is out of scope
- Possibly modify: `src/sources/geneanet/proto/messages.ts`, `src/sources/geneanet/adapter.ts`, `src/tools/trees.ts` (only if the recon succeeds)

- [ ] **Step 1: Recon, 30 minutes at most.** In Safari (cupertino-safari tools), open a Geneanet profile page that shows the "same person in other trees" block and record the network request that fills it (`apple_safari_network_record` / `network_list`). If it is a POST, or a GET that answers a plain Node `fetch` without a Cloudflare challenge, add `otherTrees: Brief[]` (ids in key form) to `geneanet_get_person`'s full detail with a captured fixture and a test asserting at least one entry. Otherwise write the finding (URL, method, why it is unusable) in `proto/README.md` and change nothing else; phase (c) covers the need.
- [ ] **Step 2:** Rewrite `README.md` as listed.
- [ ] **Step 3: Live check** with a throwaway script (not committed) through the built server over stdio: `geneanet_get_people` on 5 indexes of `maudrenel1`, `geneanet_search_records` for LOUVIGNES, `genealogy_export_gedcom` of those 5 into a temp `GENEALOGY_EXPORT_DIR`; open the `.ged` and check it by eye against the rules in Task 9.
- [ ] **Step 4:** `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`. Expected: all pass. Run the CI smoke-test block locally against `dist/cli.js`; expected tool list: `genealogy_export_gedcom`, `genealogy_status`, `geneanet_get_people`, `geneanet_get_person`, `geneanet_get_tree`, `geneanet_search_records`, `geneanet_search_tree`.
- [ ] **Step 5:** Commit `docs: README for mcp-genealogy, recon notes`.

### After the branch is merged (not a task; the user's or a follow-up)

- Rename the directory `mcp-geneanet` → `mcp-genealogy` once the worktree is removed.
- Rename the GitHub repo and the Bastion profile `prod/geneanet` → `prod/genealogy`; publish `@mgcrea/mcp-genealogy` and point Bastion at it.
