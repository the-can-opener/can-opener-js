import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";

import { assertLength, concat, readU8, readU32, writeU32 } from "./bytes.js";
import {
  DEVICE_ID_LENGTH,
  NONCE_LENGTH,
  PUBLIC_KEY_LENGTH,
  SEED_LENGTH,
  SIGNATURE_LENGTH,
  publicKeyFromSeed,
} from "./primitives.js";

// Guest invites. The Admin signs an invite body, then seals it to the
// adapter's X25519 box key so only that adapter can read it. The invite also
// carries a one-off invite key: the guest signs its own public key with it
// when redeeming, so an invite captured on the air cannot be bound to another
// phone. See docs/can-opener-se-security-protocol.md, sections 6 and 7.

export const BOX_PUBLIC_KEY_LENGTH = 32;
export const INVITE_VERSION = 0x01;
export const INVITE_LABEL_MAX_BYTES = 16;
export const CREDENTIAL_TYPE_INVITE = 0x01;
/** `eph_pubkey[32]` plus the Poly1305 tag. */
export const SEAL_OVERHEAD = 32 + 16;
const INVITE_FIXED_LENGTH = 1 + 4 + PUBLIC_KEY_LENGTH + 1;
const INVITE_TOKEN_VERSION = 0x01;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INVITE_CONTEXT = encoder.encode("CO-INVITE-v1");
const REDEEM_CONTEXT = encoder.encode("CO-REDEEM-v1");
const SEAL_CONTEXT = encoder.encode("CO-SEAL-v1");
const SEAL_NONCE = new Uint8Array(12);

export type InviteBody = {
  /** Unique per adapter, chosen by the Admin. 0 is the Admin itself. */
  userId: number;
  invitePublicKey: Uint8Array;
  label: string;
};

export type Invite = {
  userId: number;
  label: string;
  /** Private key the guest uses once, to sign its own public key when redeeming. */
  inviteSeed: Uint8Array;
  /** The signed invite body, sealed to the adapter. Opaque to the guest. */
  sealedInvite: Uint8Array;
};

function assertUserId(userId: number): void {
  if (!Number.isInteger(userId) || userId < 1 || userId > 0xffffffff) {
    throw new Error(`Invite user ID must be 1..2^32-1, got ${userId}`);
  }
}

/** Trims and truncates to 16 UTF-8 bytes without splitting a character. */
export function encodeInviteLabel(label: string): Uint8Array {
  let out = new Uint8Array(0);
  let text = "";
  for (const char of label.trim()) {
    const next = encoder.encode(text + char);
    if (next.length > INVITE_LABEL_MAX_BYTES) {
      break;
    }
    text += char;
    out = next;
  }
  return out;
}

function unsignedInviteBody(body: InviteBody): Uint8Array {
  assertUserId(body.userId);
  assertLength(body.invitePublicKey, PUBLIC_KEY_LENGTH, "Invite public key");
  const label = encodeInviteLabel(body.label);
  const out = new Uint8Array(INVITE_FIXED_LENGTH + label.length);
  out[0] = INVITE_VERSION;
  writeU32(out, 1, body.userId);
  out.set(body.invitePublicKey, 5);
  out[5 + PUBLIC_KEY_LENGTH] = label.length;
  out.set(label, INVITE_FIXED_LENGTH);
  return out;
}

/**
 * `version || user_id:u32le || invite_pubkey[32] || label_len || label ||
 * admin_sig[64]`, where admin_sig signs `"CO-INVITE-v1" || device_id ||` the
 * bytes before it.
 */
export function signInvite(
  adminSeed: Uint8Array,
  deviceId: Uint8Array,
  body: InviteBody,
): Uint8Array {
  assertLength(adminSeed, SEED_LENGTH, "Admin seed");
  assertLength(deviceId, DEVICE_ID_LENGTH, "Device ID");
  const unsigned = unsignedInviteBody(body);
  const signature = ed25519.sign(concat(INVITE_CONTEXT, deviceId, unsigned), adminSeed);
  return concat(unsigned, signature);
}

