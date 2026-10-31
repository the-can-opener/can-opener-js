import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanFrame } from "../src/dbc/types.js";
import { CanTransmitError, NoEcuResponseError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import type { VirtualVehicle } from "../src/vehicle/VirtualVehicle.js";
import { universalPidProfile } from "./fixtures.js";

const RPM_PID = 0x0c;
const FUEL_LEVEL_PID = 0x2f;
const BROADCAST_CAN_ID = 0x100;

describe("bus activity", () => {
  let transport: MockTransport;
  let vehicle: VirtualVehicle;

  beforeEach(async () => {
    vi.useFakeTimers();
    transport = new MockTransport();
    vehicle = await new VirtualVehicleManager().connect({
      id: "car-a",
      transport,
      profiles: [universalPidProfile],
    });
  });

  afterEach(async () => {
    await vehicle.disconnect();
    vi.useRealTimers();
  });

  it("stops the query round-robin once the bus goes silent", async () => {
    const activity: string[] = [];
    vehicle.onBusActivityChange((next) => activity.push(next));
    transport.scriptPidError(obdRequestFrame(RPM_PID), new NoEcuResponseError());

    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(vehicle.busActivity()).toBe("asleep");
    expect(activity).toEqual(["asleep"]);

    const sentWhileAwake = transport.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.requests.length).toBe(sentWhileAwake);
  });

  it("treats unacknowledged frames as a silent bus", async () => {
    transport.scriptPidError(obdRequestFrame(RPM_PID), new CanTransmitError());

    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(vehicle.busActivity()).toBe("asleep");
  });

  it("keeps polling while CAN traffic shows the bus is awake", async () => {
    await transport.updateMonitor({ operation: "add", canIds: [BROADCAST_CAN_ID] });
    transport.scriptPidError(obdRequestFrame(RPM_PID), new NoEcuResponseError());

    vehicle.updateQueryRoundRobin(["RPM"]);
    for (let second = 0; second < 20; second += 1) {
      transport.emitFrame(broadcastFrame());
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(vehicle.busActivity()).toBe("awake");
    const sent = transport.requests.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.requests.length).toBeGreaterThan(sent);
  });

  it("does not sleep on failures that came from an answering bus", async () => {
    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(vehicle.busActivity()).toBe("awake");
  });

  it("resumes the round-robin when CAN traffic returns", async () => {
    await transport.updateMonitor({ operation: "add", canIds: [BROADCAST_CAN_ID] });
    transport.scriptPidError(obdRequestFrame(RPM_PID), new NoEcuResponseError());
    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vehicle.busActivity()).toBe("asleep");

    transport.scriptPidResponse(obdRequestFrame(RPM_PID), rpmResponse(vehicle, 3000));
    transport.emitFrame(broadcastFrame());
    await vi.advanceTimersByTimeAsync(0);

    expect(vehicle.busActivity()).toBe("awake");
    expect(vehicle.state.get<number>("RPM")).toBe(3000);
  });

  it("resumes the round-robin on wakeBus", async () => {
    transport.scriptPidError(obdRequestFrame(RPM_PID), new NoEcuResponseError());
    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vehicle.busActivity()).toBe("asleep");

    transport.scriptPidResponse(obdRequestFrame(RPM_PID), rpmResponse(vehicle, 3100));
    vehicle.wakeBus();
    await vi.advanceTimersByTimeAsync(0);

    expect(vehicle.state.get<number>("RPM")).toBe(3100);
  });

  it("stops query subscriptions while the bus is asleep", async () => {
    transport.scriptPidError(obdRequestFrame(FUEL_LEVEL_PID), new NoEcuResponseError());

    await vehicle.subscribeQuery("FUEL_LEVEL", { frequencyHz: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vehicle.busActivity()).toBe("asleep");

    const sentWhileAwake = transport.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.requests.length).toBe(sentWhileAwake);
  });

  it("still sends explicit queries while asleep and wakes on their reply", async () => {
    transport.scriptPidError(obdRequestFrame(RPM_PID), new NoEcuResponseError());
    vehicle.updateQueryRoundRobin(["RPM"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vehicle.busActivity()).toBe("asleep");

    transport.scriptPidResponse(obdRequestFrame(RPM_PID), rpmResponse(vehicle, 3200));
    await expect(vehicle.query<number>("RPM")).resolves.toBe(3200);

    expect(vehicle.busActivity()).toBe("awake");
  });
});

function obdRequestFrame(pid: number): CanFrame {
  const data = new Uint8Array(8);
  data[0] = 0x02;
  data[1] = 0x01;
  data[2] = pid;
  return { canId: 0x7df, dlc: 8, data };
}

function rpmResponse(vehicle: VirtualVehicle, rpm: number): Uint8Array {
  const payload = vehicle.dbc.encodeSignal("RPM", rpm).data.slice();
  payload[0] = 0x41;
  payload[1] = RPM_PID;

  const response = new Uint8Array(8);
  response[0] = 0x03;
  response.set(payload.slice(0, 7), 1);
  return response;
}

function broadcastFrame(): CanFrame {
  return { canId: BROADCAST_CAN_ID, dlc: 1, data: Uint8Array.of(0xaa) };
}
