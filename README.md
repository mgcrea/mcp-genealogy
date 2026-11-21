# @mgcrea/mcp-geneanet

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Geneanet](https://en.geneanet.org). It searches every public family tree and archive index on
the site at once, then reads persons and pedigrees out of individual trees.

It is **read-only, needs no account, and has no write tools at all.**

## Features

- **Site-wide search** (`geneanet_search_records`), the same search as
  [Search all records](https://en.geneanet.org/fonds/individus/). It covers every public tree,
  genealogical societies' parish and civil register transcriptions, collaborative indexes and
  archival registers. You can filter by name, sex, up to five places with a radius, a date range,
  and the parents' names.
- **Search one tree** (`geneanet_search_tree`). Each match comes with its parents and spouses.
- **One full person record** (`geneanet_get_person`): vitals with places and sources, occupation,
  notes, parents, unions with their children, and events with witnesses.
- **A pedigree in one call** (`geneanet_get_tree`): up to 10 generations of ancestors and 5 of
  descendants. Every relationship arrives resolved: `fatherIndex`, `motherIndex`, `spouseOfIndex`,
  `parentIndexes`.
- **Compact answers.** Relatives collapse to `{index, name, life}`. Dates are ISO when GeneWeb's
  raw date is exact, notes are plain text, and no hashed node ids or edge lists reach the model.

## Security

- **No credentials.** Nothing to leak: every route it uses answers anonymous requests.
- **No write tools.** Geneanet's tree-editing API exists, but nothing here registers it.
- **Two runtime dependencies**, the MCP SDK and Zod. Native `fetch`, and a hand-written
  protobuf codec (`src/proto/wire.ts`) rather than a protobuf runtime.
- **Paced.** At most one request per second across all tools by default
  (`GENEANET_MIN_INTERVAL_MS`, minimum 500). Retries are few and short.

### Terms of use

Geneanet's terms of service forbid automated access. This server is meant for personal,
low-volume research, the kind you would otherwise do by hand in a browser. Do not use it to
crawl. The site-wide search also only works because of a gap in Geneanet's bot protection (see
[How it reaches Geneanet](#how-it-reaches-geneanet)), and that gap can close at any time.

## Configure

| Variable                   | Default                   | Description                                                                |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------- |
| `GENEANET_TREE`            | none                      | Default tree for the tree tools: the `<tree>` in `gw.geneanet.org/<tree>`. |
| `GENEANET_LANG`            | `en`                      | Language of dates and event names in tree answers.                         |
| `GENEANET_MIN_INTERVAL_MS` | `1000`                    | Minimum gap between two requests (500-60000).                              |
| `GENEANET_MAX_RETRIES`     | `2`                       | Retries on 429, 5xx and network errors (0-5).                              |
| `GENEANET_TIMEOUT_MS`      | `20000`                   | Per-request deadline (5000-120000).                                        |
| `GENEANET_TREE_API_URL`    | `https://gw.geneanet.org` | Family-tree API host.                                                      |
| `GENEANET_SITE_URL`        | `https://en.geneanet.org` | Site-wide search host.                                                     |
| `GENEANET_DEBUG`           | unset                     | `1` logs every request to stderr.                                          |

An out-of-range or malformed value never stops the server. It is replaced by the default or
clamped, and `geneanet_auth_status` lists what was adjusted.

## Quick start

```bash
pnpm install
pnpm build
```

Then add it to your client, for example `.mcp.json`:

```json
{
  "mcpServers": {
    "geneanet": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-geneanet/dist/cli.js"]
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

## Tools

| Tool                      | What it does                                                 | Requests       |
| ------------------------- | ------------------------------------------------------------ | -------------- |
| `geneanet_search_records` | Search all trees and archive indexes for one individual      | 1 per page     |
| `geneanet_search_tree`    | Search one tree by surname and/or first name                 | 1              |
| `geneanet_get_person`     | One person's full record                                     | 1 (2 with n/p) |
| `geneanet_get_tree`       | Ancestors, descendants and siblings, relationships resolved  | 1              |
| `geneanet_auth_status`    | Settings, and with `check: true` a live probe of both routes | 0 or 2         |

None of them writes.

## Worked example

> "Who were Marie Germaine LOUVIGNES's grandparents? She married in Cahuzac-sur-Vère around 1893."

1. `geneanet_search_records { lastname: "LOUVIGNES", firstname: "Marie Germaine", places: ["Cahuzac-sur-Vère"], radiusKm: 30 }`
   finds her in two family trees, `maudrenel1` and `chantalrochethomas`, and in the Tarn
   marriage index. The tree hits carry `tree`, `n` and `p`.
2. `geneanet_get_tree { tree: "maudrenel1", n: "louvignes", p: "marie germaine", ancestors: 2, descendants: 0 }`
   returns her parents, Jean François Paulin LOUVIGNES and Honorine MAUREL, and four
   grandparents, each with `fatherIndex` and `motherIndex`.
3. `geneanet_get_person { tree: "maudrenel1", index: 85 }` reads Guilhaume LOUVIGNES in full:
   born 1797-03-20 in Gaillac, married 1835-07-02 in Lisle-sur-Tarn, died 1870-01-09 in
   Cahuzac-sur-Vère, with the tree owner's notes.

## How it reaches Geneanet

Geneanet publishes no API. This server uses the same two routes as Geneanet's own pages:

- **The family-tree API**: `POST https://gw.geneanet.org/setup/api/?arbre=<op>&sourcename=<tree>`.
  This is GeneWeb's protobuf API, which the tree pages call themselves (`person`, `graph_v2`,
  `person_search_list`). Responses are framed as Latin-1 inside UTF-8. `proto/README.md` covers
  the framing and where Geneanet's schema departs from upstream GeneWeb.
- **The site-wide search**: `https://en.geneanet.org/fonds/individus/?<form fields>`. It answers
  server-rendered HTML; there is no JSON behind it. Cloudflare challenges every GET from a
  non-browser client, but the same URL sent as a POST with an empty body gets through. That is a
  gap in Geneanet's bot protection, not an interface. When it closes, the tools say so
  (`BlockedError`, naming Cloudflare) instead of failing obscurely.

## Traps worth knowing

- **Indexes are per tree.** The same ancestor has a different `index` in every tree. Keep the
  `tree` that came with an index.
- **Archive details are Premium-only.** For `society_index`, `collaborative_index` and
  `archival_register` hits, the search result is all a free account can get. Its `url` opens the
  record for a human, and the full date may be masked even there.
- **Geneanet cannot tell "no such person" from "no such operation".** Both come back as an empty
  answer, which the tools report as a 404 with a remedy.
- **Vital dates come from the events.** The person record holds display dates only, so the ISO
  form is taken from the matching birth, baptism, death or burial event. If `eventsLimit` cuts
  that event off, the date stays in the site's wording.
- **Some form filters need Premium.** Occupation and spouse names are greyed out on a free
  account, which is why the tool does not offer them.

## Troubleshooting

- **A tool fails with "Cloudflare challenged the request".** The route is closed from outside a
  browser. Run `geneanet_auth_status { check: true }` to see which of the two routes is affected.
  The tree tools and the site-wide search are independent.
- **"The search page had N result rows but no result count".** Geneanet redesigned the results
  page, and `src/records/search.ts` needs updating against a fresh capture.
- **"There is no Geneanet tree named …".** The tree name is the first path segment of the tree's
  URL, not the owner's display name.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest, against real captured responses in test/fixtures
pnpm typecheck
pnpm lint
pnpm format
```

The fixtures are real Geneanet answers, captured on 2026-11-20: protobuf bodies as `.bin`, and
search pages trimmed to their result rows as `.html`. Recapture them when Geneanet changes
something, rather than editing them by hand.

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
