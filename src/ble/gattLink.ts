/**
 * The GATT operations a Can Opener SE transport needs from a BLE stack, on a
 * link that is already connected with services discovered. Characteristics are
 * on `CAN_OPENER_SERVICE_UUID`. See `bleplxGattLink` for React Native.
 */
export interface CanOpenerGattLink {
  /** Write with response. Resolves once the adapter acknowledged the write. */
  write(characteristicUuid: string, value: Uint8Array): Promise<void>;
  /**
   * Enables notifications. `onError` reports a failed subscription or a
   * dropped link. Returns a function that stops delivery.
   */
  subscribe(
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
    onError: (error: Error) => void,
  ): () => void;
  /** Drops the BLE connection. */
  disconnect(): Promise<void>;
}

export type WarningHandler = (message: string, detail: unknown) => void;
