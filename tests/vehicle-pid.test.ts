import { describe, expect, it } from "vitest";
import { buildPidRequest } from "../src/dbc/UdsBuilder.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/MockTransport.js";
import { vehicleDbc } from "./fixtures.js";

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
});
