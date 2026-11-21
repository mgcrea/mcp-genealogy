import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BUILD_INFO } from "#/build-info";
import { TREE_NAME } from "#/config";
import { writeGedcom } from "#/gedcom/write";
import { geneanetRefId, parseRef, refKey, type RefInput } from "#/schema/ids";
import type { Brief, Person } from "#/schema/types";
import { fetchPeople, isFailure, readGraph } from "#/sources/geneanet/fetch";
import type { GeneanetClient } from "#/sources/geneanet/geneanet";
import type { ToolContext } from "#/tools/index";
import { ArgumentError, fail, ok, toFailure, type ToolResult } from "#/tools/util";

// The one tool that writes a file, and only into `config.exportDir`: a `file` argument that
// resolves anywhere else, or is a symlink, is refused before anything is fetched. It only ever
// replaces a .ged it wrote itself (one with a sidecar beside it), and replaces it atomically.

/** Same cap and scheduling budget as geneanet_get_people; the hard deadline is fetchPeople's. */
const EXPORT_MAX = 40;
const EXPORT_BUDGET_MS = 45_000;
const EXPORT_DEADLINE_MS = 55_000;

const SIDECAR = ".refs.json";

const RefArg = z.object({
  source: z
    .enum(["geneanet", "matchid", "geni", "familysearch"])
    .describe('The ref\'s source, as a tool returned it. Only "geneanet" can be exported yet.'),
  id: z.string().min(1).describe('The ref\'s id, e.g. "maudrenel1:27".'),
  url: z.string().optional().describe("The ref's url; ignored."),
});

const Detail = z.enum(["summary", "full"]);

const SidecarSchema = z.object({
  /** The detail the file was last written at, so an append without `detail` keeps it. */
  detail: Detail.optional(),
  refs: z.array(z.object({ source: z.literal("geneanet"), id: z.string().min(1) })),
});

type Sidecar = z.infer<typeof SidecarSchema>;

const FILE_REMEDY =
  'Pass a file name ending in .ged (e.g. "louvignes.ged") or the `file` an earlier call returned: it must sit directly in the export folder (genealogy_status shows it as exportDir).';

const ONLY_GENEANET =
  'Pass Geneanet refs only, {source:"geneanet", id:"<tree>:<index>"}; matchID and other sources cannot be fetched for an export yet.';

