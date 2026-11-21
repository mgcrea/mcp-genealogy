# Genealogy records MCP: design

Date: 2026-11-21. Status: approved in conversation, pending builder check.

## Why

An agent rebuilding one branch of a family tree (118 people, around a person called Georges) spent
8 minutes and about 210k tokens using this server, and then had to write its own script to
normalise what came back. Its feedback, in short:

- **Details in bulk.** `geneanet_get_tree` gives names and years only, so filling in 118 people
  took 118 `geneanet_get_person` calls.
- **Structured output.** Dates and places came as display strings ("1897-04-03, Beauvais sur
  Tescou"), places mixed in INSEE codes, and sources were free text. Normalising them was the
  expensive part of the session, not fetching.
- **Say why a record is empty.** A record with no events at all left the agent guessing that it
  was privacy.
- **Same person in other trees.** Comparing two trees (`dspano`, `rlouvignes`) was guesswork.
- **Index hits with no dates.** The INSEE death-index hit on Geneanet said "between 1900 and
  2025", though the INSEE file has exact dates.

A follow-up proposal widened the scope. The agent needed four record sources (Geneanet, INSEE
deaths, FamilySearch, Geni), and the costly part was turning each one's format into dates, places
and citations. One read-only server that answers in **one shape** solves that once, and makes a
search across every source in one call possible. So this server grows from `mcp-geneanet` into
`mcp-genealogy`.

## Goals

1. One person/event/place/citation shape across every source.
2. Bulk reads: many people per call, within a client's 60 s tool timeout.
3. Say why data is missing (privacy, Premium, absent upstream) instead of returning nothing.
4. GEDCOM 7.0 export with a citation on every fact, as the hand-off to Filiation.
5. A cross-source person search that groups likely matches without merging them.
6. New sources: matchID (INSEE deaths), then Geni, then FamilySearch if access is granted.

## Non-goals

- **No writes anywhere.** Writing a tree is Filiation's job (`filiation_edit`, and later
  `filiation_import`), in a window with undo. This server reads untrusted outside data and
  changes nothing. Keeping the two apart is the reason they are two servers.
- **No place normalisation service.** Turning "Montréal d'Aude" or an INSEE code into a canonical
  place belongs in Filiation (on edit and on import). This server only *splits* what a source
  gives it; it does not geocode or look places up.
- **No parsing of free-text citations.** Tree owners type sources however they like. A parsed
  `{acte, page, register}` would be a guess presented as fact. Structured citation fields are
  filled only when the source itself provides them as separate fields (matchID's certificate
  number, FamilySearch record ids). The same rule already governs dates in `shape.ts`.
- **No automatic merging** of people across sources or trees. Matches are candidates with reasons.

## Anti-goals (failure even if it works)

- A wrong fact that looks certain: a guessed date, a parsed citation, an "inferred" privacy
  reason shown as a known one.
- A cross-source search that hides which source said what.
- One source's breakage (Geneanet markup change, Cloudflare closing the POST gap, an expired Geni
  token) failing a call that other sources could have answered.
- More load on Geneanet than a person browsing by hand. Its terms forbid automated access; the
  1 req/s gate stays.

## Constraints (measured, not assumed)

- **Geneanet has no bulk read.** Six plausible names for GeneWeb's `GraphTreeFull` operation
  (`graph_tree_full`, `graph_full`, `graph_v2_full`, `graph_tree_v2_full`, `graph_asc_full`,
  `graph_tree`) all answered 200 with an empty body on 2026-11-21, which is how Geneanet answers
  an unknown operation. The real operation names live in the tree pages' JavaScript bundles,
  which only a browser can fetch (Cloudflare challenges every GET from Node). So N people cost
  N `person` requests at 1 req/s, and a batch must be capped (see below).
