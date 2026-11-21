import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { GeneanetClient } from "#/client/geneanet";
import { encodeSearchRequest } from "#/proto/messages";
import { buildRecordsQuery, parseRecordsPage } from "#/records/search";
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
 * Named like the fleet's `<prefix>_auth_status` so it is the first thing a
 * model reaches for when something is off, though there is no auth here: every
 * route is public. What can break is the route itself, so `check` probes both.
 */
export const registerStatusTools = (
  server: McpServer,
  client: GeneanetClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "geneanet_auth_status",
    {
      title: "Geneanet: Status",
      description:
        "Report the server's settings (default tree, request pacing) and, with check: true, " +
        "whether Geneanet still answers both routes this server uses. No credentials are ever " +
        "needed: everything read is public. Call this when a tool fails with a Cloudflare or " +
        "markup error, to tell a site change from a one-off.",
      inputSchema: z.object({
        check: z
          .boolean()
          .default(false)
          .describe(
            "Also probe Geneanet: one site-wide search, plus one tree search when GENEANET_TREE is set. Two requests, about two seconds.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ check }) =>
      wrap(async () => {
        const { config } = ctx;
        const settings = {
          credentialsNeeded: false,
          defaultTree: config.tree ?? null,
          lang: config.lang,
          minIntervalMs: config.minIntervalMs,
          treeApi: config.treeBaseUrl,
          site: config.siteBaseUrl,
          ...(config.adjusted.length ? { adjustedSettings: config.adjusted } : {}),
        };
        if (!check) return settings;

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
        return { ...settings, checks: { siteSearch: records, treeApi: tree } };
      }),
  );
};
