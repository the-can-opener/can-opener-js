import { describe, expect, it } from "vitest";
import { isCodecSignal, writeSignalValue } from "../src/dbc/codec.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleProfile } from "./fixtures.js";

describe("VirtualVehicle.subscribe", () => {
  it("decodes incoming frames into vehicle state", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [testVehicleProfile],
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
      profiles: [testVehicleProfile],
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
      profiles: [testVehicleProfile],
    });

    await expect(car.subscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"])).resolves.toBe(true);

    expect(Array.from(transport.monitorCanIds)).toEqual([300]);
    expect(car.subscriptionCount()).toBe(2);

    await car.unsubscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]);

    expect(transport.monitorCanIds.size).toBe(0);
    expect(car.subscriptionCount()).toBe(0);
  });

  it("uses DBC enum labels by default and profile normalization when declared", async () => {
    const manager = new VirtualVehicleManager();
    const defaultTransport = new MockTransport();
    const defaultCar = await manager.connect({
      id: "default-labels",
      transport: defaultTransport,
      profiles: [enumProfile({
        labels: { off: "off", on: "on" },
      })],
    });

    await defaultCar.subscribe("LOW_BEAMS");
    defaultTransport.emitFrame(defaultCar.dbc.encodeSignal("HEADLAMP_STATE", 1));

    expect(defaultCar.state.get<string>("LOW_BEAMS")).toBe("on");

    const remapTransport = new MockTransport();
    const remapCar = await manager.connect({
      id: "remapped-labels",
      transport: remapTransport,
      profiles: [enumProfile({
        labels: { off: "inactive", on: "active" },
        normalize: {
          inactive: "off",
          active: "on",
        },
      })],
    });

    await remapCar.subscribe("LOW_BEAMS");
    remapTransport.emitFrame(remapCar.dbc.encodeSignal("HEADLAMP_STATE", 1));

    expect(remapCar.state.get<string>("LOW_BEAMS")).toBe("on");
  });

  it("tracks BLE frame refresh rate even when decoded values stay the same", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [testVehicleProfile],
    });

    await car.subscribe("ENGINE_RPM");

    for (let i = 0; i < 5; i += 1) {
      transport.emitFrame(car.dbc.encodeSignal("ENGINE_RPM", 900));
    }

    expect(car.signalRefreshStatus().hzByName.ENGINE_RPM).toBe(5);
    expect(car.state.get<number>("ENGINE_RPM")).toBe(900);
  });
});

function enumProfile(options: {
  labels: {
    off: string;
    on: string;
  };
  normalize?: Record<string, string>;
}): VehicleProfileSource {
  return {
    name: "test/enum-profile.yaml",
    content: [
      "version: 1",
      "",
      "dbc:",
      "  files:",
      "    - path: signals.dbc",
      "",
      "signals:",
      "  LOW_BEAMS:",
      "    monitor:",
      "      message: BODY_STATUS",
      "      signal: HEADLAMP_STATE",
      ...(options.normalize === undefined
        ? []
        : [
            "    normalize:",
            "      enum:",
            ...Object.entries(options.normalize).map(([from, to]) => `        ${from}: ${to}`),
          ]),
    ].join("\n"),
    dbcFiles: [{
      name: "signals.dbc",
      content: [
        'VERSION ""',
        "BO_ 700 BODY_STATUS: 8 ECU",
        ' SG_ HEADLAMP_STATE : 0|1@1+ (1,0) [0|1] "" ECU',
        `VAL_ 700 HEADLAMP_STATE 0 "${options.labels.off}" 1 "${options.labels.on}";`,
      ].join("\n"),
    }],
  };
}
