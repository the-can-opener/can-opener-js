import { sha256 } from "@noble/hashes/sha2";

import { bytesToHex, hexToBytes, readU8 } from "./bytes.js";
import { createInvite, decodeInviteToken, encodeInviteToken } from "./invite.js";
import { DEVICE_ID_LENGTH, SEED_LENGTH, SecurityRole } from "./primitives.js";
import { ADMIN_USER_ID, isInviteIdUsed, type GuestEntry, type UsedInviteWindow } from "./wire.js";

/** Default scheme for invite links; apps with their own deep link pass `linkPrefix` to `issueInvite`. */
export const INVITE_LINK_PREFIX = "canopenerapp://invite?t=";

const BACKUP_CODE_PREFIX = "CO2";
const LEGACY_BACKUP_CODE_PREFIX = "CO1";
const BACKUP_CODE_GROUP_LENGTH = 5;
// device_id | role | seed | check
const BACKUP_CODE_BYTES = DEVICE_ID_LENGTH + 1 + SEED_LENGTH + 1;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Guests use the vehicle like the Admin but cannot manage access. */
export type AccessRole = "admin" | "guest";

const ROLE_CODES: Readonly<Record<AccessRole, number>> = {
  admin: SecurityRole.admin,
  guest: SecurityRole.guest,
};

/** An invite this phone received and will redeem on its first connection. Hex. */
export interface PendingInvite {
  seed: string;
  sealed: string;
}

/** An invite the Admin shared, kept until the adapter reports its ID used. */
export interface IssuedInvite {
  userId: number;
  label: string;
  issuedAt: number;
  /** The link, so it can be shared again. */
  link: string;
}

/** Everything a phone needs to authorize with one adapter. */
export interface DeviceCredential {
  /** 16-byte adapter identity, lowercase hex. */
  deviceId: string;
  role: AccessRole;
  /** 32-byte Ed25519 private key seed, lowercase hex. Never sent to the adapter. */
  seed: string;
  /** This key's user ID on the adapter: 0 for the Admin. Unknown until a guest first connects. */
  userId?: number;
  /** The adapter's X25519 box key, lowercase hex. Invites are sealed to it. */
  boxPublicKey?: string;
  /** Cleared once the adapter accepted it. */
  invite?: PendingInvite;
  /** Admin only. */
  issuedInvites?: IssuedInvite[];
  /** Admin only: the highest invite ID issued from this phone. */
  lastInviteId?: number;
}

export interface GuestList {
  capacity: number;
  nextInviteId: number;
  usedInvites: UsedInviteWindow;
  guests: GuestEntry[];
}

export function roleFromCode(code: number): AccessRole {
  switch (code) {
    case ROLE_CODES.admin:
      return "admin";
    case ROLE_CODES.guest:
      return "guest";
    default:
      throw new Error(`Unknown access role 0x${code.toString(16)}`);
  }
}

// ── Backup ────────────────────────────────────────────────────────────────────
// A backup code carries the private seed so a new phone can take over the
// same key. It only ever moves between phones, never to the adapter.

/** Human-readable form for storing a key, e.g. in a password manager: `CO2-XXXXX-...`. */
export function encodeBackupCode(credential: DeviceCredential): string {
  const payload = new Uint8Array(BACKUP_CODE_BYTES);
  payload.set(hexToBytes(credential.deviceId), 0);
  payload[DEVICE_ID_LENGTH] = ROLE_CODES[credential.role];
  payload.set(hexToBytes(credential.seed), DEVICE_ID_LENGTH + 1);
  payload[BACKUP_CODE_BYTES - 1] = backupCheckByte(payload);

  const body = bytesToCrockford(payload);
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += BACKUP_CODE_GROUP_LENGTH) {
    groups.push(body.slice(i, i + BACKUP_CODE_GROUP_LENGTH));
  }
  return [BACKUP_CODE_PREFIX, ...groups].join("-");
}

/** Whether `text` looks like a backup code rather than an invite link. */
export function isBackupCode(text: string): boolean {
  return /^\s*CO\d/i.test(text);
}

