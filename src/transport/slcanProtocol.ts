import type { CanFrame, CanPayload } from "../dbc/types.js";

/** Lawicel / CANable speed codes. `S7` is 800 kbit/s on CANable SLCAN firmware. */
const SLCAN_BITRATES: ReadonlyArray<readonly [number, string]> = [
  [10_000, "S0"],
  [20_000, "S1"],
  [50_000, "S2"],
  [100_000, "S3"],
  [125_000, "S4"],
  [250_000, "S5"],
  [500_000, "S6"],
  [800_000, "S7"],
  [1_000_000, "S8"],
];

const ISOTP_SINGLE_FRAME = 0x00;
const ISOTP_FIRST_FRAME = 0x10;
const ISOTP_CONSECUTIVE_FRAME = 0x20;
const ISOTP_PENDING_NRC = 0x78;
const ISOTP_MAX_WAIT_FRAMES = 8;
const ISOTP_MAX_PAYLOAD_LENGTH = 4095;

export type IsotpStep =
  | { type: "ignore" }
  | { type: "pending" }
  | { type: "flow-control"; canId: number; extended: boolean }
  | { type: "done"; payload: CanPayload }
  | { type: "invalid"; message: string };

export function slcanBitrateCommand(bitrate: number): string | undefined {
  const match = SLCAN_BITRATES.find(([value]) => value === bitrate);
  return match === undefined ? undefined : `${match[1]}\r`;
}

export function encodeSlcanDataFrame(frame: CanFrame): string {
  const length = frameLength(frame);
  if (length > 8) {
    throw new Error(`SLCAN frames are limited to 8 bytes, received ${length}`);
  }

  const extended = frame.extended === true;
  if (!extended && frame.canId > 0x7ff) {
    throw new Error(`Standard CAN ID ${frame.canId} does not fit in 11 bits`);
  }
  if (extended && frame.canId > 0x1fffffff) {
    throw new Error(`Extended CAN ID ${frame.canId} does not fit in 29 bits`);
  }

  const id = frame.canId
    .toString(16)
    .toUpperCase()
    .padStart(extended ? 8 : 3, "0");
  const data = Array.from(frame.data.subarray(0, length), (byte) =>
    byte.toString(16).toUpperCase().padStart(2, "0"),
  ).join("");
  return `${extended ? "T" : "t"}${id}${length.toString(16).toUpperCase()}${data}\r`;
}

/**
 * Parses one SLCAN data line. A trailing Lawicel timestamp (4 hex digits) is
 * ignored. Remote frames and command replies return `undefined`.
 */
export function parseSlcanFrame(line: string): CanFrame | undefined {
  const text = line.trim();
  if (text.length === 0) {
    return undefined;
  }

  const kind = text[0];
  if (kind !== "t" && kind !== "T") {
    return undefined;
  }

  const extended = kind === "T";
  const idLength = extended ? 8 : 3;
  if (text.length < 2 + idLength) {
    return undefined;
  }

  const canId = Number.parseInt(text.slice(1, 1 + idLength), 16);
  const dlc = Number.parseInt(text.slice(1 + idLength, 2 + idLength), 16);
  if (!Number.isInteger(canId) || !Number.isInteger(dlc) || dlc > 8) {
    return undefined;
  }

  const dataStart = 2 + idLength;
  const dataEnd = dataStart + dlc * 2;
  if (text.length < dataEnd) {
    return undefined;
  }

  const data = new Uint8Array(dlc);
  for (let index = 0; index < dlc; index += 1) {
    const byte = Number.parseInt(text.slice(dataStart + index * 2, dataStart + index * 2 + 2), 16);
    if (!Number.isInteger(byte)) {
      return undefined;
    }
    data[index] = byte;
  }

  return {
    canId,
    dlc,
    data,
    bus: 0,
    ...(extended ? { extended: true } : {}),
  };
}

/**
 * Reassembles one ISO-TP response the way Can Opener firmware does: PCI bytes
 * are removed, a standard-id flow control frame goes to `responseId - 8`, and
 * `7F xx 78` response-pending replies keep the exchange open.
 */
export class IsotpReassembly {
  private mode: "header" | "consecutive" = "header";
  private totalLength = 0;
  private copiedLength = 0;
  private expectedSequence = 1;
  private payload = new Uint8Array(0);
  private responseCanId = 0;
  private responseExtended = false;
  private pendingResponses = 0;

