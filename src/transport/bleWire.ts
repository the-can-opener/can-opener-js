import { CanTransmitError, NoEcuResponseError } from "../errors.js";
import type { VehicleRequest } from "./types.js";

// Values shared by the Can Opener SE packet layouts. All multi-byte fields are
// little-endian (ESP32 native byte order). Must stay in sync with the firmware.

/** Largest write the firmware accepts on the request characteristic. */
export const BLE_MAX_REQUEST_WRITE_BYTES = 244;
/** Firmware default when a request packet omits a timeout. */
export const REQUEST_PACKET_DEFAULT_TIMEOUT_MS = 500;
export const ISOTP_ADDRESSING_FIELD_SIZE = 2;

export const REQUEST_FLAG_EXPECT_CAN_RESPONSE = 0x01;
export const REQUEST_FLAG_TX_CAN_ID_EXTENDED = 0x02;
export const REQUEST_FLAG_RESPONSE_ID_EXTENDED = 0x04;
export const REQUEST_FLAG_ISOTP_PAYLOAD = 0x08;
export const REQUEST_FLAG_BATCH = 0x10;
export const REQUEST_FLAG_ISOTP_ADDRESSING = 0x20;
export const REQUEST_FLAG_CAN_FD = 0x40;

export const RESPONSE_FLAG_CAN_ID_EXTENDED = 0x01;

export const REQUEST_STATUS_OK = 0x00;
export const REQUEST_STATUS_CAN_TX_FAIL = 0xe3;
export const REQUEST_STATUS_CAN_RX_TIMEOUT = 0xe4;

const REQUEST_STATUS_NAMES: Readonly<Record<number, string>> = {
  0x00: "OK",
  0xe1: "BAD_LEN",
  0xe2: "BAD_DLC",
  0xe3: "CAN_TX_FAIL",
  0xe4: "CAN_RX_TIMEOUT",
  0xe5: "ISOTP_INVALID",
  0xe6: "ISOTP_OVERFLOW",
  0xe7: "INVALID_CAN_ID",
  0xe8: "INVALID_BUS",
  0xe9: "BUSY",
  0xea: "BATCH_REJECTED",
};

export function describeRequestStatus(status: number): string {
  const name = REQUEST_STATUS_NAMES[status];
  return `0x${status.toString(16)}${name === undefined ? "" : ` (${name})`}`;
}

/** Maps a failed request status onto the library error the vehicle layer understands. */
export function requestStatusError(status: number): Error {
  const message = `CAN request failed with status ${describeRequestStatus(status)}`;
  switch (status) {
    case REQUEST_STATUS_CAN_TX_FAIL:
      return new CanTransmitError(message);
    case REQUEST_STATUS_CAN_RX_TIMEOUT:
      return new NoEcuResponseError(message);
    default:
      return new Error(message);
  }
}

export function validateBus(bus: number): number {
  if (!Number.isInteger(bus) || bus < 0 || bus > 0xff) {
    throw new Error(`Invalid CAN bus ${String(bus)}`);
  }
  return bus;
}

export function isExtendedCanId(canId: number): boolean {
  return canId > 0x7ff;
}

export function isTxCanIdExtended(req: VehicleRequest): boolean {
  return req.txFrame.extended ?? isExtendedCanId(req.txFrame.canId);
}

/** Response bounds default to the transmit ID, as the firmware expects for a single ECU. */
export function resolveResponseIds(req: VehicleRequest): {
  responseIdStart: number;
  responseIdEnd: number;
  responseIdExtended: boolean;
} {
  const responseIdStart = req.responseIdStart ?? req.txFrame.canId;
  const responseIdEnd = req.responseIdEnd ?? responseIdStart;
  const responseIdExtended =
    req.responseIdExtended ?? (isExtendedCanId(responseIdStart) || isExtendedCanId(responseIdEnd));
  return { responseIdStart, responseIdEnd, responseIdExtended };
}

/** CAN FD requests with tx_dl 64 use the v3 layout, which always gets a reply. */
export function sendsAsCanFdPayload(req: VehicleRequest): boolean {
  return req.canFd?.txDl === 64;
}
