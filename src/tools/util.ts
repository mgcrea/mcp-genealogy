import { z } from "zod";

import { TREE_NAME } from "#/config";
import { DeadlineError, GeneanetApiError } from "#/sources/geneanet/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Compact JSON: indentation adds 19-41% to every response and no model needs it. */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * `extra` is spread at the top level, so a `remedy` lands beside the error
 * rather than inside the upstream envelope, where it gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** A mistake in the arguments, reported with the fix, never sent upstream. */
export class ArgumentError extends Error {
  override readonly name = "ArgumentError";
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.remedy = remedy;
  }
}

/**
 * How long a tool call may spend on Geneanet, retries included: a single-request tool passes
 * `client.now() + CALL_DEADLINE_MS` as its deadline, so it ends before a 60 s client timeout.
 */
export const CALL_DEADLINE_MS = 55_000;

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  // A batch hands a cut-off request back in `remaining`; one reaching here failed the call.
  if (err instanceof DeadlineError) {
    return fail(err.message, {
      remedy: "Geneanet is slow to answer right now; try again in a minute.",
      status: err.status,
    });
  }
  if (err instanceof GeneanetApiError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      status: err.status,
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof ArgumentError) return fail(err.message, { remedy: err.remedy });
  if (err instanceof Error) return fail(err.message);
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

// ── Arg atoms ────────────────────────────────────────────────────────────────

export const treeArg = z
  .string()
  .regex(
    TREE_NAME,
    "A tree name is the path segment after gw.geneanet.org/, e.g. maudrenel1: no slashes or spaces.",
  )
  .optional()
  .describe(
    'The family tree to read: its owner\'s Geneanet username, the first path segment of a tree URL (gw.geneanet.org/maudrenel1 → "maudrenel1"). ' +
      "Every geneanet_search_records family_tree hit carries it as `tree`. Defaults to GENEANET_TREE when that is set.",
  );

export const indexArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "The person's internal index in THIS tree, the `index` that every other geneanet_* tree tool returns (e.g. 27). " +
      "Indexes are per tree: the same ancestor has a different index in every tree.",
  );

export const nArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Surname key, lower case without accents, as in a profile URL\'s `n=` (e.g. "louvignes"). ' +
      "Use with `p` instead of `index`, typically straight from a geneanet_search_records hit.",
  );

export const pArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'First-names key, lower case without accents, as in a profile URL\'s `p=` (e.g. "marie germaine"; spaces, not +).',
  );

export const ocArg = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe(
    "Occurrence number telling apart homonyms in one tree, the URL's `oc=`. Defaults to 0, which is right unless the URL has an oc.",
  );
