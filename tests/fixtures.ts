import type { DbcFile } from "../src/dbc/types.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import nissanSentraProfileContent from "./fixtures/vehicles/nissan/sentra/profile.yaml?raw";
import nissanSentraSignalsContent from "./fixtures/vehicles/nissan/sentra/signals.dbc?raw";
import testVehicleProfileContent from "./fixtures/vehicles/test/basic/profile.yaml?raw";
import testVehicleSignalsContent from "./fixtures/vehicles/test/basic/signals.dbc?raw";
import universalPidProfileContent from "./fixtures/vehicles/universal/pid/profile.yaml?raw";
import universalPidSignalsContent from "./fixtures/vehicles/universal/pid/signals.dbc?raw";

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
