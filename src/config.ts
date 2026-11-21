import { z } from "zod";

// No credentials and no write flag, on purpose:
// - Everything the tools read is public. The family-tree API (gw.geneanet.org/setup/api)
//   and the site-wide search answer anonymous requests. A session cookie would
//   only matter for private trees or Premium records, which v1 does not try to reach.
// - There are no write tools. Geneanet's tree-editing API exists, but nothing
//   registers it, so there is no GENEANET_ALLOW_WRITES to get wrong.

/** Out-of-range tuning is clamped and reported, never fatal (rule 2). */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const ConfigSchema = z
  .object({
    /** Family-tree API host. */
    treeBaseUrl: z.url().default("https://gw.geneanet.org"),
    /** Site-wide search host. The `en.` subdomain keeps labels and dates in English. */
    siteBaseUrl: z.url().default("https://en.geneanet.org"),
    /** Default tree (`sourcename`) for the tree tools when a call names none. */
    tree: z.string().min(1).optional(),
    /** Language for dates and event names in tree answers. */
    lang: z.string().default("en"),
    /** Minimum gap between two requests to Geneanet, across all tools. */
    minIntervalMs: z.number().int().default(1000),
    maxRetries: z.number().int().default(2),
    /** Per-request deadline. */
    timeoutMs: z.number().int().default(20_000),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema> & {
  /** Settings that were out of range and got clamped, for geneanet_auth_status. */
  adjusted: string[];
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

/** A tree name is the first path segment of its URL: gw.geneanet.org/<tree>. */
export const TREE_NAME = /^[a-z0-9][a-z0-9_.-]*$/i;

/**
 * Environment only: the server persists nothing of its own. A malformed value
 * is dropped with a note rather than thrown, because a server that exits at
 * startup surfaces as a bare "Connection closed" (rule 2).
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const adjusted: string[] = [];
  const intSetting = (name: string, min: number, max: number): number | undefined => {
    const raw = trimmed(env[name]);
    if (raw === undefined) return undefined;
    const n = parseIntOpt(raw);
    if (n === undefined) {
      adjusted.push(`${name}=${raw} is not an integer; using the default.`);
      return undefined;
    }
    const c = clamp(n, min, max);
    if (c !== n) adjusted.push(`${name}=${n} is out of range; using ${c}.`);
    return c;
  };

  const url = (name: string): string | undefined => {
    const raw = trimmed(env[name]);
    if (raw === undefined) return undefined;
    if (z.url().safeParse(raw).success) return raw.replace(/\/+$/, "");
    adjusted.push(`${name}=${raw} is not a URL; using the default.`);
    return undefined;
  };

  let tree = trimmed(env.GENEANET_TREE);
  if (tree !== undefined && !TREE_NAME.test(tree)) {
    adjusted.push(
      `GENEANET_TREE=${tree} is not a tree name (the path segment after gw.geneanet.org/); ignored.`,
    );
    tree = undefined;
  }

  const parsed = ConfigSchema.parse({
    treeBaseUrl: url("GENEANET_TREE_API_URL"),
    siteBaseUrl: url("GENEANET_SITE_URL"),
    tree,
    lang: trimmed(env.GENEANET_LANG),
    // Below 500 ms is impolite to a site that forbids automated access;
    // the default stays at one request per second.
    minIntervalMs: intSetting("GENEANET_MIN_INTERVAL_MS", 500, 60_000),
    maxRetries: intSetting("GENEANET_MAX_RETRIES", 0, 5),
    timeoutMs: intSetting("GENEANET_TIMEOUT_MS", 5_000, 120_000),
  });
  return { ...parsed, adjusted };
};
