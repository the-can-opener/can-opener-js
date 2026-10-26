import type { CanFrame, CanPayload } from "../dbc/types.js";
import type { VehicleCanFdRequest } from "../transport/types.js";
import type { ExpectPattern, ProfileEndpoint, RequestStep } from "./types.js";

export function buildRequestFrame(
  endpoint: Pick<ProfileEndpoint, "requestId" | "extended" | "bus" | "canFd">,
  payload: Uint8Array,
): CanFrame {
  const data = new Uint8Array(8);
  data.set(payload.slice(0, 8));
  return {
    canId: endpoint.requestId,
    // A CAN FD request with tx_dl 8 is sent as exactly these eight bytes.
    dlc: endpoint.canFd !== undefined ? 8 : Math.min(payload.length, 8),
    data,
    ...(endpoint.extended !== undefined ? { extended: endpoint.extended } : {}),
    ...(endpoint.bus !== undefined ? { bus: endpoint.bus } : {}),
  };
}

export function buildStepFrame(step: RequestStep, endpoint?: ProfileEndpoint): CanFrame {
  const requestId = step.requestId ?? endpoint?.requestId;
  if (requestId === undefined) {
    throw new Error("Request step does not declare a request ID");
  }

  return buildRequestFrame(
    {
      requestId,
      ...(endpoint?.extended !== undefined ? { extended: endpoint.extended } : {}),
      ...(endpoint?.bus !== undefined
        ? { bus: endpoint.bus }
        : step.bus !== undefined
          ? { bus: step.bus }
          : {}),
      ...(endpoint?.canFd !== undefined ? { canFd: endpoint.canFd } : {}),
    },
    step.send,
  );
}

/**
 * The `canFd` field for a request built from `frame`. Profile `send` bytes are
 * one classic frame, so a CAN FD endpoint's request must be an ISO-TP single
 * frame; its payload is what a transport segments when `txDl` is 64.
 */
export function canFdRequestFields(
  endpoint: Pick<ProfileEndpoint, "name" | "canFd"> | undefined,
  frame: CanFrame,
): { canFd?: VehicleCanFdRequest } {
  if (endpoint?.canFd === undefined) {
    return {};
  }
  const pci = frame.data[0] ?? 0;
  const length = pci & 0x0f;
  const frameLength = frame.dlc ?? frame.data.length;
  if ((pci & 0xf0) !== 0 || length === 0 || length > frameLength - 1) {
    throw new Error(
      `CAN FD endpoint ${endpoint.name} requires send bytes that start with an ISO-TP single-frame PCI byte`,
    );
  }
  return {
    canFd: {
      txDl: endpoint.canFd.txDl,
      payload: frame.data.slice(1, 1 + length),
    },
  };
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

export function alignExpectedPrefix(expect: ExpectPattern | undefined, payload: CanPayload): CanPayload {
  if (expect === undefined || expect.exact || expect.pattern.length === 0) {
    return payload;
  }
  const offset = expectedOffset(expect, payload);
  return offset === undefined ? payload : payload.slice(offset);
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
