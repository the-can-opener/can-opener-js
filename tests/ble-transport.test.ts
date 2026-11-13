import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanOpenerBleTransport,
  MONITOR_CONTROL_CHAR_UUID,
  MONITOR_DATA_CHAR_UUID,
  REQUEST_CHAR_UUID,
  SECURITY_CHAR_UUID,
  type CanOpenerBleTransportOptions,
  type CanOpenerGattLink,
} from "../src/ble/index.js";
import { BatchUnsupportedError, CanTransmitError, NoEcuResponseError } from "../src/errors.js";
import { credentialAuthorizer, hexToBytes } from "../src/security/index.js";
import type { MonitorSnapshot, VehicleRequest } from "../src/transport/types.js";
import { batchStep, notification } from "./blePackets.js";
import { admin, FakeSecurityAdapter, SEED } from "./fakeSecurityAdapter.js";

type WriteHandler = (characteristicUuid: string, value: Uint8Array) => void;

interface Listener {
  onValue: (value: Uint8Array) => void;
  onError: (error: Error) => void;
}

/** A GATT link whose notifications the test drives; `onWrite` scripts the adapter. */
class FakeGattLink implements CanOpenerGattLink {
  readonly events: string[] = [];
  readonly writes: { characteristicUuid: string; value: Uint8Array }[] = [];
  readonly disconnect = vi.fn(async () => undefined);
  onWrite: WriteHandler = () => undefined;
  private readonly listeners = new Map<string, Listener>();

  async write(characteristicUuid: string, value: Uint8Array): Promise<void> {
    this.events.push(`write ${characteristicUuid}`);
    this.writes.push({ characteristicUuid, value });
    this.onWrite(characteristicUuid, value);
  }

  subscribe(
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
    onError: (error: Error) => void,
  ): () => void {
    this.events.push(`subscribe ${characteristicUuid}`);
    this.listeners.set(characteristicUuid, { onValue, onError });
    return () => {
      this.listeners.delete(characteristicUuid);
    };
  }

  /** Delivers a notification after the current write resolves, as a radio would. */
  notifyLater(characteristicUuid: string, value: Uint8Array): void {
    queueMicrotask(() => this.notify(characteristicUuid, value));
  }

  notify(characteristicUuid: string, value: Uint8Array): void {
    this.listeners.get(characteristicUuid)?.onValue(value);
  }

  fail(characteristicUuid: string, error: Error): void {
    this.listeners.get(characteristicUuid)?.onError(error);
  }

  isSubscribed(characteristicUuid: string): boolean {
    return this.listeners.has(characteristicUuid);
  }

  requestWrites(): Uint8Array[] {
    return this.writes.filter((write) => write.characteristicUuid === REQUEST_CHAR_UUID).map((write) => write.value);
  }
}

const obdSpeed: VehicleRequest = {
  txFrame: { canId: 0x7df, dlc: 3, data: Uint8Array.of(0x02, 0x01, 0x0d) },
  expectCanResponse: true,
  responseIdStart: 0x7e8,
  responseIdEnd: 0x7ef,
};

async function connected(options: CanOpenerBleTransportOptions = {}) {
  const link = new FakeGattLink();
  const transport = new CanOpenerBleTransport(link, options);
  await transport.connect();
  return { link, transport };
}

/** Answers every request write with `reply(seq)` on the request characteristic. */
function answerRequests(link: FakeGattLink, reply: (seq: number) => Uint8Array[]): void {
  link.onWrite = (characteristicUuid, value) => {
    if (characteristicUuid === REQUEST_CHAR_UUID) {
      for (const packet of reply(value[0] ?? 0)) {
        link.notifyLater(REQUEST_CHAR_UUID, packet);
      }
    }
  };
}

/** Answers every monitor control write with a 5-byte ACK carrying `status`. */
function answerMonitorControl(link: FakeGattLink, status: (packet: Uint8Array) => number): void {
  link.onWrite = (characteristicUuid, value) => {
    if (characteristicUuid === MONITOR_CONTROL_CHAR_UUID) {
      link.notifyLater(MONITOR_CONTROL_CHAR_UUID, Uint8Array.of(0x80, value[1] ?? 0, status(value), 0x00, 0x00));
    }
  };
}

