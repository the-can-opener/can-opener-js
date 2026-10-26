import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";

describe("CAN bus timing reports", () => {
  it("reports the bitrate the adapter found for an auto bus", async () => {
    const transport = new MockTransport();
    transport.scriptBusConfigResponse({ status: "ok", bus: 0, bitrate: 250000, dataBitrate: 0 });

    const car = await new VirtualVehicleManager().connect({
      id: "auto",
      transport,
      profiles: [timingProfile("auto-bus", "bitrate: auto")],
    });

    expect(car.busTiming()).toEqual([
      { status: "ok", bus: 0, bitrate: 250000, dataBitrate: 0, requested: { bus: 0, bitrate: "auto" } },
    ]);
  });

  it("keeps the vehicle connected when auto-detect finds no traffic", async () => {
    const transport = new MockTransport();
    transport.scriptBusConfigResponse({ status: "auto_detect_failed", bus: 0, bitrate: 500000, dataBitrate: 0 });

    const car = await new VirtualVehicleManager().connect({
      id: "asleep",
      transport,
      profiles: [timingProfile("auto-bus", "bitrate: auto")],
    });

    expect(transport.isConnected()).toBe(true);
    expect(car.busTiming()[0]).toMatchObject({ status: "auto_detect_failed", bitrate: 500000 });
  });

  it("still fails the connection when an explicit bitrate is rejected", async () => {
    const transport = new MockTransport();
    transport.scriptBusConfigResponse({ status: "invalid_bitrate", bus: 0, bitrate: 500000, dataBitrate: 0 });

    await expect(
      new VirtualVehicleManager().connect({
        id: "rejected",
        transport,
        profiles: [timingProfile("fixed-bus", "bitrate: 500000")],
      }),
    ).rejects.toThrow("Failed to configure CAN bus 0: invalid_bitrate");
    expect(transport.isConnected()).toBe(false);
  });

  it("applies timing from profiles loaded after connect and skips unchanged buses", async () => {
    const transport = new MockTransport();
    const car = await new VirtualVehicleManager().connect({ id: "reload", transport, profiles: [] });
    expect(car.busTiming()).toEqual([]);

    const fdProfile = timingProfile("fd-bus", "bitrate: 500000\n      data_bitrate: 2000000");
    car.reloadProfiles([fdProfile]);
    expect(transport.busConfigUpdates).toEqual([]);

    await expect(car.configureBuses()).resolves.toEqual([
      {
        status: "ok",
        bus: 0,
        bitrate: 500000,
        dataBitrate: 2000000,
        requested: { bus: 0, bitrate: 500000, dataBitrate: 2000000 },
      },
    ]);

    car.reloadProfiles([fdProfile]);
    await car.configureBuses();
    expect(transport.busConfigUpdates).toEqual([{ bus: 0, bitrate: 500000, dataBitrate: 2000000 }]);
  });

  it("keeps the last report for a bus the reloaded profiles no longer configure", async () => {
    const transport = new MockTransport();
    const car = await new VirtualVehicleManager().connect({
      id: "dropped",
      transport,
      profiles: [timingProfile("fixed-bus", "bitrate: 500000")],
    });

    car.reloadProfiles([]);
    await expect(car.configureBuses()).resolves.toMatchObject([{ bus: 0, bitrate: 500000 }]);
    expect(transport.busConfigUpdates).toHaveLength(1);
  });
});

function timingProfile(name: string, bus0: string): VehicleProfileSource {
  return {
    name: `test/${name}/profile.yaml`,
    content: `version: 1

can:
  buses:
    0:
      ${bus0}
`,
    dbcFiles: [],
  };
}
