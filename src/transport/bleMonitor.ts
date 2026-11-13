import type { CanFrame } from "../dbc/types.js";
import type {
  CanBusConfigRequest,
  CanBusConfigStatus,
  MonitorControlRequest,
  MonitorControlResponse,
  MonitorControlStatus,
} from "./types.js";
import { validateBus } from "./bleWire.js";

// Monitor control (0xA003) and monitor data (0xA004) layouts. Must stay in
// sync with the firmware.
const MONITOR_OPCODE_ADD = 0x01;
const MONITOR_OPCODE_REMOVE = 0x02;
const MONITOR_OPCODE_CLEAR = 0x03;
const MONITOR_OPCODE_CAPTURE_ALL = 0x04;
const MONITOR_OPCODE_NAN = 0x05;
const MONITOR_OPCODE_CONFIGURE_BUS = 0x08;
const MONITOR_CONFIG_RESPONSE_OPCODE = 0x80;
const MONITOR_DATA_OPCODE = 0x81;
const MONITOR_ACK_MIN_SIZE = 4;
const MONITOR_ACK_WITH_BUS_SIZE = 5;
const MONITOR_ACK_WITH_TIMING_SIZE = 13;
const MONITOR_FRAME_SIZE = 14;
const LEGACY_MONITOR_FRAME_SIZE = 13;
const NAN_STREAM_KEY_SIZE = 32;
const NAN_ENABLE_RESPONSE_SIZE = MONITOR_ACK_WITH_BUS_SIZE + NAN_STREAM_KEY_SIZE;
/** Bit per logical bus in the capture-all mask: CAN0 and CAN1. */
export const CAN_BUS_MASK_ALL = 0x03;

const MONITOR_STATUSES: Readonly<Record<number, MonitorControlStatus>> = {
  0x00: "ok",
  0x01: "invalid_opcode",
  0x02: "invalid_length",
  0x03: "monitor_full",
  0x04: "duplicate_id",
  0x05: "invalid_can_id",
  0x06: "internal_error",
  0x07: "invalid_bus",
  0x08: "invalid_bitrate",
  0x09: "auto_detect_failed",
};

export interface NanEnableResponse extends MonitorControlResponse {
  /** AES-256-GCM key for the v3 Wi-Fi Aware stream; absent on older firmware. */
  streamKey?: Uint8Array;
}

/** `opcode, seq, [bus], count, can_id:u32...`; `clear` sends `opcode, seq, [bus]`. */
export function buildMonitorControlPacket(seq: number, req: MonitorControlRequest): Uint8Array {
  const explicitBus = req.bus !== undefined;
  const bus = validateBus(req.bus ?? 0);

  if (req.operation === "clear") {
    return explicitBus ? Uint8Array.of(MONITOR_OPCODE_CLEAR, seq, bus) : Uint8Array.of(MONITOR_OPCODE_CLEAR, seq);
  }

  const headerLength = explicitBus ? 4 : 3;
  const buf = new Uint8Array(headerLength + req.canIds.length * 4);
  const view = new DataView(buf.buffer);
  view.setUint8(0, req.operation === "add" ? MONITOR_OPCODE_ADD : MONITOR_OPCODE_REMOVE);
  view.setUint8(1, seq);
  if (explicitBus) {
    view.setUint8(2, bus);
  }
  view.setUint8(headerLength - 1, req.canIds.length);
  req.canIds.forEach((canId, index) => {
    view.setUint32(headerLength + index * 4, canId, true);
  });
  return buf;
}

/** `0x08, seq, bus, bitrate:u32, data_bitrate:u32`. A zero bitrate asks the firmware to auto-detect. */
export function buildCanBusConfigPacket(seq: number, req: CanBusConfigRequest): Uint8Array {
  const bus = validateBus(req.bus);
  const bitrate = req.bitrate === "auto" ? 0 : validateBitrate(req.bitrate, "bitrate");
  const dataBitrate = req.dataBitrate === undefined ? 0 : validateBitrate(req.dataBitrate, "data bitrate");
  const packet = new Uint8Array(11);
  const view = new DataView(packet.buffer);
  view.setUint8(0, MONITOR_OPCODE_CONFIGURE_BUS);
  view.setUint8(1, seq);
  view.setUint8(2, bus);
  view.setUint32(3, bitrate, true);
  view.setUint32(7, dataBitrate, true);
  return packet;
}

/**
 * Forwards every received frame instead of only monitored IDs. `busMask`
 * limits capture to some buses; firmware without per-bus capture rejects the
 * longer packet with `invalid_length`.
 */
export function buildCaptureAllPacket(seq: number, enabled: boolean, busMask?: number): Uint8Array {
  return enabled && busMask !== undefined
    ? Uint8Array.of(MONITOR_OPCODE_CAPTURE_ALL, seq, 1, busMask & CAN_BUS_MASK_ALL)
    : Uint8Array.of(MONITOR_OPCODE_CAPTURE_ALL, seq, enabled ? 1 : 0);
}

