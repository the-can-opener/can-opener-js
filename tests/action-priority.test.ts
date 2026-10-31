import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanFrame, CanPayload } from "../src/dbc/types.js";
import { CanTransmitError, NoEcuResponseError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import type { VehicleRequest } from "../src/transport/types.js";
import type { VirtualVehicle } from "../src/vehicle/VirtualVehicle.js";
import { universalPidProfile } from "./fixtures.js";

const RPM_PID = 0x0c;
const FUEL_LEVEL_PID = 0x2f;

const profileWithActions: VehicleProfileSource = {
  ...universalPidProfile,
  content: `${universalPidProfile.content}
actions:
  ECU_WAKE:
    endpoint: obd
    send: [0x02, 0x3E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
  HORN:
    endpoint: obd
    send: [0x02, 0x01, 0x99, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect: [0x41, 0x99]
`,
};

/** Nothing acknowledges the first HORN frame; the retry after the wake is answered. */
class SleepyHornTransport extends MockTransport {
  private hornAttempts = 0;

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    if (req.signalName === "HORN") {
      this.hornAttempts += 1;
      if (this.hornAttempts === 1) {
        this.requests.push(req);
        throw new CanTransmitError();
      }
      this.requests.push(req);
      return Uint8Array.of(0x41, 0x99);
    }
    if (req.signalName === "ECU_WAKE") {
      this.requests.push(req);
      return undefined;
    }
    return super.sendRequest(req);
  }
}

class KnownSleepingHornTransport extends MockTransport {
  private awake = false;

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    this.requests.push(req);
    if (req.signalName === "RPM") {
      throw new NoEcuResponseError();
    }
    if (req.signalName === "ECU_WAKE") {
      this.awake = true;
      return undefined;
    }
    if (req.signalName === "HORN") {
      if (!this.awake) {
        throw new CanTransmitError();
      }
      return Uint8Array.of(0x41, 0x99);
    }
    return undefined;
  }
}

/** Resolves an action while fake timers drive the ECU wake settle delays. */
async function withSettleDelays<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    await vi.advanceTimersByTimeAsync(50);
  }
  return tracked;
}

describe("actions take priority over background queries", () => {
  let transport: SleepyHornTransport;
  let vehicle: VirtualVehicle;

  beforeEach(async () => {
    vi.useFakeTimers();
    transport = new SleepyHornTransport();
    transport.scriptPidResponse(obdRequestFrame(RPM_PID), pidResponse(RPM_PID, 0x10, 0x00));
    transport.scriptPidResponse(obdRequestFrame(FUEL_LEVEL_PID), pidResponse(FUEL_LEVEL_PID, 0x80));
    vehicle = await new VirtualVehicleManager().connect({
      id: "car-a",
      transport,
      profiles: [profileWithActions],
    });
  });

  afterEach(async () => {
    await vehicle.disconnect();
    vi.useRealTimers();
  });

  it("keeps the round-robin quiet from the first action frame to the last", async () => {
    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.requests.filter((request) => request.signalName === "RPM").length).toBeGreaterThan(0);

    const before = transport.requests.length;
    await expect(withSettleDelays(vehicle.action("HORN"))).resolves.toBe(true);

    const duringAction = transport.requests.slice(before).map((request) => request.signalName);
    expect(duringAction[0]).toBe("HORN");
    expect(duringAction[duringAction.length - 1]).toBe("HORN");
    expect(duringAction).not.toContain("RPM");

    // The round-robin picks up again once the action is done.
    const after = transport.requests.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.requests.slice(after).some((request) => request.signalName === "RPM")).toBe(true);
  });

  it("keeps polled subscriptions quiet while an action runs", async () => {
    await vehicle.subscribeQuery("FUEL_LEVEL", { frequencyHz: 20 });
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.requests.filter((request) => request.signalName === "FUEL_LEVEL").length).toBeGreaterThan(0);

    const before = transport.requests.length;
    await expect(withSettleDelays(vehicle.action("HORN"))).resolves.toBe(true);

    const duringAction = transport.requests.slice(before).map((request) => request.signalName);
    expect(duringAction).not.toContain("FUEL_LEVEL");

    const after = transport.requests.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.requests.slice(after).some((request) => request.signalName === "FUEL_LEVEL")).toBe(true);
  });

  it("does not disturb an explicit pause", async () => {
    vehicle.updateQueryRoundRobin(["RPM"]);
    vehicle.pauseQueryRoundRobin();
    await vi.advanceTimersByTimeAsync(500);
    const before = transport.requests.length;

    await expect(withSettleDelays(vehicle.action("HORN"))).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1000);

    expect(transport.requests.slice(before).some((request) => request.signalName === "RPM")).toBe(false);
  });

  it("starts with ECU wake instead of a failed action probe when the bus is asleep", async () => {
    await vehicle.disconnect();
    const sleepingTransport = new KnownSleepingHornTransport();
    vehicle = await new VirtualVehicleManager().connect({
      id: "car-b",
      transport: sleepingTransport,
      profiles: [profileWithActions],
    });

    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vehicle.busActivity()).toBe("asleep");
    vehicle.updateQueryRoundRobin([]);

    const before = sleepingTransport.requests.length;
    await expect(withSettleDelays(vehicle.action("HORN"))).resolves.toBe(true);

    expect(
      sleepingTransport.requests
        .slice(before)
        .map((request) => request.signalName),
    ).toEqual(["ECU_WAKE", "HORN"]);
  });
});

function obdRequestFrame(pid: number): CanFrame {
  const data = new Uint8Array(8);
  data[0] = 0x02;
  data[1] = 0x01;
  data[2] = pid;
  return { canId: 0x7df, dlc: 8, data };
}

function pidResponse(pid: number, ...bytes: number[]): Uint8Array {
  const response = new Uint8Array(8);
  response[0] = 2 + bytes.length;
  response[1] = 0x41;
  response[2] = pid;
  response.set(bytes, 3);
  return response;
}
