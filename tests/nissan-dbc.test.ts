import { describe, expect, it } from "vitest";
import { DbcController } from "../src/dbc/DbcController.js";
import { DbcParser } from "../src/dbc/DbcParser.js";
import type { DbcFile } from "../src/dbc/types.js";

const nissanDbc: DbcFile = {
  name: "nissan-sentra-2010.dbc",
  content: `
VERSION "Generated from jackm/carhack nissan.md notes"

NS_ :
    NS_DESC_
    CM_
    BA_DEF_
    BA_
    VAL_
    CAT_DEF_
    CAT_
    FILTER
    BA_DEF_DEF_
    EV_DATA_
    ENVVAR_DATA_
    SGTYPE_
    SGTYPE_VAL_
    BA_DEF_SGTYPE_
    BA_SGTYPE_
    SIG_TYPE_REF_
    VAL_TABLE_
    SIG_GROUP_
    SIG_VALTYPE_
    SIGTYPE_VALTYPE_
    BO_TX_BU_
    BA_DEF_REL_
    BA_REL_
    BA_DEF_DEF_REL_
    BU_SG_REL_
    BU_EV_REL_
    BU_BO_REL_
    SG_MUL_VAL_

BS_:

BU_: BCM XXX Vector__XXX

BO_ 2 STEERING: 5 XXX
 SG_ COUNTER : 35|4@0+ (1,0) [0|255] "" XXX
 SG_ STEERING_ANGLE : 0|16@1- (0.1,0) [0|65535] "deg" XXX
 SG_ POWER_STEER_RATE : 23|8@0+ (1,0) [0|255] "" XXX

BO_ 1549 LIGHTS_STATUS_60D: 8 BCM
 SG_ FrontLightMode : 1|2@1+ (1,0) [0|3] "" Vector__XXX
 SG_ HighBeam : 11|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ TurnSignalTick : 13|2@1+ (1,0) [0|3] "" Vector__XXX
 SG_ DriverFrontDoorOpen : 3|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ PassengerFrontDoorOpen : 4|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ DriverRearDoorOpen : 5|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ PassengerRearDoorOpen : 6|1@1+ (1,0) [0|1] "" Vector__XXX

VAL_ 1549 FrontLightMode 0 "off" 2 "headlights_on" 3 "fog_lights_on";
VAL_ 1549 HighBeam 0 "off" 1 "on";
VAL_ 1549 TurnSignalTick 0 "off" 1 "left_tick" 2 "right_tick" 3 "hazard_blink_on";
VAL_ 1549 DriverFrontDoorOpen 0 "closed" 1 "open";
VAL_ 1549 PassengerFrontDoorOpen 0 "closed" 1 "open";
VAL_ 1549 DriverRearDoorOpen 0 "closed" 1 "open";
VAL_ 1549 PassengerRearDoorOpen 0 "closed" 1 "open";

CM_ BO_ 1549 "CAN ID 0x60D from Nissan Sentra 2010 notes. Light-related signals plus door ajar bits included because they share the same frame.";
CM_ SG_ 1549 FrontLightMode "From nissan.md: A.2-A.3 => 0b00 off, 0b10 headlights on, 0b11 fog lights on.";
CM_ SG_ 1549 HighBeam "From nissan.md: B.4 => 0 high beams off, 1 high beams on.";
CM_ SG_ 1549 TurnSignalTick "From nissan.md: B.6-B.7 => 0b00 off tick, 0b01 left turn tick, 0b10 right turn tick, 0b11 hazard blink on.";
CM_ SG_ 1549 DriverFrontDoorOpen "From nissan.md: A.4 => 0 closed, 1 open.";
CM_ SG_ 1549 PassengerFrontDoorOpen "From nissan.md: A.5 => 0 closed, 1 open.";
CM_ SG_ 1549 DriverRearDoorOpen "From nissan.md: A.6 => 0 closed, 1 open.";
CM_ SG_ 1549 PassengerRearDoorOpen "From nissan.md: A.7 => 0 closed, 1 open.";
`,
};

describe("Nissan Sentra DBC", () => {
  it("parses steering and lights messages from the uploaded DBC", () => {
    const parsed = new DbcParser().parse(nissanDbc);

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({
      id: 2,
      name: "STEERING",
      size: 5,
      transmitter: "XXX",
    });
    expect(parsed.messages[1]).toMatchObject({
      id: 1549,
      name: "LIGHTS_STATUS_60D",
      size: 8,
      transmitter: "BCM",
    });
    expect(parsed.messages[1]?.signals).toHaveLength(7);
    expect(parsed.valueTables.find((table) => table.signalName === "TurnSignalTick")?.values).toEqual({
      0: "off",
      1: "left_tick",
      2: "right_tick",
      3: "hazard_blink_on",
    });
  });

  it("classifies and decodes the shared lights status frame", () => {
    const dbc = new DbcController();
    dbc.load([nissanDbc]);

    expect(dbc.resolve("FrontLightMode")).toMatchObject({
      protocol: "frame",
      canId: 1549,
      startBit: 1,
      length: 2,
      enumValues: {
        0: "off",
        2: "headlights_on",
        3: "fog_lights_on",
      },
    });

    const decoded = dbc.decodeFrame({
      canId: 1549,
      data: Uint8Array.of(0b0100_1100, 0b0010_1000, 0, 0, 0, 0, 0, 0),
    });

    expect(decoded).toMatchObject([
      { name: "FrontLightMode", value: 2 },
      { name: "HighBeam", value: 1 },
      { name: "TurnSignalTick", value: 1 },
      { name: "DriverFrontDoorOpen", value: 1 },
      { name: "PassengerFrontDoorOpen", value: 0 },
      { name: "DriverRearDoorOpen", value: 0 },
      { name: "PassengerRearDoorOpen", value: 1 },
    ]);
  });
});
