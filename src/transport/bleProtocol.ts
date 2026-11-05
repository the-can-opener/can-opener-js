import type { CanFdTxDl, VehicleRequest } from "./types.js";
import {
  BLE_MAX_REQUEST_WRITE_BYTES,
  ISOTP_ADDRESSING_FIELD_SIZE,
  isTxCanIdExtended,
  REQUEST_FLAG_CAN_FD,
  REQUEST_FLAG_EXPECT_CAN_RESPONSE,
  REQUEST_FLAG_ISOTP_ADDRESSING,
  REQUEST_FLAG_ISOTP_PAYLOAD,
  REQUEST_FLAG_RESPONSE_ID_EXTENDED,
  REQUEST_FLAG_TX_CAN_ID_EXTENDED,
  REQUEST_PACKET_DEFAULT_TIMEOUT_MS,
  RESPONSE_FLAG_CAN_ID_EXTENDED,
  resolveResponseIds,
  validateBus,
} from "./bleWire.js";

/** Can Opener SE GATT service and characteristics. See `docs/can-opener-se-ble-protocol.md`. */
export const CAN_OPENER_SERVICE_UUID = "00000180-0000-1000-8000-00805f9b34fb";
export const REQUEST_CHAR_UUID = "0000fef4-0000-1000-8000-00805f9b34fb";
export const MONITOR_CONTROL_CHAR_UUID = "0000a003-0000-1000-8000-00805f9b34fb";
export const MONITOR_DATA_CHAR_UUID = "0000a004-0000-1000-8000-00805f9b34fb";
export const SECURITY_CHAR_UUID = "0000a005-0000-1000-8000-00805f9b34fb";

const CLASSIC_FRAME_LENGTH = 8;
const V2_RESPONSE_FIELDS_SIZE = 10;
const ISOTP_MAX_PAYLOAD_LEN = 4095;
const V3_HEADER_SIZE = 20;
const V3_CONTINUATION_HEADER_SIZE = 4;

const RESPONSE_FLAG_FRAGMENTED = 0x02;
const RESPONSE_FLAG_MORE_FRAGMENTS = 0x04;
const RESPONSE_FLAG_BATCH_RESULT = 0x08;
const RESPONSE_FLAGS_MASK =
  RESPONSE_FLAG_CAN_ID_EXTENDED | RESPONSE_FLAG_FRAGMENTED | RESPONSE_FLAG_MORE_FRAGMENTS | RESPONSE_FLAG_BATCH_RESULT;
const RESPONSE_HEADER_SIZE = 8;
const RESPONSE_FRAGMENT_OFFSET_SIZE = 2;

/** A complete `0xFEF4` reply, after fragment reassembly. */
export interface CanResponse {
  seq: number;
  status: number;
  responseCanIdExtended: boolean;
  responseCanId: number;
  /** True when `payload` is a batch result list rather than ECU data. */
  batchResult: boolean;
  payload: Uint8Array;
}

/** One `0xFEF4` notification, before fragment reassembly. */
export interface CanNotification extends CanResponse {
  /** Present when the payload is a slice of a larger response. */
  fragment?: { offset: number; more: boolean };
}

/**
 * Encodes a request into one or more BLE writes. Classic and 8-byte CAN FD
 * frames use the single-write v2 layout. A CAN FD request with `txDl` 64 uses
 * v3: the initial write carries the header and the u16 total length, and a
 * payload longer than one write (up to 4095 bytes) continues in writes of
 * `[seq, flags, fragment_offset:u16, chunk...]`.
 */
export function buildRequestPackets(seq: number, req: VehicleRequest): Uint8Array[] {
  const dlc = req.txFrame.dlc ?? req.txFrame.data.length;
  if (dlc < 0 || dlc > CLASSIC_FRAME_LENGTH) {
    throw new Error(`Invalid CAN DLC ${dlc}`);
  }

  const { canFd } = req;
  if (canFd === undefined) {
    return [buildV2Packet(seq, req, false, dlc)];
  }
  switch (canFd.txDl) {
    case 8:
      // The firmware requires DLC 8 for an 8-byte CAN FD frame.
      return [buildV2Packet(seq, req, true, CLASSIC_FRAME_LENGTH)];
    case 64:
      return buildV3Packets(seq, req, canFd.txDl, canFd.payload);
    default: {
      const unsupported: never = canFd;
      throw new Error(`Unsupported CAN FD request ${String(unsupported)}`);
    }
  }
}

/**
 * v2 layout: `seq, flags, [bus, [tx_address, rx_address]], tx_can_id:u32,
 * [response_id_start:u32, response_id_end:u32, timeout_ms:u16], dlc, data[8]`.
 * The bus byte is omitted for the legacy 15/25-byte layout when the request
 * names no bus; addressing always needs it.
 */
