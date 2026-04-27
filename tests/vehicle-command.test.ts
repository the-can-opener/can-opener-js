import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/MockTransport.js";
import { vehicleDbc } from "./fixtures.js";

describe("VirtualVehicle.command", () => {
  it("encodes and sends command frames", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await car.command("HORN", {
      value: true,
      mask: 0b00000001,
    });

    expect(transport.commands).toHaveLength(1);
    expect(transport.commands[0]?.signalName).toBe("HORN");
    expect(transport.commands[0]?.frame.data[0]).toBe(1);
  });
});
