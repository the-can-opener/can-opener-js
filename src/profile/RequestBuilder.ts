import type { CanFrame, CanPayload } from "../dbc/types.js";
import type { ExpectPattern, ProfileEndpoint, RequestStep } from "./types.js";

export function buildRequestFrame(endpoint: ProfileEndpoint, payload: Uint8Array): CanFrame {
  const data = new Uint8Array(8);
  data.set(payload.slice(0, 8));
  return {
    canId: endpoint.requestId,
    dlc: Math.min(payload.length, 8),
    data,
  };
}

export function buildStepFrame(step: RequestStep, endpoint: ProfileEndpoint): CanFrame {
  return buildRequestFrame(endpoint, step.send);
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
