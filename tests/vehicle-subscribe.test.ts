import { describe, expect, it } from "vitest";
import { isCodecSignal, writeSignalValue } from "../src/dbc/codec.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { vehicleDbc } from "./fixtures.js";

describe("VirtualVehicle.subscribe", () => {
  it("decodes incoming frames into vehicle state", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await expect(car.subscribe("ENGINE_RPM")).resolves.toBe(true);
    transport.emitFrame(car.dbc.encodeSignal("ENGINE_RPM", 900));

    expect(car.state.get<number>("ENGINE_RPM")).toBe(900);
    expect(Array.from(transport.monitorCanIds)).toEqual([100]);
    expect(car.subscriptionCount()).toBe(1);

    await car.unsubscribe("ENGINE_RPM");
    expect(car.subscriptionCount()).toBe(0);
  });

  it("merges keyword subscriptions that share one CAN frame", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await expect(car.subscribe("TURN_SIGNAL_LEFT")).resolves.toBe(true);
    await expect(car.subscribe("HIGH_BEAMS")).resolves.toBe(true);

    expect(Array.from(transport.monitorCanIds)).toEqual([300]);
    expect(car.subscriptionCount()).toBe(2);

    const frame = {
      canId: 300,
      data: new Uint8Array(8),
    };
    const turnSignal = car.dbc.resolve("TURN_SIGNAL_LEFT");
    const highBeams = car.dbc.resolve("HIGH_BEAMS");
    if (!isCodecSignal(turnSignal) || !isCodecSignal(highBeams)) {
      throw new Error("Expected BODY signals to have DBC bit layout");
    }
    writeSignalValue(frame.data, turnSignal, true);
    writeSignalValue(frame.data, highBeams, true);
    transport.emitFrame(frame);

    expect(car.state.turn_signal_left).toBe(1);
    expect(car.state.high_beams).toBe(1);

    await car.unsubscribe("TURN_SIGNAL_LEFT");

    expect(Array.from(transport.monitorCanIds)).toEqual([300]);
    expect(car.subscriptionCount()).toBe(1);

    await car.unsubscribe("HIGH_BEAMS");

    expect(transport.monitorCanIds.size).toBe(0);
    expect(car.subscriptionCount()).toBe(0);
  });

  it("declares multiple subscriptions from a registry", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await expect(car.subscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"])).resolves.toBe(true);

    expect(Array.from(transport.monitorCanIds)).toEqual([300]);
    expect(car.subscriptionCount()).toBe(2);

    await car.unsubscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]);

    expect(transport.monitorCanIds.size).toBe(0);
    expect(car.subscriptionCount()).toBe(0);
  });

  it("rejects PID signals for frame subscriptions", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    await expect(car.subscribe("VEHICLE_SPEED")).rejects.toThrow(
      "VEHICLE_SPEED is not a frame signal (actual protocol: pid)",
    );
  });
});
