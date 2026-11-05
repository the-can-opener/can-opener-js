import { describe, expect, it } from "vitest";
import {
  buildBatchRequestPacket,
  buildCanBusConfigPacket,
  buildCaptureAllPacket,
  buildMonitorControlPacket,
  buildRequestPackets,
  CanResponseAssembler,
  canBusConfigStatus,
  isSingleRequestChunk,
  parseBatchResultPayload,
  parseCanNotification,
  parseMonitorControlResponse,
  parseMonitorDataPacket,
  parseNanEnableResponse,
  planBatchChunks,
  toBatchStepResult,
  toBatchStepResults,
} from "../src/ble/index.js";
import type { VehicleBatchStep, VehicleRequest } from "../src/transport/types.js";
import { batchStep, notification, readU16, readU32 } from "./blePackets.js";

/** The one BLE write a single-frame request encodes to. */
function singlePacket(seq: number, req: VehicleRequest): Uint8Array {
  const packets = buildRequestPackets(seq, req);
  expect(packets).toHaveLength(1);
  return packets[0] ?? new Uint8Array();
}

describe("Can Opener SE dual-CAN BLE protocol", () => {
  it("keeps the legacy 15-byte request layout when bus is omitted", () => {
    const packet = singlePacket(0x12, {
      txFrame: { canId: 0x123, dlc: 2, data: Uint8Array.of(0xaa, 0xbb) },
      expectCanResponse: false,
    });

    expect(Array.from(packet)).toEqual([
      0x12, 0x00, 0x23, 0x01, 0x00, 0x00, 0x02, 0xaa, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it("encodes the explicit bus byte in a v2 request-only packet", () => {
    const packet = singlePacket(0x34, {
      txFrame: { canId: 0x456, dlc: 3, data: Uint8Array.of(0x10, 0x20, 0x30), bus: 1 },
      expectCanResponse: false,
    });

    expect(packet).toHaveLength(16);
    expect(Array.from(packet.slice(0, 11))).toEqual([0x34, 0x00, 0x01, 0x56, 0x04, 0x00, 0x00, 0x03, 0x10, 0x20, 0x30]);
  });

  it("encodes the explicit bus byte in a v2 request/response packet", () => {
    const packet = singlePacket(0x56, {
      txFrame: { canId: 0x7e0, dlc: 3, data: Uint8Array.of(0x02, 0x22, 0xf1), bus: 1 },
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
      timeoutMs: 500,
    });

    expect(packet).toHaveLength(26);
    expect(packet[0]).toBe(0x56);
    expect(packet[1]).toBe(0x01);
    expect(packet[2]).toBe(0x01);
    expect(readU32(packet, 3)).toBe(0x7e0);
    expect(readU32(packet, 7)).toBe(0x7e8);
    expect(readU32(packet, 11)).toBe(0x7ef);
    expect(readU16(packet, 15)).toBe(500);
    expect(packet[17]).toBe(3);
    expect(Array.from(packet.slice(18, 21))).toEqual([0x02, 0x22, 0xf1]);
  });

  it("puts ISO-TP address bytes after the bus in a v2 packet", () => {
    const packet = singlePacket(0x57, {
      txFrame: { canId: 0x6f1, dlc: 8, data: Uint8Array.of(0x12, 0x03, 0x22, 0xf1, 0x90, 0, 0, 0) },
      isotpAddressing: { tx: 0x12, rx: 0xf1 },
      expectCanResponse: true,
      responseIdStart: 0x612,
    });

    expect(packet).toHaveLength(28);
    expect(Array.from(packet.slice(0, 5))).toEqual([0x57, 0x01 | 0x20, 0x00, 0x12, 0xf1]);
    expect(readU32(packet, 5)).toBe(0x6f1);
    expect(readU32(packet, 9)).toBe(0x612);
    expect(readU32(packet, 13)).toBe(0x612);
  });

  it("encodes bus-aware monitor ADD and CLEAR packets", () => {
    expect(Array.from(buildMonitorControlPacket(0x20, { operation: "add", bus: 1, canIds: [0x123] }))).toEqual([
      0x01, 0x20, 0x01, 0x01, 0x23, 0x01, 0x00, 0x00,
    ]);
    expect(Array.from(buildMonitorControlPacket(0x21, { operation: "remove", canIds: [0x123] }))).toEqual([
      0x02, 0x21, 0x01, 0x23, 0x01, 0x00, 0x00,
    ]);
    expect(Array.from(buildMonitorControlPacket(0x22, { operation: "clear", bus: 1 }))).toEqual([0x03, 0x22, 0x01]);
  });

  it("encodes capture-all with and without a bus mask", () => {
    expect(Array.from(buildCaptureAllPacket(0x23, true))).toEqual([0x04, 0x23, 0x01]);
    expect(Array.from(buildCaptureAllPacket(0x24, true, 0x02))).toEqual([0x04, 0x24, 0x01, 0x02]);
    expect(Array.from(buildCaptureAllPacket(0x25, false, 0x02))).toEqual([0x04, 0x25, 0x00]);
  });

  it("encodes runtime CAN bus timing with optional FD data bitrate", () => {
    expect(Array.from(buildCanBusConfigPacket(0x30, { bus: 0, bitrate: 500000 }))).toEqual([
      0x08, 0x30, 0x00, 0x20, 0xa1, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(Array.from(buildCanBusConfigPacket(0x31, { bus: 1, bitrate: 500000, dataBitrate: 2000000 }))).toEqual([
      0x08, 0x31, 0x01, 0x20, 0xa1, 0x07, 0x00, 0x80, 0x84, 0x1e, 0x00,
    ]);
    expect(Array.from(buildCanBusConfigPacket(0x32, { bus: 1, bitrate: "auto" }))).toEqual([
      0x08, 0x32, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => buildCanBusConfigPacket(0x33, { bus: 0, bitrate: 0 })).toThrow(/Invalid CAN bitrate 0/u);
  });

  it("parses the latest bus-tagged monitor notifications and preserves bus identity", () => {
    const packet = Uint8Array.of(0x81, 0x01, 0x23, 0x01, 0x00, 0x00, 0x02, 0xaa, 0xbb, 0, 0, 0, 0, 0, 0, 0x01);

    expect(parseMonitorDataPacket(packet)).toEqual([{ canId: 0x123, dlc: 2, data: Uint8Array.of(0xaa, 0xbb), bus: 1 }]);
  });

  it("parses legacy monitor notifications as bus 0", () => {
    const packet = Uint8Array.of(0x81, 0x01, 0x23, 0x01, 0x00, 0x00, 0x01, 0xcc, 0, 0, 0, 0, 0, 0, 0);

    expect(parseMonitorDataPacket(packet)[0]).toMatchObject({ canId: 0x123, dlc: 1, bus: 0 });
  });

  it("rejects malformed monitor notifications", () => {
    expect(() => parseMonitorDataPacket(Uint8Array.of(0x80, 0x00))).toThrow(/opcode/u);
    expect(() => parseMonitorDataPacket(Uint8Array.of(0x81, 0x01, 0x00))).toThrow(/expected 16 or 15/u);
    expect(() =>
      parseMonitorDataPacket(Uint8Array.of(0x81, 0x01, 0x23, 0x01, 0, 0, 0x09, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    ).toThrow(/DLC 9/u);
  });

  it("parses the dual-CAN control ACK bus and timing status", () => {
    expect(parseMonitorControlResponse(Uint8Array.of(0x80, 0x44, 0x07, 0x00, 0x01))).toEqual({
      seq: 0x44,
      response: { status: "invalid_bus", currentMonitorCount: 0, bus: 1 },
    });
    expect(parseMonitorControlResponse(Uint8Array.of(0x80, 0x45, 0x08, 0x00, 0x01))).toMatchObject({
      seq: 0x45,
      response: { status: "invalid_bitrate", bus: 1 },
    });
    expect(
      parseMonitorControlResponse(Uint8Array.of(0x80, 0x46, 0x00, 0x00, 0x01, 0x48, 0xe8, 0x01, 0, 0, 0, 0, 0)),
    ).toMatchObject({
      seq: 0x46,
      response: { status: "ok", bus: 1, bitrate: 125000, dataBitrate: 0 },
    });
    expect(parseMonitorControlResponse(Uint8Array.of(0x80, 0x47, 0x09, 0x00, 0x01))).toMatchObject({
      seq: 0x47,
      response: { status: "auto_detect_failed", bus: 1 },
    });
  });

  it("collapses monitor-only statuses when reporting bus timing", () => {
    expect(canBusConfigStatus("auto_detect_failed")).toBe("auto_detect_failed");
    expect(canBusConfigStatus("monitor_full")).toBe("internal_error");
  });

  it("reads the Wi-Fi Aware stream key from the 37-byte enable ACK", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
    expect(parseNanEnableResponse(Uint8Array.of(0x80, 0x50, 0x00, 0x00, 0x00, ...key))).toEqual({
      status: "ok",
      currentMonitorCount: 0,
      bus: 0,
      streamKey: key,
    });

    // Older firmware sends the plain 5-byte ACK and no key.
    expect(parseNanEnableResponse(Uint8Array.of(0x80, 0x51, 0x00, 0x00, 0x00))).toEqual({
      status: "ok",
      currentMonitorCount: 0,
      bus: 0,
    });
  });
});

describe("Can Opener SE CAN FD requests", () => {
  it("sends tx_dl 8 as a v2 packet with the CAN FD flag and DLC 8", () => {
    const packet = singlePacket(0x21, {
      txFrame: { canId: 0x7df, dlc: 3, data: Uint8Array.of(0x02, 0x01, 0x0d), bus: 0 },
      canFd: { txDl: 8 },
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
    });

    expect(packet).toHaveLength(26);
    expect(packet[1]).toBe(0x01 | 0x40);
    expect(packet[17]).toBe(8);
    expect(Array.from(packet.slice(18))).toEqual([0x02, 0x01, 0x0d, 0, 0, 0, 0, 0]);
  });

  it("sends tx_dl 8 request-only frames with the CAN FD flag", () => {
    const packet = singlePacket(0x22, {
      txFrame: { canId: 0x7e0, dlc: 3, data: Uint8Array.of(0x02, 0x3e, 0x80) },
      canFd: { txDl: 8 },
      expectCanResponse: false,
    });

    expect(packet).toHaveLength(15);
    expect(packet[1]).toBe(0x40);
    expect(packet[6]).toBe(8);
  });

  it("sends tx_dl 64 as a v3 packet with tx_dl before the payload length", () => {
    const packet = singlePacket(0x2a, {
      txFrame: { canId: 0x7df, dlc: 8, data: Uint8Array.of(0x02, 0x01, 0x0d, 0, 0, 0, 0, 0) },
      canFd: { txDl: 64, payload: Uint8Array.of(0x01, 0x0d) },
      expectCanResponse: true,
      responseIdStart: 0x7e8,
      responseIdEnd: 0x7ef,
      timeoutMs: 500,
    });

    expect(Array.from(packet)).toEqual([
      0x2a, 0x49, 0x00, 0xdf, 0x07, 0x00, 0x00, 0xe8, 0x07, 0x00, 0x00, 0xef, 0x07, 0x00, 0x00, 0xf4, 0x01, 0x40,
      0x02, 0x00, 0x01, 0x0d,
    ]);
  });

  it("marks extended IDs and the target bus in a v3 CAN FD packet", () => {
    const packet = singlePacket(0x01, {
      txFrame: { canId: 0x14da11f1, dlc: 8, data: Uint8Array.of(0x03, 0x22, 0xf1, 0x90), bus: 1 },
      canFd: { txDl: 64, payload: Uint8Array.of(0x22, 0xf1, 0x90) },
      expectCanResponse: true,
      responseIdStart: 0x14daf111,
      responseIdEnd: 0x14daf111,
    });

    expect(packet[1]).toBe(0x08 | 0x40 | 0x01 | 0x02 | 0x04);
    expect(packet[2]).toBe(1);
    expect(readU32(packet, 3)).toBe(0x14da11f1);
    expect(readU16(packet, 15)).toBe(500);
    expect(packet.slice(17)).toEqual(Uint8Array.of(64, 3, 0, 0x22, 0xf1, 0x90));
  });

  it("fits 224 payload bytes in one v3 write and continues past that", () => {
    const request = (payload: Uint8Array) =>
      buildRequestPackets(0x01, {
        txFrame: { canId: 0x7e0, dlc: 8, data: Uint8Array.of(0x01, 0x3e) },
        canFd: { txDl: 64, payload },
        expectCanResponse: true,
      });

    expect(() => request(new Uint8Array(0))).toThrow(/1 to 4095 bytes, got 0/u);
    expect(request(new Uint8Array(224)).map((packet) => packet.length)).toEqual([244]);
    expect(request(new Uint8Array(225)).map((packet) => packet.length)).toEqual([244, 5]);
  });

  it("rejects classic frames longer than 8 bytes", () => {
    expect(() =>
      buildRequestPackets(0x01, {
        txFrame: { canId: 0x7e0, dlc: 9, data: new Uint8Array(9) },
        expectCanResponse: false,
      }),
    ).toThrow(/Invalid CAN DLC 9/u);
  });

  it("sets the batch step CAN FD flag for tx_dl 8 and pads the step to DLC 8", () => {
    const packet = buildBatchRequestPacket(0x02, {
      steps: [batchStep(0x7e0, [0x02, 0x10, 0x03], { canFd: { txDl: 8 } })],
    });

    expect(packet[5]).toBe(0x40);
    expect(packet[10]).toBe(8);
    expect(Array.from(packet.slice(11, 19))).toEqual([0x02, 0x10, 0x03, 0, 0, 0, 0, 0]);
  });

  it("gives tx_dl 64 steps their own chunk and refuses to batch them", () => {
    const fdStep = batchStep(0x7e0, [0x02, 0x22, 0xf1], {
      canFd: { txDl: 64, payload: Uint8Array.of(0x22, 0xf1) },
      expectCanResponse: true,
    });
    const chunks = planBatchChunks([batchStep(0x100, [1]), batchStep(0x101, [2]), fdStep, batchStep(0x102, [3])]);

    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 1, 1]);
    expect(chunks.map(isSingleRequestChunk)).toEqual([false, true, false]);
    expect(() => buildBatchRequestPacket(0x01, { steps: [batchStep(0x100, [1]), fdStep] })).toThrow(
      /step 1 uses CAN FD tx_dl 64/u,
    );
  });

  it("maps a single CAN FD request reply onto a batch step outcome", () => {
    const step = batchStep(0x7e0, [0x02, 0x22, 0xf1], { expectCanResponse: true });
    const reply = { responseCanId: 0x7e8, payload: Uint8Array.of(0x62, 0xf1) };

    expect(toBatchStepResult(step, { ...reply, status: 0x00 })).toEqual({
      status: "ok",
      payload: reply.payload,
      responseCanId: 0x7e8,
    });
    expect(toBatchStepResult(step, { ...reply, status: 0xe4 })).toEqual({ status: "no_response" });
    expect(toBatchStepResult(step, { ...reply, status: 0xe2 }).status).toBe("error");
  });
});

describe("Can Opener SE batch (v4) requests", () => {
  it("encodes a mixed request/response and request-only batch", () => {
    const packet = buildBatchRequestPacket(0x42, {
      bus: 1,
      steps: [
        batchStep(0x745, [0x02, 0x10, 0x81, 0, 0, 0, 0, 0], {
          expectCanResponse: true,
          responseIdStart: 0x765,
          responseIdEnd: 0x765,
          timeoutMs: 500,
          delayAfterMs: 20,
        }),
        batchStep(0x35d, [0xc1, 0x03]),
      ],
    });

    expect(packet).toHaveLength(5 + 26 + 16);
    expect(Array.from(packet.slice(0, 5))).toEqual([0x42, 0x10, 0x01, 0x00, 0x02]);
    expect(Array.from(packet.slice(5, 31))).toEqual([
      0x01, 0x45, 0x07, 0x00, 0x00, 0x08, 0x02, 0x10, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x65, 0x07,
      0x00, 0x00, 0x65, 0x07, 0x00, 0x00, 0xf4, 0x01,
    ]);
    expect(Array.from(packet.slice(31))).toEqual([
      0x00, 0x5d, 0x03, 0x00, 0x00, 0x02, 0xc1, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it("derives step flags, default timeout, and the continue-on-error flag", () => {
    const packet = buildBatchRequestPacket(0x01, {
      continueOnError: true,
      steps: [
        batchStep(0x18daf110, [0x02, 0x3e, 0x00], {
          expectCanResponse: true,
          responseIdStart: 0x18daf110,
          responseIdEnd: 0x18daf1ff,
        }),
      ],
    });

    expect(packet[2]).toBe(0); // bus defaults to 0
    expect(packet[3]).toBe(0x01);
    expect(packet[5]).toBe(0x01 | 0x02 | 0x04);
    expect(readU16(packet, 5 + 24)).toBe(500);
  });

  it("rejects batches that mix buses or exceed device limits", () => {
    expect(() =>
      buildBatchRequestPacket(0x01, {
        bus: 0,
        steps: [
          batchStep(0x100, [0x01]),
          batchStep(0x100, [0x01], { txFrame: { canId: 0x100, data: Uint8Array.of(1), bus: 1 } }),
        ],
      }),
    ).toThrow(/targets CAN1 but the batch targets CAN0/u);
    expect(() => buildBatchRequestPacket(0x01, { steps: [] })).toThrow(/1 to 14 steps/u);
    expect(() =>
      buildBatchRequestPacket(0x01, {
        steps: Array.from({ length: 10 }, () => batchStep(0x7e0, [0x01], { expectCanResponse: true })),
      }),
    ).toThrow(/265 bytes/u);
    expect(() =>
      buildBatchRequestPacket(0x01, {
        steps: [
          batchStep(0x7e0, [0x01], { expectCanResponse: true, timeoutMs: 20000 }),
          batchStep(0x7e0, [0x02], { delayAfterMs: 11000 }),
        ],
      }),
    ).toThrow(/31000 ms/u);
    expect(() => buildBatchRequestPacket(0x01, { steps: [batchStep(0x7e0, [1, 2, 3, 4, 5, 6, 7, 8, 9])] })).toThrow(
      /invalid CAN DLC 9/u,
    );
  });

  it("splits long step lists into device-sized chunks in order", () => {
    const requestOnly = Array.from({ length: 15 }, (_, index) => batchStep(0x100 + index, [index]));
    expect(planBatchChunks(requestOnly).map((chunk) => chunk.length)).toEqual([14, 1]);

    const withResponses = Array.from({ length: 10 }, (_, index) =>
      batchStep(0x7e0, [index], { expectCanResponse: true }),
    );
    const chunks = planBatchChunks(withResponses);
    expect(chunks.map((chunk) => chunk.length)).toEqual([9, 1]);
    expect(chunks.flat().map((step) => step.txFrame.data[0])).toEqual(Array.from({ length: 10 }, (_, i) => i));

    const slow: VehicleBatchStep[] = [
      batchStep(0x7e0, [1], { expectCanResponse: true, timeoutMs: 20000 }),
      batchStep(0x7e0, [2], { expectCanResponse: true, timeoutMs: 20000 }),
    ];
    expect(planBatchChunks(slow).map((chunk) => chunk.length)).toEqual([1, 1]);
    expect(() => planBatchChunks([batchStep(0x7e0, [1], { expectCanResponse: true, timeoutMs: 40000 })])).toThrow(
      /exceeds the device limits on its own/u,
    );
  });

  it("parses batch results and maps them onto step outcomes", () => {
    const payload = Uint8Array.of(
      0x03, 0x02,
      // step 0: OK, 0x765, 2 bytes 50 81
      0x00, 0x00, 0x00, 0x65, 0x07, 0x00, 0x00, 0x02, 0x00, 0x50, 0x81,
      // step 1: CAN_RX_TIMEOUT, no payload
      0x01, 0xe4, 0x00, 0x65, 0x07, 0x00, 0x00, 0x00, 0x00,
    );
    const parsed = parseBatchResultPayload(payload);
    expect(parsed.stepCount).toBe(3);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({ stepIndex: 0, status: 0, responseCanId: 0x765 });
    expect(Array.from(parsed.entries[0]?.payload ?? [])).toEqual([0x50, 0x81]);

    const steps = [
      batchStep(0x745, [1], { expectCanResponse: true }),
      batchStep(0x745, [2], { expectCanResponse: true }),
      batchStep(0x745, [3]),
    ];
    expect(toBatchStepResults(parsed, steps)).toEqual([
      { status: "ok", payload: Uint8Array.of(0x50, 0x81), responseCanId: 0x765 },
      { status: "no_response" },
      { status: "skipped" },
    ]);

    const txFail = parseBatchResultPayload(Uint8Array.of(0x01, 0x01, 0x00, 0xe3, 0x00, 0, 0, 0, 0, 0x00, 0x00));
    expect(toBatchStepResults(txFail, [batchStep(0x745, [1])])).toEqual([{ status: "tx_failed" }]);
  });

  it("rejects malformed batch results", () => {
    expect(() => parseBatchResultPayload(Uint8Array.of(0x01))).toThrow(/length/u);
    expect(() => parseBatchResultPayload(Uint8Array.of(0x01, 0x02))).toThrow(/executed 2 of 1/u);
    expect(() => parseBatchResultPayload(Uint8Array.of(0x01, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0x05, 0x00))).toThrow(
      /payload is truncated/u,
    );
    expect(() =>
      parseBatchResultPayload(Uint8Array.of(0x01, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0x00, 0x00, 0xff)),
    ).toThrow(/trailing/u);
    expect(() =>
      toBatchStepResults(parseBatchResultPayload(Uint8Array.of(0x02, 0x00)), [batchStep(0x745, [1])]),
    ).toThrow(/covers 2 steps, expected 1/u);
  });
});

describe("Can Opener SE request notifications", () => {
  it("parses request notifications including batch and fragment flags", () => {
    const plain = parseCanNotification(notification(0x10, 0x00, 0x01, 0x18daf110, [0x7e, 0x00]));
    expect(plain).toMatchObject({
      seq: 0x10,
      status: 0,
      responseCanIdExtended: true,
      responseCanId: 0x18daf110,
      batchResult: false,
    });
    expect(plain.fragment).toBeUndefined();

    const fragment = parseCanNotification(notification(0x11, 0x00, 0x02 | 0x04 | 0x08, 0, [0x10, 0x00, 0xaa]));
    expect(fragment.batchResult).toBe(true);
    expect(fragment.fragment).toEqual({ offset: 0x10, more: true });
    expect(Array.from(fragment.payload)).toEqual([0xaa]);

    expect(() => parseCanNotification(notification(0x12, 0x00, 0x40, 0, []))).toThrow(/flags/u);
    expect(() => parseCanNotification(notification(0x12, 0x00, 0x04, 0, []))).toThrow(/not fragmented/u);
    expect(() => parseCanNotification(Uint8Array.of(0x12, 0x00, 0x00, 0, 0, 0, 0, 0x05, 0x01))).toThrow(
      /payload length/u,
    );
  });

  it("reassembles fragmented responses and rejects gaps", () => {
    const assembler = new CanResponseAssembler();
    expect(
      assembler.push(parseCanNotification(notification(0x20, 0x00, 0x02 | 0x04 | 0x08, 0, [0x00, 0x00, 1, 2, 3]))),
    ).toBeUndefined();
    const complete = assembler.push(parseCanNotification(notification(0x20, 0x00, 0x02 | 0x08, 0, [0x03, 0x00, 4, 5])));
    expect(complete).toMatchObject({ seq: 0x20, status: 0, batchResult: true });
    expect(Array.from(complete?.payload ?? [])).toEqual([1, 2, 3, 4, 5]);

    const reordered = new CanResponseAssembler();
    reordered.push(parseCanNotification(notification(0x21, 0x00, 0x02 | 0x04, 0x7e8, [0x02, 0x00, 3, 4])));
    reordered.push(parseCanNotification(notification(0x21, 0x00, 0x02 | 0x04, 0x7e8, [0x00, 0x00, 1, 2])));
    const last = reordered.push(parseCanNotification(notification(0x21, 0x00, 0x02, 0x7e8, [0x04, 0x00, 5])));
    expect(Array.from(last?.payload ?? [])).toEqual([1, 2, 3, 4, 5]);

    const gap = new CanResponseAssembler();
    gap.push(parseCanNotification(notification(0x22, 0x00, 0x02 | 0x04, 0, [0x00, 0x00, 1, 2, 3])));
    expect(() => gap.push(parseCanNotification(notification(0x22, 0x00, 0x02, 0, [0x05, 0x00, 6])))).toThrow(
      /missing bytes at offset 3/u,
    );

    const unfragmented = new CanResponseAssembler();
    const single = parseCanNotification(notification(0x23, 0x00, 0x00, 0x7e8, [0x41, 0x0d, 0x32]));
    expect(unfragmented.push(single)).toBe(single);
  });

  it("stages and reassembles 4095-byte ISO-TP payloads including BMW extended addressing", () => {
    const fullPayload = Uint8Array.from({ length: 4095 }, (_, i) => i & 0xff);
    const packets = buildRequestPackets(0x2b, {
      txFrame: { canId: 0x6f1, dlc: 8, data: Uint8Array.of(0x12, 0x03, 0x22, 0xf1, 0x90, 0, 0, 0), bus: 0 },
      canFd: { txDl: 64, payload: fullPayload },
      isotpAddressing: { tx: 0x12, rx: 0xf1 },
      expectCanResponse: true,
      responseIdStart: 0x612,
      responseIdEnd: 0x612,
      timeoutMs: 500,
    });

    // First write: 22-byte header + 222 payload bytes = 244 bytes.
    // Remaining 3873 bytes: ceil(3873 / 240) = 17 continuation writes (4-byte header + up to 240 bytes).
    expect(packets).toHaveLength(18);
    const [first = new Uint8Array(), ...continuations] = packets;
    expect(first).toHaveLength(244);
    expect(Array.from(first.slice(0, 5))).toEqual([0x2b, 0x01 | 0x08 | 0x20 | 0x40, 0x00, 0x12, 0xf1]);
    expect(first[19]).toBe(64);
    expect(readU16(first, 20)).toBe(4095);

    const reassembledTx = new Uint8Array(4095);
    const firstChunk = first.subarray(22);
    expect(firstChunk).toHaveLength(222);
    reassembledTx.set(firstChunk, 0);
    let expectedOffset = firstChunk.length;
    for (const packet of continuations) {
      expect(packet[0]).toBe(0x2b);
      expect(packet[1]).toBe(0x01 | 0x08 | 0x20 | 0x40);
      expect(readU16(packet, 2)).toBe(expectedOffset);
      const chunk = packet.subarray(4);
      reassembledTx.set(chunk, expectedOffset);
      expectedOffset += chunk.length;
    }
    expect(expectedOffset).toBe(4095);
    expect(reassembledTx).toEqual(fullPayload);

    expect(() =>
      buildRequestPackets(0x2b, {
        txFrame: { canId: 0x6f1, dlc: 8, data: new Uint8Array(8) },
        canFd: { txDl: 64, payload: new Uint8Array(4096) },
        isotpAddressing: { tx: 0x12, rx: 0xf1 },
        expectCanResponse: true,
      }),
    ).toThrow(/1 to 4095 bytes, got 4096/u);

    // Reassemble a 4095-byte response across 18 BLE notifications (232 data bytes each).
    const assembler = new CanResponseAssembler();
    let result: ReturnType<CanResponseAssembler["push"]>;
    for (let offset = 0; offset < fullPayload.length; offset += 232) {
      const chunk = fullPayload.subarray(offset, Math.min(offset + 232, fullPayload.length));
      const more = offset + chunk.length < fullPayload.length;
      result = assembler.push(
        parseCanNotification(
          notification(0x2b, 0x00, 0x02 | (more ? 0x04 : 0x00), 0x612, [offset & 0xff, (offset >> 8) & 0xff, ...chunk]),
        ),
      );
      if (more) {
        expect(result).toBeUndefined();
      }
    }
    expect(result?.responseCanId).toBe(0x612);
    expect(result?.payload).toEqual(fullPayload);
  });
});
