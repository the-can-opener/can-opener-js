import { describe, expect, it } from "vitest";
import { DbcParser } from "../src/dbc/DbcParser.js";
import { testVehicleDbc } from "./fixtures.js";

describe("DbcParser", () => {
  it("parses messages, signals, attributes, and value tables", () => {
    const parsed = new DbcParser().parse(testVehicleDbc);

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages[0]?.signals[0]).toMatchObject({
      name: "ENGINE_RPM",
      startBit: 0,
      length: 16,
      byteOrder: "little",
      scale: 0.25,
      unit: "rpm",
    });
    expect(parsed.attributes).toContainEqual({
      name: "SignalProtocol",
      scope: "SG_",
      messageId: 201,
      signalName: "VEHICLE_SPEED",
      value: "pid",
    });
    expect(parsed.valueTables[0]?.values[1]).toBe("locked");
  });
});
