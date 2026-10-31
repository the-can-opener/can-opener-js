import type { DbcFile } from "../src/dbc/types.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import bmwExtendedAddressingProfileContent from "./fixtures/vehicles/bmw/extended-addressing/profile.yaml?raw";
import nissanSentraProfileContent from "./fixtures/vehicles/nissan/sentra/profile.yaml?raw";
import nissanSentraSignalsContent from "./fixtures/vehicles/nissan/sentra/signals.dbc?raw";
import testVehicleProfileContent from "./fixtures/vehicles/test/basic/profile.yaml?raw";
import testVehicleSignalsContent from "./fixtures/vehicles/test/basic/signals.dbc?raw";
import universalPidProfileContent from "./fixtures/vehicles/universal/pid/profile.yaml?raw";
import universalPidSignalsContent from "./fixtures/vehicles/universal/pid/signals.dbc?raw";

/** One BMW ECU behind ISO-TP extended addressing (`0x6F1` / `0x612`, addresses `0x12` / `0xF1`). */
export const bmwExtendedAddressingProfile: VehicleProfileSource = {
  name: "bmw/extended-addressing/profile.yaml",
  content: bmwExtendedAddressingProfileContent,
  dbcFiles: [],
};

export const nissanSentraDbc: DbcFile = {
  name: "signals.dbc",
  content: nissanSentraSignalsContent,
};

export const nissanSentraProfile: VehicleProfileSource = {
  name: "nissan/sentra/profile.yaml",
  content: nissanSentraProfileContent,
  dbcFiles: [nissanSentraDbc],
};

export const testVehicleDbc: DbcFile = {
  name: "signals.dbc",
  content: testVehicleSignalsContent,
};

export const testVehicleProfile: VehicleProfileSource = {
  name: "test/basic/profile.yaml",
  content: testVehicleProfileContent,
  dbcFiles: [testVehicleDbc],
};

export const universalPidProfile: VehicleProfileSource = {
  name: "universal/pid/profile.yaml",
  content: universalPidProfileContent,
  dbcFiles: [
    {
      name: "signals.dbc",
      content: universalPidSignalsContent,
    },
  ],
};
