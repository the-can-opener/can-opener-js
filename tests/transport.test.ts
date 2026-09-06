import { describe, expect, it } from "vitest";
import type { CanPayload } from "../src/dbc/types.js";
import { NoEcuResponseError } from "../src/errors.js";
import { MockTransport } from "../src/transport/index.js";
import type { VehicleBatchStep, VehicleRequest } from "../src/transport/types.js";

function step(canId: number, data: number[], extra: Partial<VehicleBatchStep> = {}): VehicleBatchStep {
  return {
    txFrame: { canId, dlc: data.length, data: Uint8Array.from(data) },
    expectCanResponse: false,
    ...extra,
  };
}

class FlakyTransport extends MockTransport {
  constructor(private readonly failures: Map<number, "timeout" | "error">) {
    super();
  }

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    const failure = this.failures.get(req.txFrame.canId);
    if (failure === "timeout") {
      this.requests.push(req);
      throw new NoEcuResponseError();
    }
    if (failure === "error") {
      this.requests.push(req);
      throw new Error("CAN TX failed");
    }
    return super.sendRequest(req);
  }
}

describe("MockTransport batches", () => {
  it("runs steps in order and reports per-step outcomes", async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.scriptPidResponse({ canId: 0x745, data: Uint8Array.of(0x10, 0x81) }, Uint8Array.of(0x50, 0x81));

    const response = await transport.sendRequestBatch({
      signalName: "HORN",
      steps: [
        step(0x745, [0x10, 0x81], { expectCanResponse: true, responseIdStart: 0x765, delayAfterMs: 20 }),
        step(0x745, [0x30, 0x30]),
      ],
    });

    expect(response.steps).toEqual([
      { status: "ok", payload: Uint8Array.of(0x50, 0x81), responseCanId: 0x765 },
      { status: "ok" },
    ]);
    expect(transport.batches).toHaveLength(1);
    expect(transport.batches[0]?.steps[0]?.delayAfterMs).toBe(20);
    expect(transport.requests.map((request) => request.txFrame.data[0])).toEqual([0x10, 0x30]);
  });

  it("stops after the first failing step and marks the rest skipped", async () => {
    const transport = new FlakyTransport(new Map([[0x200, "timeout"]]));
    await transport.connect();

    const response = await transport.sendRequestBatch({
      steps: [
        step(0x100, [0x01]),
        step(0x200, [0x02], { expectCanResponse: true }),
        step(0x300, [0x03]),
      ],
    });

    expect(response.steps.map((result) => result.status)).toEqual(["ok", "no_response", "skipped"]);
    expect(transport.requests).toHaveLength(2);
  });

  it("keeps going after failures when continueOnError is set", async () => {
    const transport = new FlakyTransport(new Map([[0x200, "error"]]));
    await transport.connect();

    const response = await transport.sendRequestBatch({
      continueOnError: true,
      steps: [step(0x100, [0x01]), step(0x200, [0x02]), step(0x300, [0x03])],
    });

    expect(response.steps.map((result) => result.status)).toEqual(["ok", "error", "ok"]);
    expect(response.steps[1]?.error).toMatch(/CAN TX failed/u);
    expect(transport.requests).toHaveLength(3);
  });

  it("rejects batches that mix buses or contain no steps", async () => {
    const transport = new MockTransport();
    await transport.connect();

    await expect(transport.sendRequestBatch({ steps: [] })).rejects.toThrow(/at least one step/u);
    await expect(
      transport.sendRequestBatch({
        bus: 0,
        steps: [step(0x100, [0x01]), { ...step(0x200, [0x02]), txFrame: { canId: 0x200, data: Uint8Array.of(0x02), bus: 1 } }],
      }),
    ).rejects.toThrow(/CAN1 does not match batch bus CAN0/u);
    expect(transport.batches).toHaveLength(0);
  });
});

describe("MockTransport firmware contract", () => {
  it("caps the monitor list at 16 CAN IDs", async () => {
    const transport = new MockTransport();
    await transport.connect();

    const full = await transport.updateMonitor({
      operation: "add",
      canIds: Array.from({ length: 16 }, (_, index) => index),
    });
    const overflow = await transport.updateMonitor({
      operation: "add",
      canIds: [16],
    });

    expect(full).toEqual({ status: "ok", currentMonitorCount: 16 });
    expect(overflow).toEqual({ status: "monitor_full", currentMonitorCount: 16 });
    expect(transport.monitorCanIds.size).toBe(16);
  });

  it("clears monitor IDs and buffered frame data together", async () => {
    const transport = new MockTransport();
    await transport.connect();
    await transport.updateMonitor({ operation: "add", canIds: [0x100] });

    const snapshots: number[] = [];
    transport.onMonitorSnapshot((snapshot) => {
      snapshots.push(snapshot.frames.length);
    });
    transport.emitFrame({ canId: 0x100, dlc: 1, data: Uint8Array.of(0xaa) });
    await transport.updateMonitor({ operation: "clear" });
    transport.emitFrame({ canId: 0x100, dlc: 1, data: Uint8Array.of(0xbb) });

    expect(snapshots).toEqual([1]);
    expect(transport.monitorCanIds.size).toBe(0);
  });

  it("emits full latest-frame snapshots for monitored IDs", async () => {
    const transport = new MockTransport();
    await transport.connect();
    await transport.updateMonitor({ operation: "add", canIds: [0x100, 0x101] });

    const snapshots: Array<number[]> = [];
    transport.onMonitorSnapshot((snapshot) => {
      snapshots.push(snapshot.frames.map((frame) => frame.canId));
    });

    transport.emitFrame({ canId: 0x100, dlc: 1, data: Uint8Array.of(0xaa) });
    transport.emitFrame({ canId: 0x101, dlc: 1, data: Uint8Array.of(0xbb) });
    transport.emitFrame({ canId: 0x100, dlc: 1, data: Uint8Array.of(0xcc) });

    expect(snapshots).toEqual([[0x100], [0x100, 0x101], [0x100, 0x101]]);
  });
});
