import { describe, expect, it } from "vitest";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { isotpAddressBytes, isotpAddressingFields } from "../src/profile/isotpAddressing.js";
import { ProfileLoader } from "../src/profile/ProfileLoader.js";
import { buildRequestFrame, canFdRequestFields } from "../src/profile/RequestBuilder.js";
import type { VehicleProfileSource } from "../src/profile/types.js";
import { MockTransport } from "../src/transport/MockTransport.js";
import { IsotpReassembly, isotpFlowControlFrame, parseSlcanFrame } from "../src/transport/slcanProtocol.js";
import { bmwExtendedAddressingProfile as bmwProfile } from "./fixtures.js";

/** BMW-style tester: every ECU listens on 0x6F1 and answers on 0x600 + its address. */
const BMW = { requestId: 0x6f1, responseId: 0x612, target: 0x12, source: 0xf1 };

describe("ISO-TP addressing in profiles", () => {
  it("loads extended addressing on an endpoint", () => {
    const [profile] = new ProfileLoader().load([bmwProfile]);

    expect(profile?.endpoints[0]?.addressing).toEqual({ mode: "extended", targetAddress: 0x12, sourceAddress: 0xf1 });
  });

  it("loads mixed addressing on an endpoint", () => {
    const [profile] = new ProfileLoader().load([endpointProfile("mode: mixed\n      address_extension: 0xA5")]);

    expect(profile?.endpoints[0]?.addressing).toEqual({ mode: "mixed", addressExtension: 0xa5 });
  });

  it.each([
    ["an unknown mode", "mode: functional", /addressing\.mode must be extended or mixed/u],
    ["a missing mode", "target_address: 0x12", /addressing\.mode must be extended or mixed/u],
    ["extended without a source", "mode: extended\n      target_address: 0x12", /source_address must be numeric/u],
    ["mixed without an extension", "mode: mixed", /address_extension must be numeric/u],
    ["extended with a mixed field", "mode: extended\n      target_address: 1\n      source_address: 2\n      address_extension: 3", /only valid with mode mixed/u],
    ["mixed with extended fields", "mode: mixed\n      address_extension: 3\n      target_address: 1", /only valid with mode extended/u],
    ["an address above a byte", "mode: mixed\n      address_extension: 0x100", /address_extension must be a byte/u],
  ])("rejects %s", (_, addressing, error) => {
    expect(() => new ProfileLoader().load([endpointProfile(addressing)])).toThrow(error);
  });

  it("resolves each mode to the byte sent and the byte expected back", () => {
    expect(isotpAddressBytes({ mode: "extended", targetAddress: 0x12, sourceAddress: 0xf1 })).toEqual({ tx: 0x12, rx: 0xf1 });
    expect(isotpAddressBytes({ mode: "mixed", addressExtension: 0xa5 })).toEqual({ tx: 0xa5, rx: 0xa5 });
    expect(isotpAddressingFields(undefined)).toEqual({});
    expect(isotpAddressingFields({})).toEqual({});
  });
});

describe("ISO-TP addressing in request frames", () => {
  const dme = {
    requestId: BMW.requestId,
    addressing: { mode: "extended", targetAddress: BMW.target, sourceAddress: BMW.source } as const,
  };

  it("puts the target address in front of the PCI", () => {
    const frame = buildRequestFrame(dme, Uint8Array.of(0x03, 0x22, 0xf1, 0x90, 0, 0, 0, 0));

    expect(frame.canId).toBe(0x6f1);
    expect(frame.dlc).toBe(8);
    expect(Array.from(frame.data)).toEqual([0x12, 0x03, 0x22, 0xf1, 0x90, 0, 0, 0]);
  });

  it("counts the address byte in a short frame's DLC", () => {
    const frame = buildRequestFrame(dme, Uint8Array.of(0x02, 0x3e, 0x00));

    expect(frame.dlc).toBe(4);
    expect(Array.from(frame.data)).toEqual([0x12, 0x02, 0x3e, 0x00, 0, 0, 0, 0]);
  });

  it("rejects send bytes that no longer fit beside the address byte", () => {
    expect(() => buildRequestFrame(dme, Uint8Array.of(0x07, 1, 2, 3, 4, 5, 6, 7))).toThrow(
      /0x6F1 uses ISO-TP extended addressing, so its send bytes must fit in 7 bytes/u,
    );
  });

  it("leaves normal addressing untouched", () => {
    const frame = buildRequestFrame({ requestId: 0x7df }, Uint8Array.of(0x02, 0x01, 0x0d));

    expect(frame.dlc).toBe(3);
    expect(Array.from(frame.data)).toEqual([0x02, 0x01, 0x0d, 0, 0, 0, 0, 0]);
  });

  it("reads the single-frame PCI after the address byte for CAN FD tx_dl 64", () => {
    const frame = buildRequestFrame({ ...dme, canFd: { txDl: 64 } }, Uint8Array.of(0x03, 0x22, 0xf1, 0x90));

    expect(canFdRequestFields({ txDl: 64 }, frame, "Endpoint dme", dme.addressing)).toEqual({
      canFd: { txDl: 64, payload: Uint8Array.of(0x22, 0xf1, 0x90) },
    });
    expect(() => canFdRequestFields({ txDl: 64 }, frame, "Endpoint dme")).toThrow(/single-frame PCI/u);
  });

  it("hands the address bytes to the transport", async () => {
    const transport = new MockTransport();
    const car = await new VirtualVehicleManager().connect({ id: "bmw", transport, profiles: [bmwProfile] });
    transport.scriptPidResponse(
      { canId: 0x6f1, dlc: 8, data: Uint8Array.of(0x12, 0x03, 0x22, 0xf1, 0x86, 0, 0, 0), bus: 0 },
      Uint8Array.of(0x62, 0xf1, 0x86, 0x01),
    );

    await expect(car.query<Uint8Array>("SESSION")).resolves.toEqual(Uint8Array.of(0x01));
    expect(transport.requests[0]).toMatchObject({
      isotpAddressing: { tx: 0x12, rx: 0xf1 },
      responseIdStart: 0x612,
      responseIdEnd: 0x612,
    });

    transport.scriptPidResponse(
      { canId: 0x6f1, dlc: 4, data: Uint8Array.of(0x12, 0x02, 0x3e, 0x00, 0, 0, 0, 0), bus: 0 },
      Uint8Array.of(0x7e, 0x00),
    );
    await car.action("TESTER_PRESENT");
    expect(transport.requests.at(-1)).toMatchObject({ isotpAddressing: { tx: 0x12, rx: 0xf1 } });
    expect(Array.from(transport.requests.at(-1)?.txFrame.data ?? [])).toEqual([0x12, 0x02, 0x3e, 0x00, 0, 0, 0, 0]);
    await car.disconnect();
  });
});

