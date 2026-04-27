import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/MockTransport.js";
import { vehicleDbc } from "./fixtures.js";

describe("VirtualVehicleManager", () => {
  it("isolates state and DBC bindings across vehicles", async () => {
    const manager = new VirtualVehicleManager();
    const transportA = new MockTransport();
    const transportB = new MockTransport();
    const vehicleA = await manager.connect({
      id: "car-a",
      transport: transportA,
      dbcFiles: [vehicleDbc],
    });
    const vehicleB = await manager.connect({
      id: "car-b",
      transport: transportB,
      dbcFiles: [vehicleDbc],
    });

    await vehicleA.subscribe("ENGINE_RPM");
    await vehicleB.subscribe("ENGINE_RPM");

    transportA.emitFrame(vehicleA.dbc.encodeSignal("ENGINE_RPM", 1000));
    transportB.emitFrame(vehicleB.dbc.encodeSignal("ENGINE_RPM", 2000));

    expect(vehicleA.state.get<number>("ENGINE_RPM")).toBe(1000);
    expect(vehicleB.state.get<number>("ENGINE_RPM")).toBe(2000);
    expect(vehicleA.state.engine_rpm).toBe(1000);
    expect(vehicleB.state.engine_rpm).toBe(2000);
    expect(manager.list()).toHaveLength(2);
  });

  it("clears state and controller schedules when reloading DBC", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const vehicle = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await vehicle.subscribe("ENGINE_RPM");
    transport.emitFrame(vehicle.dbc.encodeSignal("ENGINE_RPM", 1000));

    vehicle.reloadDbc([vehicleDbc]);

    expect(vehicle.state.get<number>("ENGINE_RPM")).toBeUndefined();
    expect(vehicle.dbc.resolve("ENGINE_RPM").protocol).toBe("frame");
  });
});
