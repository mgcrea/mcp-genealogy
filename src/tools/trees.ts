import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { geneanetKeyRefId, geneanetRefId, refKey, type RefInput } from "#/schema/ids";
import { toSearchHits } from "#/sources/geneanet/adapter";
import { fetchPeople, fetchPerson, isFailure, readGraph } from "#/sources/geneanet/fetch";
import type { GeneanetClient } from "#/sources/geneanet/geneanet";
import {
  decodeSearchList,
  encodeSearchRequest,
  type PersonRef,
} from "#/sources/geneanet/proto/messages";
import type { ToolContext } from "#/tools/index";
import {
  ArgumentError,
  CALL_DEADLINE_MS,
  fail,
  indexArg,
  nArg,
  ocArg,
  ok,
  pArg,
  toFailure,
  treeArg,
  wrap,
} from "#/tools/util";

/** geneanet_get_people's cap and scheduling budget: the call ends well inside ~55 s. */
const PEOPLE_MAX = 40;
const PEOPLE_BUDGET_MS = 45_000;

const resolveTree = (ctx: ToolContext, tree: string | undefined): string => {
  const resolved = tree ?? ctx.config.tree;
  if (!resolved) {
    throw new ArgumentError(
      "No tree named, and GENEANET_TREE is not set.",
      "Pass `tree`: the username in the tree's URL (gw.geneanet.org/<tree>). " +
        "geneanet_search_records returns it on every family_tree hit.",
    );
  }
  return resolved;
};

const resolveRef = (args: { index?: number; n?: string; p?: string; oc: number }): PersonRef => {
  if (args.index !== undefined) return { index: args.index };
  if (args.n && args.p) return { n: args.n, p: args.p, oc: args.oc };
  throw new ArgumentError(
    "Name the person by `index`, or by both `n` and `p`.",
    "Take `index` from another geneanet_* tree tool, or `n`/`p`/`oc` from a geneanet_search_records hit or a profile URL.",
  );
};

