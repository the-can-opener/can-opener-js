import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanFrame, CanPayload } from "../src/dbc/types.js";
import { CanTransmitError, NoEcuResponseError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { recordedActionState } from "../src/profile/actionState.js";
import { CapabilityRegistry } from "../src/profile/CapabilityRegistry.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import type { VehicleRequest, VehicleTransport } from "../src/transport/types.js";
import { nissanSentraProfile, testVehicleProfile } from "./fixtures.js";

type HornBehavior =
  | "timeout-once"
  | "timeout-always"
  | "timeout-then-invalid"
  | "invalid-response"
  | "tx-failed-once"
  | "tx-failed-always"
  | "asleep-then-mismatch-then-ok";

/**
 * Drives an action to completion while the ECU wake path waits on fake
 * timers for its settle delays.
 */
async function withSettleDelays<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return tracked;
}

class ActionRetryTransport extends MockTransport {
  private hornAttempts = 0;
  /** Set by the test to make ECU_WAKE frames go unacknowledged like on a sleeping bus. */
  wakeFails = false;

  constructor(private readonly hornBehavior: HornBehavior) {
    super();
  }

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    this.requests.push(req);
    if (req.signalName === "ECU_WAKE") {
      if (this.wakeFails) {
        throw new CanTransmitError();
      }
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
      case "tx-failed-once":
        if (this.hornAttempts === 1) {
          throw new CanTransmitError();
        }
        return Uint8Array.from([0x41]);
      case "tx-failed-always":
        throw new CanTransmitError();
      case "asleep-then-mismatch-then-ok":
        // Nothing ACKs the first frame, the second is answered by an ECU that
        // is still booting, and the third is a normal reply.
        if (this.hornAttempts === 1) {
          throw new CanTransmitError();
        }
        if (this.hornAttempts === 2) {
          return Uint8Array.from([0x00]);
        }
        return Uint8Array.from([0x41]);
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

  it("runs a present-tense command and records the resulting condition", async () => {
    const transport = new MockTransport();
    const car = await new VirtualVehicleManager().connect({
      id: "car-a",
      transport,
      profiles: [{
        ...testVehicleProfile,
        content: `version: 1

endpoints:
  body:
    request_id: 200
    response_id: 201

actions:
  TRUNK:
    endpoint: body
    values:
      open:
        send: [0x01]
        expect: [0x41]
      close:
        send: [0x02]
        expect: [0x42]
  DOORS:
    endpoint: body
    values:
      lock:
        send: [0x03]
      unlock:
        send: [0x04]
`,
      }],
    });
    const frame = (first: number) => ({ canId: 200, data: Uint8Array.from([first, 0, 0, 0, 0, 0, 0, 0]) });
    transport.scriptPidResponse(frame(0x01), Uint8Array.from([0x41]));
    transport.scriptPidResponse(frame(0x02), Uint8Array.from([0x00]));

    await expect(car.action("TRUNK", { value: "open" })).resolves.toBe(true);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ signalName: "TRUNK.open" });
    expect(transport.requests[0]?.txFrame.data[0]).toBe(1);
    expect(car.state.get("TRUNK")).toBe("open");

    // A rejected request leaves the recorded condition alone.
    await expect(car.action("TRUNK.close")).resolves.toBe(false);
    expect(car.state.get("TRUNK")).toBe("open");

    transport.scriptPidResponse(frame(0x02), Uint8Array.from([0x42]));
    await expect(car.action("TRUNK", { value: "close" })).resolves.toBe(true);
    expect(car.state.get("TRUNK")).toBe("closed");

    await expect(car.action("DOORS", { value: "lock" })).resolves.toBeUndefined();
    expect(car.state.get("DOORS")).toBe("locked");
    await expect(car.action("DOORS.unlock")).resolves.toBeUndefined();
    expect(car.state.get("DOORS")).toBe("unlocked");

    await expect(car.action("TRUNK", { value: "ajar" })).rejects.toThrow(/Unknown vehicle action: TRUNK\.ajar/u);
  });

  it("records the condition for a present-tense action command", () => {
    expect(recordedActionState("lock")).toBe("locked");
    expect(recordedActionState("unlock")).toBe("unlocked");
    expect(recordedActionState("close")).toBe("closed");
    expect(recordedActionState("fold")).toBe("folded");
    expect(recordedActionState("unfold")).toBe("unfolded");
    expect(recordedActionState("open")).toBe("open");
    expect(recordedActionState("on")).toBe("on");
  });

  it("encodes numeric action targets, enforces min/max bounds, and updates state with the number", async () => {
    const transport = new MockTransport();
    const profileSource: VehicleProfileSource = {
      ...testVehicleProfile,
      content: `version: 1.1

endpoints:
  climate:
    request_id: 200
    response_id: 201

sequences:
  prep:
    steps:
      - send: [0x02, 0x10, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00]
        expect: [0x50, 0x81]

actions:
  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode:
      byte: 4
      scale: 0.5
      offset: -40
      min: 16
      max: 32
      step: 0.5
    steps:
      - ref: sequences.prep
      - send: [0x04, 0x2E, 0x12, 0x34, 0x00, 0x00, 0x00, 0x00]
        expect: [0x6E, 0x12, 0x34]
  HORN:
    endpoint: climate
    send: [0x01]
`,
    };
    const car = await new VirtualVehicleManager().connect({
      id: "car-a",
      transport,
      profiles: [profileSource],
    });
    const registry = new CapabilityRegistry();
    registry.load(new ProfileLoader().load([profileSource]));
    expect(registry.actionInput("CABIN_TEMP_SETPOINT")).toEqual({ min: 16, max: 32, step: 0.5 });
    expect(registry.actionInput("HORN")).toBeUndefined();
    const prepFrame = { canId: 200, data: Uint8Array.from([0x02, 0x10, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00]) };
    // 22.5 C -> round((22.5 - (-40)) / 0.5) = 125 (0x7D)
    const set225Frame = { canId: 200, data: Uint8Array.from([0x04, 0x2E, 0x12, 0x34, 0x7D, 0x00, 0x00, 0x00]) };
    // 20 C -> round((20 - (-40)) / 0.5) = 120 (0x78)
    const set20Frame = { canId: 200, data: Uint8Array.from([0x04, 0x2E, 0x12, 0x34, 0x78, 0x00, 0x00, 0x00]) };
    transport.scriptPidResponse(prepFrame, Uint8Array.from([0x50, 0x81]));
    transport.scriptPidResponse(set225Frame, Uint8Array.from([0x6E, 0x12, 0x34]));
    transport.scriptPidResponse(set20Frame, Uint8Array.from([0x7F, 0x2E, 0x31]));

    await expect(car.action("CABIN_TEMP_SETPOINT", { value: 22.5 })).resolves.toBe(true);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.txFrame.data).toEqual(prepFrame.data);
    expect(transport.requests[1]?.txFrame.data).toEqual(set225Frame.data);
    expect(car.state.get<number>("CABIN_TEMP_SETPOINT")).toBe(22.5);

    // A rejected response leaves the previous numeric target intact.
    await expect(car.action("CABIN_TEMP_SETPOINT", { value: 20 })).resolves.toBe(false);
    expect(car.state.get<number>("CABIN_TEMP_SETPOINT")).toBe(22.5);

    // Out-of-bounds, missing value, or numeric target on a trigger action are rejected.
    await expect(car.action("CABIN_TEMP_SETPOINT", { value: 15 })).rejects.toThrow(/below minimum 16/u);
    await expect(car.action("CABIN_TEMP_SETPOINT", { value: 33 })).rejects.toThrow(/exceeds maximum 32/u);
    await expect(car.action("CABIN_TEMP_SETPOINT")).rejects.toThrow(/requires a numeric target value/u);
    await expect(car.action("HORN", { value: 22 })).rejects.toThrow(/does not accept a numeric value/u);
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

  describe("ECU wake", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("wakes the ECU and retries an action after no response", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("timeout-once");
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);
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

    it("wakes the ECU and retries when nothing on the bus acknowledged the frame", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("tx-failed-once");
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);
      expect(transport.requests.map((request) => request.signalName)).toEqual([
        "HORN",
        "ECU_WAKE",
        "HORN",
      ]);
    });

    it("keeps waking when the wake frames themselves are not acknowledged", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("tx-failed-once");
      transport.wakeFails = true;
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);
      expect(transport.requests.map((request) => request.signalName)).toEqual([
        "HORN",
        "ECU_WAKE",
        "HORN",
      ]);
    });

    it("waits longer between each wake attempt", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("tx-failed-always");
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      const result = car.action("HORN");
      const hornAttempts = () => transport.requests.filter((request) => request.signalName === "HORN").length;

      await vi.advanceTimersByTimeAsync(0);
      expect(hornAttempts()).toBe(1);
      // Settle delays grow by 100 ms per attempt: 100, 200, 300, 400, 500.
      for (const [attempt, settleMs] of [100, 200, 300, 400, 500].entries()) {
        await vi.advanceTimersByTimeAsync(settleMs - 1);
        expect(hornAttempts()).toBe(attempt + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(hornAttempts()).toBe(attempt + 2);
      }

      await expect(result).resolves.toBe("unknown");
      expect(hornAttempts()).toBe(6);
    });

    it("reports an unknown outcome when the ECU stays silent after every wake", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("timeout-always");
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe("unknown");
      expect(transport.requests.map((request) => request.signalName)).toEqual([
        "HORN",
        ...Array<string[]>(5).fill(["ECU_WAKE", "HORN"]).flat(),
      ]);
    });

    it("retries a mismatch during the wake window and succeeds once the ECU is up", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("asleep-then-mismatch-then-ok");
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);
      expect(transport.requests.map((request) => request.signalName)).toEqual([
        "HORN",
        "ECU_WAKE",
        "HORN",
        "ECU_WAKE",
        "HORN",
      ]);
    });

    it("reports an unknown outcome when every retry after a wake is unverified", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new ActionRetryTransport("timeout-then-invalid");
      const car = await manager.connect({
        id: "car-a",
        transport,
        profiles: [wakeRetryProfile],
      });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe("unknown");
      expect(transport.requests.filter((request) => request.signalName === "ECU_WAKE")).toHaveLength(5);
    });
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

