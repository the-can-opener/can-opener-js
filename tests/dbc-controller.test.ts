import { describe, expect, it } from "vitest";
import { DbcController } from "../src/dbc/DbcController.js";
import { obd2PidDbc, vehicleDbc } from "./fixtures.js";

describe("DbcController", () => {
  it("classifies signals from DBC attributes", () => {
    const dbc = new DbcController();
    dbc.load([vehicleDbc]);

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
    dbc.load([vehicleDbc]);
    const frame = dbc.encodeSignal("ENGINE_RPM", 1200);

    expect(dbc.decodeFrame(frame)).toMatchObject([
      {
        name: "ENGINE_RPM",
        value: 1200,
      },
    ]);
  });

  it("links OBD-II PID requests and responses through diagnostic metadata", () => {
    const dbc = new DbcController();
    dbc.load([obd2PidDbc]);

    expect(dbc.resolve("Vehicle_Speed")).toMatchObject({
      protocol: "pid",
      canId: 2024,
      diagnostic: {
        request: {
          canId: 2015,
          serviceId: 0x01,
          pid: 0x0d,
        },
        response: {
          canId: 2024,
          serviceId: 0x41,
          pid: 0x0d,
        },
      },
    });
    expect(dbc.resolve("VIN")).toMatchObject({
      diagnostic: {
        request: {
          canId: 2015,
          serviceId: 0x09,
          pid: 0x02,
        },
        response: {
          canId: 2024,
          serviceId: 0x49,
          pid: 0x02,
        },
        transport: "isotp",
        responseLength: 18,
      },
    });
  });
});
