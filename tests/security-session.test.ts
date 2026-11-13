import { describe, expect, it, vi } from "vitest";
import { SECURITY_CHAR_UUID, type CanOpenerGattLink } from "../src/ble/index.js";
import {
  BleAccessError,
  buildSecurityRequest,
  bytesToHex,
  credentialAuthorizer,
  credentialMatchesAdvertisement,
  decodeBackupCode,
  decodeInviteLink,
  encodeBackupCode,
  guestCredentialFromInvite,
  hexToBytes,
  INVITE_LINK_PREFIX,
  issueInvite,
  nextInviteUserId,
  parseAdapterAdvertisement,
  parseSecurityResponse,
  pendingInvites,
  publicKeyFromSeed,
  securityPacketWriter,
  SecurityOpcode,
  SecuritySession,
  SecurityStatusError,
  withSecuritySession,
  type DeviceCredential,
  type GuestList,
} from "../src/security/index.js";
import {
  admin,
  BOX_PUBLIC_KEY,
  claimedAdmin,
  DEVICE_ID,
  FakeSecurityAdapter,
  range,
  SEED,
} from "./fakeSecurityAdapter.js";

describe("security packets", () => {
  it("builds requests as opcode, seq, payload", () => {
    expect(Array.from(buildSecurityRequest(SecurityOpcode.authProve, 0x1ff, Uint8Array.of(3)))).toEqual([
      0x03, 0xff, 0x03,
    ]);
  });

  it("parses the response header and strips the response flag", () => {
    expect(parseSecurityResponse(Uint8Array.of(0x83, 0x07, 0x08, 0xaa))).toEqual({
      opcode: 0x03,
      seq: 0x07,
      status: "unknown_key",
      payload: Uint8Array.of(0xaa),
    });
    expect(parseSecurityResponse(Uint8Array.of(0x81, 0, 0x0a)).status).toBe("provisioning_required");
    expect(parseSecurityResponse(Uint8Array.of(0x83, 0, 0x07)).status).toBe("guest_list_full");
    expect(parseSecurityResponse(Uint8Array.of(0x83, 0, 0x0b)).status).toBe("invite_used");
  });

  it("rejects requests echoed back without the response flag", () => {
    expect(() => parseSecurityResponse(Uint8Array.of(0x03, 0x00, 0x00))).toThrow();
  });
});

describe("advertising", () => {
  it("reads pairing flags and the device ID prefix", () => {
    expect(parseAdapterAdvertisement(Uint8Array.of(0xff, 0xff, 0x01, 0x02, ...range(0x80, 8)))).toEqual({
      pairingMode: false,
      claimed: true,
      deviceIdPrefix: "8081828384858687",
    });
    expect(parseAdapterAdvertisement(Uint8Array.of(0xff, 0xff, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0))).toEqual({
      pairingMode: true,
      claimed: false,
      deviceIdPrefix: null,
    });
  });

  it("ignores other manufacturers and formats", () => {
    expect(parseAdapterAdvertisement(null)).toBeNull();
    expect(parseAdapterAdvertisement(Uint8Array.of(0x4c, 0x00, 0x01, 0x02, ...range(0, 8)))).toBeNull();
    expect(parseAdapterAdvertisement(Uint8Array.of(0xff, 0xff, 0x02, 0x02, ...range(0, 8)))).toBeNull();
  });

  it("matches credentials by prefix", () => {
    expect(
      credentialMatchesAdvertisement(admin, { pairingMode: false, claimed: true, deviceIdPrefix: "8081828384858687" }),
    ).toBe(true);
    expect(credentialMatchesAdvertisement(admin, { pairingMode: true, claimed: false, deviceIdPrefix: null })).toBe(
      false,
    );
  });
});

