import type { CanFrame, VehicleSignal } from "./types.js";

export interface CodecSignal {
  canId: number;
  startBit: number;
  length: number;
  byteOrder?: "little" | "big";
  signed?: boolean;
  scale?: number;
  offset?: number;
  valueType?: "number" | "ascii" | "bytes";
}

const DEFAULT_FRAME_BYTES = 8;

export function decodeSignalValue(frame: CanFrame, signal: CodecSignal): number | string | Uint8Array {
  if (signal.valueType === "ascii") {
    return decodeAscii(readSignalBytes(frame.data, signal));
  }

  if (signal.valueType === "bytes") {
    return readSignalBytes(frame.data, signal);
  }

  const unsigned = readRaw(frame.data, signal);
  const raw = signal.signed === true ? toSigned(unsigned, signal.length) : unsigned;
  return raw * (signal.scale ?? 1) + (signal.offset ?? 0);
}

export function encodeSignalValue(signal: CodecSignal, value: unknown): CanFrame {
  const data = new Uint8Array(DEFAULT_FRAME_BYTES);
  writeSignalValue(data, signal, value);
  return {
    canId: signal.canId,
    data,
  };
}

export function writeSignalValue(data: Uint8Array, signal: CodecSignal, value: unknown): void {
  const numeric = normalizeNumericValue(value);
  const physical = (numeric - (signal.offset ?? 0)) / (signal.scale ?? 1);
  const raw = Math.round(physical);
  const unsigned = signal.signed === true ? fromSigned(raw, signal.length) : raw;
  writeRaw(data, signal, unsigned);
}

export function decodeFrameSignals(frame: CanFrame, signals: Iterable<VehicleSignal>): Array<{ signal: VehicleSignal; value: unknown }> {
  const decoded: Array<{ signal: VehicleSignal; value: unknown }> = [];

  for (const signal of signals) {
    if (!isCodecSignal(signal) || signal.canId !== frame.canId) {
      continue;
    }

    decoded.push({
      signal,
      value: decodeSignalValue(frame, signal),
    });
  }

  return decoded;
}

export function isCodecSignal(signal: VehicleSignal): signal is VehicleSignal & CodecSignal {
  return typeof signal.startBit === "number" && typeof signal.length === "number";
}

function readRaw(data: Uint8Array, signal: CodecSignal): number {
  assertSignalFits(data, signal);

  let value = 0;
  if ((signal.byteOrder ?? "little") === "little") {
    for (let i = 0; i < signal.length; i += 1) {
      const bit = readDataBit(data, signal.startBit + i);
      value |= bit << i;
    }
    return value;
  }

  for (let i = 0; i < signal.length; i += 1) {
    const bitPosition = motorolaBitPosition(signal.startBit, i);
    const bit = readDataBit(data, bitPosition);
    value = (value << 1) | bit;
  }
  return value;
}

function readSignalBytes(data: Uint8Array, signal: CodecSignal): Uint8Array {
  assertByteSignalFits(data, signal);
  const startByte = signal.startBit / 8;
  const lengthBytes = signal.length / 8;
  return data.slice(startByte, startByte + lengthBytes);
}

function decodeAscii(data: Uint8Array): string {
  return new TextDecoder().decode(data).replace(/\0+$/u, "");
}

function writeRaw(data: Uint8Array, signal: CodecSignal, value: number): void {
  assertSignalFits(data, signal);
  assertIntegerRange(value, signal.length);

  if ((signal.byteOrder ?? "little") === "little") {
    for (let i = 0; i < signal.length; i += 1) {
      writeDataBit(data, signal.startBit + i, (value >> i) & 1);
    }
    return;
  }

  for (let i = 0; i < signal.length; i += 1) {
    const bitPosition = motorolaBitPosition(signal.startBit, i);
    const shift = signal.length - 1 - i;
    writeDataBit(data, bitPosition, (value >> shift) & 1);
  }
}

function readDataBit(data: Uint8Array, bitPosition: number): number {
  const byteIndex = Math.floor(bitPosition / 8);
  const bitIndex = bitPosition % 8;
  return (data[byteIndex] ?? 0) >> bitIndex & 1;
}

function writeDataBit(data: Uint8Array, bitPosition: number, bit: number): void {
  const byteIndex = Math.floor(bitPosition / 8);
  const bitIndex = bitPosition % 8;
  const current = data[byteIndex] ?? 0;
  data[byteIndex] = bit === 1 ? current | (1 << bitIndex) : current & ~(1 << bitIndex);
}

function motorolaBitPosition(startBit: number, bitIndexFromMsb: number): number {
  let bitPosition = startBit;
  for (let i = 0; i < bitIndexFromMsb; i += 1) {
    bitPosition = bitPosition % 8 === 0 ? bitPosition + 15 : bitPosition - 1;
  }
  return bitPosition;
}

function toSigned(value: number, length: number): number {
  const signBit = 1 << (length - 1);
  return (value & signBit) === 0 ? value : value - 2 ** length;
}

function fromSigned(value: number, length: number): number {
  if (value >= 0) {
    return value;
  }
  return 2 ** length + value;
}

function normalizeNumericValue(value: unknown): number {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Signal value must be a finite number or boolean, received ${String(value)}`);
  }

  return value;
}

function assertSignalFits(data: Uint8Array, signal: CodecSignal): void {
  if (signal.length <= 0 || signal.length > 31) {
    throw new Error(`Signal length must be between 1 and 31 bits, received ${signal.length}`);
  }

  const positions = signal.byteOrder === "big"
    ? Array.from({ length: signal.length }, (_, index) => motorolaBitPosition(signal.startBit, index))
    : Array.from({ length: signal.length }, (_, index) => signal.startBit + index);

  const maxBit = data.length * 8 - 1;
  for (const position of positions) {
    if (position < 0 || position > maxBit) {
      throw new Error(`Signal exceeds ${data.length}-byte CAN frame bounds`);
    }
  }
}

function assertByteSignalFits(data: Uint8Array, signal: CodecSignal): void {
  if (signal.startBit % 8 !== 0 || signal.length % 8 !== 0) {
    throw new Error("Byte or ASCII signals must be byte-aligned");
  }

  const startByte = signal.startBit / 8;
  const lengthBytes = signal.length / 8;
  if (lengthBytes <= 0 || startByte + lengthBytes > data.length) {
    throw new Error(`Signal exceeds ${data.length}-byte payload bounds`);
  }
}

function assertIntegerRange(value: number, length: number): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Encoded raw value must be an integer, received ${value}`);
  }

  if (value < 0 || value >= 2 ** length) {
    throw new Error(`Encoded raw value ${value} does not fit in ${length} bits`);
  }
}