export const registerTreeTools = (
  server: McpServer,
  client: GeneanetClient,
  ctx: ToolContext,
): void => {
  const base = client.treeBaseUrl;
  const deps = { client, cache: ctx.cache };

  server.registerTool(
    "geneanet_search_tree",
    {
      title: "Geneanet: Search One Family Tree",
      description:
        "Search ONE family tree by surname and/or first name; returns each match's ref, index and " +
        "life years (born/died), with parents and spouses as briefs {ref, name, born, bornAt, " +
        "died, diedAt}; pass an index to geneanet_get_person. Matching is the tree's own: names " +
        "starting with what you type, accents ignored. To find people across every tree and the " +
        "archive indexes, use geneanet_search_records instead. One request.",
      inputSchema: z.object({
        tree: treeArg,
        lastname: z
          .string()
          .min(1)
          .optional()
          .describe('Surname, or its start, e.g. "louvignes". Case and accents are ignored.'),
        firstname: z
          .string()
          .min(1)
          .optional()
          .describe('First name, or its start, e.g. "Jérôme".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum matches (1-100). Defaults to 20."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tree, lastname, firstname, limit }) =>
      wrap(async () => {
        if (!lastname && !firstname) {
          throw new ArgumentError(
            "Give a lastname, a firstname, or both.",
            "An empty search would list the whole tree.",
          );
        }
        const t = resolveTree(ctx, tree);
        const res = await client.treeApi(
          "person_search_list",
          t,
          encodeSearchRequest({
            ...(lastname ? { lastname } : {}),
            ...(firstname ? { firstname } : {}),
            limit,
          }),
          { deadline: client.now() + CALL_DEADLINE_MS },
        );
        return toSearchHits(base, t, res ? decodeSearchList(res) : [], ctx.config.lang, limit);
      }),
  );

  server.registerTool(
    "geneanet_get_person",
    {
      title: "Geneanet: Get Person",
      description:
        "Read one person's full record from a family tree: names and aliases, birth, baptism, " +
        "death and burial with places and sources, occupation, notes, parents, every union with " +
        "its children, and the event list with witnesses, in the shared genealogy shape. " +
        "Relatives come back as briefs {ref, name, born, bornAt, died, diedAt}, whose ref id is " +
        '"<tree>:<index>"; pass that index back here to walk the tree one person at a time, or ' +
        "use geneanet_get_tree for several generations in one call. A person the tree hides " +
        'comes back with `withheld` ("private", or "probably-private" when inferred from an empty ' +
        "record) and `withheldReason`. A place's `code` is a commune code as the tree wrote it, " +
        "postal or INSEE unknown (never `insee`). One request with `index`, two with n/p, none " +
        "when this session already read the whole record.",
      inputSchema: z.object({
        tree: treeArg,
        index: indexArg,
        n: nArg,
        p: pArg,
        oc: ocArg,
        eventsLimit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe(
            "Maximum events to return (1-200). Defaults to 50; the answer says when there were more.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      wrap(async () => {
        const t = resolveTree(ctx, args.tree);
        const ref = resolveRef(args);
        const id = "index" in ref ? geneanetRefId(t, ref.index) : geneanetKeyRefId(t, ref);
        return fetchPerson(
          deps,
          { source: "geneanet", id },
          {
            detail: "full",
            eventsLimit: args.eventsLimit,
            deadline: client.now() + CALL_DEADLINE_MS,
          },
        );
      }),
  );

  server.registerTool(
    "geneanet_get_people",
    {
      title: "Geneanet: Get Several People",
      description:
        "Read up to 40 people of ONE family tree by index in one call, e.g. every index a " +
        'geneanet_get_tree answer listed. detail "summary" (default) gives each person\'s name, ' +
        "sex, vital events with places and sources, occupation, parents and spouses as briefs, " +
        'and a children count per family; "full" gives each the same record as ' +
        "geneanet_get_person. People are fetched one after another at about one per second; " +
        "people read earlier in this session cost nothing. A person that cannot be read comes " +
        "back in its place as {ref, error, remedy}. `withheld` and place `code`s read as in " +
        "geneanet_get_person. Indexes not reached within the time budget come back in " +
        "`remaining`: call again with them.",
      inputSchema: z.object({
        tree: treeArg,
        indexes: z
          .array(z.number().int().min(0))
          .min(1)
          .max(PEOPLE_MAX)
          .describe(
            "1-40 person indexes in THIS tree, as every other geneanet_* tree tool returns them (e.g. [27, 85]).",
          ),
        detail: z
          .enum(["summary", "full"])
          .default("summary")
          .describe(
            'How much of each person to return: "summary" (vitals, parents, spouses, children counts) or "full" (as geneanet_get_person). Defaults to "summary".',
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ tree, indexes, detail }, extra) => {
      try {
        const t = resolveTree(ctx, tree);
        const refs: RefInput[] = indexes.map((i) => ({
          source: "geneanet",
          id: geneanetRefId(t, i),
        }));
        const indexOf = new Map(refs.map((r, i) => [refKey(r), indexes[i]]));
        // oxlint-disable-next-line no-underscore-dangle -- `_meta` is the MCP protocol's name.
        const progressToken = extra.mcpReq._meta?.progressToken;
        const result = await fetchPeople(deps, refs, {
          detail,
          max: PEOPLE_MAX,
          budgetMs: PEOPLE_BUDGET_MS,
          ...(progressToken === undefined
            ? {}
            : {
                // A lost notification must not fail the read.
                onProgress: (progress: number, total: number) =>
                  extra.mcpReq
                    .notify({
                      method: "notifications/progress",
                      params: { progressToken, progress, total },
                    })
                    .catch(() => {}),
              }),
        });
        const remaining = result.remaining.map((r) => indexOf.get(refKey(r)));
        const answer = {
          tree: t,
          detail,
          people: result.people,
          ...(remaining.length > 0
            ? {
                remaining,
                note: "Not read in this call: call geneanet_get_people again with `remaining` as `indexes`.",
              }
            : {}),
        };
        const firstFailure = result.people.find(isFailure);
        if (firstFailure && result.people.every(isFailure)) {
          return fail(firstFailure.error, {
            ...(firstFailure.remedy ? { remedy: firstFailure.remedy } : {}),
            ...answer,
          });
        }
        return ok(answer);
      } catch (err) {
        return toFailure(err);
      }
    },
  );

  server.registerTool(
    "geneanet_get_tree",
    {
      title: "Geneanet: Get Family Tree Around a Person",
      description:
        "Ancestors and descendants of one person in a single call, with each relationship already " +
        "resolved: ancestors carry generation (1 = parents) and fatherIndex/motherIndex; " +
        "descendants carry relation (child or spouse) with parentIndexes and/or spouseOfIndexes (a cousin marriage has both); siblings " +
        "are listed too. Each person is a brief: ref, index, name and life years (born/died), " +
        'with withheld: "private" when the tree hides them; use geneanet_get_person on an index ' +
        "for places, sources and notes. One request whatever the depth, but 10 generations can be " +
        "over a thousand people, so start small.",
      inputSchema: z.object({
        tree: treeArg,
        index: indexArg,
        n: nArg,
        p: pArg,
        oc: ocArg,
        ancestors: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(3)
          .describe(
            "Generations of ancestors beyond the person (0-10): 1 = parents, 3 = up to great-grandparents. Defaults to 3.",
          ),
        descendants: z
          .number()
          .int()
          .min(0)
          .max(5)
          .default(1)
          .describe("Generations of descendants (0-5): 1 = spouses and children. Defaults to 1."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      wrap(async () => {
        const t = resolveTree(ctx, args.tree);
        const ref = resolveRef(args);
        return readGraph(
          client,
          t,
          ref,
          { ancestors: args.ancestors, descendants: args.descendants },
          client.now() + CALL_DEADLINE_MS,
        );
      }),
  );
};
