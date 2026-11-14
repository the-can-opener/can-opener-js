import { describe, expect, it } from "vitest";
import type { CanFrame } from "../src/dbc/types.js";
import { UnknownVehicleSignalError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { mappedActionName } from "../src/profile/loaders/mapUp.js";
import { keywordFor } from "../src/profile/loaders/vocabulary.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import { nissanSentraProfile, testVehicleProfile, universalPidProfile } from "./fixtures.js";
import { universalObdPackage, versaPackage } from "./specPackages.js";

const LOCK_PATH = "Vehicle.Cabin.IsCentralLockEngaged";
const HORN_PATH = "Vehicle.Body.Horn.IsActive";
const SPEED_PATH = "Vehicle.Speed";

const BODY_SESSION_PREP = [
  { send: [0x02, 0x10, 0x81], response: [0x50, 0x81] },
  { send: [0x02, 0x10, 0xc0], response: [0x50, 0xc0] },
];

async function connect(profiles: VehicleProfileSource[]) {
  const transport = new MockTransport();
  const car = await new VirtualVehicleManager().connect({ id: "car", transport, profiles });
  return { car, transport };
}

function bodyFrame(bytes: number[]): CanFrame {
  const data = new Uint8Array(8);
  data.set(bytes);
  return { canId: 0x745, data };
}

/** Scripts the Versa body ECU to accept the session prep and one final request. */
function scriptBodyCommand(transport: MockTransport, send: number[], response: number[]): void {
  for (const step of [...BODY_SESSION_PREP, { send, response }]) {
    transport.scriptPidResponse(bodyFrame(step.send), Uint8Array.from(step.response));
  }
}

function sentBytes(transport: MockTransport): number[][] {
  return transport.requests.map((request) => Array.from(request.txFrame.data.slice(0, 5)));
}

describe("format 1 profiles mapped onto VSS paths", () => {
  it("turns keyword commands into write cases on the VSS path", () => {
    const [profile] = new ProfileLoader().load([nissanSentraProfile]);
    const lock = profile?.properties.find((property) => property.path === LOCK_PATH);
    const horn = profile?.properties.find((property) => property.path === HORN_PATH);

    // DOORS.lock is `Vehicle.Cabin.IsCentralLockEngaged = true`, DOORS.unlock is `= false`.
    expect(Object.keys(lock?.write?.cases ?? {}).sort()).toEqual(["false", "true"]);
    expect(Array.from(lock?.write?.cases?.["true"]?.steps.at(-1)?.send ?? []).slice(0, 5)).toEqual([0x04, 0x30, 0x38, 0x00, 0x01]);
    expect(Array.from(lock?.write?.cases?.["false"]?.steps.at(-1)?.send ?? []).slice(0, 5)).toEqual([0x04, 0x30, 0x38, 0x00, 0x02]);
    expect(Object.keys(horn?.write?.cases ?? {})).toEqual(["true"]);
    expect(profile?.actions).toEqual([]);
    expect(keywordFor(LOCK_PATH, true)).toBe("LOCK");
    expect(keywordFor(LOCK_PATH, false)).toBe("UNLOCK");
  });

  it("keys signals and queries by VSS path and types them from the catalog", () => {
    const [sentra] = new ProfileLoader().load([nissanSentraProfile]);
    const [pid] = new ProfileLoader().load([universalPidProfile]);

    expect(sentra?.properties.find((property) => property.path === SPEED_PATH)).toMatchObject({
      datatype: "float",
      unit: "km/h",
      aliases: ["SPEED"],
      signal: { name: SPEED_PATH, message: "SPEED", signal: "SPEED" },
    });
    expect(pid?.properties.find((property) => property.path === SPEED_PATH)?.query).toMatchObject({
      name: SPEED_PATH,
      endpoint: "obd",
    });
  });

  it("keeps the original name of a keyword outside the vocabulary", () => {
    const [profile] = new ProfileLoader().load([testVehicleProfile]);

    expect(profile?.properties.map((property) => property.path)).toEqual(
      expect.arrayContaining(["ENGINE_RPM", "TURN_SIGNAL_LEFT"]),
    );
    expect(profile?.queries.map((query) => query.name)).toEqual(["VEHICLE_SPEED"]);
  });
});

describe("VSS methods", () => {
  it("reads a property by VSS path", async () => {
    const { car, transport } = await connect([universalObdPackage.source]);
    transport.scriptPidResponse(
      { canId: 0x7e0, data: Uint8Array.from([0x02, 0x01, 0x0d, 0, 0, 0, 0, 0]) },
      Uint8Array.from([0x41, 0x0d, 0x32]),
    );

    await expect(car.read<number>(SPEED_PATH)).resolves.toBe(50);
    expect(car.state.get<number>(SPEED_PATH)).toBe(50);
  });

  it("rejects an alias name", async () => {
    const { car, transport } = await connect([versaPackage.source, universalObdPackage.source]);

    await expect(car.read("SPEED")).rejects.toThrow(
      "SPEED is an alias of Vehicle.Speed. Pass the VSS path, or use the alias methods.",
    );
    await expect(car.set("LOCK", true)).rejects.toThrow(`LOCK is an alias of ${LOCK_PATH}`);
    await expect(car.subscribe("SPEED")).rejects.toThrow("SPEED is an alias of Vehicle.Speed");
    await expect(car.read("Vehicle.NotLoaded")).rejects.toBeInstanceOf(UnknownVehicleSignalError);
    expect(transport.requests).toEqual([]);
  });

  it("writes a property and leaves state to observations", async () => {
    const { car, transport } = await connect([versaPackage.source]);
    scriptBodyCommand(transport, [0x04, 0x30, 0x38, 0x00, 0x02], [0x70, 0x38, 0x02]);

    await expect(car.set(LOCK_PATH, false)).resolves.toBe("acknowledged");
    expect(sentBytes(transport).at(-1)).toEqual([0x04, 0x30, 0x38, 0x00, 0x02]);
    expect(car.state.get(LOCK_PATH)).toBeUndefined();
  });

  it("rejects a value of the wrong datatype and a target with no case", async () => {
    const { car, transport } = await connect([versaPackage.source]);

    await expect(car.set(LOCK_PATH, "locked")).rejects.toThrow(`${LOCK_PATH} takes a boolean`);
    await expect(car.set(HORN_PATH, false)).rejects.toThrow(`${HORN_PATH} does not support the target false`);
    await expect(car.set(SPEED_PATH, 10)).rejects.toThrow(`${SPEED_PATH} is not writable`);
    expect(transport.requests).toEqual([]);
  });

  it("invokes a named action", async () => {
    const { car, transport } = await connect([versaPackage.source]);
    scriptBodyCommand(transport, [0x04, 0x30, 0x2f, 0x00, 0x00], [0x70, 0x2f, 0x00]);

    await expect(car.invoke("SIGNAL_OFF")).resolves.toBe("acknowledged");
    await expect(car.invoke(HORN_PATH)).rejects.toThrow(`Unknown vehicle action: ${HORN_PATH}`);
  });
});

describe("alias methods", () => {
  it("reads and subscribes through a property alias", async () => {
    const { car, transport } = await connect([versaPackage.source, universalObdPackage.source]);
    transport.scriptPidResponse(
      { canId: 0x7e0, data: Uint8Array.from([0x02, 0x01, 0x0d, 0, 0, 0, 0, 0]) },
      Uint8Array.from([0x41, 0x0d, 0x32]),
    );

    await expect(car.alias.read<number>("SPEED")).resolves.toBe(50);
    // LOCKED names the central lock path. Nothing has observed it, and it has no query to send.
    await expect(car.alias.read("LOCKED")).resolves.toBeUndefined();
    await expect(car.alias.subscribe("SPEED")).resolves.toBe(true);
    expect(car.subscriptionCount()).toBe(1);
    await car.alias.unsubscribe("SPEED");
    expect(car.subscriptionCount()).toBe(0);
  });

  it("rejects a VSS path and a command alias where a property alias is expected", async () => {
    const { car, transport } = await connect([versaPackage.source]);

    await expect(car.alias.read("LOCK")).rejects.toThrow(
      "LOCK is a command alias. Run it with alias.command(), or read and write its VSS path.",
    );
    await expect(car.alias.set("UNLOCK", true)).rejects.toThrow("UNLOCK is a command alias");
    await expect(car.alias.subscribe(SPEED_PATH)).rejects.toThrow(
      "Vehicle.Speed is a VSS path, not an alias. Use the VSS methods.",
    );
    await expect(car.alias.read("NOT_A_KEYWORD")).rejects.toThrow("Unknown alias: NOT_A_KEYWORD");
    expect(transport.requests).toEqual([]);
  });

  it("runs each command alias against its path and target", async () => {
    const { car, transport } = await connect([versaPackage.source]);

    scriptBodyCommand(transport, [0x04, 0x30, 0x30, 0x00, 0x01], [0x70, 0x30, 0x01]);
    await expect(car.alias.command("HORN")).resolves.toBe("acknowledged");
    expect(sentBytes(transport).at(-1)).toEqual([0x04, 0x30, 0x30, 0x00, 0x01]);
    expect(transport.requests.at(-1)?.signalName).toBe(`${HORN_PATH}=true`);

    scriptBodyCommand(transport, [0x04, 0x30, 0x38, 0x00, 0x01], [0x70, 0x38, 0x01]);
    await expect(car.alias.command("LOCK")).resolves.toBe("acknowledged");
    expect(sentBytes(transport).at(-1)).toEqual([0x04, 0x30, 0x38, 0x00, 0x01]);
    expect(transport.requests.at(-1)?.signalName).toBe(`${LOCK_PATH}=true`);

    scriptBodyCommand(transport, [0x04, 0x30, 0x38, 0x00, 0x02], [0x70, 0x38, 0x02]);
    await expect(car.alias.command("UNLOCK")).resolves.toBe("acknowledged");
    expect(sentBytes(transport).at(-1)).toEqual([0x04, 0x30, 0x38, 0x00, 0x02]);
    expect(transport.requests.at(-1)?.signalName).toBe(`${LOCK_PATH}=false`);

    scriptBodyCommand(transport, [0x04, 0x30, 0x2f, 0x00, 0x00], [0x70, 0x2f, 0x00]);
    await expect(car.alias.command("SIGNAL_OFF")).resolves.toBe("acknowledged");
    expect(transport.requests.at(-1)?.signalName).toBe("SIGNAL_OFF");
  });

  it("runs the command aliases of a format 1 profile the same way", async () => {
    const { car, transport } = await connect([nissanSentraProfile]);
    scriptBodyCommand(transport, [0x04, 0x30, 0x38, 0x00, 0x01], [0x70, 0x38, 0x01]);

    await expect(car.alias.command("LOCK")).resolves.toBe("acknowledged");
    expect(transport.requests.at(-1)?.signalName).toBe(`${LOCK_PATH}=true`);
  });

  it("rejects a property alias as a command", async () => {
    const { car } = await connect([versaPackage.source]);

    await expect(car.alias.command("SPEED")).rejects.toThrow(
      "SPEED is a property alias of Vehicle.Speed. It names no command; use alias.set().",
    );
  });

  it("lists property and command aliases with the path and target each names", async () => {
    const { car } = await connect([versaPackage.source]);
    const aliases = new Map(car.alias.list().map((alias) => [alias.name, alias]));

    expect(aliases.get("SPEED")).toEqual({ name: "SPEED", kind: "property", path: SPEED_PATH, declared: true });
    expect(aliases.get("LOCKED")).toEqual({ name: "LOCKED", kind: "property", path: LOCK_PATH, declared: false });
    expect(aliases.get("LOCK")).toEqual({ name: "LOCK", kind: "command", path: LOCK_PATH, target: true, declared: true });
    expect(aliases.get("UNLOCK")).toEqual({ name: "UNLOCK", kind: "command", path: LOCK_PATH, target: false, declared: true });
    expect(aliases.get("HORN")).toEqual({ name: "HORN", kind: "command", path: HORN_PATH, target: true, declared: true });
    expect(aliases.get("SIGNAL_OFF")).toEqual({ name: "SIGNAL_OFF", kind: "command", action: "SIGNAL_OFF", declared: true });
  });
});

describe("allowedKeys", () => {
  it("loads only the listed signals, queries, and actions", async () => {
    const { car } = await connect([
      {
        ...versaPackage.source,
        allowedKeys: { signals: [SPEED_PATH], queries: [], actions: [HORN_PATH, "SIGNAL_OFF"] },
      },
    ]);

    await expect(car.subscribe(SPEED_PATH)).resolves.toBe(true);
    await expect(car.subscribe("Vehicle.Body.Lights.Beam.Low.IsOn")).rejects.toBeInstanceOf(UnknownVehicleSignalError);
    await expect(car.set(LOCK_PATH, true)).rejects.toBeInstanceOf(UnknownVehicleSignalError);
    await expect(car.invoke("ECU_WAKE")).rejects.toThrow("Unknown vehicle action: ECU_WAKE");
    expect(car.alias.list().map((alias) => alias.name)).toEqual(expect.arrayContaining(["HORN", "SIGNAL_OFF", "SPEED"]));
    expect(car.alias.list().map((alias) => alias.name)).not.toContain("LOCK");
  });

  it("keeps the bindings of a property that are listed and drops the rest", () => {
    const [profile] = new ProfileLoader().load([
      { ...versaPackage.source, allowedKeys: { actions: [] } },
    ]);
    const lowBeam = profile?.properties.find((property) => property.path === "Vehicle.Body.Lights.Beam.Low.IsOn");

    expect(lowBeam?.signal).toBeDefined();
    expect(lowBeam?.write).toBeUndefined();
    expect(profile?.properties.some((property) => property.path === LOCK_PATH)).toBe(false);
    expect(profile?.actions).toEqual([]);
  });

  it("keeps one write case that is listed by name", async () => {
    const { car, transport } = await connect([
      { ...versaPackage.source, allowedKeys: { actions: [`${LOCK_PATH}=true`] } },
    ]);
    scriptBodyCommand(transport, [0x04, 0x30, 0x38, 0x00, 0x01], [0x70, 0x38, 0x01]);

    await expect(car.set(LOCK_PATH, true)).resolves.toBe("acknowledged");
    await expect(car.set(LOCK_PATH, false)).rejects.toThrow(`${LOCK_PATH} does not support the target false`);
    await expect(car.set(HORN_PATH, true)).rejects.toBeInstanceOf(UnknownVehicleSignalError);
  });
});

describe("mappedActionName", () => {
  it("names a format 1 action the way the loader maps it", () => {
    expect(mappedActionName("LOCK")).toBe(`${LOCK_PATH}=true`);
    expect(mappedActionName("DOORS.unlock")).toBe(`${LOCK_PATH}=false`);
    expect(mappedActionName("HORN")).toBe(`${HORN_PATH}=true`);
    expect(mappedActionName("TRUNK.open")).toBe("Vehicle.Body.Trunk.Rear.IsOpen=true");
    expect(mappedActionName("MIRRORS.fold")).toBe("MIRRORS_FOLD");
    expect(mappedActionName("SIGNAL_OFF")).toBe("SIGNAL_OFF");
    expect(mappedActionName("LIGHT_SHOW")).toBe("LIGHT_SHOW");
    expect(mappedActionName(`${LOCK_PATH}=true`)).toBe(`${LOCK_PATH}=true`);
  });
});
