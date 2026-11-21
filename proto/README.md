# Schemas

The `.proto` files here are GeneWeb's, copied byte for byte from
[geneweb/geneweb `v7.0.0`](https://github.com/geneweb/geneweb/tree/v7.0.0/lib). GeneWeb removed
the API from `master` later, so this tag is the last public copy.

They are reference material only. Nothing compiles them:
`src/sources/geneanet/proto/messages.ts` hand-decodes the handful of messages the tools use, with
`src/sources/geneanet/proto/wire.ts` underneath. The server therefore ships no protobuf runtime.

## Where Geneanet differs from upstream

Geneanet runs its own fork. Its schemas are served at `gw.geneanet.org/setup/api/*.proto`, but
behind a Cloudflare challenge, so only a browser can fetch them. The field numbers in
`src/sources/geneanet/proto/messages.ts` were checked against those files (read in Safari on
2026-11-19) and against real responses (`test/fixtures/*.bin`). These are the differences that
matter:

- **`SaisieRead.Person`, `SimplePerson`, `Event`, `Family`.** Geneanet adds raw dates
  (`date_raw`, `birth_date_raw`, …: `/1870/11/22#`), `sosa_nb` and `has_parent` / `has_spouse` /
  `has_child`, and it moves several fields compared with v7.0.0. Use the numbers in `messages.ts`,
  not the ones in `api_saisie_read.proto` here.
- **`person_search_list` results.** Upstream `PersonSearch` is a flat 11-field message. Geneanet
  sends:
  - `1` index, `2` sex, `3` surname, `4` first names, `5` dates;
  - `7` sosa, `8` repeated `{1: spouse}`, `11` `{n, p, oc}`;
  - `12` father, `13` mother, `14` the profile's query string.

  Each related person carries `1` index, `2` sex, `3` surname, `4` first names, `5`/`6` birth date
  and place, `7`/`8` death date and place, and `11` `{n, p, oc}`.

- **Operation names.** Upstream dispatches on `m=API_*`. Geneanet routes
  `POST /setup/api/?arbre=<op>` instead, using names from its own front end (`person`, `graph_v2`,
  `person_search_list`). An unknown name answers `200` with an empty body.

## Framing

Responses are not raw protobuf. Geneanet reads the bytes as Latin-1 and writes them out as UTF-8,
so the client decodes the body as UTF-8 and maps each character back to a byte
(`unframeResponse`). Requests are `data=` plus every byte as `%XX`, URL-escaped a second time
(`frameRequest`). Both match the site's own `gwHelper`.

## Raw dates

Every `date_raw` form seen in live answers (`lang=en`, captured 2026-11-21 with
`scripts/capture.ts`; fixtures `test/fixtures/person-<tree>-<index>-<form>.bin`), next to the
display form sent with it. Events display as "Feb. 13, 1841"; relatives (`SimplePerson`) as
month/day/year.

| `date_raw`              | display                                          | meaning                            |
| ----------------------- | ------------------------------------------------ | ---------------------------------- |
| `/1841/2/13#`           | `Feb. 13, 1841` / `02/13/1841`                   | exact date                         |
| `/1767/11/0#`           | `Nov., 1767`                                     | month and year                     |
| `/1896/0/0#`            | `1896`                                           | year only                          |
| `~/1768/0/0#`           | `about 1768`                                     | about                              |
| `~/1798/8/23#`          | `about 08/23/1798`                               | about, full date                   |
| `?/1400/0/0#`           | `possibly 1400`                                  | maybe                              |
| `?/1557/1/16#`          | `possibly Jan. 16, 1557` / `possibly 01/16/1557` | maybe, full date                   |
| `</1791/0/0#`           | `before 1791`                                    | before                             |
| `</1813/6/16#`          | `before 06/16/1813`                              | before, full date                  |
| `>/1539/0/0#`           | `after 1539`                                     | after                              |
| `>/1851/6/17#`          | `after Jun. 17, 1851`                            | after, full date                   |
| `/1539/0/0#../1549/0/0` | `between 1539 and 1549`                          | range; the second bound has no `#` |
| `/1539/6/8#`            | `May 29, 1539 Julian` / `05/29/1539 (Julian)`    | Julian date                        |
| (empty)                 | (empty)                                          | no date                            |

The raw numbers are always Gregorian. A Julian date is marked only in the display, and its raw
form is the Gregorian equivalent (`/1539/6/8#` is 29 May 1539 Julian; also `/1571/1/22#` for
`01/12/1571 (Julian)` and `/1523/3/2#` for `02/20/1523 (Julian)`). `fromRaw` converts a full
Julian date back to its own calendar.

Not found in about 30 minutes of searching (trees `maudrenel1`, `pmft`, `gchene2`, `rcarre1`,
`jldron`, `ndevienne`), so not parsed: "or" years, French republican and Hebrew dates, and Julian
dates with only a year or month. They stay `text`.

## Private people

Captured 2026-11-21 (`lang=en`, as a visitor): a masked person captured from a public tree,
anonymised (fixture `test/fixtures/person-private-masked.bin`: its relatives' names, keys and
places and the tree name were replaced in place with placeholders of the same byte length, so the
framing and every length still hold; dates and flags are as captured), a living person shown by
name only (`maudrenel1` index 2; not kept as a fixture, since it names living people), and the
public `person-maudrenel1-27.bin`. The `person` answer's fields 50–52, which
`api_saisie_read.proto` v7.0.0 does not have, are the visibility flags:

| record                   | name                 | dates, places, events | 50  | 51  | 52  |
| ------------------------ | -------------------- | --------------------- | --- | --- | --- |
| public (maudrenel1 27)   | as written           | present               | 0   | 0   | 0   |
| name only (maudrenel1 2) | as written           | none                  | 1   | 0   | 0   |
| masked (anonymised)      | `x x`, empty `n`/`p` | none                  | 1   | 1   | 0   |

Both private records have death type 4 (unknown) and an event list with no events. The relatives
attached to a record (`SimplePerson`) carry the same three levels: field 18 is 0, 1 or 2, field
22 is set for both private levels and field 23 for the masked one only (24 was never seen set).
`decodePerson` reads 51 or 52 as `hidden` (the analogue of `SimplePerson`'s 23 or 24) and 50 as
`restricted`. The adapter gives `withheld: "private"` for `hidden`, and for `restricted` when the
record is indeed empty; with neither flag, an empty record whose death status is alive or unknown
is `"probably-private"`, with a reason saying it is inferred. A relative's brief is `"private"` when its
`SimplePerson` has 23 or 24 (`hidden`) or 22 (`restricted`), so a person reads the same as a
record and as a relative.

## Same person in other trees

Looked for on 2026-11-21 (Safari, signed in with a free account, `lang=en`), on
`gw.geneanet.org/maudrenel1?n=louvignes&p=marie+germaine`, in both the family-tree view
(`type=tree`) and the profile view (`type=fiche`). Neither view showed a "same person in other
trees" block, and no request on either page carries such a list. Besides the tree API calls
(`graph_v2`, `person`) the pages make one cross-site request:

- `GET https://en.geneanet.org/annuaire/sources/individu?b=<tree>&n=<n>&oc=<oc>&p=<p>`. From
  Node, a plain `GET` is challenged by Cloudflare (`403`, `cf-mitigated: challenge`); the same
  URL as a `POST` with an empty body answers `200 application/json` with the single value
  `true`. It is a flag (it most likely decides whether the page offers "Search the original
  records"), not a list of matching people.

The other trees holding a person are only reachable through the site-wide search
(`geneanet_search_records`, whose `family_tree` hits are exactly that) or the "More hints"
link, which was not followed. So `geneanet_get_person` has no `otherTrees`; grouping the same
person across trees is left to phase (c).
