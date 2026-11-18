import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/profile/CapabilityRegistry.js";
import { loadFormat1 } from "../src/profile/loaders/format1.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import type { LoadedVehicleProfile, VehicleProfileSource } from "../src/profile/types.js";
import { testVehicleDbc } from "./fixtures.js";

/** Format 1 profiles as parsed, before `ProfileLoader` maps them onto VSS paths. */
function loadFormat1Profiles(sources: readonly VehicleProfileSource[]) {
  return sources.map(loadFormat1);
}

describe("profile endpoint priority", () => {
  it("scopes property queries, direct writes, and step endpoints without mutating the profiles", () => {
    const action = {
      name: "SET_LEVEL",
      endpoint: "diagnostics",
      steps: [{ endpoint: "diagnostics", send: new Uint8Array([2]) }],
    };
    const profile: LoadedVehicleProfile = {
      name: "base",
      dbcFiles: [],
      canBuses: [],
      endpoints: [{ name: "diagnostics", requestId: 200, responseRanges: [] }],
      properties: [{
        path: "Custom.Level",
        query: { name: "Custom.Level", endpoint: "diagnostics", send: new Uint8Array([1]) },
        write: { direct: action },
      }],
      queries: [],
      actions: [action],
    };
    const override: LoadedVehicleProfile = {
      ...profile,
      name: "override",
      endpoints: [{ name: "diagnostics", requestId: 400, responseRanges: [] }],
      properties: [],
      actions: [],
    };
    const registry = new CapabilityRegistry();
    registry.load([profile, override]);

    const query = registry.resolvePolledQuery("Custom.Level");
    expect(registry.resolveEndpoint(query.endpoint).requestId).toBe(200);
    for (const binding of [registry.resolveAction("SET_LEVEL"), registry.resolveWrite("Custom.Level", 1)]) {
      expect(registry.resolveEndpoint(binding.endpoint!).requestId).toBe(200);
      expect(registry.resolveEndpoint(binding.steps[0]!.endpoint!).requestId).toBe(200);
    }
    expect(profile.properties[0]!.query!.endpoint).toBe("diagnostics");
    expect(profile.properties[0]!.write!.direct).toBe(action);
    expect(action.endpoint).toBe("diagnostics");
    expect(action.steps[0]!.endpoint).toBe("diagnostics");
    expect(profile.endpoints[0]!.name).toBe("diagnostics");

    registry.load([override]);
    expect(() => registry.resolvePolledQuery("Custom.Level")).toThrow();
    expect(() => registry.resolveEndpoint("1:diagnostics")).toThrow("Unknown profile endpoint");
    expect(registry.resolveEndpoint("diagnostics").requestId).toBe(400);
  });

  it("keeps queries and actions bound to their profile's endpoints", () => {
    const source = (requestId: number, allowedKeys?: VehicleProfileSource["allowedKeys"]): VehicleProfileSource => ({
      name: `${requestId}.yaml`,
      content: `version: 1
endpoints:
  diagnostics:
    request_id: ${requestId}
queries:
  CUSTOM_QUERY:
    endpoint: diagnostics
    send: [1]
actions:
  CUSTOM_ACTION:
    endpoint: diagnostics
    send: [2]
  HORN:
    endpoint: diagnostics
    send: [3]
`,
      dbcFiles: [],
      ...(allowedKeys === undefined ? {} : { allowedKeys }),
    });
    const loader = new ProfileLoader();
    const registry = new CapabilityRegistry();
    const low = source(200);
    const high = source(400, { queries: [], actions: [] });
    registry.load(loader.load([low, high]));

    const endpointId = (name: string) => registry.resolveEndpoint(name).requestId;
    expect(registry.resolveEndpoint("diagnostics").requestId).toBe(400);
    expect(endpointId(registry.resolveQuery("CUSTOM_QUERY").endpoint)).toBe(200);
    const action = registry.resolveAction("CUSTOM_ACTION");
    expect(action.endpoint).toBeDefined();
    expect(endpointId(action.endpoint!)).toBe(200);
    const write = registry.resolveWrite("Vehicle.Body.Horn.IsActive", true);
    expect(endpointId(write.steps[0]?.endpoint ?? write.endpoint!)).toBe(200);

    registry.load(loader.load([low, source(400)]));
    expect(endpointId(registry.resolveQuery("CUSTOM_QUERY").endpoint)).toBe(400);
    const overridden = registry.resolveWrite("Vehicle.Body.Horn.IsActive", true);
    expect(endpointId(overridden.steps[0]?.endpoint ?? overridden.endpoint!)).toBe(400);
  });
});

