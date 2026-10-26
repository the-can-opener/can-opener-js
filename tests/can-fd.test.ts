import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleDbc } from "./fixtures.js";

const FD_BUS = `bitrate: 500000
      data_bitrate: 2000000
      fd:
        isotp:
          tx_dl: 64`;

describe("CAN FD profile settings", () => {
  it("loads bus and endpoint fd settings", () => {
    const [profile] = new ProfileLoader().load([fdProfile(FD_BUS, `
  bcm:
    request_id: 0x7A0
    fd: { tx_dl: 8 }
  legacy:
    request_id: 0x7B0
    fd: false
  forced:
    request_id: 0x7C0
    fd: true`)]);

    expect(profile?.canBuses).toEqual([
      { bus: 0, bitrate: 500000, dataBitrate: 2000000, fd: { isotpTxDl: 64 } },
    ]);
    const fd = Object.fromEntries(profile?.endpoints.map((endpoint) => [endpoint.name, endpoint.fd]) ?? []);
    expect(fd).toEqual({ obd: undefined, bcm: { txDl: 8 }, legacy: false, forced: true });
  });

  it.each([
    ["fd: true", { isotpTxDl: 8 }],
    ["fd: {}", { isotpTxDl: 8 }],
    ["fd: false", undefined],
  ])("reads bus %s", (fd, expected) => {
    const [profile] = new ProfileLoader().load([fdProfile(`bitrate: 500000\n      ${fd}`)]);

    expect(profile?.canBuses[0]?.fd).toEqual(expected);
  });

  it.each([0, 12, 32, "fast"])("rejects tx_dl %s", (txDl) => {
    const busTxDl = `bitrate: 500000\n      fd: { isotp: { tx_dl: ${JSON.stringify(txDl)} } }`;
    const endpointTxDl = `\n  bcm:\n    request_id: 0x7A0\n    fd: { tx_dl: ${JSON.stringify(txDl)} }`;

    expect(() => new ProfileLoader().load([fdProfile(busTxDl)])).toThrow(/tx_dl must (be 8 or 64|be numeric)/u);
    expect(() => new ProfileLoader().load([fdProfile(FD_BUS, endpointTxDl)])).toThrow(/tx_dl must (be 8 or 64|be numeric)/u);
  });
});

describe("CAN FD frame format resolution", () => {
  it("keeps a bus with only a data bitrate classic", async () => {
    const { car, transport } = await connect(fdProfile("bitrate: 500000\n      data_bitrate: 2000000"));
    transport.scriptPidResponse(speedFrame(0x7df), Uint8Array.of(0x41, 0x0d, 42));

    await expect(car.query<number>("SPEED")).resolves.toBe(42);
    expect(transport.requests[0]?.canFd).toBeUndefined();
    expect(transport.requests[0]?.txFrame.dlc).toBe(3);
  });

  it("sends endpoints on an FD bus with the bus's ISO-TP frame size", async () => {
    const { car, transport } = await connect(fdProfile(FD_BUS));
    transport.scriptPidResponse(speedFrame(0x7df), Uint8Array.of(0x41, 0x0d, 88));

    await expect(car.query<number>("SPEED")).resolves.toBe(88);
    const request = transport.requests[0];
    expect(request?.canFd).toEqual({ txDl: 64, payload: Uint8Array.of(0x01, 0x0d) });
    expect(request?.txFrame.dlc).toBe(8);
    expect(Array.from(request?.txFrame.data ?? [])).toEqual([0x02, 0x01, 0x0d, 0, 0, 0, 0, 0]);
  });

  it("lets an endpoint override the bus default", async () => {
    const { car, transport } = await connect(fdProfile(FD_BUS, `
  bcm:
    request_id: 0x7A0
    fd: { tx_dl: 8 }
  legacy:
    request_id: 0x7B0
    fd: false`, `
  PING_BCM:
    endpoint: bcm
    send: [0x02, 0x3E, 0x00]
  PING_LEGACY:
    endpoint: legacy
    send: [0x02, 0x3E, 0x00]`));

    await car.action("PING_BCM");
    await car.action("PING_LEGACY");

    expect(transport.requests[0]?.canFd).toEqual({ txDl: 8 });
    expect(transport.requests[0]?.txFrame.dlc).toBe(8);
    expect(transport.requests[1]?.canFd).toBeUndefined();
    expect(transport.requests[1]?.txFrame.dlc).toBe(3);
  });

  it("sends inline request_id frames as FD on an FD bus unless the step opts out", async () => {
    const { car, transport } = await connect(fdProfile(FD_BUS, "", `
  HORN:
    send: { request_id: 0x3F1, bus: 0, request: [0x01, 0x02] }
  HORN_CLASSIC:
    send: { request_id: 0x3F1, bus: 0, fd: false, request: [0x01, 0x02] }`));

    await car.action("HORN");
    await car.action("HORN_CLASSIC");

    expect(transport.requests[0]?.canFd).toEqual({ txDl: 8 });
    expect(transport.requests[0]?.txFrame.dlc).toBe(8);
    expect(transport.requests[1]?.canFd).toBeUndefined();
    expect(transport.requests[1]?.txFrame.dlc).toBe(2);
  });

  it("applies a bus declared by one profile to endpoints from another", async () => {
    const universal = fdProfile(undefined);
    const vehicle: VehicleProfileSource = {
      name: "test/vehicle/profile.yaml",
      content: `version: 1\n\ncan:\n  buses:\n    0:\n      ${FD_BUS}\n`,
      dbcFiles: [],
    };
    const { car, transport } = await connect(universal, vehicle);
    transport.scriptPidResponse(speedFrame(0x7df), Uint8Array.of(0x41, 0x0d, 7));

    await expect(car.query<number>("SPEED")).resolves.toBe(7);
    expect(transport.requests[0]?.canFd).toMatchObject({ txDl: 64 });
  });

  it("rejects CAN FD send bytes that are not an ISO-TP single frame at tx_dl 64", async () => {
    const { car } = await connect(fdProfile(FD_BUS));

    await expect(car.query("FIRST_FRAME")).rejects.toThrow(/tx_dl 64, which requires .*single-frame PCI/u);
  });
});

