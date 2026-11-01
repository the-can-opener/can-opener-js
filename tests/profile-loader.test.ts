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

  it("expands a stateful entity into one action per target value", () => {
    const [profile] = new ProfileLoader().load([
      {
        name: "test/value-actions/profile.yaml",
        content: `version: 1

endpoints:
  body:
    request_id: 0x745
    response_id: 0x765

sequences:
  prep:
    steps:
      - send: [0x02, 0x10, 0x81]
        expect: [0x50, 0x81]

actions:
  TRUNK:
    endpoint: body
    batch: false
    values:
      open:
        send: [0x04, 0x30, 0x40, 0x00, 0x01]
        expect: [0x70, 0x40, 0x01]
      closed:
        steps:
          - ref: sequences.prep
          - send: [0x04, 0x30, 0x40, 0x00, 0x02]
            expect: [0x70, 0x40, 0x02]
  SUNROOF.open:
    endpoint: body
    send: [0x04, 0x30, 0x41, 0x00, 0x01]
  HORN:
    endpoint: body
    send: [0x04, 0x30, 0x30, 0x00, 0x01]
`,
        dbcFiles: [],
      },
    ]);
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

    expect(profile.actions.map((action) => action.name)).toEqual([
      "TRUNK.open",
      "TRUNK.closed",
      "SUNROOF.open",
      "HORN",
    ]);
    expect(profile.actions[0]).toMatchObject({
      name: "TRUNK.open",
      entity: "TRUNK",
      value: "open",
      endpoint: "body",
      batch: false,
    });
    expect(profile.actions[0]?.steps).toHaveLength(1);
    expect(profile.actions[1]).toMatchObject({ entity: "TRUNK", value: "closed", endpoint: "body", batch: false });
    expect(profile.actions[1]?.steps).toHaveLength(2);
    expect(profile.actions[1]?.steps[0]?.endpoint).toBe("body");
    expect(profile.actions[2]).toMatchObject({ entity: "SUNROOF", value: "open" });
    expect(profile.actions[3]).not.toHaveProperty("entity");
  });

  it("accepts spec versions 1 and 1.1 and rejects others", () => {
    const load = (version: string) => () => new ProfileLoader().load([
      { name: "test/version/profile.yaml", content: `version: ${version}\n`, dbcFiles: [] },
    ]);

    expect(load("1")).not.toThrow();
    expect(load("1.1")).not.toThrow();
    expect(load("2")).toThrow(/version: 1 or 1\.1/u);
    expect(load("\"1.1\"")).toThrow(/version: 1 or 1\.1/u);
  });

  it("rejects malformed value branches", () => {
    const load = (actions: string) => () => new ProfileLoader().load([
      {
        name: "test/bad-values/profile.yaml",
        content: `version: 1

endpoints:
  body:
    request_id: 0x745

actions:
${actions}
`,
        dbcFiles: [],
      },
    ]);

    expect(load(`  TRUNK:
    endpoint: body
    send: [0x01]
    values:
      open: { send: [0x02] }`)).toThrow(/cannot declare both values/u);
    expect(load(`  TRUNK.open:
    endpoint: body
    values:
      open: { send: [0x02] }`)).toThrow(/dotted entity name/u);
    expect(load(`  TRUNK:
    endpoint: body
    values: [open]`)).toThrow(/values must be an object/u);
    expect(load(`  TRUNK:
    endpoint: body
    values:
      open:
        values:
          again: { send: [0x02] }`)).toThrow(/cannot nest values/u);
    expect(load(`  TRUNK.open.now:
    endpoint: body
    send: [0x01]`)).toThrow(/only one/u);
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
