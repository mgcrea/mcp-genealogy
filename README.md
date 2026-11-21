# @mgcrea/mcp-genealogy

A [Model Context Protocol](https://modelcontextprotocol.io) server for genealogy records. It
reads people out of several genealogy sources, answers in one shared shape whatever the source,
and writes what you collect to a GEDCOM 7.0 file.

| Source                              | Status     | What it gives                                                                  |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| [Geneanet](https://en.geneanet.org) | available  | Site-wide search of every public tree and archive index; persons and pedigrees |
| [matchID](https://deces.matchid.io) | next phase | France's INSEE death index, with exact dates and certificate numbers           |
| [Geni](https://www.geni.com)        | later      | The world tree, with OAuth                                                     |

It is **read-only toward every source and needs no account.** The only thing it writes is the
GEDCOM file, in one folder of your choosing.

## Tools

| Tool                      | What it does                                                                         | Requests                                     |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `geneanet_search_records` | Search all Geneanet trees and archive indexes at once for one individual             | 1 per page                                   |
| `geneanet_search_tree`    | Search one tree by surname and/or first name, with each match's parents and spouses  | 1                                            |
| `geneanet_get_person`     | One person's full record: events with places, sources, notes and witnesses           | 1 (2 with n/p)                               |
| `geneanet_get_people`     | Up to 40 people of one tree in one call, `summary` or `full`                         | 1 per person                                 |
| `geneanet_get_tree`       | Ancestors (up to 10 generations), descendants (up to 5) and siblings, links resolved | 1                                            |
| `genealogy_export_gedcom` | Write people, or a pedigree, to a GEDCOM 7.0 file in the export folder               | 1 per person not yet read, +1 for a pedigree |
| `genealogy_status`        | Each source's settings and the export folder; with `check: true`, a live probe       | 0, or 1 per check                            |

People read earlier in the session come from an in-memory cache (one hour), so reading people
with `geneanet_get_people` and then exporting them does not read anyone twice.

## The shared shape

Every tool answers in the same compact JSON. Empty values are left out, never sent as `null`.

- **`Ref`** `{source, id, url}` names a person in a source. A Geneanet id is `"<tree>:<index>"`
  (`"maudrenel1:27"`); a family-tree search hit has `"<tree>:<surname>/<given names>/<occurrence>"`
  until it is first read, and both forms are accepted wherever a ref is. `url` opens the record
  for a human.
- **`DateValue`** `{date, qualifier, dateTo, calendar, text}`. `date` is ISO, as precise as known
  (`"1870-11-22"`, `"1870-11"`, `"1870"`). `qualifier` is `about`, `maybe`, `before`, `after`,
  `between`, `or`, `from` or `to`; `dateTo` is the second bound. A full Julian date is converted
  back to its own calendar, with `calendar: "julian"`; French republican and Hebrew dates, and
  Julian dates with only a year or month, are not parsed yet and stay `text`. `text` holds the
  source's wording only when it could not be parsed: nothing is guessed.
- **`Place`** `{name, code, insee, department, region, country, raw}`. Only Geneanet's full
  `town, department, region, country` shape is split into slots; anything else keeps the first
  part as `name` and the whole string in `raw`. A five-character commune code is `code` when the
  source does not say what it is (trees write postal codes and INSEE codes alike); `insee` is set
  only by a source that gives INSEE codes, such as Geneanet's INSEE death index. Do not compare
  one with the other.
- **`Citation`** `{source, url, title, text, acte, page}`: where a fact comes from. `acte` and
  `page` are filled only from a source field with that meaning.
- **`Brief`** `{ref, name, sex, born, bornAt, died, diedAt, withheld}`: a person seen from
  another record (a parent, spouse, child or search match). `born` and `died` are short strings:
  `"1870-11-22"`, `"about 1768"`, `"between 1825 and 1875"`.
- **`Person`** `{ref, name, given, surname, sex, aliases, occupation, events, parents, families,
  notes, withheld, withheldReason, detail}`. `events` are `{type, date, place, citations}` (plus
  `note` and `witnesses` in `full`). `families` are `{spouse, events, children}` in `full`, with
  `childCount` instead of `children` in `summary`.
- **`withheld`** says why a record is empty: `"private"` (the source hides the person),
  `"probably-private"` (an empty record with no death, so inferred, with `withheldReason` saying
  so), or `"premium"` (a Geneanet search hit behind the `XXXX` mask).

## Exporting to GEDCOM

`genealogy_export_gedcom` takes `people` (refs, as the other tools return them) or a `pedigree`
(a Geneanet person with ancestors and descendants, read in one request) and writes a GEDCOM 7.0
file. It returns `{file, people, families, sources, warnings}`, never the file's contents.

- **The export folder.** Files go to `~/Library/Application Support/mcp-genealogy/exports`,
  created on first use, or to `GENEALOGY_EXPORT_DIR` (an absolute path or `~/…`). To let a
  Filiation agent read the exports, point `GENEALOGY_EXPORT_DIR` at the folder granted in
  Filiation › Settings › MCP Server.
- **Names.** A new file is `<yyyy-mm-dd>-<surname>.ged`, with `-2`, `-3`… when taken. Next to it,
  `<file>.refs.json` lists the refs it holds and the `detail` it was written at.
- **One file across calls.** Each call reads at most 40 people and stops scheduling new reads
  after 45 s, so it always answers within about 55 s; whoever was not reached comes back in
  `remaining`. Call again with `remaining` as `people`, the returned `file` and `append: true`:
  the whole file is rewritten from the people it already holds plus the new ones. An append
  keeps the file's `detail` unless you pass another, which re-renders every person in it.
- **What the file holds.** `HEAD` 7.0, one `INDI` per person, `FAM` records built from the parent
  and spouse links between people in the file, one `SOUR` per tree, and on every fact a citation
  with `PAGE` (when the source has one) and the record's URL in a `NOTE`. `EXID` keeps each
  person's source id. A link to someone left out of the file becomes a warning, never a dangling
  pointer.

## Security

- **Read-only toward every source.** No tool writes to Geneanet or anywhere else online.
  Geneanet's tree-editing API exists, but nothing here reaches it.
- **One local write.** `genealogy_export_gedcom` writes its `.ged` and `.refs.json` files inside
  the export folder and nowhere else: a `file` that resolves outside it, or is a symlink, is
  refused before anything is read. It only ever replaces a file it wrote itself, atomically.
- **No credentials.** Every route used answers anonymous requests, so there is nothing to leak.
- **Two runtime dependencies**, the MCP SDK and Zod. Native `fetch`, and a hand-written protobuf
  codec (`src/sources/geneanet/proto/wire.ts`) rather than a protobuf runtime.
- **Paced.** At most one Geneanet request per second across all tools by default
  (`GENEANET_MIN_INTERVAL_MS`, minimum 500). Retries are few and short.

### Terms of use

Geneanet's terms of service forbid automated access. This server is meant for personal,
low-volume research, the kind you would otherwise do by hand in a browser. Do not use it to
crawl. The site-wide search also only works because of a gap in Geneanet's bot protection (see
[How it reaches Geneanet](#how-it-reaches-geneanet)), and that gap can close at any time.

## Configure

| Variable                   | Default                                               | Description                                                                |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `GENEALOGY_EXPORT_DIR`     | `~/Library/Application Support/mcp-genealogy/exports` | The only folder `genealogy_export_gedcom` writes to.                       |
| `GENEALOGY_DEBUG`          | unset                                                 | `1` logs every request to stderr. `GENEANET_DEBUG` is still accepted.      |
| `GENEANET_TREE`            | none                                                  | Default tree for the tree tools: the `<tree>` in `gw.geneanet.org/<tree>`. |
| `GENEANET_LANG`            | `en`                                                  | Language of dates and event names in tree answers.                         |
| `GENEANET_MIN_INTERVAL_MS` | `1000`                                                | Minimum gap between two Geneanet requests (500-60000).                     |
| `GENEANET_MAX_RETRIES`     | `2`                                                   | Retries on 429, 5xx and network errors (0-5).                              |
| `GENEANET_TIMEOUT_MS`      | `20000`                                               | Per-request deadline (5000-120000).                                        |
| `GENEANET_TREE_API_URL`    | `https://gw.geneanet.org`                             | Family-tree API host.                                                      |
| `GENEANET_SITE_URL`        | `https://en.geneanet.org`                             | Site-wide search host.                                                     |

An out-of-range or malformed value never stops the server. It is replaced by the default or
clamped, and `genealogy_status` lists what was adjusted.

## Quick start

```bash
pnpm install
pnpm build
```

Then add it to your client, for example `.mcp.json`:

```json
{
  "mcpServers": {
    "genealogy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-genealogy/dist/cli.js"],
      "env": { "GENEALOGY_EXPORT_DIR": "~/Documents/Genealogy" }
    }
  }
}
```

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

## Worked example

> "Who were Marie Germaine LOUVIGNES's grandparents? She married in Cahuzac-sur-Vère around 1893. Put them in a GEDCOM file."

1. `geneanet_search_records { lastname: "LOUVIGNES", firstname: "Marie Germaine", places: ["Cahuzac-sur-Vère"], radiusKm: 30 }`
   finds her in two family trees, `maudrenel1` and `chantalrochethomas`, and in the Tarn
   marriage index. The tree hits carry a `ref` and `tree`, `n` and `p`.
2. `geneanet_get_tree { tree: "maudrenel1", index: 27, ancestors: 2, descendants: 0 }` returns her
   parents, Jean François Paulin LOUVIGNES and Honorine MAUREL, and four grandparents, each with
   `fatherIndex` and `motherIndex`.
3. `geneanet_get_people { tree: "maudrenel1", indexes: [27, 55, 28, 85, 86] }` reads five of them:
   Guilhaume LOUVIGNES (85), for one, was born 1797-03-20 in Gaillac, married 1835-07-02 in
   Lisle-sur-Tarn and died 1870-01-09 in Cahuzac-sur-Vère.
4. `genealogy_export_gedcom { people: [{source: "geneanet", id: "maudrenel1:27"}, …] }` writes
   `2026-11-21-louvignes.ged` with 5 people and 3 families without another request, and warns
   about the links it left out (her husband, and the parents of Honorine, Guilhaume and Antoinette).

## How it reaches Geneanet

Geneanet publishes no API. This server uses the same two routes as Geneanet's own pages:

- **The family-tree API**: `POST https://gw.geneanet.org/setup/api/?arbre=<op>&sourcename=<tree>`.
  This is GeneWeb's protobuf API, which the tree pages call themselves (`person`, `graph_v2`,
  `person_search_list`). Responses are framed as Latin-1 inside UTF-8. `proto/README.md` covers
  the framing, GeneWeb's raw dates, the privacy flags, and where Geneanet's schema departs from
  upstream GeneWeb.
- **The site-wide search**: `https://en.geneanet.org/fonds/individus/?<form fields>`. It answers
  server-rendered HTML; there is no JSON behind it. Cloudflare challenges every GET from a
  non-browser client, but the same URL sent as a POST with an empty body gets through. That is a
  gap in Geneanet's bot protection, not an interface. When it closes, the tools say so
  (`BlockedError`, naming Cloudflare) instead of failing obscurely.

Geneanet's "same person in other trees" is not exposed: the profile pages fetch no such list
(see `proto/README.md`). The site-wide search's `family_tree` hits are how to find the same
person in other trees.

## Traps worth knowing

- **Indexes are per tree.** The same ancestor has a different `index` in every tree. Keep the
  tree with the index, which a `ref` id does for you.
- **Archive details are Premium-only.** For `society_index`, `collaborative_index` and
  `archival_register` hits, the search result is all a free account can get. Its `url` opens the
  record for a human, and the full date may be masked even there (`withheld: "premium"`).
- **Geneanet cannot tell "no such person" from "no such operation".** Both come back as an empty
  answer, which the tools report as a 404 with a remedy.
- **Vital dates come from the events.** The person record holds display dates only, so the ISO
  form is taken from the matching birth, baptism, death or burial event's raw date. If
  `eventsLimit` cuts that event off, the date is read from the display form instead.
- **Some form filters need Premium.** Occupation and spouse names are greyed out on a free
  account, which is why the search does not offer them.

## Troubleshooting

- **A tool fails with "Cloudflare challenged the request".** The route is closed from outside a
  browser. Run `genealogy_status { check: true }` to see which route is affected. The tree tools
  and the site-wide search are independent.
- **"The search page had N result rows but no result count".** Geneanet redesigned the results
  page, and `src/sources/geneanet/records.ts` needs updating against a fresh capture.
- **"There is no Geneanet tree named …".** The tree name is the first path segment of the tree's
  URL, not the owner's display name.
- **The export is refused.** `file` must be a `.ged` name directly in the export folder
  (`genealogy_status` shows it as `exportDir`), and an existing file is only replaced when this
  tool wrote it.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest, against real captured responses in test/fixtures
pnpm typecheck
pnpm lint
pnpm format
```

The fixtures are real Geneanet answers, captured live with `scripts/capture.ts`: protobuf bodies
as `.bin`, and search pages trimmed to their result rows as `.html`. Recapture them when Geneanet
changes something, rather than editing them by hand.

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
