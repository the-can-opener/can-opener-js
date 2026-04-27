import { describe, expect, it, vi } from "vitest";
import { buildPidRequest } from "../src/dbc/UdsBuilder.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/MockTransport.js";
import { obd2PidDbc, vehicleDbc } from "./fixtures.js";

describe("VirtualVehicle.pid", () => {
  it("sends a PID request, decodes the response, and updates state", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });
    const signal = car.dbc.resolve("VEHICLE_SPEED");

    transport.scriptPidResponse(buildPidRequest(signal), Uint8Array.of(0x41, 0x0d, 88));

    await expect(car.pid<number>("VEHICLE_SPEED")).resolves.toBe(88);
    expect(car.state.get<number>("VEHICLE_SPEED")).toBe(88);
    expect(transport.pidRequests).toHaveLength(1);
  });

  it("passes diagnostic transport metadata to PID transports", async () => {
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

    await expect(car.pid<string>("VIN")).resolves.toBe("1HGCM82633A004352");
    expect(car.state.get<string>("VIN")).toBe("1HGCM82633A004352");
    expect(transport.pidRequestContexts[0]).toMatchObject({
      signalName: "VIN",
      diagnostic: {
        transport: "isotp",
        responseLength: 18,
      },
    });
  });

  it("polls PID subscriptions and updates vehicle state", async () => {
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

      const unsubscribe = await car.subscribePid("VEHICLE_SPEED", {
        frequencyHz: 2,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(car.state.get<number>("VEHICLE_SPEED")).toBe(88);
      expect(transport.pidRequests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(500);

      expect(transport.pidRequests).toHaveLength(2);

      await unsubscribe();
      await vi.advanceTimersByTimeAsync(500);

      expect(transport.pidRequests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects frame signals for PID subscriptions", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await expect(car.subscribePid("ENGINE_RPM")).rejects.toThrow(
      "ENGINE_RPM is not a PID signal (actual protocol: frame)",
    );
  });
});