describe("backup codes", () => {
  it("encodes a grouped Crockford base32 code", () => {
    const code = encodeBackupCode(admin);
    expect(code).toMatch(/^CO2(-[0-9A-HJKMNP-TV-Z]{5}){16}$/);
    expect(decodeBackupCode(code)).toEqual(admin);
  });

  it("carries the guest role and only the key", () => {
    const guest: DeviceCredential = {
      deviceId: DEVICE_ID,
      role: "guest",
      seed: "c0".repeat(32),
      userId: 3,
      boxPublicKey: BOX_PUBLIC_KEY,
    };
    expect(decodeBackupCode(encodeBackupCode(guest))).toEqual({ deviceId: DEVICE_ID, role: "guest", seed: guest.seed });
  });

  it("tolerates case, spacing and look-alike characters", () => {
    const body = encodeBackupCode(admin).slice("CO2-".length);
    const sloppy = ` co2 ${body.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l")}\n`;
    expect(decodeBackupCode(sloppy)).toEqual(admin);
  });

  it("rejects typos and truncation", () => {
    const code = encodeBackupCode(admin);
    const lastGroupStart = code.lastIndexOf("-") + 1;
    const flipped =
      code.slice(0, lastGroupStart) + (code[lastGroupStart] === "A" ? "B" : "A") + code.slice(lastGroupStart + 1);
    expect(() => decodeBackupCode(flipped)).toThrow("typo");
    expect(() => decodeBackupCode(code.slice(0, -6))).toThrow("incomplete");
    expect(() => decodeBackupCode(`${code.slice(0, -1)}U`)).toThrow("typo");
  });

  it("explains that shared-key backup codes no longer work", () => {
    expect(() =>
      decodeBackupCode(
        "CO1-G20R5-0W4GP-38F24-9HA5R-S3CEH-W8000-820C2-0A1G7-104GM-2RC1M-70Y40-H289H-858P2-WC1J6-GV3GE-HW7R6",
      ),
    ).toThrow("older adapter firmware");
    expect(() => decodeBackupCode("hello")).toThrow("not a Can Opener");
  });
});

const emptyList: GuestList = {
  capacity: 1,
  nextInviteId: 1,
  usedInvites: { low: 1, bits: 0n },
  guests: [],
};

function invite(credential: DeviceCredential, list: GuestList, label = "Alex") {
  return issueInvite({
    credential,
    list,
    label,
    inviteSeed: range(0x20, 32),
    ephemeralSecret: range(0x60, 32),
    now: 1000,
  });
}

describe("invites", () => {
  it("issues invites past every ID the adapter or this phone used", () => {
    const first = invite(claimedAdmin, emptyList);
    expect(first.invite).toMatchObject({ userId: 1, label: "Alex", issuedAt: 1000 });
    expect(first.invite.link.startsWith(INVITE_LINK_PREFIX)).toBe(true);
    expect(first.credential).toMatchObject({ lastInviteId: 1, issuedInvites: [first.invite] });

    expect(nextInviteUserId(first.credential, emptyList)).toBe(2);
    expect(nextInviteUserId(first.credential, { ...emptyList, nextInviteId: 7 })).toBe(7);
  });

  it("uses the app's own link prefix when given", () => {
    const issued = issueInvite({
      credential: claimedAdmin,
      list: emptyList,
      label: "Alex",
      inviteSeed: range(0x20, 32),
      ephemeralSecret: range(0x60, 32),
      linkPrefix: "https://example.com/invite?t=",
    });
    expect(issued.invite.link.startsWith("https://example.com/invite?t=")).toBe(true);
    expect(decodeInviteLink(issued.invite.link).deviceId).toBe(DEVICE_ID);
  });

  it("needs the Admin key and the adapter's box key", () => {
    expect(() => invite({ ...claimedAdmin, role: "guest" }, emptyList)).toThrow("Admin");
    expect(() => invite(admin, emptyList)).toThrow("Connect");
  });

  it("decodes a link or a bare token", () => {
    const { link } = invite(claimedAdmin, emptyList).invite;
    const decoded = decodeInviteLink(` ${link}\n`);
    expect(decoded.deviceId).toBe(DEVICE_ID);
    expect(decoded.invite.seed).toBe(bytesToHex(range(0x20, 32)));
    expect(decodeInviteLink(link.slice(INVITE_LINK_PREFIX.length))).toEqual(decoded);
    expect(() => decodeInviteLink("canopenerapp://invite?t=")).toThrow("not a Can Opener");
    expect(() => decodeInviteLink("hello!")).toThrow("damaged");
  });

  it("keeps only invites the adapter would still accept", () => {
    let credential = invite(claimedAdmin, emptyList).credential;
    credential = invite(credential, emptyList, "Sam").credential;
    expect(pendingInvites(credential, { usedInvites: { low: 1, bits: 0n } })).toHaveLength(2);
    expect(pendingInvites(credential, { usedInvites: { low: 1, bits: 0b10n } }).map((i) => i.label)).toEqual(["Alex"]);
    expect(pendingInvites(credential, { usedInvites: { low: 3, bits: 0n } })).toEqual([]);
  });
});