export function buildNanControlPacket(seq: number, enabled: boolean): Uint8Array {
  return Uint8Array.of(MONITOR_OPCODE_NAN, seq, enabled ? 1 : 0);
}

/**
 * Parses a monitor control ACK: `0x80, seq, status, monitor_count, [bus,
 * [bitrate:u32, data_bitrate:u32]]`.
 */
export function parseMonitorControlResponse(data: Uint8Array): { seq: number; response: MonitorControlResponse } {
  if (data.length < MONITOR_ACK_MIN_SIZE) {
    throw new Error(`Invalid monitor config response length ${data.length}`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opcode = view.getUint8(0);
  if (opcode !== MONITOR_CONFIG_RESPONSE_OPCODE) {
    throw new Error(`Invalid monitor config response opcode 0x${opcode.toString(16)}`);
  }

  return {
    seq: view.getUint8(1),
    response: {
      status: MONITOR_STATUSES[view.getUint8(2)] ?? "internal_error",
      currentMonitorCount: view.getUint8(3),
      ...(data.length >= MONITOR_ACK_WITH_BUS_SIZE ? { bus: view.getUint8(4) } : {}),
      ...(data.length >= MONITOR_ACK_WITH_TIMING_SIZE
        ? { bitrate: view.getUint32(5, true), dataBitrate: view.getUint32(9, true) }
        : {}),
    },
  };
}

/** Parses the Wi-Fi Aware enable ACK, whose 37-byte form appends the stream key. */
export function parseNanEnableResponse(data: Uint8Array): NanEnableResponse {
  const { response } = parseMonitorControlResponse(data.slice(0, MONITOR_ACK_WITH_BUS_SIZE));
  return data.length >= NAN_ENABLE_RESPONSE_SIZE
    ? { ...response, streamKey: data.slice(MONITOR_ACK_WITH_BUS_SIZE, NAN_ENABLE_RESPONSE_SIZE) }
    : response;
}

/**
 * Parses a monitor data notification: `0x81, frame_count`, then per frame
 * `can_id:u32, dlc, data[8], bus`. Legacy firmware omits `bus` (13-byte frames).
 */
export function parseMonitorDataPacket(data: Uint8Array): CanFrame[] {
  if (data.length < 2) {
    throw new Error(`Invalid monitor data packet length ${data.length}`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opcode = view.getUint8(0);
  if (opcode !== MONITOR_DATA_OPCODE) {
    throw new Error(`Invalid monitor data opcode 0x${opcode.toString(16)}`);
  }

  const frameCount = view.getUint8(1);
  const frameSize = monitorFrameSize(data.length, frameCount);
  const frames: CanFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const offset = 2 + i * frameSize;
    const dlc = view.getUint8(offset + 4);
    if (dlc > 8) {
      throw new Error(`Invalid monitor frame DLC ${dlc}`);
    }
    const bus = frameSize === MONITOR_FRAME_SIZE ? view.getUint8(offset + 13) : 0;
    if (bus > 1) {
      throw new Error(`Invalid monitor frame bus ${bus}`);
    }
    frames.push({
      canId: view.getUint32(offset, true),
      dlc,
      data: data.slice(offset + 5, offset + 5 + dlc),
      bus,
    });
  }
  return frames;
}

/** Bus timing reuses the monitor ACK; statuses that cannot apply to timing collapse to `internal_error`. */
export function canBusConfigStatus(status: MonitorControlStatus): CanBusConfigStatus {
  switch (status) {
    case "ok":
    case "invalid_bus":
    case "invalid_bitrate":
    case "auto_detect_failed":
    case "internal_error":
      return status;
    case "invalid_opcode":
    case "invalid_length":
    case "monitor_full":
    case "duplicate_id":
    case "invalid_can_id":
      return "internal_error";
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled monitor status: ${String(exhaustive)}`);
    }
  }
}

function monitorFrameSize(dataLength: number, frameCount: number): number {
  const remaining = dataLength - 2;
  if (remaining === frameCount * MONITOR_FRAME_SIZE) {
    return MONITOR_FRAME_SIZE;
  }
  if (remaining === frameCount * LEGACY_MONITOR_FRAME_SIZE) {
    return LEGACY_MONITOR_FRAME_SIZE;
  }
  throw new Error(
    `Invalid monitor data length ${dataLength}; expected ${2 + frameCount * MONITOR_FRAME_SIZE} or ${2 + frameCount * LEGACY_MONITOR_FRAME_SIZE}`,
  );
}

function validateBitrate(bitrate: number, label: string): number {
  if (!Number.isInteger(bitrate) || bitrate <= 0 || bitrate > 0xffffffff) {
    throw new Error(`Invalid CAN ${label} ${String(bitrate)}`);
  }
  return bitrate;
}