function monitorFrame(canId: number, bus: number, data: number[]): Uint8Array {
  const packet = new Uint8Array(16);
  packet.set([0x81, 0x01, canId & 0xff, (canId >> 8) & 0xff, 0, 0, data.length, ...data]);
  packet[15] = bus;
  return packet;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CanOpenerBleTransport connection", () => {
  it("enables vehicle notifications in order and refuses requests before connecting", async () => {
    const link = new FakeGattLink();
    const transport = new CanOpenerBleTransport(link);

    await expect(transport.sendRequest(obdSpeed)).rejects.toThrow(/not connected/u);
    await transport.connect();

    expect(link.events).toEqual([
      `subscribe ${REQUEST_CHAR_UUID}`,
      `subscribe ${MONITOR_CONTROL_CHAR_UUID}`,
      `subscribe ${MONITOR_DATA_CHAR_UUID}`,
    ]);
    expect(transport.accessRole).toBeNull();
    expect(transport.accessSession).toBeNull();
  });

  it("authorizes on the security characteristic before enabling vehicle notifications", async () => {
    const adapter = new FakeSecurityAdapter();
    await adapter.connect().claim(hexToBytes(SEED));
    const respond = adapter.openConnection();
    const link = new FakeGattLink();
    link.onWrite = (characteristicUuid, value) => {
      if (characteristicUuid === SECURITY_CHAR_UUID) {
        link.notifyLater(SECURITY_CHAR_UUID, respond(value));
      }
    };
    const transport = new CanOpenerBleTransport(link, {
      authorize: credentialAuthorizer({ list: async () => [admin], save: async () => undefined }),
    });

    await transport.connect();

    const firstVehicleEvent = link.events.indexOf(`subscribe ${REQUEST_CHAR_UUID}`);
    expect(link.events.slice(0, firstVehicleEvent)).toEqual([
      `subscribe ${SECURITY_CHAR_UUID}`,
      `write ${SECURITY_CHAR_UUID}`,
      `write ${SECURITY_CHAR_UUID}`,
      `write ${SECURITY_CHAR_UUID}`,
    ]);
    expect(transport.accessRole).toBe("admin");
    expect(transport.accessSession?.authorizedUserId).toBe(0);

    await transport.disconnect();
    expect(transport.accessRole).toBeNull();
    expect(link.isSubscribed(SECURITY_CHAR_UUID)).toBe(false);
  });

  it("drops the link when authorization fails", async () => {
    const link = new FakeGattLink();
    const denied = new Error("denied");
    const transport = new CanOpenerBleTransport(link, {
      authorize: async () => {
        throw denied;
      },
    });

    await expect(transport.connect()).rejects.toBe(denied);
    expect(link.disconnect).toHaveBeenCalledOnce();
    expect(link.isSubscribed(SECURITY_CHAR_UUID)).toBe(false);
    expect(link.events).not.toContain(`subscribe ${REQUEST_CHAR_UUID}`);
  });

  it("rejects pending requests on disconnect and only drops the link when asked", async () => {
    const { link, transport } = await connected();
    const pending = transport.sendRequest(obdSpeed);
    const assertion = expect(pending).rejects.toThrow(/BLE transport disconnected/u);
    await vi.waitFor(() => expect(link.requestWrites()).toHaveLength(1));

    await transport.disconnect({ cancelConnection: false });
    await assertion;
    expect(link.disconnect).not.toHaveBeenCalled();
    expect(link.isSubscribed(REQUEST_CHAR_UUID)).toBe(false);

    await transport.disconnect();
    expect(link.disconnect).toHaveBeenCalledOnce();
  });

  it("validates the sequence range", () => {
    expect(() => new CanOpenerBleTransport(new FakeGattLink(), { sequenceRange: { min: 0x80, max: 0x7f } })).toThrow(
      /Invalid sequence range/u,
    );
    expect(() => new CanOpenerBleTransport(new FakeGattLink(), { sequenceRange: { min: 0, max: 0x100 } })).toThrow(
      /Invalid sequence range/u,
    );
  });
});

