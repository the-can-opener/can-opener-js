import type { CanFrame, CanPayload } from "../dbc/types.js";
import type { VehicleCanFdRequest } from "../transport/types.js";
import { isotpAddressBytes, isotpPciOffset } from "./isotpAddressing.js";
import type {
  ExpectPattern,
  ProfileCanFdConfig,
  ProfileEndpoint,
  RequestStep,
  ResolvedProfileEndpoint,
} from "./types.js";

const CLASSIC_FRAME_LENGTH = 8;

/**
 * The classic CAN frame for a profile `send`. With ISO-TP extended or mixed
 * addressing the endpoint's transmit address byte goes first and `send` is
 * shifted after it, so an addressed single frame carries one byte less.
 */
export function buildRequestFrame(
  endpoint: Pick<ResolvedProfileEndpoint, "requestId" | "extended" | "bus" | "canFd" | "addressing">,
  payload: Uint8Array,
): CanFrame {
  const offset = isotpPciOffset(endpoint.addressing);
  const capacity = CLASSIC_FRAME_LENGTH - offset;
  if (offset > 0 && payload.length > capacity && payload.subarray(capacity).some((byte) => byte !== 0)) {
    throw new Error(
      `Request ${formatCanId(endpoint.requestId)} uses ISO-TP ${endpoint.addressing?.mode} addressing, so its send bytes must fit in ${capacity} bytes after the address byte`,
    );
  }

  const data = new Uint8Array(CLASSIC_FRAME_LENGTH);
  if (endpoint.addressing !== undefined) {
    data[0] = isotpAddressBytes(endpoint.addressing).tx;
  }
  data.set(payload.subarray(0, capacity), offset);
  return {
    canId: endpoint.requestId,
    // CAN FD frames are sent with all eight bytes, zero-padded.
    dlc: endpoint.canFd !== undefined ? CLASSIC_FRAME_LENGTH : Math.min(offset + payload.length, CLASSIC_FRAME_LENGTH),
    data,
    ...(endpoint.extended !== undefined ? { extended: endpoint.extended } : {}),
    ...(endpoint.bus !== undefined ? { bus: endpoint.bus } : {}),
  };
}

/** `canFd` is the endpoint's setting for endpoint-backed steps, or the inline step's resolved setting. */
export function buildStepFrame(
  step: RequestStep,
  endpoint?: ResolvedProfileEndpoint,
  canFd: ProfileCanFdConfig | undefined = endpoint?.canFd,
): CanFrame {
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
      ...(canFd !== undefined ? { canFd } : {}),
      ...(endpoint?.addressing !== undefined ? { addressing: endpoint.addressing } : {}),
    },
    step.send,
  );
}

/**
 * The `canFd` field for a request built from `frame`. With `txDl` 8 the frame
 * is sent as-is. With `txDl` 64 the transport repacks the payload, so the
 * frame must be an ISO-TP single frame (profile `send` bytes are one frame).
 * `addressing` tells where that PCI sits: after the address byte, or first.
 */
export function canFdRequestFields(
  canFd: ProfileCanFdConfig | undefined,
  frame: CanFrame,
  subject: string,
  addressing?: ProfileEndpoint["addressing"],
): { canFd?: VehicleCanFdRequest } {
  if (canFd === undefined) {
    return {};
  }
  switch (canFd.txDl) {
    case 8:
      return { canFd: { txDl: 8 } };
    case 64: {
      const pciOffset = isotpPciOffset(addressing);
      const pci = frame.data[pciOffset] ?? 0;
      const length = pci & 0x0f;
      const frameLength = frame.dlc ?? frame.data.length;
      const payloadOffset = pciOffset + 1;
      if ((pci & 0xf0) !== 0 || length === 0 || length > frameLength - payloadOffset) {
        throw new Error(
          `${subject} uses CAN FD tx_dl 64, which requires send bytes that start with an ISO-TP single-frame PCI byte`,
        );
      }
      return { canFd: { txDl: 64, payload: frame.data.slice(payloadOffset, payloadOffset + length) } };
    }
    default: {
      const unsupported: never = canFd.txDl;
      throw new Error(`Unsupported CAN FD tx_dl ${String(unsupported)}`);
    }
  }
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

function formatCanId(canId: number): string {
  return `0x${canId.toString(16).toUpperCase()}`;
}

function formatPattern(expect: ExpectPattern): string {
  const bytes = expect.pattern.map((byte) => byte === "*" ? "*" : `0x${byte.toString(16).padStart(2, "0")}`);
  return `[${bytes.join(", ")}]${expect.exact ? " exactly" : ""}`;
}