/** Parses and checks a signed invite body; null when it is malformed or not signed by `adminPublicKey`. */
export function verifyInvite(
  adminPublicKey: Uint8Array,
  deviceId: Uint8Array,
  signed: Uint8Array,
): InviteBody | null {
  if (signed.length < INVITE_FIXED_LENGTH + SIGNATURE_LENGTH || signed[0] !== INVITE_VERSION) {
    return null;
  }
  const labelLength = readU8(signed, 5 + PUBLIC_KEY_LENGTH);
  const unsignedLength = INVITE_FIXED_LENGTH + labelLength;
  if (labelLength > INVITE_LABEL_MAX_BYTES || signed.length !== unsignedLength + SIGNATURE_LENGTH) {
    return null;
  }
  const unsigned = signed.subarray(0, unsignedLength);
  const signature = signed.subarray(unsignedLength);
  let valid = false;
  try {
    valid = ed25519.verify(signature, concat(INVITE_CONTEXT, deviceId, unsigned), adminPublicKey);
  } catch {
    valid = false;
  }
  const userId = readU32(signed, 1);
  if (!valid || userId === 0) {
    return null;
  }
  return {
    userId,
    invitePublicKey: signed.slice(5, 5 + PUBLIC_KEY_LENGTH),
    label: decoder.decode(signed.subarray(INVITE_FIXED_LENGTH, unsignedLength)),
  };
}

// ── Sealing ───────────────────────────────────────────────────────────────────

export function boxPublicKeyFromSecret(boxSecret: Uint8Array): Uint8Array {
  assertLength(boxSecret, 32, "Box secret");
  return x25519.getPublicKey(boxSecret);
}

function sealKey(shared: Uint8Array, ephemeralPublicKey: Uint8Array, boxPublicKey: Uint8Array) {
  return hmac(sha256, shared, concat(SEAL_CONTEXT, ephemeralPublicKey, boxPublicKey));
}

/**
 * `eph_pubkey[32] || ChaCha20-Poly1305(key, nonce = 0, aad = device_id)`, with
 * key = HMAC-SHA256(X25519(eph, box), "CO-SEAL-v1" || eph_pubkey || box_pubkey).
 * A fresh ephemeral key makes the fixed nonce safe.
 */
export function sealInvite(
  boxPublicKey: Uint8Array,
  deviceId: Uint8Array,
  signedInvite: Uint8Array,
  ephemeralSecret: Uint8Array = x25519.utils.randomSecretKey(),
): Uint8Array {
  assertLength(boxPublicKey, BOX_PUBLIC_KEY_LENGTH, "Box public key");
  assertLength(deviceId, DEVICE_ID_LENGTH, "Device ID");
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecret);
  const key = sealKey(
    x25519.getSharedSecret(ephemeralSecret, boxPublicKey),
    ephemeralPublicKey,
    boxPublicKey,
  );
  return concat(ephemeralPublicKey, chacha20poly1305(key, SEAL_NONCE, deviceId).encrypt(signedInvite));
}