/** Accepts a backup code in any case, with or without dashes and whitespace. */
export function decodeBackupCode(text: string): DeviceCredential {
  const compact = text.toUpperCase().replace(/[\s-]/g, "");
  if (compact.startsWith(LEGACY_BACKUP_CODE_PREFIX)) {
    throw new Error(
      "This backup key is from older adapter firmware and no longer works. Hold the adapter's button for 5 seconds to reset it, then set it up again.",
    );
  }
  if (!compact.startsWith(BACKUP_CODE_PREFIX)) {
    throw new Error("That is not a Can Opener backup key.");
  }
  const body = compact.slice(BACKUP_CODE_PREFIX.length).replace(/O/g, "0").replace(/[IL]/g, "1");

  let payload: Uint8Array;
  try {
    payload = crockfordToBytes(body);
  } catch {
    throw new Error("This backup key has a typo.");
  }
  if (payload.length !== BACKUP_CODE_BYTES) {
    throw new Error("This backup key is incomplete.");
  }
  if (backupCheckByte(payload) !== readU8(payload, BACKUP_CODE_BYTES - 1)) {
    throw new Error("This backup key has a typo.");
  }

  let role: AccessRole;
  try {
    role = roleFromCode(readU8(payload, DEVICE_ID_LENGTH));
  } catch {
    throw new Error("This backup key is damaged.");
  }
  return {
    deviceId: bytesToHex(payload.subarray(0, DEVICE_ID_LENGTH)),
    role,
    seed: bytesToHex(payload.subarray(DEVICE_ID_LENGTH + 1, BACKUP_CODE_BYTES - 1)),
  };
}

/** First byte of SHA-256 over everything before the check byte. */
function backupCheckByte(payload: Uint8Array): number {
  return readU8(sha256(payload.subarray(0, BACKUP_CODE_BYTES - 1)), 0);
}

function bytesToCrockford(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET.charAt((buffer >> bits) & 0x1f);
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET.charAt((buffer << (5 - bits)) & 0x1f);
  }
  return out;
}

function crockfordToBytes(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = CROCKFORD_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error(`Invalid character "${char}"`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

// ── Invites ───────────────────────────────────────────────────────────────────

/** Accepts an invite link, or the token from one. */
export function decodeInviteLink(text: string): { deviceId: string; invite: PendingInvite } {
  const trimmed = text.trim();
  const token = /[?&]t=([^&#\s]*)/.exec(trimmed)?.[1] ?? trimmed;
  if (token === "") {
    throw new Error("That is not a Can Opener invite.");
  }
  const decoded = decodeInviteToken(token);
  return {
    deviceId: bytesToHex(decoded.deviceId),
    invite: {
      seed: bytesToHex(decoded.inviteSeed),
      sealed: bytesToHex(decoded.sealedInvite),
    },
  };
}

/** A guest credential that redeems `invite` with the new key `seed`. */
export function guestCredentialFromInvite(
  deviceId: string,
  invite: PendingInvite,
  seed: Uint8Array,
): DeviceCredential {
  return { deviceId, role: "guest", seed: bytesToHex(seed), invite };
}

/** The user ID for the Admin's next invite: past every ID the adapter or this phone used. */
export function nextInviteUserId(credential: DeviceCredential, list: GuestList): number {
  return Math.max(list.nextInviteId, (credential.lastInviteId ?? ADMIN_USER_ID) + 1);
}

/**
 * Creates a single-use invite for the next free user ID. Returns the Admin
 * credential with the invite recorded; the caller stores it.
 */
export function issueInvite(options: {
  credential: DeviceCredential;
  list: GuestList;
  label: string;
  inviteSeed: Uint8Array;
  ephemeralSecret: Uint8Array;
  now?: number;
  /** Prepended to the invite token. Defaults to `INVITE_LINK_PREFIX`. */
  linkPrefix?: string;
}): { credential: DeviceCredential; invite: IssuedInvite } {
  const { credential, list } = options;
  if (credential.role !== "admin") {
    throw new Error("Only the adapter's Admin can invite guests.");
  }
  if (credential.boxPublicKey === undefined) {
    throw new Error("Connect to the adapter once before inviting guests.");
  }
  const deviceId = hexToBytes(credential.deviceId);
  const created = createInvite({
    adminSeed: hexToBytes(credential.seed),
    deviceId,
    boxPublicKey: hexToBytes(credential.boxPublicKey),
    userId: nextInviteUserId(credential, list),
    label: options.label,
    inviteSeed: options.inviteSeed,
    ephemeralSecret: options.ephemeralSecret,
  });
  const invite: IssuedInvite = {
    userId: created.userId,
    label: created.label,
    issuedAt: options.now ?? Date.now(),
    link:
      (options.linkPrefix ?? INVITE_LINK_PREFIX) +
      encodeInviteToken({ deviceId, inviteSeed: created.inviteSeed, sealedInvite: created.sealedInvite }),
  };
  return {
    credential: {
      ...credential,
      lastInviteId: created.userId,
      issuedInvites: [...(credential.issuedInvites ?? []), invite],
    },
    invite,
  };
}

/** Invites the adapter would still accept; redeemed and cancelled ones drop out. */
export function pendingInvites(credential: DeviceCredential, list: Pick<GuestList, "usedInvites">): IssuedInvite[] {
  return (credential.issuedInvites ?? []).filter((invite) => !isInviteIdUsed(list.usedInvites, invite.userId));
}
