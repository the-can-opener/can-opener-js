import { CAN_OPENER_SERVICE_UUID } from "../transport/bleProtocol.js";
import type { CanOpenerGattLink } from "../transport/gattLink.js";
import { BleAccessError } from "../security/errors.js";
import type { SecurityWritePolicy } from "../security/pairing.js";

// Values of react-native-ble-plx's `BleErrorCode`, `BleATTErrorCode` and
// `BleIOSErrorCode` enums, mirrored so this module does not import the package.
const BLE_ERROR_OPERATION_CANCELLED = 2;
const ATT_INSUFFICIENT_AUTHENTICATION = 5;
const ATT_INSUFFICIENT_AUTHORIZATION = 8;
const ATT_INSUFFICIENT_ENCRYPTION = 15;
const IOS_OPERATION_CANCELLED = 5;
// CoreBluetooth codes that ble-plx passes through without naming them.
const IOS_PEER_REMOVED_PAIRING_INFORMATION = 14;
const IOS_ENCRYPTION_TIMED_OUT = 15;

const STALE_BOND_MESSAGE_IOS =
  "This iPhone's Bluetooth pairing with the adapter is out of date. Open Settings → Bluetooth, tap the i next to CanOpener SE, choose Forget This Device, then tap Retry.";
const STALE_BOND_MESSAGE_ANDROID =
  "This phone's Bluetooth pairing with the adapter is out of date. Open Settings → Connected devices, forget CanOpener SE, then tap Retry.";

/** The `BleManager` methods the link uses. A react-native-ble-plx `BleManager` satisfies it. */
export interface BleplxManager {
  writeCharacteristicWithResponseForDevice(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    base64Value: string,
  ): Promise<unknown>;
  monitorCharacteristicForDevice(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    listener: (error: Error | null, characteristic: { value: string | null } | null) => void,
  ): { remove(): void };
  cancelDeviceConnection(deviceId: string): Promise<unknown>;
}

/** The fields of a react-native-ble-plx `BleError` that classify a failure. */
export interface BleplxErrorLike extends Error {
  errorCode: number;
  attErrorCode?: number | null;
  iosErrorCode?: number | null;
  reason?: string | null;
}

/**
 * A `CanOpenerGattLink` over a device that react-native-ble-plx has already
 * connected, with services discovered (and, on Android, the MTU raised so
 * request and notify packets fit).
 */
export function bleplxGattLink(
  manager: BleplxManager,
  deviceId: string,
  serviceUuid: string = CAN_OPENER_SERVICE_UUID,
): CanOpenerGattLink {
  return {
    async write(characteristicUuid, value) {
      await manager.writeCharacteristicWithResponseForDevice(
        deviceId,
        serviceUuid,
        characteristicUuid,
        bytesToBase64(value),
      );
    },
    subscribe(characteristicUuid, onValue, onError) {
      let active = true;
      const subscription = manager.monitorCharacteristicForDevice(
        deviceId,
        serviceUuid,
        characteristicUuid,
        (error, characteristic) => {
          // ble-plx reports the cancellation caused by `remove()` as an error.
          if (!active) {
            return;
          }
          if (error !== null) {
            onError(error);
            return;
          }
          if (characteristic?.value != null) {
            onValue(base64ToBytes(characteristic.value));
          }
        },
      );
      return () => {
        active = false;
        subscription.remove();
      };
    },
    async disconnect() {
      await manager.cancelDeviceConnection(deviceId);
    },
  };
}

export function isBleplxError(error: unknown): error is BleplxErrorLike {
  return error instanceof Error && typeof (error as Partial<BleplxErrorLike>).errorCode === "number";
}

/**
 * The adapter asks for pairing as soon as the phone connects, but iOS does not
 * hold GATT writes until the user taps Pair, so 0xA005 rejects them as
 * unencrypted until pairing finishes.
 */
export function isBleplxPairingPendingError(error: unknown): boolean {
  return (
    isBleplxError(error) &&
    (error.attErrorCode === ATT_INSUFFICIENT_AUTHENTICATION ||
      error.attErrorCode === ATT_INSUFFICIENT_ENCRYPTION ||
      error.errorCode === BLE_ERROR_OPERATION_CANCELLED ||
      error.iosErrorCode === IOS_OPERATION_CANCELLED)
  );
}

/**
 * While the Admin has no bonded phone, a new phone must prove the Admin key
 * before the adapter lets it pair. Until then the adapter answers other 0xA005
 * writes with Insufficient Authorization, which does not start pairing.
 */
export function isBleplxKeyProofRequiredError(error: unknown): boolean {
  return isBleplxError(error) && error.attErrorCode === ATT_INSUFFICIENT_AUTHORIZATION;
}

/**
 * Explains a 0xA005 write that still fails after the pairing wait. An
 * encryption failure means the phone holds a bond the adapter has dropped,
 * which only the user can clear, so it becomes `BleAccessError("stale_bond")`.
 */
export function describeBleplxSecurityWriteError(error: unknown, platform: "ios" | "android"): unknown {
  if (!isBleplxError(error) || isBleplxKeyProofRequiredError(error)) {
    return error;
  }
  if (
    isBleplxPairingPendingError(error) ||
    error.iosErrorCode === IOS_PEER_REMOVED_PAIRING_INFORMATION ||
    error.iosErrorCode === IOS_ENCRYPTION_TIMED_OUT
  ) {
    return new BleAccessError(
      "stale_bond",
      platform === "android" ? STALE_BOND_MESSAGE_ANDROID : STALE_BOND_MESSAGE_IOS,
    );
  }
  if (error.reason != null && error.reason !== "") {
    return new Error(`Could not send the access request to the adapter: ${error.reason}`);
  }
  return error;
}

/** Retries 0xA005 writes while the pairing prompt is open, for `CanOpenerBleTransport` and `withSecuritySession`. */
export function bleplxSecurityWritePolicy(platform: "ios" | "android"): SecurityWritePolicy {
  return {
    isPairingPending: isBleplxPairingPendingError,
    describeError: (error) => describeBleplxSecurityWriteError(error, platform),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