/** Today in local time, YYYY-MM-DD. */
const today = (d = new Date()): string =>
  [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0"))
    .join("-");

/** A surname as a file-name slug: ASCII, lower case, dashes; "export" when nothing is left. */
const slugOf = (surname: string | undefined): string =>
  (surname ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "export";

const hasCode = (err: unknown, code: string): boolean =>
  err instanceof Error && "code" in err && err.code === code;

const isMissing = (err: unknown): boolean => hasCode(err, "ENOENT");

/** Throws unless nothing, or a regular file, sits at `path` (never write through a symlink). */
const assertNotLink = async (path: string): Promise<void> => {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new ArgumentError(
        `${path} is a symbolic link; exports never write through one.`,
        FILE_REMEDY,
      );
    }
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
};

/** The path a `file` argument names, inside the export folder or not at all. */
const exportPath = (dir: string, file: string): string => {
  const path = resolve(dir, file);
  if (dirname(path) !== dir || !path.endsWith(".ged") || basename(path) === ".ged") {
    throw new ArgumentError(
      `${JSON.stringify(file)} is not a .ged file in the export folder ${dir}.`,
      FILE_REMEDY,
    );
  }
  return path;
};

const NOT_OURS_REMEDY =
  "Pass a new file name, leave out `file` to create a new export, or pass the `file` a genealogy_export_gedcom call returned.";

/**
 * The sidecar an earlier call wrote for `path`, read only when `parse` (an append); no refs
 * when neither the file nor its sidecar exists. A .ged with no sidecar was not written by this
 * tool, and is never replaced.
 */
const ownedSidecar = async (path: string, parse: boolean): Promise<Sidecar> => {
  let raw: string;
  try {
    raw = await readFile(`${path}${SIDECAR}`, "utf8");
  } catch (err) {
    if (!isMissing(err)) throw err;
    try {
      await lstat(path);
    } catch (e) {
      if (isMissing(e)) return { refs: [] };
      throw e;
    }
    throw new ArgumentError(
      `${path} has no ${basename(path)}${SIDECAR} beside it, so it was not written by this tool; it is never replaced.`,
      NOT_OURS_REMEDY,
    );
  }
  if (!parse) return { refs: [] };
  let parsed: Sidecar | undefined;
  try {
    parsed = SidecarSchema.parse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    throw new ArgumentError(
      `${path}${SIDECAR} is not a list of refs this tool wrote.`,
      "Export again without `append` to rebuild the file from the people you pass.",
    );
  }
  return parsed;
};

/**
 * Replace `path` with `text` atomically: written to a fresh temporary name in the same folder,
 * then renamed over it. A rename replaces a symlink itself, never what it points at.
 */
const writeAtomic = async (path: string, text: string): Promise<void> => {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: "utf8", flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
};

/** Reserve `<stem>.ged`, or `-2`, `-3`… when taken, as an empty file; never replaces one. */
const reserveNew = async (dir: string, stem: string): Promise<string> => {
  for (let n = 1; ; n += 1) {
    const path = join(dir, `${stem}${n === 1 ? "" : `-${n}`}.ged`);
    try {
      await (await open(path, "wx")).close();
      return path;
    } catch (err) {
      if (!hasCode(err, "EEXIST")) throw err;
    }
  }
};

/**
 * Write the sidecar, then the .ged: a failure between the two leaves a sidecar, so the file can
 * still be appended to or overwritten. A name reserved by this call is released on failure.
 */
const commit = async (
  path: string,
  text: string,
  sidecar: Sidecar,
  reserved: boolean,
): Promise<void> => {
  try {
    await writeAtomic(`${path}${SIDECAR}`, JSON.stringify(sidecar));
    await writeAtomic(path, text);
  } catch (err) {
    if (reserved) {
      await rm(`${path}${SIDECAR}`, { force: true });
      await rm(path, { force: true });
    }
    throw err;
  }
};

/** Union in order, by ref key. */
const union = (...lists: RefInput[][]): RefInput[] => {
  const seen = new Map<string, RefInput>();
  for (const r of lists.flat()) if (!seen.has(refKey(r))) seen.set(refKey(r), r);
  return [...seen.values()];
};

/**
 * A copy of the person with every brief's ref through the cache's aliases, so a key-form brief
 * and the index-form person it names are one INDI. Cached objects are never mutated.
 */
const withCanonicalLinks = (ctx: ToolContext, p: Person): Person => {
  const brief = <B extends Brief>(b: B): B => ({
    ...b,
    ref: { ...b.ref, ...ctx.cache.canonical(b.ref) },
  });
  return {
    ...p,
    events: p.events.map((e) => (e.with ? { ...e, with: brief(e.with) } : e)),
    ...(p.parents ? { parents: p.parents.map(brief) } : {}),
    ...(p.families
      ? {
          families: p.families.map((f) => ({
            ...f,
            ...(f.spouse ? { spouse: brief(f.spouse) } : {}),
            ...(f.children ? { children: f.children.map(brief) } : {}),
          })),
        }
      : {}),
  };
};

/** Every person in a pedigree, as refs: the root, its ancestors and descendants, no siblings. */
const pedigreeRefs = async (
  client: GeneanetClient,
  p: { tree: string; index: number; ancestors: number; descendants: number },
  deadline: number,
): Promise<RefInput[]> => {
  const graph = await readGraph(
    client,
    p.tree,
    { index: p.index },
    { ancestors: p.ancestors, descendants: p.descendants },
    deadline,
  );
  type Node = { index?: number; generation?: number; unknown?: true };
  const within = (max: number) => (n: Node) => (n.generation ?? 0) <= max;
  const nodes: Node[] = [
    graph.root as Node,
    ...((graph.ancestors ?? []) as Node[]).filter(within(p.ancestors)),
    ...(p.descendants > 0
      ? ((graph.descendants ?? []) as Node[]).filter(within(p.descendants))
      : []),
  ];
  // A "? ?" partner has nothing to export.
  return nodes
    .filter((n) => n.index !== undefined && n.index >= 0 && !n.unknown)
    .map((n) => ({ source: "geneanet", id: geneanetRefId(p.tree, n.index as number) }));
};

export const registerExportTools = (
  server: McpServer,
  client: GeneanetClient,
  ctx: ToolContext,
): void => {
  const deps = { client, cache: ctx.cache };

  server.registerTool(
    "genealogy_export_gedcom",
    {
      title: "Genealogy: Export GEDCOM",
      description:
        "Write people to a GEDCOM 7.0 file in the export folder and return its path and counts " +
        "{file, people, families, sources}, not its contents, with `warnings` when people could " +
        "not be read or links point at people left out. Pass `people` (refs as the other tools " +
        "return them) or a `pedigree` (a Geneanet person with its ancestors and descendants, " +
        "read in one request). Each call fetches at most 40 people (people read earlier in this " +
        "session cost nothing); the rest come back in `remaining`, and one file grows across " +
        "calls when you pass the returned `file` with `append: true`. Only files this tool wrote " +
        "are ever replaced. Pointing GENEALOGY_EXPORT_DIR at the folder granted in " +
        "Filiation › Settings › MCP Server lets a Filiation agent read the file.",
      inputSchema: z.object({
        people: z
          .array(RefArg)
          .min(1)
          .max(500)
          .optional()
          .describe(
            '1-500 refs to export, e.g. [{source:"geneanet", id:"maudrenel1:27"}]; key-form ids ' +
              '("<tree>:<surname>/<given names>/<occurrence>") are resolved. Give this or `pedigree`.',
          ),
        pedigree: z
          .object({
            source: z.literal("geneanet").describe('Always "geneanet".'),
            tree: z
              .string()
              .regex(TREE_NAME, "A tree name is the path segment after gw.geneanet.org/.")
              .describe('The family tree, e.g. "maudrenel1".'),
            index: z.number().int().min(0).describe("The root person's index in that tree."),
            ancestors: z
              .number()
              .int()
              .min(0)
              .max(10)
              .default(3)
              .describe("Generations of ancestors (0-10, 1 = parents). Defaults to 3."),
            descendants: z
              .number()
              .int()
              .min(0)
              .max(5)
              .default(1)
              .describe(
                "Generations of descendants (0-5, 1 = spouses and children). Defaults to 1.",
              ),
          })
          .optional()
          .describe(
            "A Geneanet person with ancestors and descendants (siblings left out), read with one graph request. Give this or `people`.",
          ),
        detail: Detail.optional().describe(
          'How much of each person to write: "summary" (vital events, occupation, families) or "full" (every event, notes, witnesses). Defaults to the detail the file was written at when appending, else "summary"; a different one re-renders the whole file.',
        ),
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A .ged file in the export folder: the `file` an earlier call returned, or a new name. Omitted, a new <date>-<surname>.ged is created. Given without `append`, a file this tool wrote is overwritten; any other existing file is refused.",
          ),
        append: z
          .boolean()
          .default(false)
          .describe(
            "With `file`: keep the people already in it and add these, rewriting the whole file. Use it to finish an export whose `remaining` was not empty.",
          ),
      }),
      // It writes a local file, so not read-only; it only ever replaces its own files.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        if ((args.people === undefined) === (args.pedigree === undefined)) {
          throw new ArgumentError(
            "Give exactly one of `people` and `pedigree`.",
            'Pass `people` as a list of refs, or `pedigree` as {source:"geneanet", tree, index}.',
          );
        }
        if (args.append && args.file === undefined) {
          throw new ArgumentError(
            "`append` adds to a file, and no `file` was given.",
            "Pass the `file` an earlier genealogy_export_gedcom call returned, or leave out `append`.",
          );
        }
        for (const r of args.people ?? []) {
          if (r.source !== "geneanet") {
            throw new ArgumentError(`A ${r.source} ref cannot be exported yet.`, ONLY_GENEANET);
          }
          parseRef(r);
        }

        const dir = ctx.config.exportDir;
        const target = args.file === undefined ? undefined : exportPath(dir, args.file);
        if (target) {
          await assertNotLink(target);
          await assertNotLink(`${target}${SIDECAR}`);
        }
        const owned = target ? await ownedSidecar(target, args.append) : { refs: [] };
        const detail = args.detail ?? owned.detail ?? "summary";
        // Every held person is written again at the new detail, not only the ones added.
        const rerendered = owned.detail !== undefined && detail !== owned.detail;

        const start = client.now();
        const asked = args.pedigree
          ? await pedigreeRefs(client, args.pedigree, start + EXPORT_DEADLINE_MS)
          : (args.people ?? []).map((r) => ({ source: r.source, id: r.id }));
        const refs = union(union(owned.refs, asked).map((r) => ctx.cache.canonical(r)));
        const elapsed = client.now() - start;
        if (args.pedigree && EXPORT_BUDGET_MS - elapsed <= 0) {
          return fail("Geneanet was too slow to answer the pedigree request; try again.", {
            remedy: "Call again in a minute, or with fewer generations.",
          });
        }
        const result = await fetchPeople(deps, refs, {
          detail,
          max: EXPORT_MAX,
          budgetMs: EXPORT_BUDGET_MS - elapsed,
          deadlineMs: EXPORT_DEADLINE_MS - elapsed,
        });

        // Key-form refs resolved in this call now have their index form.
        const kept = union(refs.map((r) => ctx.cache.canonical(r)));
        const people = result.people.filter((p): p is Person => !isFailure(p));
        const failures = result.people.filter(isFailure);
        const remaining = result.remaining.map((r) => ctx.cache.canonical(r));
        const warnings = [
          ...failures.map((f) => `${f.ref.id}: ${f.error}`),
          ...(remaining.length > 0
            ? [
                `${remaining.length} people not fetched in this call (40-request cap or time budget).`,
              ]
            : []),
        ];

        const first = failures[0];
        if (people.length === 0) {
          return fail(first?.error ?? "No person could be read.", {
            ...(first?.remedy ? { remedy: first.remedy } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(remaining.length > 0 ? { remaining } : {}),
          });
        }

        const date = today();
        const gedcom = writeGedcom(
          { people: people.map((p) => withCanonicalLinks(ctx, p)) },
          { date, version: BUILD_INFO.version },
        );
        await mkdir(dir, { recursive: true });
        const file = target ?? (await reserveNew(dir, `${date}-${slugOf(people[0]?.surname)}`));
        await commit(
          file,
          gedcom.text,
          { detail, refs: kept.map((r) => ({ source: "geneanet", id: r.id })) },
          target === undefined,
        );

        const allWarnings = [...warnings, ...gedcom.warnings];
        const short = gedcom.stats.people < kept.length;
        const note = [
          rerendered
            ? `The whole file was re-rendered at detail "${detail}" (it was "${owned.detail}").`
            : undefined,
          short
            ? `The file holds ${gedcom.stats.people} of ${kept.length} people; call again ` +
              "with this `file` and `append: true`" +
              (remaining.length > 0
                ? ", passing `remaining` as `people`."
                : " to retry the ones in `warnings`.")
            : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        return ok({
          file,
          ...gedcom.stats,
          ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
          ...(remaining.length > 0 ? { remaining } : {}),
          ...(note ? { note } : {}),
        });
      } catch (err) {
        return toFailure(err);
      }
    },
  );
};