- **Client timeout ≈ 60 s per tool call.** Hence 40 people per batch call at most.
- **matchID** (`https://deces.matchid.io/deces/api/v1/search`): answers anonymous GETs with JSON
  (tested 2026-11-21 with `firstName=Jean&lastName=Dupont&birthDate=1920`). Each person has
  `id`, `name.{first[],last}`, `sex`, `birth`/`death` with `date` as `YYYYMMDD`, and
  `location.{city, code (INSEE), codePostal[], departmentCode, country, countryCode, latitude,
  longitude}`; death adds `certificateId` and `age`; `source` (file year) and `sourceLine` locate
  the row in the INSEE file. Published limits: 1 req/s per user, burst of 20; a free token
  (requested by email, matchid.io/link-api) lifts the burst cap. INSEE opt-outs are applied
  monthly.
- **Geni**: public OAuth 2.0 API with open app registration, active as of May 2026. Needs an app
  id/secret and a user token; see the source section.
- **FamilySearch**: the API is closed to the general public. Access is through an Innovator
  Program application, reportedly limited to organisations with a shipping record. Planned only
  if access is granted.
- **Filiation** imports GEDCOM 5.5.1 and 7.0 and exports 7.0, with `SOUR`/`PAGE` citations
  (`FiliationKit/GEDCOM`). It is a sandboxed Mac app.
- **Portability**: anything committed (CI, scripts) must work with BSD tools and Apple's make
  3.81.

## Approaches considered

| Approach | Trade-off | Verdict |
| --- | --- | --- |
| **One records server, per-source tools plus shared tools** | One schema, one credential profile, cross-source search possible. Each source keeps its own errors and rate gate, so breakage stays local. | **Chosen.** |
| One server per source (geneanet, matchid, geni, familysearch) | Isolation, but four answer formats, and the agent redoes normalisation and cross-source matching every session, which is the cost the feedback is about. Tool count comes out about the same. | Rejected. |
| Records + Filiation in one server | One install, but the server that reads untrusted outside data would also write the user's tree. | Rejected: the read/write boundary is worth the second server. |
| `detail: "full"` on `geneanet_get_tree` instead of a batch tool | Simpler for the agent, but 118 people at 1 req/s is about 2 minutes, past the 60 s timeout. | Rejected unless a real full-graph operation turns up (see recon). |

## Design

### Naming and packaging

- Repo and package: `mgcrea/mcp-genealogy`, `@mgcrea/mcp-genealogy`, bin `genealogy-mcp`
  (npx picks the bin by the unscoped package name; CI already checks this).
- Server name `genealogy`. Bastion profile `prod/geneanet` becomes `prod/genealogy`.
- Per-source tools keep a source prefix: `geneanet_*` (existing names unchanged), `matchid_*`,
  `geni_*`, `familysearch_*`. Shared tools use `genealogy_*`.
- `geneanet_auth_status` becomes `genealogy_status`: settings, adjusted values and, with
  `check: true`, a live probe per source.
- Environment: existing `GENEANET_*` variables keep their names. New sources get their own
  prefix (`MATCHID_*`, `GENI_*`). `GENEALOGY_DEBUG` replaces `GENEANET_DEBUG`, which stays
  accepted as an alias.

### Code layout

```text
src/
  schema/          shared output types + zod, date and place helpers
  sources/
    geneanet/      today's client, proto, records search, shape → schema adapter
    matchid/       client + adapter
    geni/          (later)
  gedcom/          GEDCOM 7.0 writer
  match/           cross-source candidate grouping
  tools/           one file per source + genealogy.ts for shared tools
```

Each source owns its client, its rate gate, its retries and its error type. A source returns
`{ok: true, data} | {ok: false, error, remedy?}` to shared tools, so one source failing never
fails the call.

### The shared shape

Compact JSON, empty values omitted (as today). Types, roughly:

