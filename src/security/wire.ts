import { readU8, readU16, readU32, writeU16, writeU32 } from "./bytes.js";
import { BOX_PUBLIC_KEY_LENGTH } from "./invite.js";
import { DEVICE_ID_LENGTH, NONCE_LENGTH, SecurityRole, type SecurityRoleCode } from "./primitives.js";

// Payloads of the 0xA005 requests and responses, without the
// `[opcode, seq]` / `[opcode | 0x80, seq, status]` headers.

export const SecurityOpcode = {
  claim: 0x01,
  authBegin: 0x02,
  authProve: 0x03,
  /** Admin only. `[start:u16le]` -> one page of the guest list. */
  listGuests: 0x20,
  /** Admin, or a guest removing itself. `[user_id:u32le]` -> []. */
  removeGuest: 0x21,
  /** Admin only. Retires an invite that was never redeemed. `[user_id:u32le]` -> []. */
  cancelInvite: 0x22,
} as const;
export type SecurityOpcodeValue = (typeof SecurityOpcode)[keyof typeof SecurityOpcode];

export const SecurityStatusCode = {
  ok: 0x00,
  badLength: 0x01,
  unknownOpcode: 0x02,
  notInPairingMode: 0x03,
  alreadyClaimed: 0x04,
  notAuthorized: 0x05,
  badProof: 0x06,
  guestListFull: 0x07,
  unknownKey: 0x08,
  internalError: 0x09,
  provisioningRequired: 0x0a,
  inviteUsed: 0x0b,
} as const;

export const ADMIN_USER_ID = 0;

export type ClaimResult = { deviceId: Uint8Array; boxPublicKey: Uint8Array };
export type AuthChallenge = { nonce: Uint8Array; deviceId: Uint8Array; boxPublicKey: Uint8Array };
export type AuthResult = { role: SecurityRoleCode; userId: number };

export type GuestEntry = {
  userId: number;
  label: string;
  /** A phone holding this guest's key is bonded. */
  bonded: boolean;
  /** That phone is connected now. */
  connected: boolean;
};

/** The adapter's record of used invite IDs: all below `low`, plus bit i for `low + i`. */
export type UsedInviteWindow = { low: number; bits: bigint };

export type GuestListPage = {
  /** Guests on the adapter, across all pages. */
  total: number;
  capacity: number;
  /** One above the highest user ID used; use it for the next invite. */
  nextInviteId: number;
  usedInvites: UsedInviteWindow;
  guests: GuestEntry[];
};

export const USED_INVITE_WINDOW_SIZE = 64;

const GUEST_LIST_HEADER_LENGTH = 2 + 2 + 4 + 4 + 8 + 1;
const GUEST_FLAG_BONDED = 0x01;
const GUEST_FLAG_CONNECTED = 0x02;
const decoder = new TextDecoder();

function assertMinLength(payload: Uint8Array, length: number, what: string): void {
  if (payload.length < length) {
    throw new Error(`${what} response is too short (${payload.length} bytes)`);
  }
}

/** CLAIM response: `device_id[16] || box_pubkey[32]`. */
export function parseClaimResult(payload: Uint8Array): ClaimResult {
  assertMinLength(payload, DEVICE_ID_LENGTH + BOX_PUBLIC_KEY_LENGTH, "Claim");
  return {
    deviceId: payload.slice(0, DEVICE_ID_LENGTH),
    boxPublicKey: payload.slice(DEVICE_ID_LENGTH, DEVICE_ID_LENGTH + BOX_PUBLIC_KEY_LENGTH),
  };
}

/** AUTH_BEGIN response: `nonce[16] || device_id[16] || box_pubkey[32]`. */
export function parseAuthChallenge(payload: Uint8Array): AuthChallenge {
  const deviceIdEnd = NONCE_LENGTH + DEVICE_ID_LENGTH;
  assertMinLength(payload, deviceIdEnd + BOX_PUBLIC_KEY_LENGTH, "Auth");
  return {
    nonce: payload.slice(0, NONCE_LENGTH),
    deviceId: payload.slice(NONCE_LENGTH, deviceIdEnd),
    boxPublicKey: payload.slice(deviceIdEnd, deviceIdEnd + BOX_PUBLIC_KEY_LENGTH),
  };
}

/** AUTH_PROVE response: `role || user_id:u32le`. The Admin is user 0. */
export function parseAuthResult(payload: Uint8Array): AuthResult {
  assertMinLength(payload, 5, "Auth proof");
  const role = readU8(payload, 0);
  if (role !== SecurityRole.admin && role !== SecurityRole.guest) {
    throw new Error(`Unknown access role 0x${role.toString(16)}`);
  }
  return { role, userId: readU32(payload, 1) };
}

export function buildListGuestsPayload(start = 0): Uint8Array {
  const out = new Uint8Array(2);
  writeU16(out, 0, start);
  return out;
}

/**
 * LIST_GUESTS response: `total:u16le || capacity:u16le || next_invite_id:u32le ||
 * used_low:u32le || used_bits:u64le || count ||
 * count × (user_id:u32le || flags || label_len || label)`.
 */
export function parseGuestListPage(payload: Uint8Array): GuestListPage {
  assertMinLength(payload, GUEST_LIST_HEADER_LENGTH, "Guest list");
  const count = readU8(payload, GUEST_LIST_HEADER_LENGTH - 1);
  const guests: GuestEntry[] = [];
  let offset = GUEST_LIST_HEADER_LENGTH;
  for (let i = 0; i < count; i++) {
    assertMinLength(payload, offset + 6, "Guest list");
    const labelLength = readU8(payload, offset + 5);
    assertMinLength(payload, offset + 6 + labelLength, "Guest list");
    const flags = readU8(payload, offset + 4);
    guests.push({
      userId: readU32(payload, offset),
      bonded: (flags & GUEST_FLAG_BONDED) !== 0,
      connected: (flags & GUEST_FLAG_CONNECTED) !== 0,
      label: decoder.decode(payload.subarray(offset + 6, offset + 6 + labelLength)),
    });
    offset += 6 + labelLength;
  }
  return {
    total: readU16(payload, 0),
    capacity: readU16(payload, 2),
    nextInviteId: readU32(payload, 4),
    usedInvites: {
      low: readU32(payload, 8),
      bits: BigInt(readU32(payload, 12)) | (BigInt(readU32(payload, 16)) << 32n),
    },
    guests,
  };
}

/** Whether the adapter would turn away an invite for `userId` as used. */
export function isInviteIdUsed(window: UsedInviteWindow, userId: number): boolean {
  if (userId < window.low) {
    return true;
  }
  const offset = userId - window.low;
  return offset < USED_INVITE_WINDOW_SIZE && ((window.bits >> BigInt(offset)) & 1n) === 1n;
}

/** REMOVE_GUEST and CANCEL_INVITE request: `user_id:u32le`. */
export function buildGuestIdPayload(userId: number): Uint8Array {
  if (!Number.isInteger(userId) || userId < 1 || userId > 0xffffffff) {
    throw new Error(`Guest user ID must be 1..2^32-1, got ${userId}`);
  }
  const out = new Uint8Array(4);
  writeU32(out, 0, userId);
  return out;
}