/**
 * A bus with the car off: no node acknowledges anything until a full ECU_WAKE
 * sequence has been put on the wire, after which ECUs answer normally.
 */
class SleepingBusTransport extends MockTransport {
  private awake = false;
  private wakeFramesSent = 0;

  constructor(private readonly wakeFrameCount: number) {
    super();
  }

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    if (this.awake) {
      return super.sendRequest(req);
    }
    this.requests.push(req);
    if (req.signalName === "ECU_WAKE") {
      this.wakeFramesSent += 1;
      this.awake = this.wakeFramesSent >= this.wakeFrameCount;
    }
    throw new CanTransmitError();
  }
}

const sleepingBusProfile: VehicleProfileSource = {
  ...nissanSentraProfile,
  content: `${nissanSentraProfile.content}
  ECU_WAKE:
    endpoint: body
    steps:
      - send: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
      - send: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
      - send: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
`,
};

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

  describe("ECU wake", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
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

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);

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

    it("sends every wake frame on a sleeping bus and then retries the batch", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new SleepingBusTransport(3);
      scriptNissanHorn(transport);
      const car = await manager.connect({ id: "car-a", transport, profiles: [sleepingBusProfile] });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);

      expect(transport.batches.map((batch) => [batch.signalName, batch.continueOnError ?? false])).toEqual([
        ["HORN", false],
        ["ECU_WAKE", true],
        ["HORN", false],
      ]);
      // The device stops the HORN batch at the unacknowledged first frame but
      // keeps going through the wake sequence.
      expect(transport.requests.map((request) => request.signalName)).toEqual([
        "HORN",
        "ECU_WAKE",
        "ECU_WAKE",
        "ECU_WAKE",
        "HORN",
        "HORN",
        "HORN",
      ]);
    });

    it("needs more than one wake when the bus takes longer to come up", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new SleepingBusTransport(5);
      scriptNissanHorn(transport);
      const car = await manager.connect({ id: "car-a", transport, profiles: [sleepingBusProfile] });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);

      expect(transport.batches.map((batch) => batch.signalName)).toEqual([
        "HORN",
        "ECU_WAKE",
        "HORN",
        "ECU_WAKE",
        "HORN",
      ]);
    });

    it("reports an unknown outcome when the bus never acknowledges anything", async () => {
      const manager = new VirtualVehicleManager();
      const transport = new SleepingBusTransport(Number.POSITIVE_INFINITY);
      const car = await manager.connect({ id: "car-a", transport, profiles: [sleepingBusProfile] });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe("unknown");

      expect(transport.batches.map((batch) => batch.signalName)).toEqual([
        "HORN",
        ...Array<string[]>(5).fill(["ECU_WAKE", "HORN"]).flat(),
      ]);
    });

    it("sends every wake frame one at a time when the transport cannot batch", async () => {
      const manager = new VirtualVehicleManager();
      const mock = new SleepingBusTransport(3);
      scriptNissanHorn(mock);
      const car = await manager.connect({ id: "car-a", transport: withoutBatchSupport(mock), profiles: [sleepingBusProfile] });

      await expect(withSettleDelays(car.action("HORN"))).resolves.toBe(true);

      expect(mock.batches).toHaveLength(0);
      expect(mock.requests.map((request) => request.signalName)).toEqual([
        "HORN",
        "ECU_WAKE",
        "ECU_WAKE",
        "ECU_WAKE",
        "HORN",
        "HORN",
        "HORN",
      ]);
    });
  });
});
