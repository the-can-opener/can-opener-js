import { describe, expect, it } from "vitest";
import type { CanFrame, CanPayload } from "../src/dbc/types.js";
import { NoEcuResponseError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import type { VehicleRequest, VehicleTransport } from "../src/transport/types.js";
import { nissanSentraProfile, testVehicleProfile } from "./fixtures.js";

type HornBehavior =
  | "timeout-once"
  | "timeout-always"
  | "timeout-then-invalid"
  | "invalid-response";

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
      case "timeout-then-invalid":
        if (this.hornAttempts === 1) {
          throw new NoEcuResponseError();
        }
        return Uint8Array.from([0x00]);
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

  it("reports an unknown outcome when the ECU stays silent after a wake", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new ActionRetryTransport("timeout-always");
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [wakeRetryProfile],
    });

    await expect(car.action("HORN")).resolves.toBe("unknown");
    expect(transport.requests.map((request) => request.signalName)).toEqual([
      "HORN",
      "ECU_WAKE",
      "HORN",
    ]);
  });

  it("reports an unknown outcome when the retry after a wake is unverified", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new ActionRetryTransport("timeout-then-invalid");
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [wakeRetryProfile],
    });

    await expect(car.action("HORN")).resolves.toBe("unknown");
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

const BODY_REQUEST_ID = 0x745;
const BODY_RESPONSE_ID = 0x765;
const SESSION_81 = [0x02, 0x10, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00];
const SESSION_C0 = [0x02, 0x10, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00];
const HORN_ON = [0x04, 0x30, 0x30, 0x00, 0x01, 0x00, 0x00, 0x00];

function bodyFrame(data: number[]): CanFrame {
  return { canId: BODY_REQUEST_ID, dlc: 8, data: Uint8Array.from(data) };
}

function scriptNissanHorn(transport: MockTransport, hornResponse: number[] = [0x70, 0x30, 0x01]): void {
  transport.scriptPidResponse(bodyFrame(SESSION_81), Uint8Array.of(0x50, 0x81));
  transport.scriptPidResponse(bodyFrame(SESSION_C0), Uint8Array.of(0x50, 0xc0));
  transport.scriptPidResponse(bodyFrame(HORN_ON), Uint8Array.from(hornResponse));
}

/** A transport that supports single requests only, like older BLE clients. */
function withoutBatchSupport(mock: MockTransport): VehicleTransport {
  return {
    connect: () => mock.connect(),
    disconnect: () => mock.disconnect(),
    sendRequest: (req) => mock.sendRequest(req),
    updateMonitor: (req) => mock.updateMonitor(req),
    onMonitorSnapshot: (cb) => mock.onMonitorSnapshot(cb),
  };
}

class BatchWakeTransport extends MockTransport {
  private hornAttempts = 0;

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    // The first HORN attempt loses the ECU after the session prep step.
    if (req.signalName === "HORN" && req.txFrame.data[2] === 0xc0) {
      this.hornAttempts += 1;
      if (this.hornAttempts === 1) {
        this.requests.push(req);
        throw new NoEcuResponseError();
      }
    }
    return super.sendRequest(req);
  }
}

