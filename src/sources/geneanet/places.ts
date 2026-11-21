// Geneanet place strings into the shared Place. GeneWeb places are comma-separated, most
// specific first ("Cahuzac-sur-Vère, Tarn, Occitanie, France"); some places carry a 5-character
// commune code after the town. Only the exact "town, [code], department, region, country" shape
// fills department, region and country: any other shape keeps the first token as `name`, the
// code if one is there, and the whole string in `raw`. No lookup tables.
//
// A 5-digit postal code looks like an INSEE code: trees write "Albi, 81000, Tarn, France" (81000
// is Albi's postal code, 81004 its INSEE code). So the code is `insee` only when the caller knows
// the source writes INSEE codes (`inseeCode`); otherwise it is `code`, postal or INSEE unknown.

import type { Place } from "#/schema/types";

const CODE = /^(\d{5}|2[AB]\d{3})$/;

export const splitPlace = (
  input: string | undefined,
  opts: { inseeCode?: boolean } = {},
): Place | undefined => {
  const codeField = (code: string): Pick<Place, "insee" | "code"> =>
    opts.inseeCode ? { insee: code } : { code };
  // The original, trimmed, without trailing separators: "Albi, Tarn," is "Albi, Tarn".
  const raw = input?.trim().replace(/[\s,]+$/, "");
  if (!raw) return undefined;
  const tokens = raw.split(",").map((t) => t.trim());
  if (tokens.length === 1) return { name: raw };

  const complete = tokens.every(Boolean);
  if (complete && tokens.length === 4 && !tokens.some((t) => CODE.test(t))) {
    const [name, department, region, country] = tokens as [string, string, string, string];
    return { name, department, region, country, raw };
  }
  if (complete && tokens.length === 5 && CODE.test(tokens[1]!)) {
    const [name, code, department, region, country] = tokens as [
      string,
      string,
      string,
      string,
      string,
    ];
    return { name, ...codeField(code), department, region, country, raw };
  }

  const nameAt = tokens.findIndex(Boolean);
  const code = tokens.find((t, i) => i !== nameAt && CODE.test(t));
  return { name: tokens[nameAt]!, ...(code ? codeField(code) : {}), raw };
};
