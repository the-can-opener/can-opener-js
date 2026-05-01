import { describe, expect, it } from "vitest";
import { MockTransport } from "../src/transport/index.js";

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
