import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { testVehicleProfile } from "./fixtures.js";

describe("VirtualVehicle.action", () => {
  it("sends profile-declared action frames", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "car-a",
      transport,
      profiles: [testVehicleProfile],
    });

    await car.action("HORN");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      signalName: "HORN",
      expectCanResponse: false,
    });
    expect(transport.requests[0]?.txFrame.data[0]).toBe(1);
  });

  it("encodes scaled numeric action inputs into a fixed request template", async () => {
    const { car, transport } = await connectTestVehicle();

    await car.action("SET_TEMPERATURE", { temperature: 21.5 });

    expect(payloadBytes(transport)).toEqual([0x30, 0x50, 0x2b]);
  });

  it("encodes multi-byte numeric inputs with byte order", async () => {
    const { car, transport } = await connectTestVehicle();

    await car.action("SET_CHARGE_LIMIT", { limit: 80 });

    expect(payloadBytes(transport)).toEqual([0x30, 0x91, 0x00, 0x50]);
  });

  it("encodes ASCII action inputs with padding", async () => {
    const { car, transport } = await connectTestVehicle();

    await car.action("SET_DRIVER_TAG", { tag: "AB" });

    expect(payloadBytes(transport)).toEqual([0x30, 0xa0, 0x41, 0x42, 0x00, 0x00]);
  });

  it("encodes bit-packed numeric inputs", async () => {
    const { car, transport } = await connectTestVehicle();

    await car.action("SET_LIGHT_MODE", { mode: 3 });

    expect(payloadBytes(transport)).toEqual([0x30, 0xb0, 0x03]);
  });

  it("rejects missing, out-of-range, and wrong-type action inputs", async () => {
    const { car } = await connectTestVehicle();

    await expect(car.action("SET_TEMPERATURE")).rejects.toThrow(/requires input temperature/u);
    await expect(car.action("SET_TEMPERATURE", { temperature: 31 })).rejects.toThrow(/must be <= 30/u);
    await expect(car.action("SET_DRIVER_TAG", { tag: 42 })).rejects.toThrow(/must be a string/u);
  });
});

async function connectTestVehicle() {
  const manager = new VirtualVehicleManager();
  const transport = new MockTransport();
  const car = await manager.connect({
    id: `car-${Math.random()}`,
    transport,
    profiles: [testVehicleProfile],
  });
  return { car, transport };
}

function payloadBytes(transport: MockTransport): number[] {
  const frame = transport.requests.at(-1)?.txFrame;
  expect(frame).toBeDefined();
  return Array.from(frame!.data.slice(0, frame!.dlc));
}