async function claimed(adapter = new FakeSecurityAdapter()) {
  const session = adapter.connect();
  const credential = await session.claim(hexToBytes(SEED));
  return { adapter, session, credential };
}

function guestFrom(link: string, seedStart: number): DeviceCredential {
  const decoded = decodeInviteLink(link);
  return guestCredentialFromInvite(decoded.deviceId, decoded.invite, range(seedStart, 32));
}

describe("SecuritySession", () => {
  it("claims with a public key and authenticates by signature", async () => {
    const { adapter, session, credential } = await claimed();
    expect(credential).toEqual(claimedAdmin);
    expect(bytesToHex(adapter.adminPublicKey ?? new Uint8Array())).toBe(
      bytesToHex(publicKeyFromSeed(hexToBytes(SEED))),
    );
    expect(session.authorizedRole).toBe("admin");
    expect(session.authorizedUserId).toBe(0);

    await expect(adapter.connect().authenticate(credential)).resolves.toEqual({
      role: "admin",
      credential,
      changed: false,
    });
  });

  it("learns the user ID and box key of a restored backup", async () => {
    const { adapter } = await claimed();
    await expect(adapter.connect().authenticate(admin)).resolves.toEqual({
      role: "admin",
      credential: claimedAdmin,
      changed: true,
    });
  });

  it("requires the provisioning key when the adapter has one", async () => {
    const session = new FakeSecurityAdapter("CANOPENER-TEST").connect();
    const missing = await session.claim(hexToBytes(SEED)).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(SecurityStatusError);
    expect((missing as SecurityStatusError).status).toBe("provisioning_required");

    const wrong = await session.claim(hexToBytes(SEED), "WRONG").catch((e: unknown) => e);
    expect((wrong as SecurityStatusError).status).toBe("bad_proof");

    await expect(session.claim(hexToBytes(SEED), "CANOPENER-TEST")).resolves.toEqual(claimedAdmin);
  });

  it("reports a second claim as already claimed", async () => {
    const { session } = await claimed();
    const error = await session.claim(range(0x20, 32)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecurityStatusError);
    expect((error as SecurityStatusError).status).toBe("already_claimed");
  });

  it("reports a key the adapter does not know", async () => {
    const adapter = new FakeSecurityAdapter();
    await adapter.connect().claim(range(0x20, 32));
    await expect(adapter.connect().authenticate(admin)).rejects.toMatchObject({
      reason: "revoked",
      message: expect.stringContaining("no longer the adapter's Admin"),
    });
  });

  it("refuses a credential for a different adapter before proving", async () => {
    const { adapter } = await claimed();
    const error = await adapter
      .connect()
      .authenticate({ ...admin, deviceId: "00".repeat(16) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BleAccessError);
    expect((error as BleAccessError).reason).toBe("wrong_adapter");
    expect(adapter.lastConnection?.nonce).not.toBeNull();
  });

  it("picks the matching key from several stored credentials", async () => {
    const { adapter, credential } = await claimed();
    const other = { ...credential, deviceId: "00".repeat(16) };

    await expect(adapter.connect().authenticate([other, credential])).resolves.toMatchObject({
      role: "admin",
      credential,
    });
    await expect(adapter.connect().authenticate([other, other])).rejects.toMatchObject({ reason: "no_credential" });
  });

  it("reports an unclaimed adapter", async () => {
    await expect(new FakeSecurityAdapter().connect().authenticate(admin)).rejects.toMatchObject({
      reason: "not_claimed",
    });
  });

  it("redeems an invite once and then authenticates with the guest key", async () => {
    const { adapter, credential } = await claimed();
    const { link } = invite(credential, emptyList).invite;
    const guest = guestFrom(link, 0xc0);

    const redeemed = await adapter.connect().authenticate(guest);
    expect(redeemed).toEqual({
      role: "guest",
      credential: { deviceId: DEVICE_ID, role: "guest", seed: guest.seed, userId: 1, boxPublicKey: BOX_PUBLIC_KEY },
      changed: true,
    });
    await expect(adapter.connect().authenticate(redeemed.credential)).resolves.toMatchObject({
      role: "guest",
      changed: false,
    });
    // A lost response: the adapter already knows the key, so the retry works.
    await expect(adapter.connect().authenticate(guest)).resolves.toMatchObject({ role: "guest" });

    await expect(adapter.connect().authenticate(guestFrom(link, 0xe0))).rejects.toMatchObject({
      reason: "invite_used",
    });
  });

  it("rejects an invite sealed for another adapter", async () => {
    const { adapter, credential } = await claimed();
    const forged = invite({ ...credential, boxPublicKey: "11".repeat(32) }, emptyList);
    await expect(adapter.connect().authenticate(guestFrom(forged.invite.link, 0xc0))).rejects.toMatchObject({
      reason: "rejected",
      message: expect.stringContaining("invite"),
    });
  });

  it("keeps an invite valid while the guest list is full", async () => {
    const { adapter, credential } = await claimed();
    const first = invite(credential, emptyList);
    const second = invite(first.credential, emptyList, "Sam");
    await adapter.connect().authenticate(guestFrom(first.invite.link, 0xc0));

    const sam = guestFrom(second.invite.link, 0xe0);
    await expect(adapter.connect().authenticate(sam)).rejects.toMatchObject({ reason: "guest_list_full" });

    const adminSession = adapter.connect();
    await adminSession.authenticate(credential);
    await adminSession.removeGuest(1);
    await expect(adapter.connect().authenticate(sam)).resolves.toMatchObject({ credential: { userId: 2 } });
  });

  it("lists every page of guests for the Admin", async () => {
    const { adapter, session, credential } = await claimed();
    adapter.capacity = 3;
    adapter.pageSize = 1;
    let issuer = credential;
    const links = new Map<string, string>();
    for (const label of ["Alex", "Sam", "Kim"]) {
      const issued = invite(issuer, emptyList, label);
      issuer = issued.credential;
      links.set(label, issued.invite.link);
    }
    await adapter.connect().authenticate(guestFrom(links.get("Alex") ?? "", 0xc0));
    await adapter.connect().authenticate(guestFrom(links.get("Kim") ?? "", 0xe0));

    const list = await session.listGuests();
    expect(list.guests.map((guest) => [guest.userId, guest.label])).toEqual([
      [1, "Alex"],
      [3, "Kim"],
    ]);
    expect(list).toMatchObject({ capacity: 3, nextInviteId: 4 });
    expect(pendingInvites(issuer, list).map((pending) => pending.label)).toEqual(["Sam"]);

    await session.cancelInvite(2);
    expect(pendingInvites(issuer, await session.listGuests())).toEqual([]);
  });

  it("lets a guest leave but not manage access", async () => {
    const { adapter, credential } = await claimed();
    const guestSession = adapter.connect();
    const { credential: guest } = await guestSession.authenticate(
      guestFrom(invite(credential, emptyList).invite.link, 0xc0),
    );

    await expect(guestSession.listGuests()).rejects.toMatchObject({ status: "not_authorized" });
    await guestSession.removeGuest(1);
    expect(guestSession.authorizedRole).toBeNull();

    await expect(adapter.connect().authenticate(guest)).rejects.toMatchObject({
      reason: "revoked",
      message: expect.stringContaining("new invite"),
    });
  });

  it("times out when the adapter stays silent", async () => {
    const session = new SecuritySession(async () => undefined, { timeoutMs: 10 });
    await expect(session.claim(hexToBytes(SEED))).rejects.toThrow("did not answer");
  });

  it("resolves a response that arrives before the write is acknowledged", async () => {
    const session: SecuritySession = new SecuritySession(
      async (packet) => {
        session.handleNotification(
          Uint8Array.of((packet[0] ?? 0) | 0x80, packet[1] ?? 0, 0, ...range(0x80, 16), ...hexToBytes(BOX_PUBLIC_KEY)),
        );
      },
      { timeoutMs: 10 },
    );
    await expect(session.claim(hexToBytes(SEED))).resolves.toEqual(claimedAdmin);
  });

  it("fails in-flight requests on close", async () => {
    const session = new SecuritySession(async () => undefined, { timeoutMs: 1000 });
    const pending = session.claim(hexToBytes(SEED));
    await Promise.resolve();
    session.close(new Error("BLE transport disconnected"));
    await expect(pending).rejects.toThrow("disconnected");
  });

  it("reports malformed notifications instead of throwing", () => {
    const onWarning = vi.fn();
    const session = new SecuritySession(async () => undefined, { onWarning });
    session.handleNotification(Uint8Array.of(0x01));
    expect(onWarning).toHaveBeenCalledWith("Failed to parse security response", expect.any(Error));
  });
});

/** A GATT link that only carries 0xA005 traffic to `adapter`. */
function securityLink(adapter: FakeSecurityAdapter, write = vi.fn<(packet: Uint8Array) => Promise<void>>()) {
  const respond = adapter.openConnection();
  let notify: ((value: Uint8Array) => void) | undefined;
  const link: CanOpenerGattLink = {
    async write(characteristicUuid, value) {
      expect(characteristicUuid).toBe(SECURITY_CHAR_UUID);
      await write(value);
      queueMicrotask(() => notify?.(respond(value)));
    },
    subscribe(_characteristicUuid, onValue) {
      notify = onValue;
      return () => {
        notify = undefined;
      };
    },
    disconnect: vi.fn(async () => undefined),
  };
  return { link, write, isSubscribed: () => notify !== undefined };
}

describe("pairing helpers", () => {
  it("claims an adapter through a short-lived security session", async () => {
    const adapter = new FakeSecurityAdapter();
    const { link, isSubscribed } = securityLink(adapter);

    const credential = await withSecuritySession(link, (session) => session.claim(hexToBytes(SEED)));
    expect(credential).toEqual(claimedAdmin);
    expect(isSubscribed()).toBe(false);
  });

  it("authorizes with stored keys, saves changes, waits for pairing, then reports the key", async () => {
    const adapter = new FakeSecurityAdapter();
    await adapter.connect().claim(hexToBytes(SEED));
    const { link, write } = securityLink(adapter);
    const save = vi.fn(async () => undefined);
    const afterAuthenticated = vi.fn(async () => undefined);
    const authorize = credentialAuthorizer({ list: async () => [admin], save }, { afterAuthenticated });

    await withSecuritySession(link, authorize);

    expect(save).toHaveBeenCalledWith({ role: "admin", credential: claimedAdmin, changed: true });
    expect(afterAuthenticated).toHaveBeenCalledWith(claimedAdmin);
    // AUTH_BEGIN, AUTH_PROVE, then the encryption probe that waits for pairing.
    expect(write.mock.calls.map(([packet]) => packet[0])).toEqual([0x02, 0x03, 0x7f]);
  });

  it("skips saving when nothing changed and refuses an empty store", async () => {
    const adapter = new FakeSecurityAdapter();
    await adapter.connect().claim(hexToBytes(SEED));
    const save = vi.fn(async () => undefined);

    await withSecuritySession(securityLink(adapter).link, credentialAuthorizer({ list: async () => [claimedAdmin], save }));
    expect(save).not.toHaveBeenCalled();

    const empty = withSecuritySession(
      securityLink(adapter).link,
      credentialAuthorizer({ list: async () => [], save }),
    );
    await expect(empty).rejects.toMatchObject({ reason: "no_credential" });
  });

  it("retries security writes while pairing is pending, then maps the final error", async () => {
    const pairingPending = new Error("insufficient encryption");
    const write = vi
      .fn<(characteristicUuid: string, value: Uint8Array) => Promise<void>>()
      .mockRejectedValueOnce(pairingPending)
      .mockResolvedValueOnce(undefined);
    const link: CanOpenerGattLink = { write, subscribe: () => () => undefined, disconnect: async () => undefined };
    const policy = {
      isPairingPending: (error: unknown) => error === pairingPending,
      describeError: () => new BleAccessError("stale_bond", "forget the device"),
      retryIntervalMs: 1,
    };

    await securityPacketWriter(link, policy)(Uint8Array.of(0x7f, 0xff));
    expect(write).toHaveBeenCalledTimes(2);

    write.mockRejectedValue(pairingPending);
    await expect(securityPacketWriter(link, { ...policy, pairingWaitMs: 5 })(Uint8Array.of(0x7f))).rejects.toMatchObject({
      reason: "stale_bond",
    });
  });
});
