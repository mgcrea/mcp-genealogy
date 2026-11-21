// Text and URL helpers the Geneanet adapter and the records parser share: GeneWeb notes are
// HTML fragments, names come as two parts with "?" for unknown, and a person's profile page is
// built from their n/p/oc key.

import type { PersonKey } from "#/sources/geneanet/proto/messages";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Notes are user-written: one out-of-range entity must not fail the whole record.
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[ref.toLowerCase()] ?? whole;
  });

/** GeneWeb notes are HTML fragments. Keep the line structure, drop the markup. */
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const displayName = (firstname: string, lastname: string): string =>
  [firstname, lastname].filter((s) => s && s !== "?").join(" ") || "?";

/** The public profile page, which is also where a human checks the data. */
export const profileUrl = (treeBaseUrl: string, tree: string, key: PersonKey): string => {
  const q = new URLSearchParams({ lang: "en", n: key.n, p: key.p });
  if (key.oc) q.set("oc", String(key.oc));
  return `${treeBaseUrl}/${encodeURIComponent(tree)}?${q.toString()}`;
};

/**
 * Where a human checks a person: the profile page, or GeneWeb's `i=` form when the key is
 * missing or empty (a masked "x x" person has no n/p), which needs no name to be right.
 */
export const personUrl = (
  treeBaseUrl: string,
  tree: string,
  index: number,
  key: PersonKey | undefined,
): string =>
  key?.n && key.p
    ? profileUrl(treeBaseUrl, tree, key)
    : `${treeBaseUrl}/${encodeURIComponent(tree)}?lang=en&i=${index}`;
