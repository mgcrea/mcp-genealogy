// Throwaway capture helper for test fixtures; not part of the build.
//
//   pnpm tsx scripts/capture.ts person <tree> <index> [fixture-name]
//   pnpm tsx scripts/capture.ts search <tree> <lastname> [firstname] [fixture-name]
//   pnpm tsx scripts/capture.ts records <query-string> [fixture-name]
//
// Tree API answers are written byte for byte as the HTTP body arrived (before
// unframing) to test/fixtures/<fixture-name>.bin; a site search goes to
// test/fixtures/<fixture-name>.html. Without a name nothing is written, and the
// dates found are printed (raw form next to display form), which is how a
// capture is chosen. Every request goes through GeneanetClient and its 1 req/s gate.

import { writeFileSync } from "node:fs";

import { loadConfig } from "#/config";
import { GeneanetClient } from "#/sources/geneanet/geneanet";
import {
  decodePerson,
  decodeSearchList,
  encodePersonRequest,
  encodeSearchRequest,
  type SimplePerson,
} from "#/sources/geneanet/proto/messages";
import { parseRecordsPage } from "#/sources/geneanet/records";

const FIXTURES = new URL("../test/fixtures/", import.meta.url);

const config = loadConfig();
let lastBody: Uint8Array | undefined;
const client = new GeneanetClient({
  treeBaseUrl: config.treeBaseUrl,
  siteBaseUrl: config.siteBaseUrl,
  lang: config.lang,
  minIntervalMs: config.minIntervalMs,
  maxRetries: config.maxRetries,
  timeoutMs: config.timeoutMs,
  // Keep the raw body: the client unframes it before returning.
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    lastBody = new Uint8Array(await res.arrayBuffer());
    return new Response(lastBody, { status: res.status, headers: res.headers });
  },
});

const save = (name: string | undefined, ext: string): void => {
  if (!name || !lastBody) return;
  const file = new URL(`${name}.${ext}`, FIXTURES);
  writeFileSync(file, lastBody);
  console.error(`wrote ${file.pathname} (${lastBody.length} bytes)`);
};

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const simple = (role: string, s: SimplePerson): void => {
  if (s.birthDateRaw || s.birthDate)
    out(`  ${role} ${s.index} birth: ${s.birthDateRaw} | ${s.birthDate}`);
  if (s.deathDateRaw || s.deathDate)
    out(`  ${role} ${s.index} death: ${s.deathDateRaw} | ${s.deathDate}`);
};

const [mode, ...args] = process.argv.slice(2);

if (mode === "person") {
  const [tree, index, name] = args;
  if (!tree || !index) throw new Error("person <tree> <index> [fixture-name]");
  const res = await client.treeApi(
    "person",
    tree,
    encodePersonRequest({ index: Number(index), eventsLimit: 50, witnessedEventsLimit: 50 }),
  );
  if (!res) throw new Error("empty answer");
  const p = decodePerson(res);
  out(`${p.firstname} ${p.lastname}`);
  for (const e of p.events) {
    out(`  ${e.name}: ${e.dateRaw ?? ""} | ${e.date ?? ""}`);
    if (e.spouse) simple("event spouse", e.spouse);
    for (const w of e.witnesses) simple("witness", w.person);
  }
  for (const f of p.families) {
    out(`  family marriage: ${f.marriageDateRaw ?? ""} | ${f.marriageDate ?? ""}`);
    simple("spouse", f.spouse);
    for (const c of f.children) simple("child", c);
  }
  if (p.father) simple("father", p.father);
  if (p.mother) simple("mother", p.mother);
  save(name, "bin");
} else if (mode === "search") {
  const [tree, lastname, firstname, name] = args;
  if (!tree || !lastname) throw new Error("search <tree> <lastname> [firstname] [fixture-name]");
  const res = await client.treeApi(
    "person_search_list",
    tree,
    encodeSearchRequest({ lastname, ...(firstname ? { firstname } : {}), limit: 100 }),
  );
  for (const h of res ? decodeSearchList(res) : []) {
    out(`  ${h.index} ${h.firstname} ${h.lastname}: ${h.dates ?? ""}`);
  }
  save(name, "bin");
} else if (mode === "records") {
  const [query, name] = args;
  if (!query) throw new Error("records <query-string> [fixture-name]");
  const html = await client.searchRecordsPage(new URLSearchParams(query));
  for (const h of parseRecordsPage(html, config.siteBaseUrl, config.treeBaseUrl).hits) {
    const dates = h.dates.map((d) => `${d.event} ${JSON.stringify(d.date ?? {})}`);
    out(
      `  ${h.kind} ${h.tree ?? ""} ${h.name}: ${dates.join(" / ")}${h.hint ? ` [${h.hint}]` : ""}`,
    );
  }
  save(name, "html");
} else {
  console.error("usage: capture.ts person|search|records …");
  process.exitCode = 1;
}
