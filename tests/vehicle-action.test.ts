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

  it("sends actions that declare inline request_id values", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [
        {
          ...testVehicleProfile,
          content: `version: 1

dbc:
  files:
    - path: signals.dbc

actions:
  WIPERS:
    send:
      request_id: 0x35D
      request: [0xC1, 0x03, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]
`,
        },
      ],
    });

    await car.action("WIPERS");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      signalName: "WIPERS",
      expectCanResponse: false,
      txFrame: {
        canId: 0x35D,
        dlc: 8,
      },
    });
    expect(transport.requests[0]?.txFrame.data).toEqual(
      Uint8Array.from([0xC1, 0x03, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
  });
});
