export type SecurityStatus =
  | "ok"
  | "bad_length"
  | "unknown_opcode"
  | "not_in_pairing_mode"
  | "already_claimed"
  | "not_authorized"
  | "bad_proof"
  | "guest_list_full"
  | "unknown_key"
  | "internal_error"
  | "provisioning_required"
  | "invite_used";

/** Indexed by the status byte of a 0xA005 response. */
export const SECURITY_STATUSES: readonly SecurityStatus[] = [
  "ok",
  "bad_length",
  "unknown_opcode",
  "not_in_pairing_mode",
  "already_claimed",
  "not_authorized",
  "bad_proof",
  "guest_list_full",
  "unknown_key",
  "internal_error",
  "provisioning_required",
  "invite_used",
];

/** The adapter answered a 0xA005 request with a non-`ok` status. */
export class SecurityStatusError extends Error {
  constructor(
    readonly opcode: number,
    readonly status: SecurityStatus,
    message?: string,
  ) {
    super(message ?? securityStatusMessage(status));
    this.name = "SecurityStatusError";
  }
}

export type BleAccessErrorReason =
  | "no_credential"
  | "revoked"
  | "wrong_adapter"
  | "not_claimed"
  | "rejected"
  | "invite_used"
  | "guest_list_full"
  /** The phone holds Bluetooth keys the adapter no longer has; the user must forget it in system settings. */
  | "stale_bond";

/**
 * The adapter is reachable but this phone cannot use it until the user acts.
 * Reconnecting on a timer will not help, so a UI should show the message instead.
 */
export class BleAccessError extends Error {
  constructor(
    readonly reason: BleAccessErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "BleAccessError";
  }
}

function securityStatusMessage(status: SecurityStatus): string {
  switch (status) {
    case "ok":
      return "OK";
    case "bad_length":
      return "The adapter rejected a malformed security request.";
    case "unknown_opcode":
      return "This adapter firmware does not support that security request. Update the adapter firmware.";
    case "not_in_pairing_mode":
      return "The adapter is not in pairing mode. Press its button and try again.";
    case "already_claimed":
      return "This adapter already has an Admin.";
    case "not_authorized":
      return "This phone is not allowed to do that. Only the adapter's Admin can manage access.";
    case "bad_proof":
      return "The adapter rejected this phone's key.";
    case "guest_list_full":
      return "The adapter has no room for another guest.";
    case "unknown_key":
      return "The adapter does not know this phone's key.";
    case "internal_error":
      return "The adapter could not save its security settings.";
    case "provisioning_required":
      return "This adapter needs its provisioning key to be set up.";
    case "invite_used":
      return "This invite was already used or cancelled.";
    default: {
      const exhaustive: never = status;
      return `Security error ${String(exhaustive)}`;
    }
  }
}