describe("CAN FD on a classic bus", () => {
  it.each([
    ["an endpoint", `\n  bcm:\n    request_id: 0x7A0\n    fd: { tx_dl: 8 }`, "", /Endpoint bcm sends CAN FD on bus 0/u],
    ["an inline step", "", `\n  HORN:\n    send: { request_id: 0x3F1, fd: true, request: [0x01] }`, /Action HORN sends CAN FD on bus 0/u],
  ])("refuses to load %s that sends FD", async (_, endpoints, actions, error) => {
    const transport = new MockTransport();

    await expect(new VirtualVehicleManager().connect({
      id: "classic",
      transport,
      profiles: [fdProfile("bitrate: 500000", endpoints, actions)],
    })).rejects.toThrow(error);
    expect(transport.isConnected()).toBe(false);
  });

  it("rejects profiles that disagree on a bus's FD default", async () => {
    const other: VehicleProfileSource = {
      name: "test/other/profile.yaml",
      content: "version: 1\n\ncan:\n  buses:\n    0:\n      bitrate: 500000\n      data_bitrate: 2000000\n",
      dbcFiles: [],
    };

    await expect(connect(fdProfile(FD_BUS), other)).rejects.toThrow(/Conflicting CAN bus 0 settings/u);
  });
});

async function connect(...profiles: VehicleProfileSource[]) {
  const transport = new MockTransport();
  const car = await new VirtualVehicleManager().connect({ id: "can-fd", transport, profiles });
  return { car, transport };
}

function speedFrame(canId: number) {
  return { canId, dlc: 8, data: Uint8Array.of(0x02, 0x01, 0x0d, 0, 0, 0, 0, 0), bus: 0 };
}

/** A profile with an `obd` endpoint, `SPEED`/`FIRST_FRAME` queries, and optional bus 0 settings. */
function fdProfile(bus0: string | undefined, extraEndpoints = "", actions = ""): VehicleProfileSource {
  const can = bus0 === undefined ? "" : `can:\n  buses:\n    0:\n      ${bus0}\n\n`;
  return {
    name: "test/can-fd/profile.yaml",
    content: `version: 1

${can}dbc:
  files:
    - path: signals.dbc

endpoints:
  obd:
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]${extraEndpoints}

queries:
  SPEED:
    endpoint: obd
    send: [0x02, 0x01, 0x0D]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: DIAGNOSTICS_RESPONSE
      signal: VEHICLE_SPEED

  FIRST_FRAME:
    endpoint: obd
    send: [0x10, 0x14, 0x2E, 0xF1, 0x90, 0, 0, 0]
${actions === "" ? "" : `\nactions:${actions}\n`}`,
    dbcFiles: [testVehicleDbc],
  };
}
