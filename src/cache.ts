import { refKey, type RefInput } from "#/schema/ids";
import type { Person } from "#/schema/types";

export type PersonCacheOptions = {
  /** People kept before the least recently read one is dropped. Defaults to 5000. */
  max?: number;
  /** How long a person stays fresh after it is put. Defaults to one hour. */
  ttlMs?: number;
  now?: () => number;
};

type Entry = { person: Person; storedAt: number };

/**
 * People already fetched in this server's lifetime, so later calls (a batch, a
 * GEDCOM export across several calls) need not fetch them again. In memory
 * only. LRU by `Map` insertion order: a read moves the entry to the end.
 *
 * Aliases map a Geneanet key-form ref ("<tree>:<n>/<p>/<oc>") to the
 * index-form ref it resolved to, so either finds the same person.
 */
export class PersonCache {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly people = new Map<string, Entry>();
  private readonly aliases = new Map<string, RefInput>();

  constructor(opts: PersonCacheOptions = {}) {
    this.max = opts.max ?? 5000;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The person under this ref or its alias, while fresh. The object is shared
   * with the cache and every later caller: never mutate it.
   */
  get(ref: RefInput): Person | undefined {
    const key = refKey(this.canonical(ref));
    const entry = this.fresh(key);
    if (!entry) return undefined;
    this.people.delete(key);
    this.people.set(key, entry);
    return entry.person;
  }

  /**
   * Keep a person under its ref. A fresh "full" record is never replaced by a
   * "summary", and a fresh complete one (no `eventsTruncated`) never by a full
   * one whose events were cut short, as a later call with a small eventsLimit
   * returns.
   */
  put(p: Person): void {
    const key = refKey(p.ref);
    const held = this.fresh(key)?.person;
    if (
      held?.detail === "full" &&
      (p.detail === "summary" || (p.eventsTruncated !== undefined && !held.eventsTruncated))
    ) {
      return;
    }
    this.people.delete(key);
    this.people.set(key, { person: p, storedAt: this.now() });
    evictOldest(this.people, this.max);
  }

  /** Record that `from` (a key-form ref) names the same person as `to` (its index form). */
  alias(from: RefInput, to: RefInput): void {
    const key = refKey(from);
    this.aliases.delete(key);
    this.aliases.set(key, { source: to.source, id: to.id });
    evictOldest(this.aliases, this.max);
  }

  /** The ref after aliases: the index form when one is known, else the ref as given. */
  canonical(ref: RefInput): RefInput {
    return this.aliases.get(refKey(ref)) ?? { source: ref.source, id: ref.id };
  }

  /** The entry under `key` if it has not expired; an expired one is dropped. */
  private fresh(key: string): Entry | undefined {
    const entry = this.people.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.people.delete(key);
      return undefined;
    }
    return entry;
  }
}

const evictOldest = <V>(map: Map<string, V>, max: number): void => {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
};