/** The adapter's side of `sealInvite`; null when the box does not open. */
export function openSealedInvite(
  boxSecret: Uint8Array,
  deviceId: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | null {
  if (sealed.length <= SEAL_OVERHEAD) {
    return null;
  }
  const ephemeralPublicKey = sealed.subarray(0, 32);
  try {
    const key = sealKey(
      x25519.getSharedSecret(boxSecret, ephemeralPublicKey),
      ephemeralPublicKey,
      boxPublicKeyFromSecret(boxSecret),
    );
    return chacha20poly1305(key, SEAL_NONCE, deviceId).decrypt(sealed.subarray(32));
  } catch {
    return null;
  }
}

// ── Issuing and redeeming ─────────────────────────────────────────────────────

/** Creates a single-use invite. Only the Admin can do this; it needs no connection to the adapter. */
export function createInvite(options: {
  adminSeed: Uint8Array;
  deviceId: Uint8Array;
  boxPublicKey: Uint8Array;
  userId: number;
  label: string;
  /** Fixed values for test vectors; random by default. */
  inviteSeed?: Uint8Array;
  ephemeralSecret?: Uint8Array;
}): Invite {
  const inviteSeed = options.inviteSeed ?? ed25519.utils.randomSecretKey();
  assertLength(inviteSeed, SEED_LENGTH, "Invite seed");
  const label = decoder.decode(encodeInviteLabel(options.label));
  const signed = signInvite(options.adminSeed, options.deviceId, {
    userId: options.userId,
    invitePublicKey: publicKeyFromSeed(inviteSeed),
    label,
  });
  return {
    userId: options.userId,
    label,
    inviteSeed,
    sealedInvite: sealInvite(options.boxPublicKey, options.deviceId, signed, options.ephemeralSecret),
  };
}

/** `"CO-REDEEM-v1" || nonce || device_id || guest_pubkey`, signed with the invite key. */
export function redeemMessage(
  nonce: Uint8Array,
  deviceId: Uint8Array,
  guestPublicKey: Uint8Array,
): Uint8Array {
  assertLength(nonce, NONCE_LENGTH, "Nonce");
  assertLength(deviceId, DEVICE_ID_LENGTH, "Device ID");
  assertLength(guestPublicKey, PUBLIC_KEY_LENGTH, "Guest public key");
  return concat(REDEEM_CONTEXT, nonce, deviceId, guestPublicKey);
}

/**
 * The AUTH_PROVE credential that redeems an invite:
 * `0x01 || redeem_sig[64] || sealed_invite`.
 */
export function buildInviteCredential(
  inviteSeed: Uint8Array,
  sealedInvite: Uint8Array,
  nonce: Uint8Array,
  deviceId: Uint8Array,
  guestPublicKey: Uint8Array,
): Uint8Array {
  const signature = ed25519.sign(redeemMessage(nonce, deviceId, guestPublicKey), inviteSeed);
  return concat(Uint8Array.of(CREDENTIAL_TYPE_INVITE), signature, sealedInvite);
}

// ── Sharing ───────────────────────────────────────────────────────────────────

export type InviteToken = {
  deviceId: Uint8Array;
  inviteSeed: Uint8Array;
  sealedInvite: Uint8Array;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Invalid base64url string");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** base64url of `0x01 || device_id[16] || invite_seed[32] || sealed_invite`, for links and QR codes. */
export function encodeInviteToken(token: InviteToken): string {
  assertLength(token.deviceId, DEVICE_ID_LENGTH, "Device ID");
  assertLength(token.inviteSeed, SEED_LENGTH, "Invite seed");
  return bytesToBase64Url(
    concat(Uint8Array.of(INVITE_TOKEN_VERSION), token.deviceId, token.inviteSeed, token.sealedInvite),
  );
}

export function decodeInviteToken(text: string): InviteToken {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(text.trim());
  } catch {
    throw new Error("This invite is damaged.");
  }
  const sealedStart = 1 + DEVICE_ID_LENGTH + SEED_LENGTH;
  if (bytes.length === 0 || bytes[0] !== INVITE_TOKEN_VERSION) {
    throw new Error("This invite needs a newer version of the app.");
  }
  if (bytes.length <= sealedStart + SEAL_OVERHEAD) {
    throw new Error("This invite is incomplete.");
  }
  return {
    deviceId: bytes.slice(1, 1 + DEVICE_ID_LENGTH),
    inviteSeed: bytes.slice(1 + DEVICE_ID_LENGTH, sealedStart),
    sealedInvite: bytes.slice(sealedStart),
  };
}
