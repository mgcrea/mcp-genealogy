# Schemas

The `.proto` files here are GeneWeb's, copied byte for byte from
[geneweb/geneweb `v7.0.0`](https://github.com/geneweb/geneweb/tree/v7.0.0/lib). GeneWeb removed
the API from `master` later, so this tag is the last public copy.

They are reference material only. Nothing compiles them: `src/proto/messages.ts` hand-decodes the
handful of messages the tools use, with `src/proto/wire.ts` underneath. The server therefore ships
no protobuf runtime.

## Where Geneanet differs from upstream

Geneanet runs its own fork. Its schemas are served at `gw.geneanet.org/setup/api/*.proto`, but
behind a Cloudflare challenge, so only a browser can fetch them. The field numbers in
`src/proto/messages.ts` were checked against those files (read in Safari on 2026-11-19) and against
real responses (`test/fixtures/*.bin`). These are the differences that matter:

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
