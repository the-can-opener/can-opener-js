import type { WarningHandler } from "../transport/gattLink.js";
import { bytesToHex, hexToBytes, readU8 } from "./bytes.js";
import { roleFromCode, type AccessRole, type DeviceCredential, type GuestList } from "./credentials.js";
import { BleAccessError, SECURITY_STATUSES, SecurityStatusError, type SecurityStatus } from "./errors.js";
import { buildInviteCredential } from "./invite.js";
import { buildAuthProvePayload, buildClaimPayload, publicKeyFromSeed, signAuthChallenge, type ProvisioningKey } from "./primitives.js";
import {
  ADMIN_USER_ID,
  SecurityOpcode,
  buildGuestIdPayload,
  buildListGuestsPayload,
  parseAuthChallenge,
  parseAuthResult,
  parseClaimResult,
  parseGuestListPage,
  type GuestEntry,
  type SecurityOpcodeValue,
} from "./wire.js";

const SECURITY_RESPONSE_FLAG = 0x80;
const SECURITY_RESPONSE_HEADER_SIZE = 3;
const SECURITY_REQUEST_TIMEOUT_MS = 3000;
/**
 * A harmless unknown opcode. Writing it makes the OS finish link encryption,
 * which may mean showing the pairing prompt, without changing adapter state.
 */
const SECURITY_ENCRYPTION_PROBE = Uint8Array.of(0x7f, 0xff);

export interface SecurityResponse {
  opcode: number;
  seq: number;
  status: SecurityStatus;
  payload: Uint8Array;
}

export interface Authentication {
  role: AccessRole;
  /** The proven credential, updated with what the adapter reported. */
  credential: DeviceCredential;
  /** Whether `credential` differs from the stored one and should be saved. */
  changed: boolean;
}

export interface SecuritySessionOptions {
  /** How long to wait for a response once the adapter acknowledged the write. Defaults to 3 s. */
  timeoutMs?: number;
  /** Receives notifications that could not be parsed. */
  onWarning?: WarningHandler;
}

/** `opcode, seq, payload...` */
export function buildSecurityRequest(
  opcode: SecurityOpcodeValue,
  seq: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const packet = new Uint8Array(2 + payload.length);
  packet[0] = opcode;
  packet[1] = seq & 0xff;
  packet.set(payload, 2);
  return packet;
}

/** `opcode | 0x80, seq, status, payload...` */
export function parseSecurityResponse(data: Uint8Array): SecurityResponse {
  if (data.length < SECURITY_RESPONSE_HEADER_SIZE) {
    throw new Error(`Invalid security response length ${data.length}`);
  }
  const opcode = readU8(data, 0);
  if ((opcode & SECURITY_RESPONSE_FLAG) === 0) {
    throw new Error(`Invalid security response opcode 0x${opcode.toString(16)}`);
  }
  return {
    opcode: opcode & ~SECURITY_RESPONSE_FLAG,
    seq: readU8(data, 1),
    status: SECURITY_STATUSES[readU8(data, 2)] ?? "internal_error",
    payload: data.slice(SECURITY_RESPONSE_HEADER_SIZE),
  };
}

