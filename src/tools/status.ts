import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { GeneanetClient } from "#/sources/geneanet/geneanet";
import { encodeSearchRequest } from "#/sources/geneanet/proto/messages";
import { buildRecordsQuery, parseRecordsPage } from "#/sources/geneanet/records";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/** Run one live check, turning a failure into a line of the report instead of an error. */
const probe = async (fn: () => Promise<string>): Promise<string> => {
  try {
    return await fn();
  } catch (err) {
    return `FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/**
 * One status tool for every source, so it is the first thing a model reaches
 * for when something is off. There is no auth: every route read is public.
 * What can break is a route itself, so `check` probes each source's routes.
 * Settings sit under `sources.<name>`; clamped settings are server-wide.
 */
export const registerStatusTools = (
  server: McpServer,
  client: GeneanetClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "genealogy_status",
    {
      title: "Genealogy: Status",
      description:
        "Report each source's settings and, with check: true, whether each source still answers. " +
        "Geneanet: settings are the default tree and request pacing; the check probes the " +
        "site-wide search and, when GENEANET_TREE is set, the tree API. No credentials are ever " +
        "needed: everything read is public. Call this when a tool fails with a Cloudflare or " +
        "markup error, to tell a site change from a one-off. Also gives exportDir, the folder " +
        "genealogy_export_gedcom writes to.",
      inputSchema: z.object({
        check: z
          .boolean()
          .default(false)
          .describe(
            "Also probe each source, one request per check. Geneanet: a site-wide search, plus a tree search when GENEANET_TREE is set (one or two requests, a second apart).",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ check }) =>
      wrap(async () => {
        const { config } = ctx;
        const geneanet = {
          credentialsNeeded: false,
          defaultTree: config.tree ?? null,
          lang: config.lang,
          minIntervalMs: config.minIntervalMs,
          treeApi: config.treeBaseUrl,
          site: config.siteBaseUrl,
        };
        const adjusted = config.adjusted.length ? { adjustedSettings: config.adjusted } : {};
        const { exportDir } = config;
        if (!check) return { sources: { geneanet }, exportDir, ...adjusted };

        const records = await probe(async () => {
          const html = await client.searchRecordsPage(
            buildRecordsQuery({ lastname: "MARTIN", page: 1, size: 10 }),
          );
          const page = parseRecordsPage(html, config.siteBaseUrl, config.treeBaseUrl);
          return page.total > 0 ? `ok (${page.total} results for MARTIN)` : "FAILED: no results";
        });
        const tree = config.tree
          ? await probe(async () => {
              const res = await client.treeApi(
                "person_search_list",
                config.tree as string,
                encodeSearchRequest({ lastname: "a", limit: 1 }),
              );
              return res
                ? `ok (tree ${config.tree} answered)`
                : `ok (tree ${config.tree} answered, empty)`;
            })
          : "skipped: GENEANET_TREE is not set";
        return {
          sources: { geneanet: { ...geneanet, checks: { siteSearch: records, treeApi: tree } } },
          exportDir,
          ...adjusted,
        };
      }),
  );
};
