import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleDbc } from "./fixtures.js";

describe("dual-CAN profile contract", () => {
  it("loads bus selectors for endpoints, monitor signals, and inline actions", () => {
    const [profile] = new ProfileLoader().load([dualCanProfile]);
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

    expect(profile.canBuses).toEqual([
      { bus: 0, bitrate: 500000 },
      { bus: 1, bitrate: "auto", dataBitrate: 2000000 },
    ]);
    expect(profile.endpoints.find((endpoint) => endpoint.name === "diagnostics")?.bus).toBe(1);
    expect(profile.signals.find((signal) => signal.name === "RPM_CAN1")?.bus).toBe(1);
    expect(profile.actions.find((action) => action.name === "INLINE_CAN1")?.steps[0]?.bus).toBe(1);
  });

  it("applies declared bus timing when the vehicle connects", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    await manager.connect({ id: "dual-timing", transport, profiles: [dualCanProfile] });
    expect(transport.busConfigUpdates).toEqual([
      { bus: 0, bitrate: 500000 },
      { bus: 1, bitrate: "auto", dataBitrate: 2000000 },
    ]);
  });

  it("rejects conflicting timing for the same logical bus", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const conflict: VehicleProfileSource = {
      name: "test/conflict/profile.yaml",
      content: `version: 1
can:
  buses:
    1:
      bitrate: 250000
`,
      dbcFiles: [],
    };
    await expect(manager.connect({ id: "dual-conflict", transport, profiles: [dualCanProfile, conflict] }))
      .rejects.toThrow("Conflicting CAN bus 1 timing");
    expect(transport.isConnected()).toBe(false);
  });

  it("routes endpoint-backed queries onto the declared CAN bus", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "dual-query",
      transport,
      profiles: [dualCanProfile],
    });

    transport.scriptPidResponse(
      {
        canId: 200,
        dlc: 2,
        data: Uint8Array.of(0x01, 0x0d, 0, 0, 0, 0, 0, 0),
        bus: 1,
      },
      Uint8Array.of(0x41, 0x0d, 88),
    );

    await expect(car.query<number>("VEHICLE_SPEED")).resolves.toBe(88);
    expect(transport.requests[0]?.txFrame.bus).toBe(1);
  });

  it("keeps the same CAN ID on different buses as independent subscriptions", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "dual-monitor",
      transport,
      profiles: [dualCanProfile],
    });

    await car.subscribe(["RPM_CAN0", "RPM_CAN1"]);

    expect(transport.monitorUpdates).toEqual([
      { operation: "add", canIds: [100], bus: 0 },
      { operation: "add", canIds: [100], bus: 1 },
    ]);

    const rpm900 = car.dbc.encodeSignal("ENGINE_RPM", 900);
    transport.emitFrame({ ...rpm900, bus: 0 });
    expect(car.state.get<number>("RPM_CAN0")).toBe(900);
    expect(car.state.get<number>("RPM_CAN1")).toBeUndefined();

    const rpm1200 = car.dbc.encodeSignal("ENGINE_RPM", 1200);
    transport.emitFrame({ ...rpm1200, bus: 1 });
    expect(car.state.get<number>("RPM_CAN0")).toBe(900);
    expect(car.state.get<number>("RPM_CAN1")).toBe(1200);

    await car.unsubscribe("RPM_CAN0");
    expect(transport.monitorUpdates.at(-1)).toEqual({
      operation: "remove",
      canIds: [100],
      bus: 0,
    });

    const rpm1500 = car.dbc.encodeSignal("ENGINE_RPM", 1500);
    transport.emitFrame({ ...rpm1500, bus: 0 });
    expect(car.state.get<number>("RPM_CAN0")).toBe(900);
    expect(car.state.get<number>("RPM_CAN1")).toBe(1200);
  });
});

const dualCanProfile: VehicleProfileSource = {
  name: "test/dual-can/profile.yaml",
  content: `version: 1

can:
  buses:
    0:
      bitrate: 500000
    1:
      bitrate: auto
      data_bitrate: 2000000

dbc:
  files:
    - path: signals.dbc

endpoints:
  diagnostics:
    bus: 1
    request_id: 200
    response_id: 201
    timeout_ms: 500

signals:
  RPM_CAN0:
    monitor:
      bus: 0
      message: POWERTRAIN
      signal: ENGINE_RPM

  RPM_CAN1:
    monitor:
      bus: 1
      message: POWERTRAIN
      signal: ENGINE_RPM

queries:
  VEHICLE_SPEED:
    endpoint: diagnostics
    send: [0x01, 0x0D]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: DIAGNOSTICS_RESPONSE
      signal: VEHICLE_SPEED

actions:
  INLINE_CAN1:
    send:
      bus: 1
      request_id: 0x35D
      request: [0xC1, 0x03]
`,
  dbcFiles: [testVehicleDbc],
};