interface PendingSecurityRequest {
  opcode: number;
  resolve: (response: SecurityResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Request/response client for the 0xA005 security characteristic. The caller
 * wires `write` to a GATT write-with-response and feeds every 0xA005
 * notification to `handleNotification`.
 */
export class SecuritySession {
  private seq = 0;
  private readonly pending = new Map<number, PendingSecurityRequest>();
  private role: AccessRole | null = null;
  private userId: number | null = null;

  constructor(
    private readonly write: (packet: Uint8Array) => Promise<void>,
    private readonly options: SecuritySessionOptions = {},
  ) {}

  get authorizedRole(): AccessRole | null {
    return this.role;
  }

  get authorizedUserId(): number | null {
    return this.userId;
  }

  handleNotification(data: Uint8Array): void {
    let response: SecurityResponse;
    try {
      response = parseSecurityResponse(data);
    } catch (error: unknown) {
      this.options.onWarning?.("Failed to parse security response", error);
      return;
    }

    const pending = this.pending.get(response.seq);
    if (pending === undefined || pending.opcode !== response.opcode) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(response.seq);
    pending.resolve(response);
  }

  /** Fails every in-flight request, e.g. on disconnect. */
  close(error: Error): void {
    this.role = null;
    this.userId = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Registers the public key of `seed` as the adapter's Admin. The adapter
   * only accepts this in its pairing window, and also requires
   * `provisioningKey` when one was configured for it.
   */
  async claim(seed: Uint8Array, provisioningKey?: ProvisioningKey): Promise<DeviceCredential> {
    const response = await this.requestOk(
      SecurityOpcode.claim,
      buildClaimPayload(publicKeyFromSeed(seed), provisioningKey),
    );
    const { deviceId, boxPublicKey } = parseClaimResult(response.payload);
    this.role = "admin";
    this.userId = ADMIN_USER_ID;
    return {
      deviceId: bytesToHex(deviceId),
      role: "admin",
      seed: bytesToHex(seed),
      userId: ADMIN_USER_ID,
      boxPublicKey: bytesToHex(boxPublicKey),
    };
  }

  /**
   * Proves possession of a key on this connection. With several candidates,
   * the one for this adapter (matched on its device ID) is used. A pending
   * invite is redeemed on the way.
   */
  async authenticate(candidates: DeviceCredential | readonly DeviceCredential[]): Promise<Authentication> {
    const credentials: readonly DeviceCredential[] = isCredentialList(candidates) ? candidates : [candidates];
    const begin = await this.request(SecurityOpcode.authBegin);
    if (begin.status === "not_authorized") {
      throw new BleAccessError("not_claimed", "This adapter was reset. Set it up again from the vehicle menu.");
    }
    if (begin.status !== "ok") {
      throw new SecurityStatusError(begin.opcode, begin.status);
    }

    const challenge = parseAuthChallenge(begin.payload);
    const deviceId = bytesToHex(challenge.deviceId);
    const credential = credentials.find((candidate) => candidate.deviceId === deviceId);
    if (credential === undefined) {
      throw credentials.length === 1
        ? new BleAccessError(
            "wrong_adapter",
            "This adapter was reset or is a different adapter. Restore its backup key, or set it up again.",
          )
        : new BleAccessError(
            "no_credential",
            "No access key for this adapter. Restore its backup key, or hold its button for 5 seconds to reset it.",
          );
    }

    const { publicKey, signature } = signAuthChallenge(hexToBytes(credential.seed), challenge.nonce, challenge.deviceId);
    const redemption =
      credential.invite === undefined
        ? undefined
        : buildInviteCredential(
            hexToBytes(credential.invite.seed),
            hexToBytes(credential.invite.sealed),
            challenge.nonce,
            challenge.deviceId,
            publicKey,
          );
    const prove = await this.request(SecurityOpcode.authProve, buildAuthProvePayload(publicKey, signature, redemption));
    if (prove.status !== "ok") {
      throw proofRejection(prove.status, credential);
    }

    const result = parseAuthResult(prove.payload);
    const role = roleFromCode(result.role);
    const boxPublicKey = bytesToHex(challenge.boxPublicKey);
    const updated: DeviceCredential = { ...credential, role, userId: result.userId, boxPublicKey };
    delete updated.invite;
    this.role = role;
    this.userId = result.userId;
    return {
      role,
      credential: updated,
      changed:
        credential.invite !== undefined ||
        credential.role !== role ||
        credential.userId !== result.userId ||
        credential.boxPublicKey !== boxPublicKey,
    };
  }

  /**
   * Resolves once the link is encrypted. After a new phone proves its key the
   * adapter asks it to pair, and vehicle characteristics need the encrypted
   * link, so this waits for the user to accept the OS pairing prompt.
   * Returns at once on a phone that is already paired.
   */
  async waitForPairing(): Promise<void> {
    await this.write(SECURITY_ENCRYPTION_PROBE);
  }

  /** Admin only. Reads every page of the guest list. */
  async listGuests(): Promise<GuestList> {
    const guests: GuestEntry[] = [];
    for (;;) {
      const response = await this.requestOk(SecurityOpcode.listGuests, buildListGuestsPayload(guests.length));
      const page = parseGuestListPage(response.payload);
      guests.push(...page.guests);
      if (guests.length >= page.total || page.guests.length === 0) {
        return {
          capacity: page.capacity,
          nextInviteId: page.nextInviteId,
          usedInvites: page.usedInvites,
          guests,
        };
      }
    }
  }

  /** The Admin removes any guest; a guest may remove itself. */
  async removeGuest(userId: number): Promise<void> {
    await this.requestOk(SecurityOpcode.removeGuest, buildGuestIdPayload(userId));
    if (userId === this.userId) {
      this.role = null;
      this.userId = null;
    }
  }

  /** Admin only. Makes an unredeemed invite unusable. */
  async cancelInvite(userId: number): Promise<void> {
    await this.requestOk(SecurityOpcode.cancelInvite, buildGuestIdPayload(userId));
  }

  private async requestOk(opcode: SecurityOpcodeValue, payload?: Uint8Array): Promise<SecurityResponse> {
    const response = await this.request(opcode, payload);
    if (response.status !== "ok") {
      throw new SecurityStatusError(opcode, response.status);
    }
    return response;
  }

  private async request(opcode: SecurityOpcodeValue, payload?: Uint8Array): Promise<SecurityResponse> {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;

    const responsePromise = new Promise<SecurityResponse>((resolve, reject) => {
      this.pending.set(seq, { opcode, resolve, reject, timeoutId: undefined });
    });
    void responsePromise.catch(() => undefined);

    try {
      // The first encrypted write may wait on the OS pairing prompt, so the
      // response timeout only starts once the write has been acknowledged.
      await this.write(buildSecurityRequest(opcode, seq, payload));
    } catch (error: unknown) {
      this.pending.delete(seq);
      throw error;
    }

    const pending = this.pending.get(seq);
    if (pending !== undefined) {
      pending.timeoutId = setTimeout(() => {
        this.pending.delete(seq);
        pending.reject(new Error("The adapter did not answer the security request."));
      }, this.options.timeoutMs ?? SECURITY_REQUEST_TIMEOUT_MS);
    }
    return responsePromise;
  }
}

function isCredentialList(
  candidates: DeviceCredential | readonly DeviceCredential[],
): candidates is readonly DeviceCredential[] {
  return Array.isArray(candidates);
}

function proofRejection(status: SecurityStatus, credential: DeviceCredential): Error {
  switch (status) {
    case "unknown_key":
      return new BleAccessError(
        "revoked",
        credential.role === "admin"
          ? "This phone is no longer the adapter's Admin. Restore the current backup key, or reset the adapter and set it up again."
          : "Your access to this adapter was removed. Ask the Admin for a new invite.",
      );
    case "bad_proof":
      return new BleAccessError(
        "rejected",
        credential.invite !== undefined
          ? "This invite does not work with this adapter. It may have been reset; ask the Admin for a new invite."
          : "The adapter rejected this phone's key.",
      );
    case "invite_used":
      return new BleAccessError("invite_used", "This invite was already used or cancelled. Ask the Admin for a new one.");
    case "guest_list_full":
      return new BleAccessError(
        "guest_list_full",
        "The adapter has no room for another guest. Ask the Admin to remove a guest, then connect again.",
      );
    case "ok":
    case "bad_length":
    case "unknown_opcode":
    case "not_in_pairing_mode":
    case "already_claimed":
    case "not_authorized":
    case "internal_error":
    case "provisioning_required":
      return new SecurityStatusError(SecurityOpcode.authProve, status);
    default: {
      const exhaustive: never = status;
      return new Error(`Unexpected status ${String(exhaustive)}`);
    }
  }
}
