import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  SecurityRole,
  boxPublicKeyFromSecret,
  buildGuestIdPayload,
  buildInviteCredential,
  buildListGuestsPayload,
  createInvite,
  decodeInviteToken,
  encodeInviteLabel,
  encodeInviteToken,
  isInviteIdUsed,
  openSealedInvite,
  parseAuthChallenge,
  parseAuthResult,
  parseClaimResult,
  parseGuestListPage,
  publicKeyFromSeed,
  sealInvite,
  signInvite,
  verifyInvite,
} from "../src/security/index.js";

const hex = bytesToHex;
const range = (start: number, length: number) =>
  Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

// Vectors published in docs/can-opener-se-security-protocol.md.
const ADMIN_SEED = range(0x00, 32);
const ADMIN_PUBLIC_KEY = publicKeyFromSeed(ADMIN_SEED);
const DEVICE_ID = range(0x80, 16);
const BOX_SECRET = range(0xa0, 32);
const INVITE_SEED = range(0x20, 32);
const EPHEMERAL_SECRET = range(0x60, 32);
const NONCE = range(0x40, 16);
const GUEST_PUBLIC_KEY = publicKeyFromSeed(range(0xc0, 32));

const BOX_PUBLIC_KEY = "605a725d2a4adfeeb1a29e17edd621c1b7593ee8cdbc44ac6c4ab6e2f805d23c";
const SIGNED_INVITE =
  "0101000000" +
  "29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7" +
  "04416c6578" +
  "711e6204a90681b0020f12d99c1c187702bc710279d14f29f8bf1d9db967cbf6" +
  "22125017941af74fb1eb006b29151eb1b0a023e5a0cde7f4cb71a049babf620c";
const SEALED_INVITE =
  "675dd574ed7789310b3d2e7681f3790b466c773b1521fecf36577958371ea52f" +
  "3b4d9bf03385f8cef361ffc2291aa49dbe41db135a3c726631d0f9a247980fe0" +
  "928bd88f640beda92ce11e80c96bf50c89fd121de51fb728127ecbf7b451754c" +
  "5dadecbab82404d3ce248a73ebc5506dfa4ed6cecc18d7073272ab981197e5e5" +
  "2b6524d17a927555afc675c444156ca5c412ff1dee8184e3361e";
const REDEEM_SIGNATURE =
  "eecf72cb928689d460c88a3ed700be40e31df24f7b4942e939dcb4dbb215cb39" +
  "2ef3646e5156552aece71a3345fa60c68fc7fc12997ed289df6a51e1ef2ce907";

function vectorInvite() {
  return createInvite({
    adminSeed: ADMIN_SEED,
    deviceId: DEVICE_ID,
    boxPublicKey: hexToBytes(BOX_PUBLIC_KEY),
    userId: 1,
    label: "Alex",
    inviteSeed: INVITE_SEED,
    ephemeralSecret: EPHEMERAL_SECRET,
  });
}

describe("invites", () => {
  it("matches the spec vector", () => {
    expect(hex(boxPublicKeyFromSecret(BOX_SECRET))).toBe(BOX_PUBLIC_KEY);
    const invite = vectorInvite();
    expect(invite.userId).toBe(1);
    expect(invite.label).toBe("Alex");
    expect(hex(invite.sealedInvite)).toBe(SEALED_INVITE);
    expect(hex(openSealedInvite(BOX_SECRET, DEVICE_ID, invite.sealedInvite)!)).toBe(
      SIGNED_INVITE,
    );
    expect(
      hex(
        buildInviteCredential(
          INVITE_SEED,
          invite.sealedInvite,
          NONCE,
          DEVICE_ID,
          GUEST_PUBLIC_KEY,
        ),
      ),
    ).toBe(`01${REDEEM_SIGNATURE}${SEALED_INVITE}`);
  });

  it("verifies only the Admin's signature for this adapter", () => {
    const signed = hexToBytes(SIGNED_INVITE);
    expect(verifyInvite(ADMIN_PUBLIC_KEY, DEVICE_ID, signed)).toEqual({
      userId: 1,
      invitePublicKey: publicKeyFromSeed(INVITE_SEED),
      label: "Alex",
    });
    expect(verifyInvite(GUEST_PUBLIC_KEY, DEVICE_ID, signed)).toBeNull();
    expect(verifyInvite(ADMIN_PUBLIC_KEY, range(0x81, 16), signed)).toBeNull();
    const tampered = signed.slice();
    tampered[1] = 2;
    expect(verifyInvite(ADMIN_PUBLIC_KEY, DEVICE_ID, tampered)).toBeNull();
    expect(verifyInvite(ADMIN_PUBLIC_KEY, DEVICE_ID, signed.slice(0, -1))).toBeNull();
  });

  it("only opens on the adapter it was sealed to", () => {
    const sealed = hexToBytes(SEALED_INVITE);
    expect(openSealedInvite(range(0xa1, 32), DEVICE_ID, sealed)).toBeNull();
    expect(openSealedInvite(BOX_SECRET, range(0x81, 16), sealed)).toBeNull();
    const tampered = sealed.slice();
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(openSealedInvite(BOX_SECRET, DEVICE_ID, tampered)).toBeNull();
    expect(openSealedInvite(BOX_SECRET, DEVICE_ID, sealed.slice(0, 48))).toBeNull();
  });

  it("seals with a fresh ephemeral key each time", () => {
    const boxPublicKey = hexToBytes(BOX_PUBLIC_KEY);
    const signed = hexToBytes(SIGNED_INVITE);
    const a = sealInvite(boxPublicKey, DEVICE_ID, signed);
    const b = sealInvite(boxPublicKey, DEVICE_ID, signed);
    expect(hex(a)).not.toBe(hex(b));
    expect(hex(openSealedInvite(BOX_SECRET, DEVICE_ID, b)!)).toBe(SIGNED_INVITE);
  });

  it("truncates labels to 16 bytes without splitting a character", () => {
    expect(encodeInviteLabel("  Alex  ")).toEqual(new TextEncoder().encode("Alex"));
    expect(encodeInviteLabel("abcdefghijklmnopqrst")).toHaveLength(16);
    // "é" is 2 bytes, so 8 of them fill the 16 bytes.
    expect(new TextDecoder().decode(encodeInviteLabel("ééééééééé"))).toBe("éééééééé");
    expect(new TextDecoder().decode(encodeInviteLabel("abcdefghijklmno🚗"))).toBe(
      "abcdefghijklmno",
    );
  });

  it("rejects user ID 0, which is the Admin", () => {
    expect(() =>
      signInvite(ADMIN_SEED, DEVICE_ID, {
        userId: 0,
        invitePublicKey: GUEST_PUBLIC_KEY,
        label: "",
      }),
    ).toThrow("user ID");
  });
});