```ts
type Ref = { source: "geneanet" | "matchid" | "geni" | "familysearch"; id: string; url: string };
// geneanet id: "<tree>:<index>"; matchid id: its `id`; geni: "profile-<n>".

type DateValue = {
  date?: string;          // ISO, as precise as known: "1897-04-03", "1897-04", "1897"
  qualifier?: "about" | "maybe" | "before" | "after" | "between" | "or" | "from" | "to";
  dateTo?: string;        // second bound for between / or / from–to
  calendar?: "julian" | "french" | "hebrew";   // omitted = gregorian; date stays in that calendar
  text?: string;          // the source's own wording, only when it could not be parsed
};

type Place = {
  name: string;           // as the source wrote the locality, e.g. "Beauvais-sur-Tescou"
  insee?: string;         // 5 chars: \d{5} or 2[AB]\d{3}
  department?: string;    // name or code, as given
  region?: string;
  country?: string;
  raw?: string;           // full original string when it was split
};

type Citation = {
  source: Ref["source"];
  url?: string;
  title?: string;         // e.g. "INSEE, fichier des personnes décédées, 1978"
  text?: string;          // free text, verbatim (tree owners' sources)
  acte?: string;          // only from structured fields (matchID certificateId)
  page?: string;          // only from structured fields
};

type Event = {
  type: "birth" | "baptism" | "death" | "burial" | "marriage" | "occupation" | string;
  date?: DateValue;
  place?: Place;
  citations?: Citation[];
  with?: Brief;           // spouse for marriage
};

type Brief = { ref: Ref; name: string; born?: string; bornAt?: string; died?: string; diedAt?: string; withheld?: Withheld };

type Withheld =
  | "private"               // the source flagged the person hidden
  | "probably-private"      // inferred: empty record, alive or unknown death status
  | "premium";              // Geneanet archive detail masked as XXXX

type Person = {
  ref: Ref;
  name: string; given?: string; surname?: string; sex?: "male" | "female";
  aliases?: string[]; occupation?: string;
  events: Event[];
  parents?: Brief[]; families?: { spouse?: Brief; events: Event[]; children: Brief[] }[];
  notes?: string; withheld?: Withheld; withheldReason?: string;
};
```

`born`/`died` on a brief are the ISO-or-qualified short form ("1897-04-03", "about 1768").
Dates in `Event` are always the `DateValue` object, so a script never has to parse a string.

**Date parsing (Geneanet).** GeneWeb's raw date grammar (`/<y>/<m>/<d>#` today, plus the
precision prefixes, ranges and calendar suffixes) is parsed fully into `DateValue`. Anything that
does not match is passed through as `text` with no `date`. The builder captures real raw strings
for each prefix from a live tree before writing the parser; `FuzzyDateGEDCOMTests` in Filiation
is a useful cross-check for the qualifier set.

**Place splitting (Geneanet).** GeneWeb places are comma-separated, most specific first
("Cahuzac-sur-Vère, Tarn, Occitanie, France"; some trees insert an INSEE code after the town).
The town is `name`; a token matching the INSEE pattern becomes `insee`; with exactly the
"town, [code], department, region, country" shape, the rest fills those fields. Any other shape
keeps `name` = first token and the whole string in `raw`. No lookup tables.

### Geneanet tools

Existing tools keep their names and inputs; their outputs move to the shared shape.

- `geneanet_search_records`: hits gain `ref` for family-tree hits, and `dates` becomes
  `[{event, date: DateValue}]`. The search page's wording ("Death (between 1900 and 2025)")
  parses into `qualifier: "between"`. Hits whose collection is the INSEE death index get
  `hint: "matchid"`, so the agent knows exact dates are one `matchid_search` away. The two are
  not joined automatically here; `genealogy_search_person` does that.
- `geneanet_search_tree`, `geneanet_get_tree`: briefs use `born`/`bornAt`/`died`/`diedAt`.
  `private: true` becomes `withheld: "private"`.
- `geneanet_get_person`: shared `Person`. When the record has no dates, no places and no events
  and its death status is alive or unknown, it gets `withheld: "probably-private"` and a
  `withheldReason` that says it is inferred. Before shipping, the builder captures a real private
  person's `person` response as a fixture and adjusts the rule to what it actually contains (a
  "x x" name, a flag in fields 50–52, or nothing).
