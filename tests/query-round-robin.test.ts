import { describe, expect, it, vi } from "vitest";

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
});
