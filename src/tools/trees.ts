import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { GeneanetApiError } from "#/client/errors";
import type { GeneanetClient } from "#/client/geneanet";
import { shapeGraph, shapePerson, shapeSearchHits } from "#/client/shape";
import {
  decodeGraph,
  decodePerson,
  decodeSearchList,
  encodeGraphRequest,
  encodePersonRequest,
  encodeSearchRequest,
  type PersonRef,
} from "#/proto/messages";
import type { ToolContext } from "#/tools/index";
import { ArgumentError, indexArg, nArg, ocArg, pArg, treeArg, wrap } from "#/tools/util";

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

const notFound = (tree: string, ref: PersonRef): GeneanetApiError =>
  new GeneanetApiError(
    `Tree ${tree} has no ${"index" in ref ? `person with index ${ref.index}` : `person ${ref.p} ${ref.n} (oc ${ref.oc})`}.`,
    {
      status: 404,
      remedy:
        "Indexes belong to one tree. Look the person up with geneanet_search_tree in this tree, " +
        "or check n/p/oc against the profile URL. A private person also answers this way.",
    },
  );

export const registerTreeTools = (
  server: McpServer,
  client: GeneanetClient,
  ctx: ToolContext,
): void => {
  const base = client.treeBaseUrl;

  /** The person op takes only an index; a key is resolved through a one-node graph. */
  const indexFor = async (tree: string, ref: PersonRef): Promise<number> => {
    if ("index" in ref) return ref.index;
    const res = await client.treeApi(
      "graph_v2",
      tree,
      encodeGraphRequest({ person: ref, ancestorGenerations: 0, descendantGenerations: 0 }),
    );
    const root = res ? decodeGraph(res).ancestors[0] : undefined;
    if (!root || root.person.index < 0) throw notFound(tree, ref);
    return root.person.index;
  };

  server.registerTool(
    "geneanet_search_tree",
    {
      title: "Geneanet: Search One Family Tree",
      description:
        "Search ONE family tree by surname and/or first name; returns each match's index, dates, " +
        "parents and spouses, ready for geneanet_get_person. Matching is the tree's own: names " +
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
        );
        return shapeSearchHits(base, t, res ? decodeSearchList(res) : [], ctx.config.lang, limit);
      }),
  );

  server.registerTool(
    "geneanet_get_person",
    {
      title: "Geneanet: Get Person",
      description:
        "Read one person's full record from a family tree: names and aliases, birth, baptism, " +
        "death and burial with places and sources, occupation, notes, parents, every union with " +
        "its children, and the event list with witnesses. Relatives come back as {index, name, " +
        "life}; pass an index back here to walk the tree one person at a time, or use " +
        "geneanet_get_tree for several generations in one call. One request with `index`, two " +
        "with n/p.",
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
        const index = await indexFor(t, ref);
        const res = await client.treeApi(
          "person",
          t,
          encodePersonRequest({
            index,
            eventsLimit: args.eventsLimit,
            witnessedEventsLimit: args.eventsLimit,
          }),
        );
        if (!res) throw notFound(t, ref);
        return shapePerson(base, t, decodePerson(res));
      }),
  );

  server.registerTool(
    "geneanet_get_tree",
    {
      title: "Geneanet: Get Family Tree Around a Person",
      description:
        "Ancestors and descendants of one person in a single call, with each relationship already " +
        "resolved: ancestors carry generation (1 = parents) and fatherIndex/motherIndex; " +
        "descendants carry relation (child or spouse) with parentIndexes and/or spouseOfIndexes (a cousin marriage has both); siblings " +
        "are listed too. Names and life years only; use geneanet_get_person on an index for " +
        "places, sources and notes. One request whatever the depth, but 10 generations can be " +
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
        const res = await client.treeApi(
          "graph_v2",
          t,
          encodeGraphRequest({
            person: ref,
            ancestorGenerations: args.ancestors,
            descendantGenerations: args.descendants,
          }),
        );
        const shaped = res ? shapeGraph(base, t, decodeGraph(res)) : { found: false };
        if (shaped.found === false) throw notFound(t, ref);
        return shaped;
      }),
  );
};