- **New `geneanet_get_people(tree, indexes[1..40], detail: "summary" | "full")`**:
  - `summary` (default): name, sex, vital events with place and citations, occupation, parents
    and spouses as briefs, children count per family. No event list beyond vitals, no notes, no
    witnesses.
  - `full`: the same as `geneanet_get_person` per person.
  - Requests go through the existing 1 req/s gate, sequentially. The tool sends MCP progress
    notifications when the client provides a progress token.
  - Cap of 40 per call. Per-person failures come back as `{ref, error}` in place; the call
    succeeds if any person succeeded.
  - If `withheld` for a person can be read from a graph node the caller passed through, fine;
    otherwise the inference rule above applies.

### matchID tools

- `matchid_search(lastname, firstname?, birthDate?, deathDate?, birthPlace?, deathPlace?, sex?,
  page?, size?)`: maps to the API's query parameters (exact parameter names verified against
  matchid.io/link-api by the builder; the tested call used `firstName`, `lastName`, `birthDate`,
  `size`). Answers `Person` records with birth and death `Event`s, `Place` from `location`
  (`insee` = `code`, `department` = `departmentCode`), and a `Citation` with
  `title: "INSEE, fichier des personnes décédées, <source>"`, `acte: certificateId`, and the
  row (`sourceLine`) in `text`. matchID's own `score` is kept as `score`.
- `matchid_get(id)` only if the API has a by-id route; otherwise left out.
- Pacing: its own gate, 1 req/s. Optional `MATCHID_TOKEN` when set (lifts the burst cap).
  `genealogy_status` reports whether it is set; no token is not an error.

### Geni tools (phase 4)

- `geni_search_profiles`, `geni_get_profile(id)`, `geni_get_immediate_family(id)`: the minimum
  to fetch one record and walk a tree, mapped to the shared shape.
- OAuth 2.0 with app id/secret and a refreshable user token, stored through Bastion like other
  servers' OAuth credentials. The exact flow (desktop vs server-side) is the builder's call after
  reading Geni's docs; the requirement is that a token refresh never needs the user mid-session.
- Own rate gate; honour Geni's rate-limit headers.

### FamilySearch (phase 5, conditional)

Not designed until access is granted. Its adapter would follow the same pattern.

### `genealogy_export_gedcom`

- Input: a list of `Ref`s (any sources), or `{source: "geneanet", tree, index, ancestors,
  descendants}` to export a pedigree directly; `detail` as in `get_people`. Same 40-request cap
  per call; a bigger pedigree is exported in several calls that write **one** file, by passing
  the `file` returned by the first call (`append: true`).
- Output: GEDCOM **7.0**, UTF-8.
  - `HEAD.SOUR` names this server and version.
  - One `SOUR` record per (source, collection or tree): "Geneanet tree rlouvignes",
    "INSEE, fichier des personnes décédées, 1978", with the base URL.
  - Every fact carries a `SOUR` pointer with `PAGE` (the citation's `acte`/`page`/`text`, in that
    order of preference) and the record URL in a `WWW` or `NOTE`.
  - Every person carries `EXID` with `TYPE` = a URI naming the source (e.g.
    `https://gw.geneanet.org/rlouvignes`) and the source id, so Filiation can recognise a person
    it imported before.
  - Dates use 7.0 syntax (`ABT`, `BET … AND …`, `@#DJULIAN@`); `text`-only dates become a `DATE`
    with a `PHRASE`, or a `NOTE` when there is no date at all.
  - Places are written as the original string (`raw` or `name`), with no `MAP` coordinates
    unless the source gave them (matchID does).
  - `withheld` people are exported as name-only individuals with a `NOTE` saying why, so
    family links survive.
- Where it goes: a file under `GENEALOGY_EXPORT_DIR` (default
  `~/Library/Application Support/mcp-genealogy/exports`, created on first use), named
  `<yyyy-mm-dd>-<slug>.ged`. The tool returns `{file, people, families, sources, warnings}`,
  not the file's contents, to keep ~25k tokens per 100 people out of the agent's context.
  How Filiation's sandboxed app reads that file is settled when `filiation_import` is designed
  (a shared folder, a path the user grants, or inline content); if inline turns out to be
  required, the tool grows a `return: "content"` option.

### `genealogy_search_person` (phase 3, after matchID)

- Input: `lastname`, `firstname?`, `born?` / `died?` (year or ISO), `place?`, `sources?`
  (default: every configured source).
