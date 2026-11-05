import { ed25519 } from "@noble/curves/ed25519";
import {
  boxPublicKeyFromSecret,
  bytesToHex,
  claimVerification,
  hexToBytes,
  openSealedInvite,
  redeemMessage,
  SecurityOpcode,
  SecuritySession,
  verifyAuthSignature,
  verifyInvite,
  type DeviceCredential,
} from "../src/security/index.js";

export const DEVICE_ID = "808182838485868788898a8b8c8d8e8f";
export const SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
export const BOX_SECRET = range(0xa0, 32);
export const BOX_PUBLIC_KEY = "605a725d2a4adfeeb1a29e17edd621c1b7593ee8cdbc44ac6c4ab6e2f805d23c";

export const admin: DeviceCredential = { deviceId: DEVICE_ID, role: "admin", seed: SEED };
export const claimedAdmin: DeviceCredential = { ...admin, userId: 0, boxPublicKey: BOX_PUBLIC_KEY };

export function range(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
}

interface FakeGuest {
  userId: number;
  label: string;
}

interface FakeConnection {
  nonce: Uint8Array | null;
  authorizedKey: string | null;
}

/** Minimal adapter model following the firmware's main/security.c. */
export class FakeSecurityAdapter {
  claimed = false;
  pairingMode = true;
  adminPublicKey: Uint8Array | null = null;
  readonly deviceId = hexToBytes(DEVICE_ID);
  readonly boxPublicKey = boxPublicKeyFromSecret(BOX_SECRET);
  readonly guests = new Map<string, FakeGuest>();
  readonly usedIds = new Set<number>();
  capacity = 1;
  pageSize = 8;
  lastConnection: FakeConnection | null = null;

  constructor(private readonly provisioningKey: string | null = null) {}

  /** A new phone connection; returns the adapter's 0xA005 reply to each request. */
  openConnection(): (packet: Uint8Array) => Uint8Array {
    const connection: FakeConnection = { nonce: null, authorizedKey: null };
    this.lastConnection = connection;
    return (packet) => this.handle(connection, packet);
  }

  /** A `SecuritySession` on a new connection. */
  connect(): SecuritySession {
    const respond = this.openConnection();
    const session: SecuritySession = new SecuritySession(
      async (packet) => {
        queueMicrotask(() => session.handleNotification(respond(packet)));
      },
      { timeoutMs: 50 },
    );
    return session;
  }

  private isAdmin(connection: FakeConnection): boolean {
    return (
      connection.authorizedKey !== null &&
      this.adminPublicKey !== null &&
      connection.authorizedKey === bytesToHex(this.adminPublicKey)
    );
  }

  private reply(opcode: number, seq: number, status: number, payload: Iterable<number> = []): Uint8Array {
    return Uint8Array.of(opcode | 0x80, seq, status, ...payload);
  }

