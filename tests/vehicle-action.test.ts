import { describe, expect, it } from "vitest";
import type { CanPayload } from "../src/dbc/types.js";
import { NoEcuResponseError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import type { VehicleRequest } from "../src/transport/types.js";
import { testVehicleProfile } from "./fixtures.js";

type HornBehavior = "timeout-once" | "timeout-always" | "invalid-response";

class ActionRetryTransport extends MockTransport {
  private hornAttempts = 0;

  constructor(private readonly hornBehavior: HornBehavior) {
    super();
  }

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    this.requests.push(req);
    if (req.signalName === "ECU_WAKE") {
      return undefined;
    }
    if (req.signalName !== "HORN") {
      return undefined;
    }

    this.hornAttempts += 1;
    switch (this.hornBehavior) {
      case "timeout-once":
        if (this.hornAttempts === 1) {
          throw new NoEcuResponseError();
        }
        return Uint8Array.from([0x41]);
      case "timeout-always":
        throw new NoEcuResponseError();
      case "invalid-response":
        return Uint8Array.from([0x00]);
      default: {
        const exhaustiveBehavior: never = this.hornBehavior;
        throw new Error(`Unhandled horn behavior: ${exhaustiveBehavior}`);
      }
    }
  }
}

const wakeRetryProfile: VehicleProfileSource = {
  ...testVehicleProfile,
  content: `version: 1

dbc:
  files:
    - path: signals.dbc

endpoints:
  diagnostics:
    request_id: 200
    response_id: 201

actions:
  ECU_WAKE:
    endpoint: diagnostics
    send: [0x02]
  HORN:
    endpoint: diagnostics
    send: [0x01]
    expect: [0x41]
`,
};

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

  it("wakes the ECU and retries an action after no response", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new ActionRetryTransport("timeout-once");
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [wakeRetryProfile],
    });

    await expect(car.action("HORN")).resolves.toBe(true);
    expect(transport.requests.map((request) => request.signalName)).toEqual([
      "HORN",
      "ECU_WAKE",
      "HORN",
    ]);
    expect(transport.requests.map((request) => request.expectCanResponse)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("retries only once when the ECU remains unresponsive", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new ActionRetryTransport("timeout-always");
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [wakeRetryProfile],
    });

    await expect(car.action("HORN")).rejects.toBeInstanceOf(NoEcuResponseError);
    expect(transport.requests.map((request) => request.signalName)).toEqual([
      "HORN",
      "ECU_WAKE",
      "HORN",
    ]);
  });

  it("does not wake or retry when the ECU returns an unexpected response", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new ActionRetryTransport("invalid-response");
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [wakeRetryProfile],
    });

    await expect(car.action("HORN")).resolves.toBe(false);
    expect(transport.requests.map((request) => request.signalName)).toEqual(["HORN"]);
  });
});
