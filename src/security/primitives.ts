import { ed25519 } from "@noble/curves/ed25519";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";

import { assertLength, concat } from "./bytes.js";

// Can Opener SE security primitives (0xA005). The wire format is specified in
// docs/can-opener-se-security-protocol.md and must stay in sync with the
// firmware's main/security.c.

export const SEED_LENGTH = 32;
export const PUBLIC_KEY_LENGTH = 32;
export const SIGNATURE_LENGTH = 64;
export const DEVICE_ID_LENGTH = 16;
export const NONCE_LENGTH = 16;
export const CLAIM_VERIFICATION_LENGTH = 32;

/** What an authorized connection may do. Guests have full vehicle access but cannot manage access. */
export const SecurityRole = {
  admin: 0x01,
  guest: 0x02,
} as const;
export type SecurityRoleCode = (typeof SecurityRole)[keyof typeof SecurityRole];

/** Optional per-adapter secret that gates CLAIM. Absent means any phone in the pairing window may claim. */
export type ProvisioningKey = string | Uint8Array | null | undefined;

const encoder = new TextEncoder();
const AUTH_CONTEXT = encoder.encode("CO-AUTH-v2");
const CLAIM_CONTEXT = encoder.encode("CO-CLAIM-v1");

function provisioningKeyBytes(key: ProvisioningKey): Uint8Array | null {
  if (key == null) {
    return null;
  }
  const bytes = typeof key === "string" ? encoder.encode(key) : key;
  return bytes.length === 0 ? null : bytes;
}

// ── Keys ──────────────────────────────────────────────────────────────────────

/** A new Ed25519 private key (seed). Uses `crypto.getRandomValues`. */
export function generateSeed(): Uint8Array {
  return ed25519.utils.randomSecretKey();
}

export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  assertLength(seed, SEED_LENGTH, "Seed");
  return ed25519.getPublicKey(seed);
}

// ── Provisioning ──────────────────────────────────────────────────────────────

/** What the adapter stores for a provisioning key: SHA-256 of its UTF-8 text. */
export function provisioningKeyMaterial(provisioningKey: string | Uint8Array): Uint8Array {
  const bytes = provisioningKeyBytes(provisioningKey);
  if (bytes === null) {
    throw new Error("Provisioning key is empty");
  }
  return sha256(bytes);
}

/**
 * The CLAIM `verification` field. Empty when there is no provisioning key;
 * otherwise HMAC-SHA256(SHA-256(key), "CO-CLAIM-v1" || adminPublicKey).
 */
export function claimVerification(
  provisioningKey: ProvisioningKey,
  adminPublicKey: Uint8Array,
): Uint8Array {
  assertLength(adminPublicKey, PUBLIC_KEY_LENGTH, "Admin public key");
  const bytes = provisioningKeyBytes(provisioningKey);
  if (bytes === null) {
    return new Uint8Array(0);
  }
  return hmac(sha256, sha256(bytes), concat(CLAIM_CONTEXT, adminPublicKey));
}

/** CLAIM request payload: `admin_pubkey[32]`, then `verification[32]` when a provisioning key is given. */
export function buildClaimPayload(
  adminPublicKey: Uint8Array,
  provisioningKey?: ProvisioningKey,
): Uint8Array {
  return concat(adminPublicKey, claimVerification(provisioningKey, adminPublicKey));
}

// ── Authentication ────────────────────────────────────────────────────────────

/** `"CO-AUTH-v2" || nonce || device_id || pubkey`, the bytes AUTH_PROVE signs. */
export function authMessage(
  nonce: Uint8Array,
  deviceId: Uint8Array,
  publicKey: Uint8Array,
): Uint8Array {
  assertLength(nonce, NONCE_LENGTH, "Nonce");
  assertLength(deviceId, DEVICE_ID_LENGTH, "Device ID");
  assertLength(publicKey, PUBLIC_KEY_LENGTH, "Public key");
  return concat(AUTH_CONTEXT, nonce, deviceId, publicKey);
}

export function signAuthChallenge(
  seed: Uint8Array,
  nonce: Uint8Array,
  deviceId: Uint8Array,
): { publicKey: Uint8Array; signature: Uint8Array } {
  const publicKey = publicKeyFromSeed(seed);
  return {
    publicKey,
    signature: ed25519.sign(authMessage(nonce, deviceId, publicKey), seed),
  };
}

export function verifyAuthSignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  nonce: Uint8Array,
  deviceId: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_LENGTH) {
    return false;
  }
  try {
    return ed25519.verify(signature, authMessage(nonce, deviceId, publicKey), publicKey);
  } catch {
    return false;
  }
}

/** AUTH_PROVE request payload: `pubkey[32] || signature[64] || cred_len:u16le || cred`. A key the adapter already knows sends no credential; redeeming an invite sends `buildInviteCredential()`. */
export function buildAuthProvePayload(
  publicKey: Uint8Array,
  signature: Uint8Array,
  credential: Uint8Array = new Uint8Array(0),
): Uint8Array {
  assertLength(publicKey, PUBLIC_KEY_LENGTH, "Public key");
  assertLength(signature, SIGNATURE_LENGTH, "Signature");
  if (credential.length > 0xffff) {
    throw new Error("Credential is too long");
  }
  const length = Uint8Array.of(credential.length & 0xff, credential.length >> 8);
  return concat(publicKey, signature, length, credential);
}
