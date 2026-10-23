import type { SlcanBytePort } from "./SlcanTransport.js";

export interface WebSerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface WebSerial {
  requestPort(): Promise<WebSerialPort>;
}

export function webSerialAvailable(): boolean {
  return readWebSerial() !== undefined;
}

/** Must run inside a click handler. The browser shows its serial-port picker. */
export async function requestWebSerialPort(): Promise<WebSerialPort> {
  const serial = readWebSerial();
  if (serial === undefined) {
    throw new Error("Web Serial is not available in this browser. Use Chrome or Edge on a computer.");
  }
  return serial.requestPort();
}

/**
 * Opens a USB SLCAN adapter. `baudRate` is the USB serial speed; CANable
 * ignores it. The CAN bitrate is selected separately by `SlcanTransport`.
 */
export async function openWebSerialSlcanPort(
  port: WebSerialPort,
  baudRate = 115_200,
): Promise<SlcanBytePort> {
  await port.open({ baudRate });
  if (port.readable === null || port.writable === null) {
    throw new Error("Web Serial port did not expose a byte stream");
  }

  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let closed = false;

  return {
    async write(chunk: Uint8Array): Promise<void> {
      await writer.write(chunk);
    },
    async read(): Promise<Uint8Array | null> {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        return null;
      }
      return value;
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await writer.close().catch(() => undefined);
      await port.close().catch(() => undefined);
    },
  };
}

function readWebSerial(): WebSerial | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const serial = (navigator as Navigator & { serial?: WebSerial }).serial;
  return serial;
}