describe("CanOpenerBleTransport requests", () => {
  it("matches replies by sequence byte and stays inside its sequence range", async () => {
    const { link, transport } = await connected({ sequenceRange: { min: 0x80, max: 0x81 } });
    answerRequests(link, (seq) => [notification(seq, 0x00, 0x00, 0x7e8, [0x41, 0x0d, seq])]);

    const payloads = [
      await transport.sendRequest(obdSpeed),
      await transport.sendRequest(obdSpeed),
      await transport.sendRequest(obdSpeed),
    ];

    expect(link.requestWrites().map((packet) => packet[0])).toEqual([0x80, 0x81, 0x80]);
    expect(payloads.map((payload) => Array.from(payload ?? []))).toEqual([
      [0x41, 0x0d, 0x80],
      [0x41, 0x0d, 0x81],
      [0x41, 0x0d, 0x80],
    ]);
  });

  it("reassembles fragmented responses and reports the responding CAN ID", async () => {
    const { link, transport } = await connected();
    answerRequests(link, (seq) => [
      notification(seq, 0x00, 0x02 | 0x04, 0x7e8, [0x00, 0x00, 0x62, 0xf1]),
      notification(0xff, 0x00, 0x00, 0x7e8, [0xee]),
      notification(seq, 0x00, 0x02, 0x7e8, [0x02, 0x00, 0x90, 0x57]),
    ]);

    const response = await transport.sendRequestWithResponseDetails(obdSpeed);

    expect(response?.responseCanId).toBe(0x7e8);
    expect(Array.from(response?.payload ?? [])).toEqual([0x62, 0xf1, 0x90, 0x57]);
  });

  it("maps adapter status codes onto transport errors", async () => {
    const { link, transport } = await connected();

    answerRequests(link, (seq) => [notification(seq, 0xe4, 0x00, 0, [])]);
    await expect(transport.sendRequest(obdSpeed)).rejects.toBeInstanceOf(NoEcuResponseError);

    answerRequests(link, (seq) => [notification(seq, 0xe3, 0x00, 0, [])]);
    await expect(transport.sendRequest(obdSpeed)).rejects.toBeInstanceOf(CanTransmitError);
  });

  it("times out a silent ECU slightly after the declared timeout", async () => {
    vi.useFakeTimers();
    const { transport } = await connected();

    const pending = transport.sendRequest({ ...obdSpeed, timeoutMs: 500 });
    const assertion = expect(pending).rejects.toBeInstanceOf(NoEcuResponseError);
    await vi.advanceTimersByTimeAsync(749);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("rejects pending requests when the request notification fails", async () => {
    const { link, transport } = await connected();
    const lost = new Error("notification stopped");

    const pending = transport.sendRequest(obdSpeed);
    const assertion = expect(pending).rejects.toBe(lost);
    await vi.waitFor(() => expect(link.requestWrites()).toHaveLength(1));
    link.fail(REQUEST_CHAR_UUID, lost);
    await assertion;
  });

  it("returns immediately for classic request-only frames", async () => {
    const { link, transport } = await connected();

    await expect(
      transport.sendRequest({ txFrame: { canId: 0x123, data: Uint8Array.of(1) }, expectCanResponse: false }),
    ).resolves.toBeUndefined();
    expect(link.requestWrites()).toHaveLength(1);
  });

  it("waits for the confirmation of a request-only CAN FD payload", async () => {
    const { link, transport } = await connected();
    answerRequests(link, (seq) => [notification(seq, 0x00, 0x00, 0, [])]);

    await expect(
      transport.sendRequest({
        txFrame: { canId: 0x7e0, dlc: 8, data: new Uint8Array(8) },
        canFd: { txDl: 64, payload: new Uint8Array(300) },
        expectCanResponse: false,
      }),
    ).resolves.toBeUndefined();
    expect(link.requestWrites().map((packet) => packet.length)).toEqual([244, 80]);
  });

  it("reports warnings for notifications it cannot parse", async () => {
    const onWarning = vi.fn();
    const { link } = await connected({ onWarning });

    link.notify(REQUEST_CHAR_UUID, Uint8Array.of(0x01));
    link.notify(MONITOR_DATA_CHAR_UUID, Uint8Array.of(0x80));

    expect(onWarning.mock.calls.map(([message]) => message)).toEqual([
      "Failed to parse CAN response",
      "Failed to parse monitor data",
    ]);
  });
});

describe("CanOpenerBleTransport batches", () => {
  it("sends a batch and maps the fragmented result list onto steps", async () => {
    const { link, transport } = await connected();
    answerRequests(link, (seq) => [
      notification(seq, 0x00, 0x02 | 0x04 | 0x08, 0, [0x00, 0x00, 0x02, 0x02, 0x00, 0x00, 0x00, 0x65, 0x07]),
      notification(seq, 0x00, 0x02 | 0x08, 0, [0x07, 0x00, 0x00, 0x00, 0x01, 0x00, 0x50, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0]),
    ]);

    const response = await transport.sendRequestBatch({
      steps: [batchStep(0x745, [0x02, 0x10, 0x81], { expectCanResponse: true }), batchStep(0x35d, [0xc1])],
    });

    expect(link.requestWrites()).toHaveLength(1);
    expect(link.requestWrites()[0]?.[1]).toBe(0x10);
    expect(response.steps).toEqual([
      { status: "ok", payload: Uint8Array.of(0x50), responseCanId: 0x765 },
      { status: "ok" },
    ]);
  });

  it("learns that firmware without batch support stays silent", async () => {
    vi.useFakeTimers();
    const { link, transport } = await connected();
    const steps = [batchStep(0x100, [1]), batchStep(0x101, [2])];

    const first = transport.sendRequestBatch({ steps });
    const assertion = expect(first).rejects.toBeInstanceOf(BatchUnsupportedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    await expect(transport.sendRequestBatch({ steps })).rejects.toBeInstanceOf(BatchUnsupportedError);
    expect(link.requestWrites()).toHaveLength(1);
  });

  it("skips the remaining chunks after a failed step unless told to continue", async () => {
    const { link, transport } = await connected();
    answerRequests(link, (seq) => [notification(seq, 0xe4, 0x00, 0, [])]);
    const fdStep = (byte: number) =>
      batchStep(0x7e0, [byte], { canFd: { txDl: 64, payload: Uint8Array.of(byte) }, expectCanResponse: true });

    const stopped = await transport.sendRequestBatch({ steps: [fdStep(1), fdStep(2)] });
    expect(stopped.steps).toEqual([{ status: "no_response" }, { status: "skipped" }]);

    const continued = await transport.sendRequestBatch({ steps: [fdStep(1), fdStep(2)], continueOnError: true });
    expect(continued.steps).toEqual([{ status: "no_response" }, { status: "no_response" }]);
    expect(link.requestWrites()).toHaveLength(3);
  });
});

describe("CanOpenerBleTransport monitoring", () => {
  it("keeps the latest frame per bus and CAN ID and clears one bus", async () => {
    const { link, transport } = await connected();
    answerMonitorControl(link, () => 0x00);
    const snapshots: MonitorSnapshot[] = [];
    transport.onMonitorSnapshot((snapshot) => snapshots.push(snapshot));

    link.notify(MONITOR_DATA_CHAR_UUID, monitorFrame(0x123, 0, [0x01]));
    link.notify(MONITOR_DATA_CHAR_UUID, monitorFrame(0x123, 1, [0x02]));
    link.notify(MONITOR_DATA_CHAR_UUID, monitorFrame(0x123, 0, [0x03]));
    await expect(transport.updateMonitor({ operation: "clear", bus: 1 })).resolves.toMatchObject({ status: "ok" });
    link.notify(MONITOR_DATA_CHAR_UUID, monitorFrame(0x456, 0, [0x04]));

    expect(snapshots.map((snapshot) => snapshot.sequence)).toEqual([0, 1, 2, 3]);
    expect(snapshots[2]?.frames).toEqual([
      { canId: 0x123, dlc: 1, data: Uint8Array.of(0x03), bus: 0 },
      { canId: 0x123, dlc: 1, data: Uint8Array.of(0x02), bus: 1 },
    ]);
    expect(snapshots[3]?.frames.map((frame) => [frame.bus, frame.canId])).toEqual([
      [0, 0x123],
      [0, 0x456],
    ]);
  });

  it("retries capture-all without a bus mask on firmware that rejects it", async () => {
    const { link, transport } = await connected();
    answerMonitorControl(link, (packet) => (packet.length === 4 ? 0x02 : 0x00));

    await expect(transport.setCaptureAll(true, 0x02)).resolves.toMatchObject({ status: "ok" });
    expect(link.writes.map((write) => Array.from(write.value))).toEqual([
      [0x04, 0x00, 0x01, 0x02],
      [0x04, 0x01, 0x01],
    ]);
  });

  it("reports the bus timing the adapter settled on", async () => {
    const { link, transport } = await connected();
    link.onWrite = (_characteristicUuid, value) => {
      link.notifyLater(
        MONITOR_CONTROL_CHAR_UUID,
        Uint8Array.of(0x80, value[1] ?? 0, 0x00, 0x00, 0x01, 0x48, 0xe8, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00),
      );
    };

    await expect(transport.configureBus({ bus: 1, bitrate: "auto" })).resolves.toEqual({
      status: "ok",
      bus: 1,
      bitrate: 125000,
      dataBitrate: 0,
    });
  });
});
