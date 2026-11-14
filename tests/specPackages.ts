// The example packages of https://github.com/the-can-opener/vehicle-profile-spec,
// copied under tests/fixtures/spec with the fixture files that describe them.
import type { VehicleProfileSource } from "../src/profile/types.js";
import bmwAddressingFixtures from "./fixtures/spec/bmw-addressing/fixtures.yaml?raw";
import bmwAddressingManifest from "./fixtures/spec/bmw-addressing/vehicle.yaml?raw";
import canFdDualBusFixtures from "./fixtures/spec/canfd-dual-bus/fixtures.yaml?raw";
import canFdDualBusManifest from "./fixtures/spec/canfd-dual-bus/vehicle.yaml?raw";
import hvacSyntheticFixtures from "./fixtures/spec/hvac-synthetic/fixtures.yaml?raw";
import hvacSyntheticManifest from "./fixtures/spec/hvac-synthetic/vehicle.yaml?raw";
import versaActions from "./fixtures/spec/nissan-versa/actions.yaml?raw";
import versaBase from "./fixtures/spec/nissan-versa/base.yaml?raw";
import versaBody from "./fixtures/spec/nissan-versa/body.yaml?raw";
import versaFixtures from "./fixtures/spec/nissan-versa/fixtures/body.yaml?raw";
import versaPowertrain from "./fixtures/spec/nissan-versa/powertrain.yaml?raw";
import versaSignals from "./fixtures/spec/nissan-versa/signals.dbc?raw";
import versaManifest from "./fixtures/spec/nissan-versa/vehicle.yaml?raw";
import universalObdFixtures from "./fixtures/spec/universal-obd/fixtures.yaml?raw";
import universalObdManifest from "./fixtures/spec/universal-obd/vehicle.yaml?raw";

export interface SpecPackage {
  source: VehicleProfileSource;
  /** The package's fixture file. */
  fixtures: string;
}

function singleFile(name: string, content: string, fixtures: string): SpecPackage {
  return { source: { name, content, dbcFiles: [] }, fixtures };
}

export const versaPackage: SpecPackage = {
  source: {
    name: "nissan-versa/vehicle.yaml",
    content: versaManifest,
    documents: [
      { name: "base.yaml", content: versaBase },
      { name: "body.yaml", content: versaBody },
      { name: "powertrain.yaml", content: versaPowertrain },
      { name: "actions.yaml", content: versaActions },
    ],
    dbcFiles: [{ name: "signals.dbc", content: versaSignals }],
  },
  fixtures: versaFixtures,
};

export const universalObdPackage = singleFile("universal-obd/vehicle.yaml", universalObdManifest, universalObdFixtures);
export const hvacSyntheticPackage = singleFile("hvac-synthetic/vehicle.yaml", hvacSyntheticManifest, hvacSyntheticFixtures);
export const canFdDualBusPackage = singleFile("canfd-dual-bus/vehicle.yaml", canFdDualBusManifest, canFdDualBusFixtures);
export const bmwAddressingPackage = singleFile("bmw-addressing/vehicle.yaml", bmwAddressingManifest, bmwAddressingFixtures);

export const specPackages: Record<string, SpecPackage> = {
  "nissan-versa": versaPackage,
  "universal-obd": universalObdPackage,
  "hvac-synthetic": hvacSyntheticPackage,
  "canfd-dual-bus": canFdDualBusPackage,
  "bmw-addressing": bmwAddressingPackage,
};
