import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  authMessage,
  buildAuthProvePayload,
  buildClaimPayload,
  claimVerification,
  generateSeed,
  provisioningKeyMaterial,
  publicKeyFromSeed,
  signAuthChallenge,
  verifyAuthSignature,
} from "../src/security/index.js";

const hex = bytesToHex;
const fromHex = hexToBytes;
const range = (start: number, length: number) =>
  Uint8Array.from({ length }, (_, i) => start + i);

// Vectors published in docs/can-opener-se-security-protocol.md.
const SEED = range(0x00, 32);
const PUBLIC_KEY = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
const NONCE = range(0x40, 16);
const DEVICE_ID = range(0x80, 16);
const SIGNATURE =
  "719865296dc5a09915db68740e1f84ab8b15abae441d6752b570f22585ddbe12" +
  "8aa668b1c5409afe592617358cadfd9a223c23f1be87f26131853de9b37f1104";

describe("provisioning key", () => {
  it("adds no verification when there is no key", () => {
    const publicKey = fromHex(PUBLIC_KEY);
    expect(claimVerification(null, publicKey)).toHaveLength(0);
    expect(claimVerification(undefined, publicKey)).toHaveLength(0);
    expect(claimVerification("", publicKey)).toHaveLength(0);
    expect(claimVerification(new Uint8Array(0), publicKey)).toHaveLength(0);
    expect(buildClaimPayload(publicKey)).toEqual(publicKey);
  });

  it("matches the spec vector", () => {
    const publicKey = fromHex(PUBLIC_KEY);
    expect(hex(provisioningKeyMaterial("CANOPENER-TEST"))).toBe(
      "4499bf24388ac4eac510b62068c4cdd1bf66e702c5796959156c1aa9cbc5e92e",
    );
    const verification = claimVerification("CANOPENER-TEST", publicKey);
    expect(hex(verification)).toBe(
      "7c0d6dc9747c40c45dff8cf3ace95912fc585648293796347efbe37bd63e7025",
    );
    expect(buildClaimPayload(publicKey, "CANOPENER-TEST")).toEqual(
      Uint8Array.from([...publicKey, ...verification]),
    );
  });

  it("binds the verification to the Admin public key", () => {
    const other = publicKeyFromSeed(range(0x20, 32));
    expect(hex(claimVerification("CANOPENER-TEST", other))).not.toBe(
      hex(claimVerification("CANOPENER-TEST", fromHex(PUBLIC_KEY))),
    );
  });

  it("rejects an empty key as key material", () => {
    expect(() => provisioningKeyMaterial("")).toThrow("empty");
  });
});

describe("authentication", () => {
  it("matches the spec vector", () => {
    expect(hex(publicKeyFromSeed(SEED))).toBe(PUBLIC_KEY);
    expect(hex(authMessage(NONCE, DEVICE_ID, fromHex(PUBLIC_KEY)))).toBe(
      "434f2d415554482d7632" +
        "404142434445464748494a4b4c4d4e4f" +
        "808182838485868788898a8b8c8d8e8f" +
        PUBLIC_KEY,
    );
    const { publicKey, signature } = signAuthChallenge(SEED, NONCE, DEVICE_ID);
    expect(hex(publicKey)).toBe(PUBLIC_KEY);
    expect(hex(signature)).toBe(SIGNATURE);
    expect(verifyAuthSignature(publicKey, signature, NONCE, DEVICE_ID)).toBe(true);
  });

  it("rejects a signature for another challenge, adapter or key", () => {
    const { publicKey, signature } = signAuthChallenge(SEED, NONCE, DEVICE_ID);
    expect(verifyAuthSignature(publicKey, signature, range(0x41, 16), DEVICE_ID)).toBe(false);
    expect(verifyAuthSignature(publicKey, signature, NONCE, range(0x81, 16))).toBe(false);
    expect(
      verifyAuthSignature(publicKeyFromSeed(generateSeed()), signature, NONCE, DEVICE_ID),
    ).toBe(false);
    expect(verifyAuthSignature(publicKey, signature.slice(1), NONCE, DEVICE_ID)).toBe(false);
  });

  it("lays out AUTH_PROVE with an empty credential", () => {
    const { publicKey, signature } = signAuthChallenge(SEED, NONCE, DEVICE_ID);
    const payload = buildAuthProvePayload(publicKey, signature);
    expect(payload).toHaveLength(98);
    expect(hex(payload)).toBe(`${PUBLIC_KEY}${SIGNATURE}0000`);
  });

  it("appends a credential with its little-endian length", () => {
    const { publicKey, signature } = signAuthChallenge(SEED, NONCE, DEVICE_ID);
    const payload = buildAuthProvePayload(publicKey, signature, range(0, 0x102));
    expect(payload).toHaveLength(98 + 0x102);
    expect(Array.from(payload.slice(96, 98))).toEqual([0x02, 0x01]);
  });

  it("rejects malformed inputs", () => {
    expect(() => publicKeyFromSeed(range(0, 31))).toThrow("Seed");
    expect(() => authMessage(range(0, 15), DEVICE_ID, fromHex(PUBLIC_KEY))).toThrow("Nonce");
    expect(() => claimVerification("key", range(0, 31))).toThrow("Admin public key");
  });
});
