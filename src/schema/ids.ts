import { TREE_NAME } from "#/config";
import type { Ref } from "#/schema/types";
import type { PersonKey } from "#/sources/geneanet/proto/messages";
import { ArgumentError } from "#/tools/util";

// Plumbing over `Ref.id`, whose form depends on the source:
//   geneanet  "<tree>:<index>", or "<tree>:<surname>/<given names>/<occurrence>" for a
//             family-tree search hit that has no index yet
//   matchid   its own id
// geni and familysearch refs are not fetchable yet, so parseRef rejects them.

export type RefInput = { source: Ref["source"]; id: string };

export type ParsedRef =
  | { source: "geneanet"; tree: string; index: number }
  | { source: "geneanet"; tree: string; n: string; p: string; oc: number }
  | { source: "matchid"; id: string };

const REMEDY =
  'Pass a ref as a tool returned it: {source:"geneanet", id:"<tree>:<index>"}, ' +
  '{source:"geneanet", id:"<tree>:<surname>/<given names>/<occurrence>"} or ' +
  '{source:"matchid", id:"<id>"}.';

/** A non-negative integer without leading zeros, so each number has one spelling. */
const COUNT = /^(?:0|[1-9]\d*)$/;
const MATCHID = /^[A-Za-z0-9_-]+$/;
/** Surname and given names are non-empty and slash-free; the occurrence follows the last slash. */
const KEY = /^([^/]+)\/([^/]+)\/(\d+)$/;

const invalid = (ref: RefInput, why: string): ArgumentError =>
  new ArgumentError(`Invalid ${ref.source} ref id ${JSON.stringify(ref.id)}: ${why}`, REMEDY);

const count = (text: string): number | undefined => {
  if (!COUNT.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
};

const parseGeneanet = (ref: RefInput): ParsedRef => {
  const colon = ref.id.indexOf(":");
  if (colon < 0) throw invalid(ref, "expected <tree>:<person>.");
  const tree = ref.id.slice(0, colon);
  const person = ref.id.slice(colon + 1);
  if (!TREE_NAME.test(tree)) throw invalid(ref, `${JSON.stringify(tree)} is not a tree name.`);

  const index = count(person);
  if (index !== undefined) return { source: "geneanet", tree, index };

  const key = KEY.exec(person);
  const oc = key?.[3] === undefined ? undefined : count(key[3]);
  if (key?.[1] === undefined || key[2] === undefined || oc === undefined) {
    throw invalid(ref, "the person is an index or <surname>/<given names>/<occurrence>.");
  }
  return { source: "geneanet", tree, n: key[1], p: key[2], oc };
};

/** The cache key for a ref: one string across every source. */
export const refKey = (ref: RefInput): string => `${ref.source}:${ref.id}`;

/** Read a ref's id into its parts; anything not fetchable throws with the accepted forms. */
export const parseRef = (ref: RefInput): ParsedRef => {
  switch (ref.source) {
    case "geneanet":
      return parseGeneanet(ref);
    case "matchid":
      if (!MATCHID.test(ref.id)) throw invalid(ref, "a matchID id is letters, digits, - and _.");
      return { source: "matchid", id: ref.id };
    default:
      throw new ArgumentError(
        `Refs from ${JSON.stringify(ref.source)} cannot be fetched yet.`,
        REMEDY,
      );
  }
};

export const geneanetRefId = (tree: string, index: number): string => `${tree}:${index}`;

export const geneanetKeyRefId = (tree: string, key: PersonKey): string =>
  `${tree}:${key.n}/${key.p}/${key.oc}`;
