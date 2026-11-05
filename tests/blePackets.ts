import type { VehicleBatchStep } from "../src/transport/types.js";

export function batchStep(canId: number, data: number[], extra: Partial<VehicleBatchStep> = {}): VehicleBatchStep {
  return {
    txFrame: { canId, dlc: data.length, data: Uint8Array.from(data) },
    expectCanResponse: false,
    ...extra,
  };
}

/** A `0xFEF4` notification: `seq, status, flags, response_can_id:u32, payload_len, payload`. */
export function notification(
  seq: number,
  status: number,
  flags: number,
  canId: number,
  payload: readonly number[],
): Uint8Array {
  const packet = new Uint8Array(8 + payload.length);
  const view = new DataView(packet.buffer);
  view.setUint8(0, seq);
  view.setUint8(1, status);
  view.setUint8(2, flags);
  view.setUint32(3, canId, true);
  view.setUint8(7, payload.length);
  packet.set(payload, 8);
  return packet;
}

export function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

export function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}
