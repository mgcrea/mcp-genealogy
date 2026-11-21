import { describe, expect, it } from "vitest";

import { splitPlace } from "#/sources/geneanet/places";

describe("splitPlace", () => {
  it("fills every field from the exact town, department, region, country shape", () => {
    const raw = "Cahuzac-sur-Vère, Tarn, Occitanie, France";
    expect(splitPlace(raw)).toEqual({
      name: "Cahuzac-sur-Vère",
      department: "Tarn",
      region: "Occitanie",
      country: "France",
      raw,
    });
  });

  it("reads a commune code placed second as a code, postal or INSEE unknown", () => {
    // Trees write postal codes there too: 81000 is Albi's postal code (its INSEE code is 81004).
    const raw = "Beauvais-sur-Tescou, 82014, Tarn-et-Garonne, Occitanie, France";
    expect(splitPlace(raw)).toEqual({
      name: "Beauvais-sur-Tescou",
      code: "82014",
      department: "Tarn-et-Garonne",
      region: "Occitanie",
      country: "France",
      raw,
    });
  });

  it("reads the code as INSEE only from a source known to write INSEE codes", () => {
    const raw = "Lisle-sur-Tarn, 81145, Tarn, Occitanie, France";
    expect(splitPlace(raw, { inseeCode: true })).toEqual({
      name: "Lisle-sur-Tarn",
      insee: "81145",
      department: "Tarn",
      region: "Occitanie",
      country: "France",
      raw,
    });
    expect(splitPlace("Lavaur, 81140, Tarn", { inseeCode: true })).toEqual({
      name: "Lavaur",
      insee: "81140",
      raw: "Lavaur, 81140, Tarn",
    });
    expect(splitPlace("Lavaur, Tarn, Occitanie, France", { inseeCode: true })).toEqual({
      name: "Lavaur",
      department: "Tarn",
      region: "Occitanie",
      country: "France",
      raw: "Lavaur, Tarn, Occitanie, France",
    });
  });

  it("reads a Corsican commune code", () => {
    const raw = "Ajaccio, 2A004, Corse-du-Sud, Corse, France";
    expect(splitPlace(raw)).toEqual({
      name: "Ajaccio",
      code: "2A004",
      department: "Corse-du-Sud",
      region: "Corse",
      country: "France",
      raw,
    });
  });

  it("keeps a town name that holds digits", () => {
    const raw = "Paris 14e, 75114, Paris, Île-de-France, France";
    expect(splitPlace(raw)).toEqual({
      name: "Paris 14e",
      code: "75114",
      department: "Paris",
      region: "Île-de-France",
      country: "France",
      raw,
    });
  });

  it("returns a single token as the name, with nothing split", () => {
    expect(splitPlace("Tarn")).toEqual({ name: "Tarn" });
    expect(splitPlace("  Tarn  ")).toEqual({ name: "Tarn" });
  });

  it("fills no slots for other shapes, keeping the whole string in raw", () => {
    expect(splitPlace("Lisle-sur-Tarn, Tarn")).toEqual({
      name: "Lisle-sur-Tarn",
      raw: "Lisle-sur-Tarn, Tarn",
    });
    expect(splitPlace("Albi, 81004, Tarn")).toEqual({
      name: "Albi",
      code: "81004",
      raw: "Albi, 81004, Tarn",
    });
    expect(splitPlace("A, B, C, D, E, F")).toEqual({ name: "A", raw: "A, B, C, D, E, F" });
  });

  it("does not treat a four-token string with an empty token as the exact shape", () => {
    expect(splitPlace("Cahuzac, , Occitanie, France")).toEqual({
      name: "Cahuzac",
      raw: "Cahuzac, , Occitanie, France",
    });
  });

  it("does not treat a four-token string holding a code as the exact shape", () => {
    expect(splitPlace("Albi, 81000, Tarn, France")).toEqual({
      name: "Albi",
      code: "81000",
      raw: "Albi, 81000, Tarn, France",
    });
  });

  it("does not treat a five-token string without a code second as the exact shape", () => {
    expect(splitPlace("Albi, Le Bourg, Tarn, Occitanie, France")).toEqual({
      name: "Albi",
      raw: "Albi, Le Bourg, Tarn, Occitanie, France",
    });
  });

  it("names the first non-empty token when leading tokens are empty", () => {
    expect(splitPlace(", , France")).toEqual({ name: "France", raw: ", , France" });
  });

  it("does not take the name as the code", () => {
    expect(splitPlace("81004, Tarn")).toEqual({ name: "81004", raw: "81004, Tarn" });
  });

  it("ignores trailing empty tokens", () => {
    expect(splitPlace("Albi, Tarn, Occitanie, France,")).toEqual({
      name: "Albi",
      department: "Tarn",
      region: "Occitanie",
      country: "France",
      raw: "Albi, Tarn, Occitanie, France",
    });
    expect(splitPlace("Tarn, ,")).toEqual({ name: "Tarn" });
  });

  it("returns undefined when there is no place", () => {
    expect(splitPlace("")).toBeUndefined();
    expect(splitPlace("   ")).toBeUndefined();
    expect(splitPlace(" , ,")).toBeUndefined();
    expect(splitPlace(undefined)).toBeUndefined();
  });
});
