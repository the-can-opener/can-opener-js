import { describe, expect, it } from "vitest";
import { decodeSignalValue, encodeSignalValue } from "../src/dbc/codec.js";

describe("codec", () => {
  it("round-trips little-endian scaled values", () => {
    const signal = {
      canId: 100,
      startBit: 0,
      length: 16,
      byteOrder: "little" as const,
      scale: 0.25,
      offset: 0,
    };

    const frame = encodeSignalValue(signal, 3000);

    expect(frame.data[0]).toBe(0xe0);
    expect(frame.data[1]).toBe(0x2e);
    expect(decodeSignalValue(frame, signal)).toBe(3000);
  });

  it("round-trips big-endian values", () => {
    const signal = {
      canId: 101,
      startBit: 7,
      length: 12,
      byteOrder: "big" as const,
      scale: 1,
      offset: 0,
    };

    const frame = encodeSignalValue(signal, 0xabc);

    expect(decodeSignalValue(frame, signal)).toBe(0xabc);
  });

  it("decodes signed values", () => {
    const signal = {
      canId: 102,
      startBit: 0,
      length: 8,
      byteOrder: "little" as const,
      signed: true,
      scale: 1,
      offset: 0,
    };

    const frame = encodeSignalValue(signal, -5);

    expect(decodeSignalValue(frame, signal)).toBe(-5);
  });
});
