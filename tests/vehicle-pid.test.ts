import { describe, expect, it, vi } from "vitest";
import type { CanFrame } from "../src/dbc/types.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleProfile, universalPidProfile } from "./fixtures.js";

describe("VirtualVehicle.query", () => {
  it("loads profile-declared PID queries from YAML and decodes with DBC mappings", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [universalPidProfile],
    });
    const response = car.dbc.encodeSignal("RPM", 3000);
    response.data[1] = 0x41;
    response.data[2] = 0x0c;

    transport.scriptPidResponse(requestFrame(0x01, 0x0c), response.data);

    await expect(car.query<number>("RPM")).resolves.toBe(3000);
    expect(car.state.get<number>("RPM")).toBe(3000);
    expect(transport.requests[0]).toMatchObject({
      signalName: "RPM",
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
      timeoutMs: 500,
    });
    expect(Array.from(transport.requests[0]?.txFrame.data ?? [])).toEqual([0x01, 0x0c, 0, 0, 0, 0, 0, 0]);
  });

  it("supports profile query aliases that decode a different DBC signal", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [universalPidProfile],
    });
    const response = car.dbc.encodeSignal("O2_B1S1_VOLTAGE", 0.5);
    response.data[1] = 0x41;
    response.data[2] = 0x14;

    transport.scriptPidResponse(requestFrame(0x01, 0x14), response.data);

    await expect(car.query<number>("O2_DATA")).resolves.toBe(0.5);
    expect(car.state.get<number>("O2_DATA")).toBe(0.5);
  });

  it("does not execute undeclared DBC signals as profile queries", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [universalPidProfile],
    });

    await expect(car.query("O2_B1S1_VOLTAGE")).rejects.toThrow("Unknown vehicle signal: O2_B1S1_VOLTAGE");
  });

  it("sends a query request, decodes the response, and updates state", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [testVehicleProfile],
    });

    transport.scriptPidResponse(requestFrame(0x01, 0x0d, 200), Uint8Array.of(0x41, 0x0d, 88));

    await expect(car.query<number>("VEHICLE_SPEED")).resolves.toBe(88);
    expect(car.state.get<number>("VEHICLE_SPEED")).toBe(88);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      signalName: "VEHICLE_SPEED",
      expectCanResponse: true,
    });
  });

  it("loads VIN queries from the universal PID profile", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [universalPidProfile],
    });
    const vin = new TextEncoder().encode("1HGCM82633A004352");

    transport.scriptPidResponse(requestFrame(0x09, 0x02), Uint8Array.of(0x49, 0x02, 0x01, ...vin));

    await expect(car.query<string>("VIN")).resolves.toBe("1HGCM82633A004352");
    expect(car.state.get<string>("VIN")).toBe("1HGCM82633A004352");
    expect(transport.requests[0]).toMatchObject({
      signalName: "VIN",
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
      timeoutMs: 500,
    });
  });

  it("accepts query endpoint lists from generated profiles", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [{
        ...universalPidProfile,
        content: universalPidProfile.content.replace(
          "RPM: { endpoint: obd,",
          "RPM: { endpoints: [obd_29, obd_11],",
        ).replace(
          "  obd:\n    request_id: 0x7DF\n    response_ids:\n      - range: [0x7E8, 0x7EF]\n    timeout_ms: 500",
          "  obd_29:\n    request_id: 0x18DB33F1\n    response_ids:\n      - range: [0x18DAF100, 0x18DAF1FF]\n    timeout_ms: 500\n\n  obd_11:\n    request_id: 0x7DF\n    response_ids:\n      - range: [0x7E8, 0x7EF]\n    timeout_ms: 500",
        ),
      }],
    });
    const response = car.dbc.encodeSignal("RPM", 3000);
    response.data[1] = 0x41;
    response.data[2] = 0x0c;

    transport.scriptPidResponse(requestFrame(0x01, 0x0c, 0x18db33f1), response.data);

    await expect(car.query<number>("RPM")).resolves.toBe(3000);
    expect(transport.requests[0]).toMatchObject({
      responseIdStart: 0x18daf100,
      responseIdEnd: 0x18daf1ff,
    });
  });

  it("polls query subscriptions and updates vehicle state", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [testVehicleProfile],
      });
      transport.scriptPidResponse(requestFrame(0x01, 0x0d, 200), Uint8Array.of(0x41, 0x0d, 88));

      const subscription = await car.subscribeQuery("VEHICLE_SPEED", {
        frequencyHz: 2,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(car.state.get<number>("VEHICLE_SPEED")).toBe(88);
      expect(transport.requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(transport.requests).toHaveLength(2);

      car.unsubscribeQuery(subscription);
      await vi.advanceTimersByTimeAsync(500);

      expect(transport.requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stale query subscription handles", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [testVehicleProfile],
      });
      transport.scriptPidResponse(requestFrame(0x01, 0x0d, 200), Uint8Array.of(0x41, 0x0d, 88));

      const staleSubscription = await car.subscribeQuery("VEHICLE_SPEED", {
        frequencyHz: 2,
      });
      const activeSubscription = await car.subscribeQuery("VEHICLE_SPEED", {
        frequencyHz: 2,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(staleSubscription).not.toEqual(activeSubscription);

      car.unsubscribeQuery(staleSubscription);
      await vi.advanceTimersByTimeAsync(500);

      expect(transport.requests).toHaveLength(3);

      car.unsubscribeQuery(activeSubscription);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects frame signals for query subscriptions", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [testVehicleProfile],
    });

    await expect(car.subscribeQuery("ENGINE_RPM")).rejects.toThrow("Unknown vehicle signal: ENGINE_RPM");
  });
});

function requestFrame(service: number, pid: number, canId = 0x7df): CanFrame {
  const data = new Uint8Array(8);
  data[0] = service;
  data[1] = pid;
  return {
    canId,
    dlc: 2,
    data,
  };
}
