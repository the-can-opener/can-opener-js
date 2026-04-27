import { describe, expect, it } from "vitest";
import { DbcController } from "../src/dbc/DbcController.js";
import { vehicleDbc } from "./fixtures.js";

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
});
