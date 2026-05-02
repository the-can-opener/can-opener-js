import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleProfile } from "./fixtures.js";

describe("VirtualVehicle.action", () => {
  it("sends profile-declared action frames", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [testVehicleProfile],
    });

    await car.action("HORN");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      signalName: "HORN",
      expectCanResponse: false,
    });
    expect(transport.requests[0]?.txFrame.data[0]).toBe(1);
  });
});
