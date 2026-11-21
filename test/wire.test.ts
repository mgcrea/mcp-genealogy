import { describe, expect, it } from "vitest";

import {
  ProtoDecodeError,
  ProtoMessage,
  ProtoWriter,
  frameRequest,
  unframeResponse,
} from "#/sources/geneanet/proto/wire";

describe("ProtoWriter / ProtoMessage", () => {
  it("round-trips varints, strings and nested messages", () => {
    const bytes = new ProtoWriter()
      .int(1, 27)
      .int(2, 300)
      .string(3, "Vère")
      .message(4, new ProtoWriter().string(1, "louvignes").int(4, 0))
      .bool(5, true)
      .finish();
    const m = new ProtoMessage(bytes);
    expect(m.int(1)).toBe(27);
    expect(m.int(2)).toBe(300);
    expect(m.string(3)).toBe("Vère");
    expect(m.message(4)?.string(1)).toBe("louvignes");
    expect(m.message(4)?.int(4)).toBe(0);
    expect(m.bool(5)).toBe(true);
  });

  it("encodes the requests byte for byte as the browser did", () => {
    // IndexPerson{index 27, indexz 2, events 25, witnesses 25}, captured from Safari 2026-11-19.
    expect([...new ProtoWriter().int(1, 27).int(2, 2).int(3, 25).int(4, 25).finish()]).toEqual([
      0x08, 0x1b, 0x10, 0x02, 0x18, 0x19, 0x20, 0x19,
    ]);
    // GraphTreeParams{identifier{index 27}, nb_asc 5, nb_desc 2, indexz 2}.
    expect([
      ...new ProtoWriter()
        .message(1, new ProtoWriter().int(1, 27))
        .int(2, 5)
        .int(3, 2)
        .int(4, 2)
        .finish(),
    ]).toEqual([0x0a, 0x02, 0x08, 0x1b, 0x10, 0x05, 0x18, 0x02, 0x20, 0x02]);
  });

  it("omits undefined fields instead of sending zero values", () => {
    expect([...new ProtoWriter().int(1, undefined).string(2, undefined).finish()]).toEqual([]);
  });

  it("decodes an int64 -1 exactly (a float would round it to 0)", () => {
    // ifam = -1 on a graph root: ten-byte two's complement.
    const bytes = Uint8Array.from([
      0x18, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ]);
    expect(new ProtoMessage(bytes).int(3)).toBe(-1);
  });

  it("keeps every occurrence of a repeated field, in order", () => {
    const bytes = new ProtoWriter().string(10, "a").string(10, "b").finish();
    expect(new ProtoMessage(bytes).strings(10)).toEqual(["a", "b"]);
  });

  it("skips fixed-width fields it does not model", () => {
    const bytes = Uint8Array.from([0x0d, 1, 2, 3, 4, 0x10, 0x07]);
    expect(new ProtoMessage(bytes).int(2)).toBe(7);
  });

  it("refuses a truncated message instead of returning half of it", () => {
    expect(() => new ProtoMessage(Uint8Array.from([0x0a, 0x05, 0x41]))).toThrow(ProtoDecodeError);
  });

  it("refuses a length that folds negative instead of looping forever", () => {
    const bytes = Uint8Array.from([
      0x0a, 0xf5, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ]);
    expect(() => new ProtoMessage(bytes)).toThrow(ProtoDecodeError);
  });

  it("refuses negative varints rather than guessing their encoding", () => {
    expect(() => new ProtoWriter().int(1, -1)).toThrow(RangeError);
  });
});

describe("framing", () => {
  it("double-escapes every request byte, as the site's gwHelper does", () => {
    expect(frameRequest(Uint8Array.from([0x08, 0x1b, 0xc3]))).toBe("data=%2508%251B%25C3");
  });

  it("recovers the protobuf bytes from Latin-1-in-UTF-8 responses", () => {
    // 0x96 arrives as C2 96, 0xDC as C3 9C.
    expect([...unframeResponse(Uint8Array.from([0x08, 0xc2, 0x96, 0xc3, 0x9c, 0x01]))]).toEqual([
      0x08, 0x96, 0xdc, 0x01,
    ]);
  });

  it("rejects a body that is not framed that way", () => {
    expect(() => unframeResponse(new TextEncoder().encode("€"))).toThrow(ProtoDecodeError);
    expect(() => unframeResponse(Uint8Array.from([0xff]))).toThrow();
  });
});
