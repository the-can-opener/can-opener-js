import type { FrameDecoder, ProfileEncodedField, VssValue } from "./types.js";

/**
 * Decodes one value from `data` with a format 2 decoder. Order: extraction,
 * `invalid_raw`, then `enum` or numeric scaling. Throws when the field does
 * not fit, the bytes are not ASCII, or the raw value has no enum entry.
 */
export function decodeField(data: Uint8Array, decoder: FrameDecoder): VssValue {
  const raw = decoder.byte !== undefined ? readBytes(data, decoder) : readBits(data, decoder);
  if (typeof raw === "string") {
    return raw;
  }
  if (decoder.invalid_raw?.includes(raw) === true) {
    throw new Error(`Raw value ${raw} is marked invalid`);
  }
  if (decoder.enum !== undefined) {
    const value = decoder.enum[String(raw)];
    if (value === undefined) {
      throw new Error(`Raw value ${raw} has no enum entry`);
    }
    return value;
  }
  return raw * (decoder.scale ?? 1) + (decoder.offset ?? 0);
}

function readBytes(data: Uint8Array, decoder: FrameDecoder): number | string {
  const start = decoder.byte ?? 0;
  const length = decoder.bytes ?? 0;
  if (start + length > data.length) {
    throw new Error(`Decoder needs ${start + length} bytes, received ${data.length}`);
  }
  const segment = data.subarray(start, start + length);
  switch (decoder.type) {
    case "ascii":
      if (segment.some((byte) => byte > 0x7f)) {
        throw new Error("Decoded bytes are not ASCII");
      }
      return String.fromCharCode(...segment);
    case "hex":
      return Array.from(segment, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    case "uint":
    case "int": {
      const ordered = decoder.endian === "little" ? Array.from(segment).reverse() : Array.from(segment);
      const unsigned = ordered.reduce((value, byte) => value * 256 + byte, 0);
      return decoder.type === "int" ? toSigned(unsigned, length * 8) : unsigned;
    }
    default: {
      const unhandled: never = decoder.type;
      throw new Error(`Unknown decoder type ${String(unhandled)}`);
    }
  }
}

function readBits(data: Uint8Array, decoder: FrameDecoder): number {
  const start = decoder.start_bit ?? 0;
  const width = decoder.bits ?? 0;
  if (start + width > data.length * 8) {
    throw new Error(`Decoder needs ${start + width} bits, received ${data.length * 8}`);
  }
  let raw = 0;
  for (let index = 0; index < width; index += 1) {
    const position = start + index;
    const byte = data[position >> 3] ?? 0;
    if (decoder.bit_order === "msb0") {
      raw = raw * 2 + ((byte >> (7 - (position % 8))) & 1);
    } else {
      raw += ((byte >> (position % 8)) & 1) * 2 ** index;
    }
  }
  return decoder.type === "int" ? toSigned(raw, width) : raw;
}

function toSigned(value: number, bits: number): number {
  return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
}

/**
 * Writes `value` into `send` at the field. The raw value,
 * `(value - offset) / scale`, must be a whole number that fits the wire
 * width. Nothing is rounded or clamped.
 */
export function encodeField(send: Uint8Array, field: ProfileEncodedField, value: number): void {
  const exact = (value - field.offset) / field.scale;
  const raw = Math.round(exact);
  if (!Number.isFinite(exact) || Math.abs(exact - raw) > 1e-9) {
    throw new Error(`${value} does not encode to a whole number`);
  }
  const bits = field.bytes * 8;
  const min = field.signed ? -(2 ** (bits - 1)) : 0;
  const max = field.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (raw < min || raw > max) {
    throw new Error(`${value} does not fit in ${field.bytes} byte${field.bytes === 1 ? "" : "s"}`);
  }
  let unsigned = raw < 0 ? raw + 2 ** bits : raw;
  for (let index = 0; index < field.bytes; index += 1) {
    const position = field.endian === "little" ? index : field.bytes - 1 - index;
    send[field.at + position] = unsigned % 256;
    unsigned = Math.floor(unsigned / 256);
  }
}
