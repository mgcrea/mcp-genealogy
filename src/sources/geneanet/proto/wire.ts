// A minimal protobuf (proto2) wire codec: just what the GeneWeb API needs, so
// the server carries no protobuf runtime (rule 9: two runtime dependencies).
//
// Supported wire types: 0 (varint) and 2 (length-delimited). The schemas in
// proto/ also never use groups (3/4); fixed32/fixed64 (5/1) are skipped on read
// so an unknown field of that kind cannot derail the rest of the message.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

// ── Writing ──────────────────────────────────────────────────────────────────

export class ProtoWriter {
  private readonly bytes: number[] = [];

  private varint(value: number): void {
    // Negative int32 values are sign-extended to 10 bytes on the wire; none of
    // the request fields we send can be negative, so refuse rather than guess.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`varint must be a non-negative safe integer, got ${value}`);
    }
    let v = value;
    while (v > 0x7f) {
      this.bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.bytes.push(v);
  }

  private tag(field: number, wireType: 0 | 2): void {
    this.varint(field * 8 + wireType);
  }

  int(field: number, value: number | undefined): this {
    if (value === undefined) return this;
    this.tag(field, 0);
    this.varint(value);
    return this;
  }

  bool(field: number, value: boolean | undefined): this {
    return value === undefined ? this : this.int(field, value ? 1 : 0);
  }

  bytesField(field: number, value: Uint8Array | undefined): this {
    if (value === undefined) return this;
    this.tag(field, 2);
    this.varint(value.length);
    for (const b of value) this.bytes.push(b);
    return this;
  }

  string(field: number, value: string | undefined): this {
    return value === undefined ? this : this.bytesField(field, textEncoder.encode(value));
  }

  message(field: number, value: ProtoWriter | undefined): this {
    return value === undefined ? this : this.bytesField(field, value.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

type Value = number | Uint8Array;

/**
 * A decoded message: every occurrence of every field, in wire order. Typed
 * accessors below turn it into values; unknown fields are kept and ignored,
 * which is what lets the decoders tolerate Geneanet adding fields.
 */
export class ProtoMessage {
  private readonly fields = new Map<number, Value[]>();

  constructor(buf: Uint8Array) {
    let pos = 0;
    // Accumulated as a BigInt: int64 fields carry -1 as a 10-byte two's
    // complement (GraphTree's `ifam` does), which a float cannot hold, and the
    // fold back to a signed value has to happen before the conversion.
    const readVarint = (): number => {
      let result = 0n;
      let shift = 0n;
      for (let i = 0; i < 10; i += 1) {
        if (pos >= buf.length) throw new ProtoDecodeError("truncated varint");
        const byte = buf[pos] as number;
        pos += 1;
        result |= BigInt(byte & 0x7f) << shift;
        if (byte < 0x80) {
          if (result >= 1n << 63n) result -= 1n << 64n;
          return Number(result);
        }
        shift += 7n;
      }
      throw new ProtoDecodeError("varint longer than 10 bytes");
    };

    while (pos < buf.length) {
      const key = readVarint();
      const field = Math.floor(key / 8);
      const wireType = key % 8;
      let value: Value;
      if (wireType === 0) {
        value = readVarint();
      } else if (wireType === 2) {
        const len = readVarint();
        // A 10-byte varint folds to a negative length; without the < 0 check `pos` moves backwards forever.
        if (len < 0 || pos + len > buf.length) {
          throw new ProtoDecodeError(`field ${field} has an invalid length ${len}`);
        }
        value = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wireType === 1 || wireType === 5) {
        pos += wireType === 1 ? 8 : 4;
        if (pos > buf.length) throw new ProtoDecodeError(`field ${field} overruns the buffer`);
        continue;
      } else {
        throw new ProtoDecodeError(`unsupported wire type ${wireType} on field ${field}`);
      }
      const list = this.fields.get(field);
      if (list) list.push(value);
      else this.fields.set(field, [value]);
    }
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  private last(field: number): Value | undefined {
    const list = this.fields.get(field);
    return list?.[list.length - 1];
  }

  int(field: number): number | undefined {
    const v = this.last(field);
    return typeof v === "number" ? v : undefined;
  }

  bool(field: number): boolean | undefined {
    const v = this.int(field);
    return v === undefined ? undefined : v !== 0;
  }

  string(field: number): string | undefined {
    const v = this.last(field);
    return v instanceof Uint8Array ? textDecoder.decode(v) : undefined;
  }

  strings(field: number): string[] {
    return (this.fields.get(field) ?? []).flatMap((v) =>
      v instanceof Uint8Array ? [textDecoder.decode(v)] : [],
    );
  }

  message(field: number): ProtoMessage | undefined {
    const v = this.last(field);
    return v instanceof Uint8Array ? new ProtoMessage(v) : undefined;
  }

  messages(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? []).flatMap((v) =>
      v instanceof Uint8Array ? [new ProtoMessage(v)] : [],
    );
  }

  /** Field numbers present, for debugging an unexpected payload. */
  fieldNumbers(): number[] {
    return [...this.fields.keys()].toSorted((a, b) => a - b);
  }
}

export class ProtoDecodeError extends Error {
  override readonly name = "ProtoDecodeError";
}

// ── Transport framing ────────────────────────────────────────────────────────

/**
 * Undo the API's response framing. Geneanet does not send the protobuf bytes
 * as they are: it reads them as Latin-1 characters and writes those out as
 * UTF-8, so every byte >= 0x80 arrives as two (the varint 0x96 becomes C2 96).
 * Its own front end undoes this with `str2ab()` on the decoded response text.
 * Every operation answers this way, `person`, `graph_v2` and
 * `person_search_list` alike (measured 2026-11-20). Strings inside the
 * recovered message are then ordinary UTF-8.
 */
export const unframeResponse = (body: Uint8Array): Uint8Array => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new ProtoDecodeError(
        `response is not Latin-1-in-UTF-8 framed (code point U+${code.toString(16)} at ${i})`,
      );
    }
    out[i] = code;
  }
  return out;
};

/**
 * Frame a request message the way the site's `gwHelper` does: every byte
 * becomes `%XX`, and that string is URL-escaped again, so 0x08 travels as
 * `%2508`. Geneanet decodes both layers server-side.
 */
export const frameRequest = (message: Uint8Array): string => {
  let hex = "";
  for (const b of message) hex += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  return `data=${encodeURIComponent(hex)}`;
};