function buildV2Packet(seq: number, req: VehicleRequest, canFd: boolean, dlc: number): Uint8Array {
  const { txFrame, isotpAddressing, expectCanResponse } = req;
  const addressed = isotpAddressing !== undefined;
  const explicitBus = txFrame.bus !== undefined || addressed;
  const headerSize = 2 + (explicitBus ? 1 : 0) + (addressed ? ISOTP_ADDRESSING_FIELD_SIZE : 0);
  const responseFieldsSize = expectCanResponse ? V2_RESPONSE_FIELDS_SIZE : 0;
  const buf = new Uint8Array(headerSize + 4 + responseFieldsSize + 1 + CLASSIC_FRAME_LENGTH);
  const view = new DataView(buf.buffer);
  const { responseIdStart, responseIdEnd, responseIdExtended } = resolveResponseIds(req);

  view.setUint8(0, seq);
  view.setUint8(
    1,
    (expectCanResponse ? REQUEST_FLAG_EXPECT_CAN_RESPONSE : 0) |
      (isTxCanIdExtended(req) ? REQUEST_FLAG_TX_CAN_ID_EXTENDED : 0) |
      (expectCanResponse && responseIdExtended ? REQUEST_FLAG_RESPONSE_ID_EXTENDED : 0) |
      (addressed ? REQUEST_FLAG_ISOTP_ADDRESSING : 0) |
      (canFd ? REQUEST_FLAG_CAN_FD : 0),
  );
  if (explicitBus) {
    view.setUint8(2, validateBus(txFrame.bus ?? 0));
  }
  if (addressed) {
    view.setUint8(3, isotpAddressing.tx & 0xff);
    view.setUint8(4, isotpAddressing.rx & 0xff);
  }

  let offset = headerSize;
  view.setUint32(offset, txFrame.canId, true);
  offset += 4;
  if (expectCanResponse) {
    view.setUint32(offset, responseIdStart, true);
    view.setUint32(offset + 4, responseIdEnd, true);
    view.setUint16(offset + 8, req.timeoutMs ?? REQUEST_PACKET_DEFAULT_TIMEOUT_MS, true);
    offset += V2_RESPONSE_FIELDS_SIZE;
  }
  view.setUint8(offset, dlc);
  buf.set(txFrame.data.subarray(0, dlc), offset + 1);
  return buf;
}

/**
 * v3 CAN FD layout: `seq, flags, bus, [tx_address, rx_address], tx_can_id:u32,
 * response_id_start:u32, response_id_end:u32, timeout_ms:u16, tx_dl,
 * total_length:u16, payload...`. The firmware segments `payload` with
 * ISO 15765-2:2016 framing at `txDl` bytes per frame and always answers.
 */
function buildV3Packets(seq: number, req: VehicleRequest, txDl: CanFdTxDl, payload: Uint8Array): Uint8Array[] {
  if (payload.length === 0 || payload.length > ISOTP_MAX_PAYLOAD_LEN) {
    throw new Error(`ISO-TP request payload must be 1 to ${ISOTP_MAX_PAYLOAD_LEN} bytes, got ${payload.length}`);
  }
  const { txFrame, isotpAddressing } = req;
  const addressOffset = isotpAddressing === undefined ? 0 : ISOTP_ADDRESSING_FIELD_SIZE;
  const headerSize = V3_HEADER_SIZE + addressOffset;
  const { responseIdStart, responseIdEnd, responseIdExtended } = resolveResponseIds(req);
  const flags =
    REQUEST_FLAG_ISOTP_PAYLOAD |
    REQUEST_FLAG_CAN_FD |
    (req.expectCanResponse ? REQUEST_FLAG_EXPECT_CAN_RESPONSE : 0) |
    (isTxCanIdExtended(req) ? REQUEST_FLAG_TX_CAN_ID_EXTENDED : 0) |
    (responseIdExtended ? REQUEST_FLAG_RESPONSE_ID_EXTENDED : 0) |
    (isotpAddressing !== undefined ? REQUEST_FLAG_ISOTP_ADDRESSING : 0);

  const firstChunk = payload.subarray(0, BLE_MAX_REQUEST_WRITE_BYTES - headerSize);
  const first = new Uint8Array(headerSize + firstChunk.length);
  const view = new DataView(first.buffer);
  view.setUint8(0, seq);
  view.setUint8(1, flags);
  view.setUint8(2, validateBus(txFrame.bus ?? 0));
  if (isotpAddressing !== undefined) {
    view.setUint8(3, isotpAddressing.tx & 0xff);
    view.setUint8(4, isotpAddressing.rx & 0xff);
  }
  view.setUint32(3 + addressOffset, txFrame.canId, true);
  view.setUint32(7 + addressOffset, responseIdStart, true);
  view.setUint32(11 + addressOffset, responseIdEnd, true);
  view.setUint16(15 + addressOffset, req.timeoutMs ?? REQUEST_PACKET_DEFAULT_TIMEOUT_MS, true);
  view.setUint8(17 + addressOffset, txDl);
  view.setUint16(headerSize - 2, payload.length, true);
  first.set(firstChunk, headerSize);

  const packets = [first];
  const continuationChunkSize = BLE_MAX_REQUEST_WRITE_BYTES - V3_CONTINUATION_HEADER_SIZE;
  for (let offset = firstChunk.length; offset < payload.length; offset += continuationChunkSize) {
    const chunk = payload.subarray(offset, offset + continuationChunkSize);
    const packet = new Uint8Array(V3_CONTINUATION_HEADER_SIZE + chunk.length);
    const continuation = new DataView(packet.buffer);
    continuation.setUint8(0, seq);
    continuation.setUint8(1, flags);
    continuation.setUint16(2, offset, true);
    packet.set(chunk, V3_CONTINUATION_HEADER_SIZE);
    packets.push(packet);
  }
  return packets;
}