describe("IsotpReassembly with an address byte", () => {
  const addressing = { tx: BMW.target, rx: BMW.source };

  function reassembly(address = addressing) {
    return new IsotpReassembly(BMW.requestId, false, BMW.responseId, BMW.responseId, false, address);
  }

  it("strips the address byte and the PCI from a single frame", () => {
    const step = reassembly().push(frame("t6128F10462F186010000"));

    expect(step).toEqual({ type: "done", payload: Uint8Array.of(0x62, 0xf1, 0x86, 0x01) });
  });

  it("ignores frames carrying another address", () => {
    const parser = reassembly();

    expect(parser.push(frame("t6128F20462F186010000"))).toEqual({ type: "ignore" });
    expect(parser.push(frame("t6128F10462F186010000")).type).toBe("done");
  });

  it("sends flow control to the request ID with the target address first", () => {
    const parser = reassembly();

    expect(parser.push(frame("t6128F1101462F1903148"))).toEqual({ type: "flow-control", canId: 0x6f1, extended: false });
    expect(parser.push(frame("t6128F12147434D383236"))).toEqual({ type: "ignore" });
    expect(parser.push(frame("t6128F222414141414141"))).toEqual({ type: "ignore" });
    expect(parser.push(frame("t6128F122333341303034"))).toEqual({ type: "ignore" });
    const done = parser.push(frame("t6128F123333532000000"));

    expect(done.type).toBe("done");
    expect(new TextDecoder().decode(done.type === "done" ? done.payload.subarray(3) : new Uint8Array())).toBe(
      "1HGCM82633A004352",
    );
    expect(Array.from(isotpFlowControlFrame(8, addressing))).toEqual([0x12, 0x30, 0, 0, 0, 0, 0, 0]);
  });

  it("uses the same byte both ways for mixed addressing", () => {
    const parser = reassembly({ tx: 0xa5, rx: 0xa5 });

    expect(parser.push(frame("t6128A50462F186010000")).type).toBe("done");
    expect(Array.from(isotpFlowControlFrame(8, { tx: 0xa5, rx: 0xa5 }))).toEqual([0xa5, 0x30, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps the OBD response-minus-eight rule for normal addressing", () => {
    const parser = new IsotpReassembly(0x7df, false, 0x7e8, 0x7ef, false);

    expect(parser.push(frame("t7E881014490201314847"))).toEqual({ type: "flow-control", canId: 0x7e0, extended: false });
    expect(Array.from(isotpFlowControlFrame(8))).toEqual([0x30, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("reads the escaped CAN FD single-frame length after the address byte", () => {
    const step = reassembly().push(frame(`b612FF1000362F186${"00".repeat(58)}`));

    expect(step).toEqual({ type: "done", payload: Uint8Array.of(0x62, 0xf1, 0x86) });
  });
});

function frame(line: string) {
  const parsed = parseSlcanFrame(line);
  if (parsed === undefined) {
    throw new Error(`Invalid SLCAN test frame ${line}`);
  }
  return parsed;
}

function endpointProfile(addressing: string): VehicleProfileSource {
  return {
    name: "addressing",
    content: `
version: 1
endpoints:
  ecu:
    request_id: 0x6F1
    response_id: 0x612
    addressing:
      ${addressing}
`,
    dbcFiles: [],
  };
}