  constructor(
    private readonly requestCanId: number,
    private readonly requestExtended: boolean,
    private readonly responseIdStart: number,
    private readonly responseIdEnd: number,
    private readonly responseExtendedRange: boolean,
  ) {}

  push(frame: CanFrame): IsotpStep {
    if (this.mode === "header") {
      if (!this.matchesRange(frame)) {
        return { type: "ignore" };
      }
      return this.pushHeader(frame);
    }

    const extended = frame.extended === true;
    if (extended !== this.responseExtended || frame.canId !== this.responseCanId) {
      return { type: "ignore" };
    }
    return this.pushConsecutive(frame);
  }

  private pushHeader(frame: CanFrame): IsotpStep {
    const data = frame.data;
    const dlc = frame.dlc ?? data.length;
    if (dlc === 0 || data.length === 0) {
      return { type: "invalid", message: "ISO-TP response frame was empty" };
    }

    const pci = data[0] ?? 0;
    const pciType = pci & 0xf0;
    if (pciType === ISOTP_SINGLE_FRAME) {
      const length = pci & 0x0f;
      if (length > dlc - 1) {
        return { type: "invalid", message: "ISO-TP single frame length exceeds the CAN frame" };
      }
      return this.finish(data.slice(1, 1 + length));
    }

    if (pciType !== ISOTP_FIRST_FRAME || dlc < 2) {
      return { type: "invalid", message: `Unexpected ISO-TP PCI 0x${pci.toString(16)}` };
    }

    const lengthHigh = data[1] ?? 0;
    const totalLength = ((pci & 0x0f) << 8) | lengthHigh;
    if (totalLength === 0 || totalLength > ISOTP_MAX_PAYLOAD_LENGTH) {
      return { type: "invalid", message: `ISO-TP length ${totalLength} is out of range` };
    }

    const firstLength = Math.min(dlc - 2, totalLength);
    this.payload = new Uint8Array(totalLength);
    this.payload.set(data.subarray(2, 2 + firstLength));
    this.totalLength = totalLength;
    this.copiedLength = firstLength;
    this.expectedSequence = 1;
    this.responseCanId = frame.canId;
    this.responseExtended = frame.extended === true;
    this.mode = "consecutive";

    if (!this.responseExtended) {
      if (frame.canId < 8) {
        return { type: "invalid", message: "ISO-TP response ID is too small for flow control" };
      }
      return { type: "flow-control", canId: frame.canId - 8, extended: false };
    }

    return {
      type: "flow-control",
      canId: this.requestCanId,
      extended: this.requestExtended,
    };
  }

  private pushConsecutive(frame: CanFrame): IsotpStep {
    const data = frame.data;
    const dlc = frame.dlc ?? data.length;
    if (dlc === 0 || data.length === 0) {
      return { type: "ignore" };
    }

    const pci = data[0] ?? 0;
    const pciType = pci & 0xf0;
    const sequence = pci & 0x0f;
    if (pciType !== ISOTP_CONSECUTIVE_FRAME || sequence !== this.expectedSequence) {
      return { type: "ignore" };
    }

    const remaining = this.totalLength - this.copiedLength;
    const chunkLength = Math.min(dlc - 1, remaining);
    this.payload.set(data.subarray(1, 1 + chunkLength), this.copiedLength);
    this.copiedLength += chunkLength;
    this.expectedSequence = (this.expectedSequence + 1) & 0x0f;

    if (this.copiedLength < this.totalLength) {
      return { type: "ignore" };
    }
    return this.finish(this.payload.slice(0, this.copiedLength));
  }

  private finish(payload: CanPayload): IsotpStep {
    if (
      payload.length === 3 &&
      payload[0] === 0x7f &&
      payload[2] === ISOTP_PENDING_NRC &&
      this.pendingResponses < ISOTP_MAX_WAIT_FRAMES
    ) {
      this.pendingResponses += 1;
      this.mode = "header";
      this.copiedLength = 0;
      return { type: "pending" };
    }
    return { type: "done", payload };
  }

  private matchesRange(frame: CanFrame): boolean {
    if ((frame.extended === true) !== this.responseExtendedRange) {
      return false;
    }
    return frame.canId >= this.responseIdStart && frame.canId <= this.responseIdEnd;
  }
}

function frameLength(frame: CanFrame): number {
  return frame.dlc ?? frame.data.length;
}
