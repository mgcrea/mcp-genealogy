# Phase (a): where the build departs from the plan and the spec

The spec was rewritten after the plan was written. These are the rulings the build followed; the spec itself was not edited (it is owned separately), so its `Place` type and place-splitting rule still describe the earlier `insee`-only form. See rules 19 and 20 before phase (c).

The spec `docs/superpowers/specs/2026-11-21-genealogy-records-design.md` was rewritten after the plan
was written. The spec is the binding authority. Where a task brief (extracted from the plan)
disagrees with the spec, the rules below win over the brief. Read the spec section each rule names.

## Identity (spec "The shared shape": `Ref`)

1. Output identity is `ref: Ref` = `{source, id, url}` on every `Person` and `Brief`, never a bare
   string id. Per-person failures are `{ref, error}`.
2. `Ref.id` forms: Geneanet `"<tree>:<index>"` (e.g. `"maudrenel1:27"`); for a Geneanet family-tree
   search hit that has no index, `"<tree>:<n>/<p>/<oc>"` (e.g. `"maudrenel1:louvignes/marie germaine/0"`),
   accepted anywhere a Geneanet ref is and resolved to the index form on first fetch (one `graph_v2`
   request; the cache keeps the alias). matchID: its own `id`.
3. `src/schema/ids.ts` is internal plumbing over `Ref`:
   - `refKey(ref: {source: Ref["source"]; id: string}): string` → `` `${source}:${id}` `` (cache key).
   - `parseRef(ref: {source: Ref["source"]; id: string}): ParsedRef`, throwing `ArgumentError` with a
     remedy; `ParsedRef = {source:"geneanet"; tree; index} | {source:"geneanet"; tree; n; p; oc} | {source:"matchid"; id}`.
   - `geneanetRefId(tree, index): string` and `geneanetKeyRefId(tree, key: PersonKey): string`.
   - No `geneanet:record:` ids and no `recordId`: the spec gives non-tree search hits no ref.
4. Tool inputs that name people from any source (the export) take `Ref`-shaped objects
   `{source, id}` (`url` optional on input). Tools scoped to Geneanet keep their native args
   (`tree` + `index`, `n`/`p`/`oc`).

## Types (spec "The shared shape", already in `src/schema/types.ts`)

5. `DateValue` is `{date?, qualifier?, dateTo?, calendar?, text?}`; qualifiers include `"to"`.
   `text` only when the source wording could not be parsed.
6. `Brief.born`/`died` are short strings: the ISO date, or `"<qualifier> <date>"` (`"about 1768"`,
   `"between 1825 and 1875"`), or the source's text. `Event.date` is always a `DateValue`.
7. `Place` has `raw` (not `text`). `Citation` has no `register`; matchID's `sourceLine` goes in `text`.
8. `Withheld` includes `"premium"`: a Geneanet search hit whose name or dates show the `XXXX` mask.
9. `Person.parents` is `Brief[]`. Families are `{spouse?, events, children?, childCount?}`:
   `full` detail carries `children: Brief[]`; `summary` carries `childCount` only (spec
   "Geneanet tools": "children count per family"). `Person.detail` is `"summary" | "full"`.

## Parsing

10. Places (spec "Place splitting"): only the exact shape `town, [INSEE], department, region,
    country` (4 parts, or 5 with the INSEE token second) fills `department`/`region`/`country`, with
    `raw` = the original string. Any other shape: `name` = first token, `insee` if a token matches,
    `raw` = the whole string. No 2- or 3-part slot rules.
11. Site-search wording (spec "Geneanet tools"): `"Death (between 1900 and 2025)"` parses into
    `{qualifier:"between", date:"1900", dateTo:"2025"}`, whatever the span. Hits whose collection is
    the INSEE death index get `hint: "matchid"`. The plan's "more than 30 years keeps text" rule is
    withdrawn.

## `geneanet_get_people` (spec "Geneanet tools")

12. Per-person failures come back in place in `people` as `{ref, error, remedy?}`. The call is an
    error only when no person succeeded. The 40 cap and the 45 s scheduling budget (plan) stand.

## `genealogy_export_gedcom` (spec "`genealogy_export_gedcom`")

13. Input: `people: Ref[]` OR `pedigree: {source:"geneanet", tree, index, ancestors, descendants}`;
    `detail` (`"summary"` default); `file?` + `append?: true` to add to a file an earlier call wrote.
    No `same` groups, no `anchor` (the spec has neither).
14. One file across calls: every call regenerates the whole file from the people it already holds
    plus the new ones. The refs already in a file are kept in a sidecar `<file>.refs.json`; their
    people come from the cache, or are refetched within the same 40-request cap.
15. Default directory `~/Library/Application Support/mcp-genealogy/exports` (`GENEALOGY_EXPORT_DIR`
    overrides; `~` expanded), created on first use. Filename `<yyyy-mm-dd>-<slug>.ged` (slug from the
    first person's surname, ascii, lower case; `-2`, `-3` … when taken). Returns
    `{file, people, families, sources, warnings}`, never the contents. Unresolved people and dropped
    links are `warnings`.
16. GEDCOM 7.0 details: `PAGE` = the citation's `acte`, else `page`, else `text` (200 chars max);
    the record URL in a `NOTE` under the citation (7.0 citations have no `WWW`). Calendar escapes in
    7.0 syntax (`JULIAN`, `FRENCH_R`, `HEBREW`), not 5.5.1's `@#DJULIAN@`. A `DateValue` with `text`
    and a date → `DATE` + `PHRASE`; with no date → `NOTE`. `PLAC` = the original string (`raw`, else
    `name`). `EXID` `TYPE` = a URI naming the source and tree (e.g. `https://gw.geneanet.org/rlouvignes`,
    `https://deces.matchid.io`). Withheld people: name only plus a `NOTE` saying why. `FAM` records are
    built from parent and spouse links between included people; links to people not included become
    warnings, never dangling pointers. `CAL` and `EST` are never written.

## Elsewhere

17. `GENEALOGY_DEBUG` replaces `GENEANET_DEBUG` (kept as an alias); `src/cli.ts` logs as
    `genealogy-mcp`; `.release-it.json` references the new name. (Task 11.)
18. The in-memory cache (plan Task 7) stays: the spec does not forbid it and rule 14 needs it.

## Added during the run

19. (Task 6 ruling) `Place.code`: a 5-character commune code as the source wrote it, postal or INSEE
    unknown. `insee` is set only when the source states the code is INSEE (Geneanet INSEE-index hits,
    matchID's `code`). Overrides rule 10's "insee if a token matches". Phase (c) grouping must not
    compare `code` with `insee` as if equal.
20. (Task 5 ruling) `Brief.sex?` exists; name-only relatives (SimplePerson field 22) and hidden ones
    get `Brief.withheld = "private"`. Event `type` is always lower case.
