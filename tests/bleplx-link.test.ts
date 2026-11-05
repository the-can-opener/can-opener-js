import { describe, expect, it, vi } from "vitest";
import { CAN_OPENER_SERVICE_UUID, REQUEST_CHAR_UUID } from "../src/ble/index.js";
import {
  bleplxGattLink,
  bleplxSecurityWritePolicy,
  describeBleplxSecurityWriteError,
  isBleplxError,
  isBleplxKeyProofRequiredError,
  isBleplxPairingPendingError,
  type BleplxManager,
} from "../src/react-native-ble/index.js";
import { BleAccessError } from "../src/security/index.js";

type MonitorListener = Parameters<BleplxManager["monitorCharacteristicForDevice"]>[3];

/** Shaped like react-native-ble-plx's `BleError`. */
function bleError(fields: { errorCode?: number; attErrorCode?: number; iosErrorCode?: number; reason?: string }) {
  return Object.assign(new Error("Characteristic write failed"), {
    errorCode: 0,
    attErrorCode: null,
    iosErrorCode: null,
    reason: null,
    ...fields,
  });
}

function fakeManager() {
  const listeners: MonitorListener[] = [];
  const remove = vi.fn();
  const manager = {
    writeCharacteristicWithResponseForDevice: vi.fn(async () => null),
    monitorCharacteristicForDevice: vi.fn(
      (_deviceId: string, _serviceUuid: string, _characteristicUuid: string, listener: MonitorListener) => {
        listeners.push(listener);
        return { remove };
      },
    ),
    cancelDeviceConnection: vi.fn(async () => null),
  } satisfies BleplxManager;
  return { manager, listeners, remove };
}

describe("bleplxGattLink", () => {
  it("writes base64 values to the Can Opener service", async () => {
    const { manager } = fakeManager();
    const link = bleplxGattLink(manager, "device-1");

    await link.write(REQUEST_CHAR_UUID, Uint8Array.of(0x00, 0xff, 0x10, 0x80));
    await link.disconnect();

    expect(manager.writeCharacteristicWithResponseForDevice).toHaveBeenCalledWith(
      "device-1",
      CAN_OPENER_SERVICE_UUID,
      REQUEST_CHAR_UUID,
      "AP8QgA==",
    );
    expect(manager.cancelDeviceConnection).toHaveBeenCalledWith("device-1");
  });

  it("decodes notifications and ignores callbacks after unsubscribing", () => {
    const { manager, listeners, remove } = fakeManager();
    const onValue = vi.fn();
    const onError = vi.fn();

    const unsubscribe = bleplxGattLink(manager, "device-1").subscribe(REQUEST_CHAR_UUID, onValue, onError);
    const [listener] = listeners;
    listener?.(null, { value: "AP8QgA==" });
    listener?.(null, { value: null });
    const failure = new Error("link lost");
    listener?.(failure, null);
    unsubscribe();
    listener?.(new Error("Operation was cancelled"), null);

    expect(onValue.mock.calls).toEqual([[Uint8Array.of(0x00, 0xff, 0x10, 0x80)]]);
    expect(onError.mock.calls).toEqual([[failure]]);
    expect(remove).toHaveBeenCalledOnce();
  });
});

describe("ble-plx security write errors", () => {
  it("recognizes ble-plx errors by shape", () => {
    expect(isBleplxError(bleError({}))).toBe(true);
    expect(isBleplxError(new Error("boom"))).toBe(false);
    expect(isBleplxError({ errorCode: 2 })).toBe(false);
  });

  it("retries only while pairing may still be in progress", () => {
    expect(isBleplxPairingPendingError(bleError({ attErrorCode: 5 }))).toBe(true);
    expect(isBleplxPairingPendingError(bleError({ attErrorCode: 15 }))).toBe(true);
    expect(isBleplxPairingPendingError(bleError({ errorCode: 2 }))).toBe(true);
    expect(isBleplxPairingPendingError(bleError({ iosErrorCode: 5 }))).toBe(true);
    expect(isBleplxPairingPendingError(bleError({ iosErrorCode: 14 }))).toBe(false);
    expect(isBleplxPairingPendingError(new Error("boom"))).toBe(false);
  });

  it.each([{ attErrorCode: 5 }, { attErrorCode: 15 }, { iosErrorCode: 14 }, { iosErrorCode: 15 }])(
    "points at the stale bond for %o",
    (fields) => {
      const ios = describeBleplxSecurityWriteError(bleError(fields), "ios");
      expect(ios).toBeInstanceOf(BleAccessError);
      expect(ios).toMatchObject({ reason: "stale_bond" });
      expect((ios as Error).message).toContain("Forget This Device");

      const android = describeBleplxSecurityWriteError(bleError(fields), "android");
      expect((android as Error).message).toContain("Connected devices");
    },
  );

  it("leaves the Admin key-proof requirement to the caller", () => {
    const keyProof = bleError({ attErrorCode: 8 });
    expect(isBleplxKeyProofRequiredError(keyProof)).toBe(true);
    expect(isBleplxPairingPendingError(keyProof)).toBe(false);
    expect(describeBleplxSecurityWriteError(keyProof, "ios")).toBe(keyProof);
  });

  it("surfaces the native reason for other BLE failures and passes other errors through", () => {
    const described = describeBleplxSecurityWriteError(
      bleError({ iosErrorCode: 7, reason: "The peripheral disconnected." }),
      "ios",
    );
    expect((described as Error).message).toBe(
      "Could not send the access request to the adapter: The peripheral disconnected.",
    );

    const original = new Error("boom");
    expect(describeBleplxSecurityWriteError(original, "ios")).toBe(original);
  });

  it("builds a security write policy for the platform", () => {
    const policy = bleplxSecurityWritePolicy("android");
    expect(policy.isPairingPending(bleError({ attErrorCode: 15 }))).toBe(true);
    expect(policy.describeError?.(bleError({ attErrorCode: 15 }))).toMatchObject({ reason: "stale_bond" });
  });
});