describe("invite tokens", () => {
  it("round-trips through base64url", () => {
    const invite = vectorInvite();
    const token = encodeInviteToken({
      deviceId: DEVICE_ID,
      inviteSeed: invite.inviteSeed,
      sealedInvite: invite.sealedInvite,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeInviteToken(` ${token}\n`);
    expect(decoded.deviceId).toEqual(DEVICE_ID);
    expect(decoded.inviteSeed).toEqual(INVITE_SEED);
    expect(decoded.sealedInvite).toEqual(invite.sealedInvite);
  });

  it("explains damaged tokens", () => {
    expect(() => decodeInviteToken("not a token!")).toThrow("damaged");
    expect(() => decodeInviteToken("Ag")).toThrow("newer version");
    expect(() => decodeInviteToken("AYCB")).toThrow("incomplete");
  });
});

describe("wire payloads", () => {
  it("parses CLAIM and AUTH_BEGIN responses with the box key", () => {
    const box = hexToBytes(BOX_PUBLIC_KEY);
    expect(parseClaimResult(Uint8Array.from([...DEVICE_ID, ...box]))).toEqual({
      deviceId: DEVICE_ID,
      boxPublicKey: box,
    });
    expect(parseAuthChallenge(Uint8Array.from([...NONCE, ...DEVICE_ID, ...box]))).toEqual({
      nonce: NONCE,
      deviceId: DEVICE_ID,
      boxPublicKey: box,
    });
    expect(() => parseClaimResult(DEVICE_ID)).toThrow("too short");
  });

  it("parses the role and user ID from AUTH_PROVE", () => {
    expect(parseAuthResult(Uint8Array.of(0x01, 0, 0, 0, 0))).toEqual({
      role: SecurityRole.admin,
      userId: 0,
    });
    expect(parseAuthResult(Uint8Array.of(0x02, 0x07, 0x01, 0, 0))).toEqual({
      role: SecurityRole.guest,
      userId: 0x107,
    });
    expect(() => parseAuthResult(Uint8Array.of(0x03, 0, 0, 0, 0))).toThrow("role");
  });

  it("parses a guest list page", () => {
    const label = new TextEncoder().encode("Alex");
    const header = [1, 0, 1, 0, 0x45, 0, 0, 0, 2, 0, 0, 0, 0x0a, 0, 0, 0, 0, 0, 0, 0x80];
    const page = parseGuestListPage(
      Uint8Array.of(...header, 1, 2, 0, 0, 0, 0x03, label.length, ...label),
    );
    expect(page).toEqual({
      total: 1,
      capacity: 1,
      nextInviteId: 0x45,
      usedInvites: { low: 2, bits: 0x8000_0000_0000_000an },
      guests: [{ userId: 2, label: "Alex", bonded: true, connected: true }],
    });
    expect(() => parseGuestListPage(Uint8Array.of(...header, 1, 2))).toThrow("too short");
  });

  it("tells which invite IDs the adapter has used", () => {
    const window = { low: 2, bits: 0x8000_0000_0000_000an };
    expect([1, 2, 3, 4, 5].map((id) => isInviteIdUsed(window, id))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(isInviteIdUsed(window, 2 + 63)).toBe(true);
    expect(isInviteIdUsed(window, 2 + 64)).toBe(false);
  });

  it("builds list and guest-ID requests", () => {
    expect(Array.from(buildListGuestsPayload(0x0102))).toEqual([0x02, 0x01]);
    expect(Array.from(buildGuestIdPayload(0x01020304))).toEqual([4, 3, 2, 1]);
    expect(() => buildGuestIdPayload(0)).toThrow("user ID");
  });
});