  private handle(connection: FakeConnection, packet: Uint8Array): Uint8Array {
    const [opcode = 0, seq = 0] = packet;
    const body = packet.slice(2);
    switch (opcode) {
      case SecurityOpcode.claim: {
        if (this.claimed) return this.reply(opcode, seq, 4);
        if (!this.pairingMode) return this.reply(opcode, seq, 3);
        const publicKey = body.slice(0, 32);
        if (this.provisioningKey !== null) {
          if (body.length !== 64) return this.reply(opcode, seq, 0x0a);
          const expected = claimVerification(this.provisioningKey, publicKey);
          if (bytesToHex(expected) !== bytesToHex(body.slice(32))) {
            return this.reply(opcode, seq, 6);
          }
        }
        this.claimed = true;
        this.adminPublicKey = publicKey;
        connection.authorizedKey = bytesToHex(publicKey);
        return this.reply(opcode, seq, 0, [...this.deviceId, ...this.boxPublicKey]);
      }
      case SecurityOpcode.authBegin: {
        if (!this.claimed) return this.reply(opcode, seq, 5);
        connection.nonce = range(0x40, 16);
        return this.reply(opcode, seq, 0, [...connection.nonce, ...this.deviceId, ...this.boxPublicKey]);
      }
      case SecurityOpcode.authProve:
        return this.prove(connection, opcode, seq, body);
      case SecurityOpcode.listGuests: {
        if (!this.isAdmin(connection)) return this.reply(opcode, seq, 5);
        const start = u16(body, 0);
        const entries = [...this.guests.values()].slice(start, start + this.pageSize);
        let low = 1;
        while (this.usedIds.has(low)) low++;
        let bits = 0n;
        for (let i = 0; i < 64; i++) {
          if (this.usedIds.has(low + i)) bits |= 1n << BigInt(i);
        }
        const bitBytes = Array.from({ length: 8 }, (_, i) => Number((bits >> BigInt(i * 8)) & 0xffn));
        return this.reply(opcode, seq, 0, [
          this.guests.size,
          0,
          this.capacity,
          0,
          ...u32Bytes(Math.max(0, ...this.usedIds) + 1),
          ...u32Bytes(low),
          ...bitBytes,
          entries.length,
          ...entries.flatMap((guest) => {
            const label = new TextEncoder().encode(guest.label);
            return [...u32Bytes(guest.userId), 0x01, label.length, ...label];
          }),
        ]);
      }
      case SecurityOpcode.removeGuest: {
        const userId = u32(body, 0);
        const entry = [...this.guests.entries()].find(([, guest]) => guest.userId === userId);
        const isSelf = entry !== undefined && entry[0] === connection.authorizedKey;
        if (!this.isAdmin(connection) && !isSelf) return this.reply(opcode, seq, 5);
        if (entry !== undefined) this.guests.delete(entry[0]);
        if (isSelf) connection.authorizedKey = null;
        return this.reply(opcode, seq, 0);
      }
      case SecurityOpcode.cancelInvite: {
        if (!this.isAdmin(connection)) return this.reply(opcode, seq, 5);
        this.usedIds.add(u32(body, 0));
        return this.reply(opcode, seq, 0);
      }
      default:
        return this.reply(opcode, seq, 2);
    }
  }

  private prove(connection: FakeConnection, opcode: number, seq: number, body: Uint8Array): Uint8Array {
    const nonce = connection.nonce;
    connection.nonce = null;
    if (nonce === null || this.adminPublicKey === null) return this.reply(opcode, seq, 5);
    const credentialLength = u16(body, 96);
    if (body.length !== 98 + credentialLength) return this.reply(opcode, seq, 1);
    const publicKey = body.slice(0, 32);
    const key = bytesToHex(publicKey);
    const isAdmin = key === bytesToHex(this.adminPublicKey);
    const known = isAdmin || this.guests.has(key);
    if (!known && credentialLength === 0) return this.reply(opcode, seq, 8);
    if (!verifyAuthSignature(publicKey, body.slice(32, 96), nonce, this.deviceId)) {
      return this.reply(opcode, seq, 6);
    }
    if (!known) {
      const credential = body.slice(98);
      const opened = openSealedInvite(BOX_SECRET, this.deviceId, credential.slice(65));
      const signed =
        credential[0] === 0x01 && opened !== null ? verifyInvite(this.adminPublicKey, this.deviceId, opened) : null;
      if (
        signed === null ||
        !ed25519.verify(credential.slice(1, 65), redeemMessage(nonce, this.deviceId, publicKey), signed.invitePublicKey)
      ) {
        return this.reply(opcode, seq, 6);
      }
      if (this.usedIds.has(signed.userId)) return this.reply(opcode, seq, 0x0b);
      if (this.guests.size >= this.capacity) return this.reply(opcode, seq, 7);
      this.usedIds.add(signed.userId);
      this.guests.set(key, { userId: signed.userId, label: signed.label });
    }
    connection.authorizedKey = key;
    const userId = isAdmin ? 0 : (this.guests.get(key)?.userId ?? 0);
    return this.reply(opcode, seq, 0, [isAdmin ? 0x01 : 0x02, ...u32Bytes(userId)]);
  }
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function u32Bytes(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}
