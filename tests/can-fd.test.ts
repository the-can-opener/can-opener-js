import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleDbc } from "./fixtures.js";

describe("CAN FD endpoints", () => {
  it("loads can_fd.tx_dl beside the endpoint and keeps other endpoints classic", () => {
    const [profile] = new ProfileLoader().load([canFdProfile(64)]);
    if (profile === undefined) {
      throw new Error("Expected profile to load");
    }

    expect(profile.canBuses).toEqual([{ bus: 0, bitrate: 500000, dataBitrate: 2000000 }]);
    expect(profile.endpoints.find((endpoint) => endpoint.name === "obd_fd")?.canFd).toEqual({ txDl: 64 });
    expect(profile.endpoints.find((endpoint) => endpoint.name === "obd")?.canFd).toBeUndefined();
  });

  it.each([0, 12, 32, "fast"])("rejects tx_dl %s", (txDl) => {
    expect(() => new ProfileLoader().load([canFdProfile(txDl)])).toThrow(/tx_dl must (be 8 or 64|be numeric)/u);
  });

  it("sends a classic request without CAN FD fields even when the bus has a data bitrate", async () => {
    const { car, transport } = await connect(canFdProfile(64));
    transport.scriptPidResponse(speedFrame(0x7df), Uint8Array.of(0x41, 0x0d, 42));

    await expect(car.query<number>("SPEED")).resolves.toBe(42);
    expect(transport.requests[0]?.canFd).toBeUndefined();
    expect(transport.requests[0]?.txFrame.dlc).toBe(3);
  });

  it.each([8, 64] as const)("sends the PCI-free payload with tx_dl %i", async (txDl) => {
    const { car, transport } = await connect(canFdProfile(txDl));
    transport.scriptPidResponse(speedFrame(0x7e0), Uint8Array.of(0x41, 0x0d, 88));

    await expect(car.query<number>("SPEED_FD")).resolves.toBe(88);
    const request = transport.requests[0];
    expect(request?.canFd).toEqual({ txDl, payload: Uint8Array.of(0x01, 0x0d) });
    expect(request?.txFrame.dlc).toBe(8);
    expect(Array.from(request?.txFrame.data ?? [])).toEqual([0x02, 0x01, 0x0d, 0, 0, 0, 0, 0]);
  });

  it("carries CAN FD fields on endpoint-backed action steps", async () => {
    const { car, transport } = await connect(canFdProfile(64));

    await car.action("PING_FD");
    expect(transport.requests[0]?.canFd).toEqual({ txDl: 64, payload: Uint8Array.of(0x3e, 0x00) });
  });

  it("rejects CAN FD send bytes that are not an ISO-TP single frame", async () => {
    const { car } = await connect(canFdProfile(64));

    await expect(car.query("FIRST_FRAME_FD")).rejects.toThrow(/single-frame PCI/u);
  });
});

async function connect(profile: VehicleProfileSource) {
  const transport = new MockTransport();
  const car = await new VirtualVehicleManager().connect({ id: "can-fd", transport, profiles: [profile] });
  return { car, transport };
}

function speedFrame(canId: number) {
  return { canId, dlc: 8, data: Uint8Array.of(0x02, 0x01, 0x0d, 0, 0, 0, 0, 0), bus: 0 };
}

function canFdProfile(txDl: unknown): VehicleProfileSource {
  return {
    name: "test/can-fd/profile.yaml",
    content: `version: 1

can:
  buses:
    0:
      bitrate: 500000
      data_bitrate: 2000000

dbc:
  files:
    - path: signals.dbc

endpoints:
  obd:
    bus: 0
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]

  obd_fd:
    bus: 0
    request_id: 0x7E0
    response_id: 0x7E8
    can_fd:
      tx_dl: ${JSON.stringify(txDl)}

queries:
  SPEED:
    endpoint: obd
    send: [0x02, 0x01, 0x0D]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: DIAGNOSTICS_RESPONSE
      signal: VEHICLE_SPEED

  SPEED_FD:
    endpoint: obd_fd
    send: [0x02, 0x01, 0x0D]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: DIAGNOSTICS_RESPONSE
      signal: VEHICLE_SPEED

  FIRST_FRAME_FD:
    endpoint: obd_fd
    send: [0x10, 0x14, 0x2E, 0xF1, 0x90, 0, 0, 0]

actions:
  PING_FD:
    endpoint: obd_fd
    send: [0x02, 0x3E, 0x00, 0, 0, 0, 0, 0]
`,
    dbcFiles: [testVehicleDbc],
  };
}
