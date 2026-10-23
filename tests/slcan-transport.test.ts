import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { NoEcuResponseError } from "../src/errors.js";
import { SlcanTransport, type SlcanBytePort } from "../src/transport/SlcanTransport.js";
import { encodeSlcanDataFrame, parseSlcanFrame } from "../src/transport/slcanProtocol.js";

class FakeSlcanPort implements SlcanBytePort {
  readonly written: string[] = [];
  onWrite: ((text: string) => void) | undefined;
  private readonly pending: Uint8Array[] = [];
  private readonly readers: Array<(chunk: Uint8Array | null) => void> = [];
  private closed = false;

  async write(chunk: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(chunk);
    this.written.push(text);
    this.onWrite?.(text);
  }

  async read(): Promise<Uint8Array | null> {
    const next = this.pending.shift();
    if (next !== undefined) {
      return next;
    }
    if (this.closed) {
      return null;
    }
    return new Promise((resolve) => {
      this.readers.push(resolve);
    });
  }

  pushRx(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const reader = this.readers.shift();
    if (reader !== undefined) {
      reader(bytes);
      return;
    }
    this.pending.push(bytes);
  }

  async close(): Promise<void> {
    this.closed = true;
    const readers = this.readers.splice(0);
    for (const reader of readers) {
      reader(null);
    }
  }
}

const speedProfile: VehicleProfileSource = {
  name: "speed",
  content: `
version: 1
endpoints:
  obd:
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]
    timeout_ms: 500
queries:
  SPEED:
    endpoint: obd
    send: [0x02, 0x01, 0x0D, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: OBD_Response_7E8
      signal: SPEED
  VIN:
    endpoint: obd
    send: [0x02, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect: [0x49, 0x02, 0x01]
    decoder: ascii
    length: 17
  RPM:
    endpoint: obd
    send: [0x02, 0x01, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect: [0x41, 0x0C]
    dbc_mapping:
      message: OBD_Response_7E8
      signal: RPM
`,
  dbcFiles: [
    {
      name: "signals.dbc",
      content: `
VERSION ""
NS_ :
BS_:
BU_: ECU
BO_ 2024 OBD_Response_7E8: 8 ECU
 SG_ SPEED : 16|8@1+ (1,0) [0|255] "km/h" Vector__XXX
 SG_ RPM : 23|16@0+ (0.25,0) [0|16383.75] "rpm" Vector__XXX
`,
    },
  ],
};

describe("SLCAN protocol", () => {
  it("encodes and parses a standard frame, ignoring a trailing timestamp", () => {
    const encoded = encodeSlcanDataFrame({
      canId: 0x7df,
      data: Uint8Array.of(0x02, 0x01, 0x0d, 0, 0, 0, 0, 0),
    });
    expect(encoded).toBe("t7DF802010D0000000000\r");

    const parsed = parseSlcanFrame("t7E8804410D5800000000ABCD");
    expect(parsed).toMatchObject({ canId: 0x7e8, dlc: 8, bus: 0 });
    expect(Array.from(parsed?.data ?? [])).toEqual([0x04, 0x41, 0x0d, 0x58, 0, 0, 0, 0]);
  });

  it("encodes extended frames", () => {
    const encoded = encodeSlcanDataFrame({
      canId: 0x18db33f1,
      extended: true,
      dlc: 3,
      data: Uint8Array.of(0x02, 0x01, 0x0c, 0, 0, 0, 0, 0),
    });
    expect(encoded).toBe("T18DB33F1302010C\r");
    expect(parseSlcanFrame("T18DAF1102410C\r")?.extended).toBe(true);
  });
});

