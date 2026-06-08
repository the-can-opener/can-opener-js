import type { CodecSignal } from "../dbc/codec.js";
import { writeSignalValue } from "../dbc/codec.js";
import type { ActionInputs, CanFrame, CanPayload } from "../dbc/types.js";
import type { ActionEncodeField, ExpectPattern, ProfileEndpoint, RequestStep } from "./types.js";

export function buildRequestFrame(endpoint: ProfileEndpoint, payload: Uint8Array): CanFrame {
  const data = new Uint8Array(8);
  data.set(payload.slice(0, 8));
  return {
    canId: endpoint.requestId,
    dlc: Math.min(payload.length, 8),
    data,
  };
}

export function buildStepFrame(step: RequestStep, endpoint: ProfileEndpoint, inputs: ActionInputs = {}): CanFrame {
  const frame = buildRequestFrame(endpoint, step.send);
  for (const field of step.encode ?? []) {
    overlayActionField(frame.data, frame.dlc ?? 0, endpoint.requestId, field, inputs);
  }
  return frame;
}

export function responseBounds(endpoint: ProfileEndpoint): { responseIdStart?: number; responseIdEnd?: number } {
  if (endpoint.responseRanges.length === 0) {
    return {};
  }
  return {
    responseIdStart: Math.min(...endpoint.responseRanges.map((range) => range.start)),
    responseIdEnd: Math.max(...endpoint.responseRanges.map((range) => range.end)),
  };
}

export function assertExpectedResponse(expect: ExpectPattern | undefined, payload: CanPayload): void {
  if (expect === undefined) {
    return;
  }
  if (!matchesExpectedResponse(expect, payload)) {
    throw new Error(`Response payload did not match expected pattern ${formatPattern(expect)}`);
  }
}

export function stripExpectedPrefix(expect: ExpectPattern | undefined, payload: CanPayload): CanPayload {
  if (expect === undefined || expect.exact || expect.pattern.length === 0) {
    return payload;
  }
  const offset = expectedOffset(expect, payload);
  return offset === undefined ? payload : payload.slice(offset + expect.pattern.length);
}

function matchesExpectedResponse(expect: ExpectPattern, payload: CanPayload): boolean {
  return expectedOffset(expect, payload) !== undefined;
}

function expectedOffset(expect: ExpectPattern, payload: CanPayload): number | undefined {
  if (expect.exact && payload.length !== expect.pattern.length) {
    return undefined;
  }
  if (payload.length < expect.pattern.length) {
    return undefined;
  }
  if (matchesAt(expect, payload, 0)) {
    return 0;
  }
  if (!expect.exact && payload.length > expect.pattern.length && matchesAt(expect, payload, 1)) {
    return 1;
  }
  return undefined;
}

function matchesAt(expect: ExpectPattern, payload: CanPayload, offset: number): boolean {
  if (payload.length < offset + expect.pattern.length) {
    return false;
  }
  return expect.pattern.every((byte, index) => byte === "*" || payload[offset + index] === byte);
}

function formatPattern(expect: ExpectPattern): string {
  const bytes = expect.pattern.map((byte) => byte === "*" ? "*" : `0x${byte.toString(16).padStart(2, "0")}`);
  return `[${bytes.join(", ")}]${expect.exact ? " exactly" : ""}`;
}

function overlayActionField(
  data: Uint8Array,
  dlc: number,
  canId: number,
  field: ActionEncodeField,
  inputs: ActionInputs,
): void {
  const value = inputs[field.input];
  if (value === undefined) {
    throw new Error(`Action input ${field.input} is required for request encoding`);
  }

  if (field.type === "ascii") {
    writeAsciiField(data, dlc, field, value);
    return;
  }

  assertNumericFieldFitsTemplate(field, dlc);
  const signal: CodecSignal = {
    canId,
    startBit: field.startBit,
    length: field.length,
    byteOrder: field.byteOrder,
    signed: field.signed,
    scale: field.scale,
    offset: field.offset,
  };
  writeSignalValue(data, signal, value);
}

function writeAsciiField(
  data: Uint8Array,
  dlc: number,
  field: Extract<ActionEncodeField, { type: "ascii" }>,
  value: unknown,
): void {
  if (typeof value !== "string") {
    throw new Error(`Action input ${field.input} must be a string`);
  }
  if (field.startByte + field.length > dlc) {
    throw new Error(`Action input ${field.input} exceeds request template length`);
  }

  const bytes = new TextEncoder().encode(value);
  for (let index = 0; index < field.length; index += 1) {
    data[field.startByte + index] = bytes[index] ?? field.pad;
  }
}

function assertNumericFieldFitsTemplate(
  field: Extract<ActionEncodeField, { type: "numeric" }>,
  dlc: number,
): void {
  const maxBit = dlc * 8 - 1;
  for (let index = 0; index < field.length; index += 1) {
    const bitPosition = field.byteOrder === "big"
      ? motorolaBitPosition(field.startBit, index)
      : field.startBit + index;
    if (bitPosition < 0 || bitPosition > maxBit) {
      throw new Error(`Action input ${field.input} exceeds request template length`);
    }
  }
}

function motorolaBitPosition(startBit: number, bitIndexFromMsb: number): number {
  let bitPosition = startBit;
  for (let index = 0; index < bitIndexFromMsb; index += 1) {
    bitPosition = bitPosition % 8 === 0 ? bitPosition + 15 : bitPosition - 1;
  }
  return bitPosition;
}
