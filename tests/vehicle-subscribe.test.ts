import { describe, expect, it } from "vitest";
import { isCodecSignal, writeSignalValue } from "../src/dbc/codec.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/MockTransport.js";
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

    const unsubscribe = await car.subscribe("ENGINE_RPM", {
      frequencyHz: 10,
      durationMs: 30_000,
    });
    transport.emitFrame(car.dbc.encodeSignal("ENGINE_RPM", 900));

    expect(car.state.get<number>("ENGINE_RPM")).toBe(900);
    expect(transport.subscriptions[0]).toMatchObject({
      signalNames: ["ENGINE_RPM"],
      frequencyHz: 10,
    });

    await unsubscribe();
  });

  it("merges keyword subscriptions that share one CAN frame", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    const unsubscribeTurnSignal = await car.subscribe("TURN_SIGNAL_LEFT", {
      frequencyHz: 5,
    });
    const unsubscribeHighBeams = await car.subscribe("HIGH_BEAMS", {
      frequencyHz: 20,
    });

    expect(transport.subscriptions).toHaveLength(1);
    expect(transport.subscriptions[0]).toMatchObject({
      signalNames: ["TURN_SIGNAL_LEFT", "HIGH_BEAMS"],
      frequencyHz: 20,
    });

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

    await unsubscribeTurnSignal();

    expect(transport.subscriptions).toHaveLength(1);
    expect(transport.subscriptions[0]?.signalNames).toEqual(["HIGH_BEAMS"]);

    await unsubscribeHighBeams();

    expect(transport.subscriptions).toHaveLength(0);
  });

  it("declares multiple subscriptions from a registry", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      dbcFiles: [vehicleDbc],
    });

    const unsubscribe = await car.subscribe({
      TURN_SIGNAL_LEFT: { frequencyHz: 5 },
      HIGH_BEAMS: { frequencyHz: 20 },
    });

    expect(transport.subscriptions).toHaveLength(1);
    expect(transport.subscriptions[0]).toMatchObject({
      signalNames: ["TURN_SIGNAL_LEFT", "HIGH_BEAMS"],
      frequencyHz: 20,
    });

    await unsubscribe();

    expect(transport.subscriptions).toHaveLength(0);
  });
});
