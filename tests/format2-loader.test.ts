import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanPayload } from "../src/dbc/types.js";
import { NoEcuResponseError, VirtualVehicleError } from "../src/errors.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { parsePackageYaml } from "../src/profile/loaders/format2.js";
import { ProfileLoader, readProfileSource } from "../src/profile/ProfileLoader.js";
import type { VssValue } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import type { VehicleRequest } from "../src/transport/types.js";
import type { VirtualVehicle } from "../src/vehicle/VirtualVehicle.js";
import {
  bmwAddressingPackage,
  canFdDualBusPackage,
  hvacSyntheticPackage,
  specPackages,
  universalObdPackage,
  versaPackage,
  type SpecPackage,
} from "./specPackages.js";

interface FixtureResponse {
  /** CAN ID the response arrives from. Omitted: the endpoint's own responder. */
  id?: number;
  data: Uint8Array;
}

interface FixtureCase {
  label: string;
  kind: "signal" | "query" | "write" | "action";
  path?: string;
  name?: string;
  target?: VssValue;
  frame?: { id: string | number; data: string | number };
  responses?: (string | number | { id: string | number; data: string | number })[];
  expect: {
    value?: VssValue;
    quality?: "valid" | "invalid";
    error?: string;
    result?: string;
    sent?: (string | number)[];
  };
}

/** Answers requests from the fixture's scripted responses, in order. */
class FixtureTransport extends MockTransport {
  constructor(private readonly responses: FixtureResponse[]) {
    super();
  }

  override async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    this.requests.push(req);
    if (!req.expectCanResponse) {
      return undefined;
    }
    const response = this.responses.shift();
    if (response === undefined) {
      throw new NoEcuResponseError();
    }
    if (
      response.id !== undefined &&
      req.responseIdStart !== undefined &&
      (response.id < req.responseIdStart || response.id > (req.responseIdEnd ?? req.responseIdStart))
    ) {
      throw new NoEcuResponseError();
    }
    return response.data;
  }
}

function hexBytes(text: string | number): Uint8Array {
  return Uint8Array.from(String(text).trim().split(/\s+/u).map((byte) => Number.parseInt(byte, 16)));
}

function hexText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function hexId(text: string | number): number {
  return Number.parseInt(String(text), 16);
}

function fixtureCases(pkg: SpecPackage): FixtureCase[] {
  return (parsePackageYaml(pkg.fixtures) as { cases: FixtureCase[] }).cases;
}

/** ISO-TP endpoints of a package by transmit ID, with whether an address byte leads each frame. */
function isotpEndpoints(pkg: SpecPackage): Map<number, { addressed: boolean }> {
  const endpoints = new Map<number, { addressed: boolean }>();
  for (const content of [pkg.source.content, ...(pkg.source.documents ?? []).map((document) => document.content)]) {
    const document = parsePackageYaml(content) as {
      endpoints?: Record<string, { protocol: string; tx: string | number; addressing?: unknown }>;
    };
    for (const endpoint of Object.values(document.endpoints ?? {})) {
      if (endpoint.protocol === "isotp") {
        endpoints.set(hexId(endpoint.tx), { addressed: endpoint.addressing != null });
      }
    }
  }
  return endpoints;
}

/** What each request carried: the ISO-TP application payload, or the CAN data field of a raw frame. */
function sentPayloads(pkg: SpecPackage, transport: MockTransport): string[] {
  const isotp = isotpEndpoints(pkg);
  return transport.requests.map(({ txFrame }) => {
    const endpoint = isotp.get(txFrame.canId);
    if (endpoint === undefined) {
      return hexText(txFrame.data.slice(0, txFrame.dlc ?? txFrame.data.length));
    }
    const pci = endpoint.addressed ? 1 : 0;
    return hexText(txFrame.data.slice(pci + 1, pci + 1 + ((txFrame.data[pci] ?? 0) & 0x0f)));
  });
}

async function withSettleDelays<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  while (!settled) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return tracked;
}

async function connect(pkg: SpecPackage, responses: FixtureResponse[] = []) {
  const transport = new FixtureTransport(responses);
  const car = await new VirtualVehicleManager().connect({ id: "car", transport, profiles: [pkg.source] });
  return { car, transport };
}

async function runSignalCase(testCase: FixtureCase, car: VirtualVehicle, transport: MockTransport): Promise<void> {
  const path = testCase.path as string;
  const frame = testCase.frame as NonNullable<FixtureCase["frame"]>;
  await car.subscribe(path);
  const data = hexBytes(frame.data);
  transport.emitFrame({ canId: hexId(frame.id), dlc: data.length, data });

  if (testCase.expect.quality === "invalid") {
    expect(car.state.get(path)).toBeUndefined();
  } else {
    expect(car.state.get(path)).toBe(testCase.expect.value);
  }
}