describe("SlcanTransport", () => {
  it("opens the channel at 500 kbit/s and decodes a single-frame query", async () => {
    const port = new FakeSlcanPort();
    port.onWrite = (text) => {
      if (text.startsWith("t7DF")) {
        port.pushRx("t7E8403410D58\r");
      }
    };
    const transport = new SlcanTransport(port);
    const car = await new VirtualVehicleManager().connect({
      id: "car",
      transport,
      profiles: [speedProfile],
    });

    await expect(car.query<number>("SPEED")).resolves.toBe(88);
    expect(port.written.slice(0, 2)).toEqual(["S6\r", "O\r"]);
    expect(port.written.some((line) => line.startsWith("t7DF8"))).toBe(true);
    await car.disconnect();
  });

  it("decodes RPM from the bytes that follow the ISO-TP length", async () => {
    const port = new FakeSlcanPort();
    port.onWrite = (text) => {
      if (text.startsWith("t7DF")) {
        port.pushRx("t7E8504410C2EE0\r");
      }
    };
    const transport = new SlcanTransport(port);
    const car = await new VirtualVehicleManager().connect({
      id: "car",
      transport,
      profiles: [speedProfile],
    });

    await expect(car.query<number>("RPM")).resolves.toBe(3000);
    await car.disconnect();
  });

  it("reassembles a multi-frame VIN and sends flow control to the physical id", async () => {
    const port = new FakeSlcanPort();
    port.onWrite = (text) => {
      if (text.startsWith("t7DF")) {
        port.pushRx("t7E881014490201314847\r");
      } else if (text.startsWith("t7E0")) {
        port.pushRx("t7E8821434D3832363333\rt7E882241303034333532\r");
      }
    };
    const transport = new SlcanTransport(port);
    const car = await new VirtualVehicleManager().connect({
      id: "car",
      transport,
      profiles: [speedProfile],
    });

    await expect(car.query<string>("VIN")).resolves.toBe("1HGCM82633A004352");
    expect(port.written).toContain("t7E083000000000000000\r");
    await car.disconnect();
  });

  it("waits through a UDS response-pending frame", async () => {
    const port = new FakeSlcanPort();
    port.onWrite = (text) => {
      if (text.startsWith("t7DF")) {
        port.pushRx("t7E84037F0D78\rt7E8403410D58\r");
      }
    };
    const transport = new SlcanTransport(port);
    const car = await new VirtualVehicleManager().connect({
      id: "car",
      transport,
      profiles: [speedProfile],
    });

    await expect(car.query<number>("SPEED")).resolves.toBe(88);
    await car.disconnect();
  });

  it("times out when the ECU does not answer", async () => {
    const port = new FakeSlcanPort();
    const transport = new SlcanTransport(port);
    await transport.connect();

    await expect(transport.sendRequest({
      txFrame: { canId: 0x7df, data: Uint8Array.of(0x02, 0x01, 0x0d) },
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
      timeoutMs: 20,
    })).rejects.toBeInstanceOf(NoEcuResponseError);
    await transport.disconnect();
  });

  it("changes bitrate by closing the channel first", async () => {
    const port = new FakeSlcanPort();
    const transport = new SlcanTransport(port);
    await transport.connect();
    port.written.length = 0;

    await expect(transport.configureBus({ bus: 0, bitrate: 250_000 })).resolves.toMatchObject({
      status: "ok",
      bitrate: 250_000,
    });
    expect(port.written).toEqual(["C\r", "S5\r", "O\r"]);
    await expect(transport.configureBus({ bus: 1, bitrate: 500_000 })).resolves.toMatchObject({
      status: "invalid_bus",
    });
    await expect(transport.configureBus({ bus: 0, bitrate: "auto" })).resolves.toMatchObject({
      status: "auto_detect_failed",
    });
    await transport.disconnect();
  });

  it("forwards only monitored CAN ids", async () => {
    const port = new FakeSlcanPort();
    const transport = new SlcanTransport(port);
    await transport.connect();
    await transport.updateMonitor({ operation: "add", canIds: [0x123] });

    const seen = new Promise<number>((resolve) => {
      transport.onMonitorSnapshot((snapshot) => {
        const frame = snapshot.frames[0];
        if (frame !== undefined) {
          resolve(frame.canId);
        }
      });
    });
    port.pushRx("t456110\rt123110\r");

    await expect(seen).resolves.toBe(0x123);
    await expect(transport.updateMonitor({ operation: "add", canIds: [0x123] })).resolves.toMatchObject({
      status: "duplicate_id",
    });
    await transport.disconnect();
  });

  it("runs batch steps in order", async () => {
    const port = new FakeSlcanPort();
    port.onWrite = (text) => {
      if (text.startsWith("t200")) {
        port.pushRx("t210201AA\r");
      }
    };
    const transport = new SlcanTransport(port);
    await transport.connect();

    const response = await transport.sendRequestBatch({
      steps: [
        {
          txFrame: { canId: 0x100, data: Uint8Array.of(0x01) },
          expectCanResponse: false,
          delayAfterMs: 1,
        },
        {
          txFrame: { canId: 0x200, data: Uint8Array.of(0x02) },
          expectCanResponse: true,
          responseIdStart: 0x210,
          responseIdEnd: 0x210,
        },
      ],
    });

    expect(response.steps[0]?.status).toBe("ok");
    expect(response.steps[1]).toMatchObject({ status: "ok", responseCanId: 0x210 });
    expect(Array.from(response.steps[1]?.payload ?? [])).toEqual([0xaa]);
    await transport.disconnect();
  });
});
