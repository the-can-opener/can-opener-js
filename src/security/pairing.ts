import type { CanOpenerGattLink } from "../ble/gattLink.js";
import { SECURITY_CHAR_UUID } from "../ble/protocol.js";
import { delay } from "../delay.js";
import type { DeviceCredential } from "./credentials.js";
import { BleAccessError } from "./errors.js";
import { SecuritySession, type Authentication, type SecuritySessionOptions } from "./session.js";

const DEFAULT_PAIRING_WAIT_MS = 30_000;
const DEFAULT_PAIRING_RETRY_MS = 500;

/**
 * 0xA005 only accepts writes on an encrypted link. Some BLE stacks reject
 * writes until the user answers the OS pairing prompt instead of holding them,
 * so a policy retries those writes for a while. Error shapes are
 * platform-specific; see `bleplxSecurityWritePolicy`.
 */
export interface SecurityWritePolicy {
  /** The write failed because pairing has not finished yet, so a retry may succeed. */
  isPairingPending(error: unknown): boolean;
  /** Maps the error that ends the retries, e.g. onto `BleAccessError("stale_bond")`. */
  describeError?(error: unknown): unknown;
  /** How long to keep retrying while the user answers the prompt. Defaults to 30 s. */
  pairingWaitMs?: number;
  /** Defaults to 500 ms. */
  retryIntervalMs?: number;
}

export interface SecurityChannelOptions extends SecuritySessionOptions {
  writePolicy?: SecurityWritePolicy;
}

/** A `SecuritySession` bound to the 0xA005 characteristic of `link`. */
export interface SecurityChannel {
  readonly session: SecuritySession;
  /** Fails pending requests with `reason` and stops notifications. */
  close(reason?: Error): void;
}

/**
 * Persists credentials for `credentialAuthorizer`. Every stored key is a
 * candidate: after a factory reset and a restored backup key, a BLE identifier
 * may still be bound to the adapter's old device ID.
 */
export interface CredentialStore {
  list(): Promise<readonly DeviceCredential[]>;
  /** Called after authentication when the adapter reported something new, e.g. a redeemed invite. */
  save(authentication: Authentication): Promise<void>;
}

export function securityPacketWriter(
  link: CanOpenerGattLink,
  policy?: SecurityWritePolicy,
): (packet: Uint8Array) => Promise<void> {
  const write = (packet: Uint8Array) => link.write(SECURITY_CHAR_UUID, packet);
  if (policy === undefined) {
    return write;
  }

  return async (packet) => {
    const deadline = Date.now() + (policy.pairingWaitMs ?? DEFAULT_PAIRING_WAIT_MS);
    for (;;) {
      try {
        await write(packet);
        return;
      } catch (error: unknown) {
        if (!policy.isPairingPending(error) || Date.now() >= deadline) {
          throw policy.describeError?.(error) ?? error;
        }
      }
      await delay(policy.retryIntervalMs ?? DEFAULT_PAIRING_RETRY_MS);
    }
  };
}

export function openSecurityChannel(link: CanOpenerGattLink, options: SecurityChannelOptions = {}): SecurityChannel {
  const session = new SecuritySession(securityPacketWriter(link, options.writePolicy), options);
  let open = true;
  const unsubscribe = link.subscribe(
    SECURITY_CHAR_UUID,
    (value) => session.handleNotification(value),
    (error) => {
      if (open) {
        options.onWarning?.("Security notification error", error);
        session.close(error);
      }
    },
  );

  return {
    session,
    close(reason = new Error("Security session closed")) {
      if (!open) {
        return;
      }
      open = false;
      session.close(reason);
      unsubscribe();
    },
  };
}

/**
 * Runs `operation` against the security characteristic of a connected adapter
 * before any vehicle transport exists, e.g. to claim an adapter in pairing mode
 * with `session.claim(seed)`.
 */
export async function withSecuritySession<T>(
  link: CanOpenerGattLink,
  operation: (session: SecuritySession) => Promise<T>,
  options: SecurityChannelOptions & { subscribeSettleMs?: number } = {},
): Promise<T> {
  const channel = openSecurityChannel(link, options);
  try {
    if (options.subscribeSettleMs !== undefined && options.subscribeSettleMs > 0) {
      await delay(options.subscribeSettleMs);
    }
    return await operation(channel.session);
  } finally {
    channel.close();
  }
}

/**
 * Builds the `authorize` step for `CanOpenerBleTransport`: proves one of the
 * stored keys, saves what the adapter reported, then waits until the link is
 * paired so vehicle characteristics are usable. `afterAuthenticated` runs last,
 * e.g. to remember which credential belongs to this BLE identifier.
 */
export function credentialAuthorizer(
  store: CredentialStore,
  options: { afterAuthenticated?: (credential: DeviceCredential) => Promise<void> } = {},
): (session: SecuritySession) => Promise<void> {
  return async (session) => {
    const candidates = await store.list();
    if (candidates.length === 0) {
      throw new BleAccessError(
        "no_credential",
        "No access key for this adapter. Restore its backup key, or hold its button for 5 seconds to reset it.",
      );
    }

    const authentication = await session.authenticate(candidates);
    if (authentication.changed) {
      await store.save(authentication);
    }
    await session.waitForPairing();
    await options.afterAuthenticated?.(authentication.credential);
  };
}