async function runQueryCase(testCase: FixtureCase, car: VirtualVehicle): Promise<void> {
  const result = testCase.path !== undefined ? car.read(testCase.path) : car.query(testCase.name as string);
  if (testCase.expect.error === "TIMEOUT") {
    await expect(result).rejects.toBeInstanceOf(NoEcuResponseError);
    return;
  }
  await expect(result).resolves.toBe(testCase.expect.value);
}

async function runCommandCase(testCase: FixtureCase, car: VirtualVehicle): Promise<void> {
  const run = async () =>
    testCase.kind === "write"
      ? await car.set(testCase.path as string, testCase.target as VssValue)
      : await car.invoke(testCase.name as string);

  switch (testCase.expect.error) {
    case "UNSUPPORTED":
    case "INVALID_PACKAGE":
      // Nothing is sent for a target the package has no exact request for.
      await expect(run()).rejects.toBeInstanceOf(VirtualVehicleError);
      return;
    case "NEGATIVE_RESPONSE":
      await expect(withSettleDelays(run())).resolves.toBe("rejected");
      return;
    case "OUTCOME_UNKNOWN": {
      // The request went out and no acknowledgement came back. With an
      // ECU_WAKE action the write is retried and reports "unknown"; without
      // one this runtime reports the missing response as NoEcuResponseError.
      const outcome = await withSettleDelays(run()).catch((error: unknown) => error);
      if (outcome !== "unknown") {
        expect(outcome).toBeInstanceOf(NoEcuResponseError);
      }
      return;
    }
    case undefined:
      await expect(withSettleDelays(run())).resolves.toBe(testCase.expect.result);
      return;
    default:
      throw new Error(`Fixture case ${testCase.label} expects an error this runner does not know: ${testCase.expect.error}`);
  }
}

async function runCase(pkg: SpecPackage, testCase: FixtureCase): Promise<void> {
  const { car, transport } = await connect(
    pkg,
    (testCase.responses ?? []).map((response) =>
      typeof response === "object"
        ? { id: hexId(response.id), data: hexBytes(response.data) }
        : { data: hexBytes(response) }),
  );

  switch (testCase.kind) {
    case "signal":
      await runSignalCase(testCase, car, transport);
      break;
    case "query":
      await runQueryCase(testCase, car);
      break;
    case "write":
    case "action":
      await runCommandCase(testCase, car);
      break;
    default: {
      const unhandled: never = testCase.kind;
      throw new Error(`Unknown fixture kind ${String(unhandled)}`);
    }
  }

  if (testCase.expect.sent !== undefined) {
    expect(sentPayloads(pkg, transport)).toEqual(testCase.expect.sent.map((sent) => hexText(hexBytes(sent))));
  }
}

describe("format 2 packages from the vehicle-profile-spec examples", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [name, pkg] of Object.entries(specPackages)) {
    describe(name, () => {
      for (const testCase of fixtureCases(pkg)) {
        it(`${testCase.kind}: ${testCase.label}`, async () => {
          await runCase(pkg, testCase);
        });
      }
    });
  }
});

