import type { PersonCache } from "#/cache";
import { geneanetRefId, parseRef, type RefInput } from "#/schema/ids";
import type { Person, Ref } from "#/schema/types";
import { toGraph, toPerson, toSummary } from "#/sources/geneanet/adapter";
import { BlockedError, DeadlineError, GeneanetApiError } from "#/sources/geneanet/errors";
import type { GeneanetClient } from "#/sources/geneanet/geneanet";
import {
  decodeGraph,
  decodePerson,
  encodeGraphRequest,
  encodePersonRequest,
  type PersonRef,
} from "#/sources/geneanet/proto/messages";
import { profileUrl } from "#/sources/geneanet/shape";
import { ArgumentError } from "#/tools/util";

// Reading Geneanet people by ref, one (geneanet_get_person) or many
// (geneanet_get_people), through the shared person cache.

/** The time budget and the deadline are read on `client.now()`, the clock requests are timed on. */
export type FetchDeps = { client: GeneanetClient; cache: PersonCache };

export type ReadOptions = {
  detail: Person["detail"];
  /** Events (and witnessed events) asked of the API. Defaults to 50. */
  eventsLimit?: number;
  /** Absolute time (client clock) every request must be over by; see RequestOptions. */
  deadline?: number;
};

export type FetchOptions = ReadOptions & {
  /** People fetched over the network at most; cache hits are free. */
  max: number;
  /** No new fetch is started once this much time has passed since the call began. */
  budgetMs: number;
  /**
   * Hard stop, from the call's start: a request still running then is cut off and its
   * ref handed back in `remaining`. Defaults to 55 s, so a call ends before a 60 s client
   * timeout even when its last request started just inside `budgetMs`.
   */
  deadlineMs?: number;
  /** Called after each person fetched (or failed), with cache hits counted as done. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
};

/** A person that could not be read, in the place it had in the input. */
export type PersonFailure = { ref: Ref; error: string; remedy?: string };

export type FetchResult = {
  /** One entry per ref read, in input order: the person, or why it failed. */
  people: (Person | PersonFailure)[];
  /** Refs not reached (max, time budget, deadline, or a block), in input order. */
  remaining: RefInput[];
};

const DEFAULT_EVENTS_LIMIT = 50;
const DEFAULT_DEADLINE_MS = 55_000;

export const notFound = (tree: string, ref: PersonRef): GeneanetApiError =>
  new GeneanetApiError(
    `Tree ${tree} has no ${"index" in ref ? `person with index ${ref.index}` : `person ${ref.p} ${ref.n} (oc ${ref.oc})`}.`,
    {
      status: 404,
      remedy:
        "Indexes belong to one tree. Look the person up with geneanet_search_tree in this tree, " +
        "or check n/p/oc against the profile URL. A private person also answers this way.",
    },
  );

/**
 * The cached person for this ref when it answers a request at `detail`: any
 * record does for "summary" (a full one is cut down to its summary); "full"
 * needs a full record whose events were not cut short, since the caller may be
 * asking for more of them.
 */
const held = (cache: PersonCache, ref: RefInput, detail: Person["detail"]): Person | undefined => {
  const p = cache.get(ref);
  if (!p) return undefined;
  if (detail === "summary") return toSummary(p);
  return p.detail === "full" && !p.eventsTruncated ? p : undefined;
};

/** The person op takes only an index; a key is resolved through a one-node graph. */
const indexFor = async (
  client: GeneanetClient,
  tree: string,
  ref: PersonRef,
  deadline: number | undefined,
): Promise<number> => {
  if ("index" in ref) return ref.index;
  const res = await client.treeApi(
    "graph_v2",
    tree,
    encodeGraphRequest({ person: ref, ancestorGenerations: 0, descendantGenerations: 0 }),
    deadline === undefined ? {} : { deadline },
  );
  const root = res ? decodeGraph(res).ancestors[0] : undefined;
  if (!root || root.person.index < 0) throw notFound(tree, ref);
  return root.person.index;
};

/** The resolved graph, as geneanet_get_tree answers it. */
export type TreeGraph = ReturnType<typeof toGraph>;

/**
 * Ancestors and descendants of one person in one `graph_v2` request, resolved
 * into people (see `toGraph`). Throws when the tree has no such person.
 */
export const readGraph = async (
  client: GeneanetClient,
  tree: string,
  person: PersonRef,
  generations: { ancestors: number; descendants: number },
  deadline?: number,
): Promise<TreeGraph> => {
  const res = await client.treeApi(
    "graph_v2",
    tree,
    encodeGraphRequest({
      person,
      ancestorGenerations: generations.ancestors,
      descendantGenerations: generations.descendants,
    }),
    deadline === undefined ? {} : { deadline },
  );
  const shaped = res ? toGraph(client.treeBaseUrl, tree, decodeGraph(res)) : { found: false };
  if (shaped.found === false) throw notFound(tree, person);
  return shaped;
};

/**
 * Read one Geneanet person: from the cache when it holds a usable record,
 * else from the API (one request, two for a key-form ref not aliased yet).
 * The fetched person is cached, and a key-form ref is aliased to it. Throws
 * on failure, like the API call it wraps.
 */
export const fetchPerson = async (
  deps: FetchDeps,
  ref: RefInput,
  opts: ReadOptions,
): Promise<Person> => {
  const hit = held(deps.cache, ref, opts.detail);
  if (hit) return hit;

  // canonical() first: a key-form ref already aliased goes straight to its index.
  const parsed = parseRef(deps.cache.canonical(ref));
  if (parsed.source !== "geneanet") {
    throw new ArgumentError(
      `A ${parsed.source} ref cannot be read from Geneanet.`,
      'Pass Geneanet refs only: {source:"geneanet", id:"<tree>:<index>"}.',
    );
  }
  const { tree } = parsed;
  const key: PersonRef =
    "index" in parsed ? { index: parsed.index } : { n: parsed.n, p: parsed.p, oc: parsed.oc };
  const index = await indexFor(deps.client, tree, key, opts.deadline);
  if (!("index" in key)) {
    // The index form may already be held (named earlier in the same batch, say).
    const known = held(
      deps.cache,
      { source: "geneanet", id: geneanetRefId(tree, index) },
      opts.detail,
    );
    if (known) {
      deps.cache.alias(ref, known.ref);
      return known;
    }
  }
  const limit = opts.eventsLimit ?? DEFAULT_EVENTS_LIMIT;
  const res = await deps.client.treeApi(
    "person",
    tree,
    encodePersonRequest({ index, eventsLimit: limit, witnessedEventsLimit: limit }),
    opts.deadline === undefined ? {} : { deadline: opts.deadline },
  );
  if (!res) throw notFound(tree, key);
  const person = toPerson(deps.client.treeBaseUrl, tree, decodePerson(res), opts.detail);
  deps.cache.put(person);
  if (!("index" in key)) deps.cache.alias(ref, person.ref);
  return person;
};

/**
 * Where a human can check a ref that failed. A key-form ref has a profile
 * URL; an index-form one only GeneWeb's `i=` form of it; a ref that does not
 * parse falls back to the tree site itself.
 */
const failedRefUrl = (base: string, ref: RefInput): string => {
  try {
    const p = parseRef(ref);
    if (p.source === "geneanet") {
      return "index" in p
        ? `${base}/${encodeURIComponent(p.tree)}?lang=en&i=${p.index}`
        : profileUrl(base, p.tree, p);
    }
  } catch {
    // Unparseable: the failure itself says why.
  }
  return base;
};

const failure = (base: string, ref: RefInput, err: unknown): PersonFailure => {
  const remedy =
    err instanceof GeneanetApiError || err instanceof ArgumentError ? err.remedy : undefined;
  return {
    ref: { source: ref.source, id: ref.id, url: failedRefUrl(base, ref) },
    error: err instanceof Error ? err.message : String(err),
    ...(remedy ? { remedy } : {}),
  };
};

/**
 * Read several people. Cache hits are served first and do not count against
 * `max`; the rest are fetched one after another in input order until `max`
 * fetches are done or `budgetMs` has passed, and whatever is left comes back
 * in `remaining`. Every request must also be over by the hard deadline; one
 * it cuts off is not a failure: that ref and every later one go to `remaining`.
 * A failure lands in place in `people`; a `BlockedError` (Cloudflare) also
 * ends the batch, since every later request would meet it.
 */
export const fetchPeople = async (
  deps: FetchDeps,
  refs: RefInput[],
  opts: FetchOptions,
): Promise<FetchResult> => {
  const now = (): number => deps.client.now();
  const start = now();
  const deadline = start + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const base = deps.client.treeBaseUrl;
  const slots: (Person | PersonFailure | undefined)[] = refs.map((r) =>
    held(deps.cache, r, opts.detail),
  );
  const remaining: RefInput[] = [];
  let done = slots.filter(Boolean).length;
  let fetched = 0;
  let stopped = false;

  for (const [i, ref] of refs.entries()) {
    if (slots[i]) continue;
    if (stopped) {
      remaining.push(ref);
      continue;
    }
    // A ref named twice, or a key resolved earlier in this batch, is a hit by now.
    const hit = held(deps.cache, ref, opts.detail);
    if (hit) {
      slots[i] = hit;
      done += 1;
      continue;
    }
    if (fetched >= opts.max || now() - start > opts.budgetMs) {
      stopped = true;
      remaining.push(ref);
      continue;
    }
    fetched += 1;
    try {
      slots[i] = await fetchPerson(deps, ref, { ...opts, deadline });
    } catch (err) {
      if (err instanceof DeadlineError) {
        stopped = true;
        remaining.push(ref);
        continue;
      }
      slots[i] = failure(base, ref, err);
      if (err instanceof BlockedError) stopped = true;
    }
    done += 1;
    await opts.onProgress?.(done, refs.length);
  }

  return {
    people: slots.filter((s): s is Person | PersonFailure => s !== undefined),
    remaining,
  };
};

/** True for an entry of `FetchResult.people` that is a failure. */
export const isFailure = (p: Person | PersonFailure): p is PersonFailure => "error" in p;
