import { describe, expect, it, vi } from "vitest";
import { buildPidRequest } from "../src/dbc/UdsBuilder.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { obd2PidDbc, vehicleDbc } from "./fixtures.js";

describe("VirtualVehicle.query", () => {
  it("sends a query request, decodes the response, and updates state", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });
    const signal = car.dbc.resolve("VEHICLE_SPEED");

    transport.scriptPidResponse(buildPidRequest(signal), Uint8Array.of(0x41, 0x0d, 88));

    await expect(car.query<number>("VEHICLE_SPEED")).resolves.toBe(88);
    expect(car.state.get<number>("VEHICLE_SPEED")).toBe(88);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      signalName: "VEHICLE_SPEED",
      expectCanResponse: true,
    });
  });

  it("passes diagnostic transport metadata to query transports", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [obd2PidDbc],
    });
    const signal = car.dbc.resolve("VIN");
    const vin = new TextEncoder().encode("1HGCM82633A004352");

    transport.scriptPidResponse(buildPidRequest(signal), Uint8Array.of(0x49, 0x02, 0x01, ...vin));

    await expect(car.query<string>("VIN")).resolves.toBe("1HGCM82633A004352");
    expect(car.state.get<string>("VIN")).toBe("1HGCM82633A004352");
    expect(transport.requests[0]).toMatchObject({
      signalName: "VIN",
      diagnostic: {
        transport: "isotp",
        responseLength: 18,
      },
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
        dbcFiles: [vehicleDbc],
      });
      const signal = car.dbc.resolve("VEHICLE_SPEED");
      transport.scriptPidResponse(buildPidRequest(signal), Uint8Array.of(0x41, 0x0d, 88));

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
        dbcFiles: [vehicleDbc],
      });
      const signal = car.dbc.resolve("VEHICLE_SPEED");
      transport.scriptPidResponse(buildPidRequest(signal), Uint8Array.of(0x41, 0x0d, 88));

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
      dbcFiles: [vehicleDbc],
    });

    await expect(car.subscribeQuery("ENGINE_RPM")).rejects.toThrow(
      "ENGINE_RPM is not a query signal (actual protocol: frame)",
    );
  });
});
