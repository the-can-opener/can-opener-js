import { describe, expect, it } from "vitest";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import { testVehicleDbc } from "./fixtures.js";

describe("ProfileLoader", () => {
  it("skips placeholder actions that do not declare send bytes or steps", () => {
    const [profile] = new ProfileLoader().load([
      {
        name: "test/placeholder-actions/profile.yaml",
        content: `version: 1

dbc:
  files:
    - path: signals.dbc

endpoints:
  body:
    request_id: 300

actions:
  HORN:
    endpoint: body
    send: [0x01]
  WIPERS: {}
`,
        dbcFiles: [testVehicleDbc],
      },
    ]);

    expect(profile.actions.map((action) => action.name)).toEqual(["HORN"]);
  });

  it("loads monitor signals from profiles with skipped placeholder actions", () => {
    const [profile] = new ProfileLoader().load([
      {
        name: "test/placeholder-actions/profile.yaml",
        content: `version: 1

dbc:
  files:
    - path: signals.dbc

signals:
  ENGINE_RPM:
    monitor:
      message: POWERTRAIN
      signal: ENGINE_RPM

actions:
  WIPERS: {}
`,
        dbcFiles: [testVehicleDbc],
      },
    ]);

    expect(profile.signals.map((signal) => signal.name)).toEqual(["ENGINE_RPM"]);
    expect(profile.actions).toEqual([]);
  });

  it("loads actions that declare inline request_id and request bytes", () => {
    const [profile] = new ProfileLoader().load([
      {
        name: "test/inline-request/profile.yaml",
        content: `version: 1

dbc:
  files:
    - path: signals.dbc

actions:
  WIPERS:
    send:
      request_id: 0x35D
      request: [0xC1, 0x03, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]
`,
        dbcFiles: [testVehicleDbc],
      },
    ]);

    expect(profile.actions).toEqual([
      {
        name: "WIPERS",
        steps: [
          {
            requestId: 0x35D,
            send: Uint8Array.from([0xC1, 0x03, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]),
          },
        ],
      },
    ]);
  });
});
