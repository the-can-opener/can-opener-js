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
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

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
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

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
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

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

  it("loads per-step timing and the action batch opt-out", () => {
    const [profile] = new ProfileLoader().load([
      {
        name: "test/step-timing/profile.yaml",
        content: `version: 1

dbc:
  files:
    - path: signals.dbc

endpoints:
  body:
    request_id: 0x745
    response_id: 0x765
    timeout_ms: 500

sequences:
  prep:
    steps:
      - send: [0x02, 0x10, 0x81]
        expect: [0x50, 0x81]
        timeout_ms: 250
        delay_ms: 20

actions:
  HORN:
    endpoint: body
    batch: false
    steps:
      - ref: sequences.prep
      - send: [0x04, 0x30, 0x30, 0x00, 0x01]
        expect: [0x70, 0x30, 0x01]
`,
        dbcFiles: [testVehicleDbc],
      },
    ]);
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

    expect(profile.actions).toHaveLength(1);
    expect(profile.actions[0]).toMatchObject({
      name: "HORN",
      endpoint: "body",
      batch: false,
    });
    expect(profile.actions[0]?.steps[0]).toMatchObject({ timeoutMs: 250, delayMs: 20 });
    expect(profile.actions[0]?.steps[1]).not.toHaveProperty("delayMs");
  });

  it("rejects out-of-range step timing", () => {
    const load = (field: string, value: string) => () => new ProfileLoader().load([
      {
        name: "test/bad-timing/profile.yaml",
        content: `version: 1

endpoints:
  body:
    request_id: 0x745

actions:
  HORN:
    endpoint: body
    steps:
      - send: [0x01]
        ${field}: ${value}
`,
        dbcFiles: [],
      },
    ]);

    expect(load("delay_ms", "70000")).toThrow(/steps\.delay_ms/u);
    expect(load("timeout_ms", "-1")).toThrow(/steps\.timeout_ms/u);
    expect(load("delay_ms", "1.5")).toThrow(/steps\.delay_ms/u);
  });
});