/** Parses one `0xFEF4` notification: `seq, status, flags, response_can_id:u32, payload_len, payload`. */
export function parseCanNotification(data: Uint8Array): CanNotification {
  if (data.length < RESPONSE_HEADER_SIZE) {
    throw new Error(`Invalid CAN response length ${data.length}`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = view.getUint8(2);
  if ((flags & ~RESPONSE_FLAGS_MASK) !== 0) {
    throw new Error(`Invalid CAN response flags 0x${flags.toString(16)}`);
  }

  const payloadLength = view.getUint8(7);
  if (data.length < RESPONSE_HEADER_SIZE + payloadLength) {
    throw new Error(`Invalid CAN response payload length ${payloadLength}`);
  }

  let payload = data.slice(RESPONSE_HEADER_SIZE, RESPONSE_HEADER_SIZE + payloadLength);
  let fragment: CanNotification["fragment"];
  if ((flags & RESPONSE_FLAG_FRAGMENTED) !== 0) {
    if (payload.length < RESPONSE_FRAGMENT_OFFSET_SIZE) {
      throw new Error("Invalid fragmented CAN response");
    }
    fragment = {
      offset: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0, true),
      more: (flags & RESPONSE_FLAG_MORE_FRAGMENTS) !== 0,
    };
    payload = payload.slice(RESPONSE_FRAGMENT_OFFSET_SIZE);
  } else if ((flags & RESPONSE_FLAG_MORE_FRAGMENTS) !== 0) {
    throw new Error("CAN response claims more fragments but is not fragmented");
  }

  return {
    seq: view.getUint8(0),
    status: view.getUint8(1),
    responseCanIdExtended: (flags & RESPONSE_FLAG_CAN_ID_EXTENDED) !== 0,
    responseCanId: view.getUint32(3, true),
    batchResult: (flags & RESPONSE_FLAG_BATCH_RESULT) !== 0,
    payload,
    ...(fragment !== undefined ? { fragment } : {}),
  };
}

/**
 * Reassembles a fragmented response. The firmware emits fragments in
 * ascending offset order and marks the last one by clearing the "more" flag;
 * the assembler tolerates reordering and rejects gaps so a dropped
 * notification cannot surface as a truncated-but-"complete" payload.
 */
export class CanResponseAssembler {
  private header: CanResponse | undefined;
  private readonly chunks: { offset: number; data: Uint8Array }[] = [];

  /** Returns the full response once the final fragment has been pushed. */
  push(notification: CanNotification): CanResponse | undefined {
    const { fragment, ...response } = notification;
    if (fragment === undefined) {
      return notification;
    }

    this.header ??= { ...response, payload: new Uint8Array(0) };
    this.chunks.push({ offset: fragment.offset, data: response.payload });
    if (fragment.more) {
      return undefined;
    }

    const totalLength = fragment.offset + response.payload.length;
    const payload = new Uint8Array(totalLength);
    let expectedOffset = 0;
    for (const chunk of [...this.chunks].sort((a, b) => a.offset - b.offset)) {
      if (chunk.offset !== expectedOffset) {
        throw new Error(`Fragmented CAN response is missing bytes at offset ${expectedOffset}`);
      }
      payload.set(chunk.data, chunk.offset);
      expectedOffset += chunk.data.length;
    }
    if (expectedOffset !== totalLength) {
      throw new Error("Fragmented CAN response has inconsistent length");
    }

    return { ...this.header, payload };
  }
}
