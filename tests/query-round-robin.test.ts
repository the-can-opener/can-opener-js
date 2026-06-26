import { describe, expect, it, vi } from "vitest";

import type { CanFrame } from "../src/dbc/types.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { universalPidProfile } from "./fixtures.js";

describe("QueryRoundRobinController", () => {
  it("reports measured Hz for active round-robin queries", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const vehicle = await manager.connect({
        id: "car-a",
        transport,
        profiles: [universalPidProfile],
      });

      vehicle.updateQueryRoundRobin(["FUEL_LEVEL", "RPM", "SPEED"]);

      expect(vehicle.queryRoundRobinStatus()).toEqual({
        hzByName: {
          FUEL_LEVEL: 0,
          RPM: 0,
          SPEED: 0,
        },
        names: ["FUEL_LEVEL", "RPM", "SPEED"],
        totalHz: 0,
        perQueryHz: 0,
      });

      vehicle.updateQueryRoundRobin(["FUEL_LEVEL"]);

      expect(vehicle.queryRoundRobinStatus()).toEqual({
        hzByName: {
          FUEL_LEVEL: 0,
        },
        names: ["FUEL_LEVEL"],
        totalHz: 0,
        perQueryHz: 0,
      });

      vehicle.updateQueryRoundRobin([]);

      expect(vehicle.queryRoundRobinStatus()).toEqual({
        hzByName: {},
        names: [],
        totalHz: 0,
        perQueryHz: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates query names", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const vehicle = await manager.connect({
        id: "car-a",
        transport,
        profiles: [universalPidProfile],
      });

      vehicle.updateQueryRoundRobin(["FUEL_LEVEL", "FUEL_LEVEL", "RPM"]);

      expect(vehicle.queryRoundRobinStatus()).toEqual({
        hzByName: {
          FUEL_LEVEL: 0,
          RPM: 0,
        },
        names: ["FUEL_LEVEL", "RPM"],
        totalHz: 0,
        perQueryHz: 0,
      });

      vehicle.updateQueryRoundRobin([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the loop when update is called while already running", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const vehicle = await manager.connect({
        id: "car-a",
        transport,
        profiles: [universalPidProfile],
      });

      transport.scriptPidResponse(
        obdRequestFrame(0x01, 0x0c),
        obdResponsePayload(vehicle.dbc.encodeSignal("RPM", 3000), 0x0c),
      );

      vehicle.updateQueryRoundRobin(["RPM"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(vehicle.state.get<number>("RPM")).toBe(3000);

      vehicle.updateQueryRoundRobin(["RPM"]);
      await vi.advanceTimersByTimeAsync(200);

      expect(vehicle.queryRoundRobinStatus().names).toEqual(["RPM"]);
      expect(vehicle.state.get<number>("RPM")).toBe(3000);

      vehicle.updateQueryRoundRobin([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls telemetry queries and decodes standard single-frame OBD responses", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const vehicle = await manager.connect({
        id: "car-a",
        transport,
        profiles: [universalPidProfile],
      });

      transport.scriptPidResponse(
        obdRequestFrame(0x01, 0x0c),
        obdResponsePayload(vehicle.dbc.encodeSignal("RPM", 3000), 0x0c),
      );
      transport.scriptPidResponse(
        obdRequestFrame(0x01, 0x05),
        obdResponsePayload(vehicle.dbc.encodeSignal("ECT", 90), 0x05),
      );

      vehicle.updateQueryRoundRobin(["RPM", "ECT"]);
      await vi.advanceTimersByTimeAsync(0);

      expect(vehicle.state.get<number>("RPM")).toBe(3000);

      await vi.advanceTimersByTimeAsync(2000);

      expect(vehicle.state.get<number>("ECT")).toBe(90);
      expect(vehicle.queryRoundRobinStatus().names).toEqual(["RPM", "ECT"]);

      vehicle.updateQueryRoundRobin([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries failed queries with short exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      const manager = new VirtualVehicleManager();
      const transport = new MockTransport();
      const vehicle = await manager.connect({
        id: "car-a",
        transport,
        profiles: [universalPidProfile],
      });

      transport.scriptPidResponse(
        obdRequestFrame(0x01, 0x0c),
        obdResponsePayload(vehicle.dbc.encodeSignal("RPM", 3000), 0x0c),
      );

      vehicle.updateQueryRoundRobin(["RPM"]);
      await vi.advanceTimersByTimeAsync(0);
      expect(vehicle.state.get<number>("RPM")).toBe(3000);

      transport.scriptPidResponse(
        obdRequestFrame(0x01, 0x0c),
        obdResponsePayload(vehicle.dbc.encodeSignal("RPM", 3100), 0x0c),
      );

      await vi.advanceTimersByTimeAsync(85);
      expect(vehicle.state.get<number>("RPM")).toBe(3100);

      transport.pidResponses.clear();
      await vi.advanceTimersByTimeAsync(85);
      expect(vehicle.state.get<number>("RPM")).toBe(3100);

      transport.scriptPidResponse(
        obdRequestFrame(0x01, 0x0c),
        obdResponsePayload(vehicle.dbc.encodeSignal("RPM", 3200), 0x0c),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(vehicle.state.get<number>("RPM")).toBe(3200);

      vehicle.updateQueryRoundRobin([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

function obdResponsePayload(frame: CanFrame, pid: number): Uint8Array {
  const payload = frame.data.slice();
  payload[0] = 0x41;
  payload[1] = pid;

  const response = new Uint8Array(8);
  response[0] = 0x03;
  response.set(payload.slice(0, 7), 1);
  return response;
}