describe("ProfileLoader with format 1 profiles", () => {
  it("skips placeholder actions that do not declare send bytes or steps", () => {
    const [profile] = loadFormat1Profiles([
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
    const [profile] = loadFormat1Profiles([
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
    const [profile] = loadFormat1Profiles([
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
    const [profile] = loadFormat1Profiles([
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

  it("expands a stateful entity into one action per command", () => {
    const [profile] = loadFormat1Profiles([
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
      close:
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
      "TRUNK.close",
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
    expect(profile.actions[1]).toMatchObject({ entity: "TRUNK", value: "close", endpoint: "body", batch: false });
    expect(profile.actions[1]?.steps).toHaveLength(2);
    expect(profile.actions[1]?.steps[0]?.endpoint).toBe("body");
    expect(profile.actions[2]).toMatchObject({ entity: "SUNROOF", value: "open" });
    expect(profile.actions[3]).not.toHaveProperty("entity");
  });

  it("loads format 1 and 1.1 and skips every other profile version", () => {
    const load = (version: string) => new ProfileLoader().load([
      { name: "test/version/profile.yaml", content: `version: ${version}\n`, dbcFiles: [] },
    ]);

    expect(load("1")).toHaveLength(1);
    expect(load("1.1")).toHaveLength(1);
    expect(load("\"1.1\"")).toHaveLength(1);
    expect(load("2")).toEqual([]);

    const profiles = new ProfileLoader().load([
      {
        name: "future/profile.yaml",
        content: "version: 2\nactions:\n  HORN:\n    send: [0x01]\n",
        dbcFiles: [],
      },
      {
        name: "current/profile.yaml",
        content: "version: \"1.1\"\nactions:\n  WIPERS:\n    send: [0x02]\n",
        dbcFiles: [],
      },
      {
        name: "original/profile.yaml",
        content: "version: 1\nactions:\n  LIGHTS:\n    send: [0x03]\n",
        dbcFiles: [],
      },
    ]);

    expect(profiles.map((profile) => profile.name)).toEqual([
      "current/profile.yaml",
      "original/profile.yaml",
    ]);
    // WIPERS is a vocabulary keyword, so it becomes a write; LIGHTS keeps its name.
    expect(profiles[0]?.properties.map((property) => property.path)).toEqual([
      "Vehicle.Body.Windshield.Front.Wiping.Mode",
    ]);
    expect(profiles[1]?.actions.map((action) => action.name)).toEqual(["LIGHTS"]);
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

  it("loads numeric encode actions with byte shorthand, bit ranges, and multi-step sequences", () => {
    const [profile] = loadFormat1Profiles([
      {
        name: "test/numeric-encode/profile.yaml",
        content: `version: 1.1

endpoints:
  climate:
    request_id: 0x745
    response_id: 0x765

sequences:
  prep:
    steps:
      - send: [0x02, 0x10, 0x81]
        expect: [0x50, 0x81]

actions:
  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode:
      byte: 4
      scale: 0.5
      offset: -40
      min: 16
      max: 32
      step: 0.5
    send: [0x04, 0x2E, 0x12, 0x34, 0x00, 0x00, 0x00, 0x00]
    expect: [0x6E, 0x12, 0x34]
  CHARGE_LIMIT:
    endpoint: climate
    encode:
      min: 50
      max: 100
      step: 5
    steps:
      - ref: sequences.prep
      - send: [0x04, 0x2E, 0x20, 0x00, 0x00]
        encode:
          start_bit: 24
          length: 12
          byte_order: big
          signed: true
          scale: 2
          offset: 10
        expect: [0x6E, 0x20]
`,
        dbcFiles: [],
      },
    ]);
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

    expect(profile.actions).toHaveLength(2);
    expect(profile.actions[0]).toMatchObject({
      name: "CABIN_TEMP_SETPOINT",
      entity: "CABIN_TEMP_SETPOINT",
      endpoint: "climate",
      input: { min: 16, max: 32, step: 0.5 },
    });
    expect(profile.actions[0]?.steps[0]?.encode).toEqual({
      startBit: 32,
      length: 8,
      scale: 0.5,
      offset: -40,
    });
    expect(profile.actions[1]).toMatchObject({
      name: "CHARGE_LIMIT",
      entity: "CHARGE_LIMIT",
      input: { min: 50, max: 100, step: 5 },
    });
    expect(profile.actions[1]?.steps).toHaveLength(2);
    expect(profile.actions[1]?.steps[0]?.encode).toBeUndefined();
    expect(profile.actions[1]?.steps[1]?.encode).toEqual({
      startBit: 24,
      length: 12,
      byteOrder: "big",
      signed: true,
      scale: 2,
      offset: 10,
    });
  });

  it("rejects malformed numeric encode definitions", () => {
    const load = (actions: string) => () => new ProfileLoader().load([
      {
        name: "test/bad-encode/profile.yaml",
        content: `version: 1.1

endpoints:
  climate:
    request_id: 0x745

sequences:
  prep:
    steps:
      - send: [0x02, 0x10, 0x81]

actions:
${actions}
`,
        dbcFiles: [],
      },
    ]);

    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 4 }
    values:
      "22": { send: [0x01] }`)).toThrow(/cannot declare both values/u);
    expect(load(`  CABIN_TEMP_SETPOINT.warm:
    endpoint: climate
    encode: { byte: 4 }
    send: [0x01, 0x00, 0x00, 0x00, 0x00]`)).toThrow(/dotted entity name/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 8 }
    send: [0x01]`)).toThrow(/between 0 and 7/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 4, start_bit: 32 }
    send: [0x01]`)).toThrow(/cannot declare both byte and start_bit/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { start_bit: 60, length: 8 }
    send: [0x01]`)).toThrow(/exceeds 8-byte CAN frame bounds/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 4, scale: 0 }
    send: [0x01]`)).toThrow(/scale must not be 0/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 4, min: 32, max: 16 }
    send: [0x01]`)).toThrow(/min must not exceed max/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 4, step: 0 }
    send: [0x01]`)).toThrow(/step must be a positive number/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { min: 16, max: 32 }
    send: [0x01]`)).toThrow(/must declare byte or start_bit/u);
    expect(load(`  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode: { byte: 4 }
    steps:
      - ref: sequences.prep`)).toThrow(/must declare byte or start_bit, or declare encode on a step/u);
  });
});
