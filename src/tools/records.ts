import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { GeneanetApiError } from "#/client/errors";
import type { GeneanetClient } from "#/client/geneanet";
import {
  RecordsParseError,
  buildRecordsQuery,
  parseRecordsPage,
  type RecordsQuery,
} from "#/records/search";
import { wrap } from "#/tools/util";

const nameArg = (what: string, example: string) =>
  z.string().min(1).optional().describe(`${what}, e.g. "${example}".`);

export const registerRecordsTools = (server: McpServer, client: GeneanetClient): void => {
  server.registerTool(
    "geneanet_search_records",
    {
      title: "Geneanet: Search All Records",
      description:
        "Search all of Geneanet at once for one individual: every public family tree plus the " +
        "archive indexes (genealogical societies' parish and civil register transcriptions, " +
        "collaborative indexes, archival registers). Each hit says its kind, name, spouse, " +
        "dates and places, and where it comes from. family_tree hits carry tree/n/p, which " +
        "geneanet_get_person and geneanet_get_tree take directly. Archive record details are " +
        "Premium-only on Geneanet, so for other kinds the hit itself is all there is; its url " +
        "opens the record for a human. One request per page. The same person often appears in " +
        "several trees, so read the results before fetching any of them.",
      inputSchema: z.object({
        lastname: z
          .string()
          .min(1)
          .describe('Surname to search, e.g. "LOUVIGNES". Required by Geneanet; case is ignored.'),
        firstname: nameArg("First name", "Marie Germaine"),
        sex: z.enum(["male", "female"]).optional().describe("Restrict to one sex."),
        places: z
          .array(z.string().min(1))
          .max(5)
          .optional()
          .describe(
            'Up to 5 places, matched against birth, marriage and death places, e.g. ["Cahuzac-sur-Vère"]. A town name alone usually works.',
          ),
        radiusKm: z
          .union([
            z.literal(5),
            z.literal(10),
            z.literal(15),
            z.literal(30),
            z.literal(100),
            z.literal(200),
          ])
          .optional()
          .describe(
            "Also match places within this many km of `places`: 5, 10, 15, 30, 100 or 200. Ignored without places.",
          ),
        from: z
          .number()
          .int()
          .min(1000)
          .max(2100)
          .optional()
          .describe("First year of the period, e.g. 1800."),
        to: z
          .number()
          .int()
          .min(1000)
          .max(2100)
          .optional()
          .describe("Last year of the period, e.g. 1900."),
        dateOf: z
          .enum(["any", "birth", "marriage", "death"])
          .default("any")
          .describe("Which event the period applies to. Defaults to any."),
        dateMode: z
          .enum(["between", "before", "after"])
          .default("between")
          .describe(
            "between uses from..to; before uses `to` alone; after uses `from` alone. Defaults to between.",
          ),
        fatherLastname: nameArg("Father's surname", "LOUVIGNES"),
        fatherFirstname: nameArg("Father's first name", "Jean François"),
        motherLastname: nameArg("Mother's surname", "MAUREL"),
        motherFirstname: nameArg("Mother's first name", "Honorine"),
        page: z.number().int().min(1).max(500).default(1).describe("Result page, from 1."),
        size: z
          .union([
            z.literal(10),
            z.literal(20),
            z.literal(30),
            z.literal(40),
            z.literal(50),
            z.literal(100),
          ])
          .default(20)
          .describe(
            "Results per page: 10, 20, 30, 40, 50 or 100. Defaults to 20; a hit is about 60 tokens.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      wrap(async () => {
        const query: RecordsQuery = args;
        const params = buildRecordsQuery(query);
        const html = await client.searchRecordsPage(params);
        let page;
        try {
          page = parseRecordsPage(html, client.siteBaseUrl, client.treeBaseUrl);
        } catch (err) {
          if (err instanceof RecordsParseError) {
            throw new GeneanetApiError(err.message, {
              status: 502,
              remedy:
                "Geneanet changed its search page. The tree tools still work; report this one.",
            });
          }
          throw err;
        }
        const shown = (args.page - 1) * args.size + page.hits.length;
        return {
          total: page.total,
          page: args.page,
          ...(shown < page.total ? { nextPage: args.page + 1 } : {}),
          results: page.hits,
          searchUrl: `${client.siteBaseUrl}/fonds/individus/?${params.toString()}`,
        };
      }),
  );
};