describe("format 2 loader", () => {
  it("composes the manifest with its documents", () => {
    const [profile] = new ProfileLoader().load([versaPackage.source]);

    expect(profile?.id).toBe("org.canopener.nissan.versa");
    expect(profile?.dbcFiles.map((file) => file.name)).toEqual(["signals.dbc"]);
    expect(profile?.endpoints.map((endpoint) => endpoint.name)).toEqual(["body_status", "body", "generated-wipers"]);
    expect(profile?.endpoints.find((endpoint) => endpoint.name === "body")).toMatchObject({
      requestId: 0x745,
      responseRanges: [{ start: 0x765, end: 0x765 }],
      timeoutMs: 300,
    });
    expect(profile?.actions.map((action) => action.name)).toEqual(expect.arrayContaining(["ECU_WAKE", "SIGNAL_OFF"]));
    expect(profile?.properties.map((property) => property.path)).toEqual(
      expect.arrayContaining([
        "Vehicle.Speed",
        "Vehicle.Body.Horn.IsActive",
        "Vehicle.Cabin.IsCentralLockEngaged",
      ]),
    );
  });

  it("types each property from the VSS catalog", () => {
    const [profile] = new ProfileLoader().load([versaPackage.source]);
    const horn = profile?.properties.find((property) => property.path === "Vehicle.Body.Horn.IsActive");
    const speed = profile?.properties.find((property) => property.path === "Vehicle.Speed");

    expect(horn?.datatype).toBe("boolean");
    expect(speed).toMatchObject({ datatype: "float", unit: "km/h" });
  });

  it("expands sequence calls into the steps of a write case", () => {
    const [profile] = new ProfileLoader().load([versaPackage.source]);
    const horn = profile?.properties.find((property) => property.path === "Vehicle.Body.Horn.IsActive");
    const steps = horn?.write?.cases?.["true"]?.steps ?? [];

    expect(steps.map((step) => Array.from(step.send))).toEqual([
      [0x02, 0x10, 0x81],
      [0x02, 0x10, 0xc0],
      [0x04, 0x30, 0x30, 0x00, 0x01],
    ]);
    expect(steps.map((step) => step.expect?.pattern)).toEqual([
      [0x50, 0x81],
      [0x50, 0xc0],
      [0x70, 0x30, 0x01],
    ]);
  });

  it("fails when the manifest lists a document that was not provided", () => {
    expect(() =>
      new ProfileLoader().load([{ ...versaPackage.source, documents: [] }]),
    ).toThrow(/lists document base.yaml, which was not provided/u);
  });

  it("maps channel names onto buses and keeps runtime channels unconfigured", () => {
    const [dualBus] = new ProfileLoader().load([canFdDualBusPackage.source]);
    const [hvac] = new ProfileLoader().load([hvacSyntheticPackage.source]);

    expect(dualBus?.canBuses).toEqual([
      { bus: 0, bitrate: 500_000 },
      { bus: 1, bitrate: "auto", dataBitrate: 2_000_000, fd: { isotpTxDl: 64 } },
    ]);
    expect(dualBus?.endpoints.find((endpoint) => endpoint.name === "obd")).toMatchObject({
      bus: 1,
      // `responder` narrows the receive range to the one ECU that answers.
      responseRanges: [{ start: 0x7e8, end: 0x7e8 }],
    });
    expect(dualBus?.endpoints.find((endpoint) => endpoint.name === "bcm")?.fd).toEqual({ txDl: 8 });
    expect(dualBus?.endpoints.find((endpoint) => endpoint.name === "legacy-ecu")?.fd).toBe(false);
    expect(hvac?.canBuses).toEqual([]);
    expect(hvac?.endpoints[0]?.bus).toBeUndefined();
  });

  it("keeps hex CAN IDs that YAML would read as numbers", () => {
    const [profile] = new ProfileLoader().load([universalObdPackage.source]);

    expect(profile?.endpoints[0]).toMatchObject({
      requestId: 0x7e0,
      responseRanges: [{ start: 0x7e8, end: 0x7e8 }],
    });
  });

  it("puts the address byte ahead of the PCI for an addressed endpoint", async () => {
    const { car, transport } = await connect(bmwAddressingPackage, [{ data: hexBytes("7E 00") }]);

    await expect(car.invoke("TESTER_PRESENT")).resolves.toBe("acknowledged");
    expect(Array.from(transport.requests[0]?.txFrame.data ?? [])).toEqual([0x12, 0x02, 0x3e, 0x00, 0, 0, 0, 0]);
  });

  it("loads a request longer than one ISO-TP frame as unavailable instead of throwing", async () => {
    const manifest = [
      "manifest: 1",
      "format: 2",
      "id: org.example.long",
      "version: 1.0.0",
      "name: Long request",
      "vss: '6.1'",
      "endpoints:",
      "  body:",
      "    protocol: isotp",
      "    tx: '745'",
      "    rx: ['765']",
      "    id_format: standard",
      "actions:",
      "  LONG_WRITE:",
      "    endpoint: body",
      "    request: 2E 01 02 03 04 05 06 07 08",
      "  HELD:",
      "    endpoint: body",
      "    request: 3E 00",
      "    repeat:",
      "      interval_ms: 100",
      "      release: silence",
      "      frame: { base: last-rx, mask: FF, patch: '01' }",
    ].join("\n");
    const { car, transport } = await connect({
      source: { name: "long/vehicle.yaml", content: manifest, dbcFiles: [] },
      fixtures: "",
    });

    await expect(car.invoke("LONG_WRITE")).rejects.toThrow(
      "LONG_WRITE is unavailable: a 9-byte request is longer than one ISO-TP frame",
    );
    await expect(car.invoke("HELD")).rejects.toThrow("HELD is unavailable: repeat writes are not supported");
    expect(transport.requests).toEqual([]);
  });

  it("skips a package whose dependency is not loaded before it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dependent = {
      name: "dependent/vehicle.yaml",
      content: [
        "manifest: 1",
        "format: 2",
        "id: org.example.dependent",
        "version: 1.0.0",
        "name: Dependent",
        "vss: '6.1'",
        "depends:",
        "  - id: org.canopener.universal.obd",
        "    version: ^2.0.0",
      ].join("\n"),
      dbcFiles: [],
    };

    expect(new ProfileLoader().load([dependent])).toEqual([]);
    expect(readProfileSource(dependent)?.id).toBe("org.example.dependent");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("depends on org.canopener.universal.obd"));
    expect(
      new ProfileLoader().load([universalObdPackage.source, dependent]).map((profile) => profile.id),
    ).toEqual(["org.canopener.universal.obd", "org.example.dependent"]);
    warn.mockRestore();
  });

  it("skips a manifest version it does not know", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      new ProfileLoader().load([{ name: "future/vehicle.yaml", content: "manifest: 2\nformat: 3\n", dbcFiles: [] }]),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("manifest 2 is not loaded"));
    warn.mockRestore();
  });
});