describe("VirtualVehicle.action batching", () => {
  it("sends a multi-step action as one same-bus batch", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    scriptNissanHorn(transport);
    const car = await manager.connect({ id: "car-a", transport, profiles: [nissanSentraProfile] });

    await expect(car.action("HORN")).resolves.toBe(true);

    expect(transport.batches).toHaveLength(1);
    const batch = transport.batches[0];
    expect(batch).toMatchObject({ signalName: "HORN" });
    expect(batch?.steps.map((step) => Array.from(step.txFrame.data))).toEqual([SESSION_81, SESSION_C0, HORN_ON]);
    expect(batch?.steps.map((step) => step.expectCanResponse)).toEqual([true, true, true]);
    expect(batch?.steps.map((step) => step.timeoutMs)).toEqual([500, 500, 500]);
    expect(batch?.steps.every((step) => step.responseIdStart === BODY_RESPONSE_ID)).toBe(true);
    expect(transport.requests).toHaveLength(3);
  });

  it("falls back to one request per step when the transport cannot batch", async () => {
    const manager = new VirtualVehicleManager();
    const mock = new MockTransport();
    scriptNissanHorn(mock);
    const car = await manager.connect({ id: "car-a", transport: withoutBatchSupport(mock), profiles: [nissanSentraProfile] });

    await expect(car.action("HORN")).resolves.toBe(true);

    expect(mock.batches).toHaveLength(0);
    expect(mock.requests).toHaveLength(3);
  });

  it("does not batch single-step actions", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({ id: "car-a", transport, profiles: [testVehicleProfile] });

    await car.action("HORN");

    expect(transport.batches).toHaveLength(0);
    expect(transport.requests).toHaveLength(1);
  });

  it("honours batch: false and stops before later steps on a mismatch", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    transport.scriptPidResponse(bodyFrame(SESSION_81), Uint8Array.of(0x7f, 0x10, 0x12));
    transport.scriptPidResponse(bodyFrame(SESSION_C0), Uint8Array.of(0x50, 0xc0));
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [
        {
          ...nissanSentraProfile,
          content: `version: 1

endpoints:
  body:
    request_id: 0x745
    response_id: 0x765

actions:
  UNLOCK:
    endpoint: body
    batch: false
    steps:
      - send: [0x02, 0x10, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00]
        expect: [0x50, 0x81]
      - send: [0x02, 0x10, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00]
        expect: [0x50, 0xC0]
`,
        },
      ],
    });

    await expect(car.action("UNLOCK")).resolves.toBe(false);

    expect(transport.batches).toHaveLength(0);
    // Sequential mode gates each step on the previous response.
    expect(transport.requests).toHaveLength(1);
  });

  it("reports a mismatch from a batched step as failure", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    scriptNissanHorn(transport, [0x7f, 0x30, 0x22]);
    const car = await manager.connect({ id: "car-a", transport, profiles: [nissanSentraProfile] });

    await expect(car.action("HORN")).resolves.toBe(false);
    expect(transport.batches).toHaveLength(1);
  });

  it("splits steps into consecutive same-bus batches", async () => {
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
  LIGHT_SHOW:
    steps:
      - send: { bus: 1, request_id: 0x35D, request: [0xC1] }
        delay_ms: 50
      - send: { bus: 1, request_id: 0x35D, request: [0xC2] }
      - send: { bus: 0, request_id: 0x123, request: [0x01] }
      - send: { bus: 0, request_id: 0x123, request: [0x02] }
      - send: { bus: 1, request_id: 0x35D, request: [0xC3] }
`,
        },
      ],
    });

    await expect(car.action("LIGHT_SHOW")).resolves.toBeUndefined();

    expect(transport.batches.map((batch) => [batch.bus, batch.steps.length])).toEqual([[1, 2], [0, 2]]);
    expect(transport.batches[0]?.steps[0]?.delayAfterMs).toBe(50);
    // The trailing single step is sent on its own.
    expect(transport.requests).toHaveLength(5);
    expect(transport.requests[4]?.txFrame.bus).toBe(1);
  });

  it("wakes the ECU and re-runs the whole batch after a step gets no response", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new BatchWakeTransport();
    scriptNissanHorn(transport);
    transport.scriptPidResponse(bodyFrame([0x02, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), Uint8Array.of(0x7e));
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [
        {
          ...nissanSentraProfile,
          content: `${nissanSentraProfile.content}
  ECU_WAKE:
    endpoint: body
    send: [0x02, 0x3E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
`,
        },
      ],
    });

    await expect(car.action("HORN")).resolves.toBe(true);

    expect(transport.batches.map((batch) => batch.signalName)).toEqual(["HORN", "HORN"]);
    expect(transport.requests.map((request) => request.signalName)).toEqual([
      "HORN",
      "HORN",
      "ECU_WAKE",
      "HORN",
      "HORN",
      "HORN",
    ]);
  });
});
