import { describe, expect, it, vi } from "vitest";
import type { CanFrame } from "../src/dbc/types.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
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
    response.data[0] = 0x41;
    response.data[1] = 0x0c;

    transport.scriptPidResponse(obdRequestFrame(0x01, 0x0c), response.data);

    await expect(car.query<number>("RPM")).resolves.toBe(3000);
    expect(car.state.get<number>("RPM")).toBe(3000);
    expect(transport.requests[0]).toMatchObject({
      signalName: "RPM",
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
      timeoutMs: 500,
    });
    expect(transport.requests[0]?.txFrame.dlc).toBe(8);
    expect(Array.from(transport.requests[0]?.txFrame.data ?? [])).toEqual([0x02, 0x01, 0x0c, 0, 0, 0, 0, 0]);
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
    response.data[0] = 0x41;
    response.data[1] = 0x14;

    transport.scriptPidResponse(obdRequestFrame(0x01, 0x14), response.data);

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

    transport.scriptPidResponse(obdRequestFrame(0x09, 0x02), Uint8Array.of(0x49, 0x02, 0x01, ...vin));

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

  it("sends VIN queries through an extended 29-bit PID endpoint", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [extendedVinProfile],
    });
    const vin = new TextEncoder().encode("1HGCM82633A004352");
    const request = obdRequestFrame(0x09, 0x02, 0x18db33f1);
    request.extended = true;

    transport.scriptPidResponse(request, Uint8Array.of(0x49, 0x02, 0x01, ...vin));

    await expect(car.query<string>("VIN")).resolves.toBe("1HGCM82633A004352");
    expect(transport.requests[0]).toMatchObject({
      signalName: "VIN",
      expectCanResponse: true,
      responseIdStart: 0x18daf100,
      responseIdEnd: 0x18daf1ff,
      responseIdExtended: true,
      timeoutMs: 2000,
      txFrame: {
        canId: 0x18db33f1,
        extended: true,
      },
    });
  });

  it("keeps universal PID fuel queries when a cloud profile is also loaded", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [cloudFuelProfile, universalPidProfile],
    });
    const response = car.dbc.encodeSignal("FUEL_LEVEL", 50);
    response.data[0] = 0x41;
    response.data[1] = 0x2f;

    transport.scriptPidResponse(obdRequestFrame(0x01, 0x2f), response.data);

    await expect(car.query<number>("FUEL_LEVEL")).resolves.toBeCloseTo(50, 0);
    expect(transport.requests[0]).toMatchObject({
      signalName: "FUEL_LEVEL",
      txFrame: {
        canId: 0x7df,
      },
    });
    expect(Array.from(transport.requests[0]?.txFrame.data ?? [])).toEqual([
      0x02,
      0x01,
      0x2f,
      0,
      0,
      0,
      0,
      0,
    ]);
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

const cloudFuelProfile: VehicleProfileSource = {
  name: "cloud/profile.yaml",
  content: `version: 1

endpoints:
  cloud:
    request_id: 0x700
    response_id: 0x708

queries:
  FUEL_LEVEL:
    endpoint: cloud
    send: [0x22, 0x12, 0x34]
    expect: [0x62, 0x12, 0x34]
    decoder: bytes
`,
  dbcFiles: [],
};

const extendedVinProfile: VehicleProfileSource = {
  name: "extended/vin/profile.yaml",
  content: `version: 1

endpoints:
  obd_29:
    request_id: 0x18DB33F1
    response_ids:
      - range: [0x18DAF100, 0x18DAF1FF]
    extended: true
    timeout_ms: 500

queries:
  VIN:
    endpoint: obd_29
    send: [0x02, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect: [0x49, 0x02, 0x01]
    timeout_ms: 2000
    decoder: ascii
    length: 17
`,
  dbcFiles: [],
};

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

function obdRequestFrame(service: number, pid: number, canId = 0x7df): CanFrame {
  const data = new Uint8Array(8);
  data[0] = 0x02;
  data[1] = service;
  data[2] = pid;
  return {
    canId,
    dlc: 8,
    data,
  };
}
