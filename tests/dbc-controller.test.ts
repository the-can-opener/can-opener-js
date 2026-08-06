import { describe, expect, it } from "vitest";
import { DbcController } from "../src/dbc/DbcController.js";
import { testVehicleDbc, universalPidProfile } from "./fixtures.js";

describe("DbcController", () => {
  it("classifies signals from DBC attributes", () => {
    const dbc = new DbcController();
    dbc.load([testVehicleDbc]);

    expect(dbc.resolve("VEHICLE_SPEED")).toMatchObject({
      protocol: "pid",
      canId: 201,
      diagnostic: {
        request: {
          canId: 200,
          pid: 13,
        },
        response: {
          canId: 201,
          pid: 13,
        },
      },
    });
    expect(dbc.resolve("DOOR_LOCK")).toMatchObject({
      protocol: "frame",
    });
  });

  it("encodes and decodes frame signals", () => {
    const dbc = new DbcController();
    dbc.load([testVehicleDbc]);
    const frame = dbc.encodeSignal("ENGINE_RPM", 1200);

    expect(dbc.decodeFrame(frame)).toMatchObject([
      {
        name: "ENGINE_RPM",
        value: 1200,
      },
    ]);
  });

  it("decodes DBC enum values as labels", () => {
    const dbc = new DbcController();
    dbc.load([testVehicleDbc]);
    const frame = dbc.encodeSignal("DOOR_LOCK", 1);

    expect(dbc.decodeFrame(frame)).toMatchObject([
      {
        name: "DOOR_LOCK",
        value: "locked",
      },
    ]);
  });

  it("loads universal PID DBC files from the profile source", () => {
    const dbc = new DbcController();
    dbc.load(universalPidProfile.dbcFiles);

    expect(dbc.resolveMessageSignal("OBD_Response_7E8", "SPEED")).toMatchObject({
      name: "SPEED",
      canId: 2024,
    });
    expect(dbc.decodeMessageSignal("OBD_Response_7E8", "SPEED", Uint8Array.of(0, 0x41, 0x0d, 88, 0, 0, 0, 0))).toBe(88);
  });

  it("decodes signals with duplicate names from different messages", () => {
    const dbc = new DbcController();
    dbc.load([
      {
        name: "toyota-rav4.dbc",
        content: [
          "BO_ 180 VEHICLE_SPEED: 8 Vehicle",
          ' SG_ SPEED : 47|16@0+ (0.01,0) [0|655.35] "km/h" CANOpener',
        ].join("\n"),
      },
      ...universalPidProfile.dbcFiles,
    ]);

    expect(
      dbc.decodeFrame({
        canId: 180,
        data: Uint8Array.of(0, 0, 0, 0, 0, 0x07, 0xd0, 0),
      }),
    ).toMatchObject([
      {
        name: "SPEED",
        value: 20,
        signal: {
          messageName: "VEHICLE_SPEED",
          canId: 180,
        },
      },
    ]);
  });
});