- Fan-out: one search per source, in parallel across sources, each through its own gate
  (Geneanet's site-wide search, `matchid_search`, Geni later). Wall time ≈ the slowest source.
- Grouping into **candidates**: two hits group when the normalised names match (accents, case,
  hyphens and first given name), birth or death years are within ±2 where both are known, and,
  if both have a place, the INSEE code or the normalised town name agree. Each group lists its
  hits with `ref`, source, the facts each hit contributed, and `why` (which rules matched).
  Ungrouped hits are listed separately. Nothing is merged; conflicting facts stay side by side.
- Per-source errors appear as `sources: {geneanet: {ok}, matchid: {error, remedy}}`.
- Result size: `limit` per source (default 10) so a common surname cannot flood the context.

### Same person in other trees

Recon first, in Safari: find the request that fills Geneanet's "same person in other trees"
block on a profile page.

- If it is a POST, or a GET Cloudflare does not challenge, expose it as `otherTrees: [Ref]` on
  `geneanet_get_person` (and `summary`).
- If it is blocked, `genealogy_search_person` with the person's own name, years and place,
  filtered to Geneanet family-tree hits from other trees, is the substitute. The tool
  description says so.

## Repo and package migration

Done in this order, each destructive step confirmed with Olivier before it runs:

1. On a branch: rename package, bin, server name, `genealogy_status`, README, Docker script tags,
   `.release-it.json`, CI references.
2. `gh repo rename mcp-genealogy` (GitHub redirects the old URL and remote); update the local
   remote URL.
3. Publish `@mgcrea/mcp-genealogy`.
4. Repoint Bastion: profile `prod/geneanet` → `prod/genealogy` on the new package; check that
   every tool answers.
5. Unpublish `@mgcrea/mcp-geneanet` (all three versions: `0.0.0-stage`, `0.0.0`, `0.1.0`).
   npm allows this only within 72 h of publishing, i.e. **before 2026-11-24 ~09:00 UTC**. If step
   4 is not done by then, deprecate instead:
   `npm deprecate @mgcrea/mcp-geneanet "Renamed to @mgcrea/mcp-genealogy"`.
6. Rename `.studio/mcp-template/memory/2026-11-20-mcp-geneanet-build.md` and add a note there.

## Phases

1. **Rename + shared schema + Geneanet adapter + `geneanet_get_people` + `withheld` + GEDCOM
   export.** Migration steps 1–5 ride with this phase (the unpublish deadline). If the full phase
   cannot land by the deadline, ship the rename alone first as 0.2.0.
2. **matchID** source.
3. **`genealogy_search_person`.**
4. **Geni** source.
5. **FamilySearch**, only if Innovator Program access is granted.

`filiation_import` (with place normalisation and conflicting facts kept side by side, as one undo
step) is designed separately in the Filiation repo. It is useful as soon as phase 1 ships.

## Testing

Unchanged principle: tests run against **real captured** responses, never hand-written ones.
New fixtures to capture: a Geneanet private person; raw dates with each GeneWeb precision prefix,
a range and a Julian date; a place string with an INSEE code; an INSEE-index hit on the site
search; matchID responses (a hit, no hit, a 429); later, Geni profile and family responses.
GEDCOM output is checked by round-tripping through Filiation's importer if it can run headless,
and otherwise by golden files reviewed once by hand. `test/fixtures` stays excluded from oxfmt.

## Recon to do before or during phase 1

- Safari: look in the tree pages' JS bundles for any full-graph or batch operation name
  (`gwHelper.request` callers). If one exists, `geneanet_get_tree` gains `detail: "full"` and
  `get_people` uses it.
- Safari: the request behind "same person in other trees".
- A live private person in a public tree, for the `withheld` rule.

## Left to the builder

- Internal module boundaries beyond the layout above, zod schema details, helper names.
- Exact progress-notification cadence.
- Golden-file vs round-trip GEDCOM testing (see Testing).
- matchID parameter names, after reading its docs.
- Geni OAuth flow choice, within the constraint above.
