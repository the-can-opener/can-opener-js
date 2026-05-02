import { describe, expect, it, vi } from "vitest";
import { DbcController } from "../src/dbc/DbcController.js";
import { DbcParser } from "../src/dbc/DbcParser.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";
import { nissanSentraDbc, nissanSentraProfile } from "./fixtures.js";
import lightsCsv from "./fixtures/lights.csv?raw";

const nissanDbc = nissanSentraDbc;

describe("Nissan Sentra DBC", () => {
  it("parses steering and lights messages from the uploaded DBC", () => {
    const parsed = new DbcParser().parse(nissanDbc);

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({
      id: 2,
      name: "STEERING",
      size: 5,
      transmitter: "XXX",
    });
    expect(parsed.messages[1]).toMatchObject({
      id: 1549,
      name: "LIGHTS_STATUS_60D",
      size: 8,
      transmitter: "BCM",
    });
    expect(parsed.messages[1]?.signals).toHaveLength(8);
    expect(parsed.messages[1]?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "LEFT_SIGNAL", startBit: 13, length: 1 }),
      expect.objectContaining({ name: "RIGHT_SIGNAL", startBit: 14, length: 1 }),
    ]));
  });

  it("contains normalized names for the known Nissan signals", () => {
    const dbc = new DbcController();
    dbc.load([nissanDbc]);

    for (const signalName of normalizedNissanSignalNames) {
      expect(dbc.resolveState(signalName).name).toBe(signalName);
    }
    expect(dbc.resolveState("LEFT_SIGNAL").signal.name).toBe("LEFT_SIGNAL");
    expect(dbc.resolveState("RIGHT_SIGNAL").signal.name).toBe("RIGHT_SIGNAL");
  });

  it("classifies and decodes the shared lights status frame", () => {
    const dbc = new DbcController();
    dbc.load([nissanDbc]);

    expect(dbc.resolve("HEADLIGHTS")).toMatchObject({
      protocol: "frame",
      canId: 1549,
      startBit: 1,
      length: 2,
      enumValues: {
        0: "off",
        2: "headlights_on",
        3: "fog_lights_on",
      },
    });

    const decoded = dbc.decodeFrame({
      canId: 1549,
      data: Uint8Array.of(0b0100_1100, 0b0010_1000, 0, 0, 0, 0, 0, 0),
    });

    expect(decoded).toMatchObject([
      { name: "HEADLIGHTS", value: 2 },
      { name: "HIGH_BEAM", value: 1 },
      { name: "LEFT_SIGNAL", value: 1 },
      { name: "RIGHT_SIGNAL", value: 0 },
      { name: "FRONT_LEFT_DOOR_OPEN", value: 1 },
      { name: "FRONT_RIGHT_DOOR_OPEN", value: 0 },
      { name: "REAR_LEFT_DOOR_OPEN", value: 0 },
      { name: "REAR_RIGHT_DOOR_OPEN", value: 1 },
    ]);
  });

  it("loads the paired Nissan profile with its DBC monitor signals", async () => {
    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "sentra",
      transport,
      profiles: [nissanSentraProfile],
    });

    await expect(car.subscribe(["HEADLIGHTS", "LEFT_SIGNAL", "RIGHT_SIGNAL", "FRONT_LEFT_DOOR_OPEN"])).resolves.toBe(true);
    expect(Array.from(transport.monitorCanIds)).toEqual([1549]);

    transport.emitFrame({
      canId: 1549,
      data: Uint8Array.of(0b0100_1100, 0b0010_1000, 0, 0, 0, 0, 0, 0),
    });

    expect(car.state.get<number>("HEADLIGHTS")).toBe(2);
    expect(car.state.get<number>("LEFT_SIGNAL")).toBe(1);
    expect(car.state.get<number>("RIGHT_SIGNAL")).toBe(0);
    expect(car.state.get<number>("FRONT_LEFT_DOOR_OPEN")).toBe(1);
  });

  it("streams captured lights CSV frames at recorded timestamps into vehicle state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "sentra",
      transport,
      dbcFiles: nissanSentraProfile.dbcFiles,
    });

    try {
      await expect(car.subscribe([
        "HEADLIGHTS",
        "HIGH_BEAM",
        "LEFT_SIGNAL",
        "RIGHT_SIGNAL",
        "FRONT_LEFT_DOOR_OPEN",
        "FRONT_RIGHT_DOOR_OPEN",
        "REAR_LEFT_DOOR_OPEN",
        "REAR_RIGHT_DOOR_OPEN",
      ])).resolves.toBe(true);
      const emittedFrames: StreamedFrame[] = [];
      let previousState: Record<string, unknown> | undefined;
      const stream = streamCsvFramesAtRecordedTimes(lightsCsv, transport, (frame) => {
        const state = car.state.snapshot();
        emittedFrames.push({
          ...frame,
          state,
        });
    if (stateChanged(previousState, state)) {
          console.log(formatStateChange(frame, state));
          previousState = state;
        }
      });

      expect(Array.from(transport.monitorCanIds)).toEqual([1549]);
      expect(car.subscriptionCount()).toBe(8);
      expect(emittedFrames).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(stream.totalDurationMs);

      expect(emittedFrames).toHaveLength(stream.frames.length);
      expect(emittedFrames[0]).toMatchObject({
        elapsedMs: 0,
        state: {
          HEADLIGHTS: 0,
          HIGH_BEAM: 0,
          LEFT_SIGNAL: 0,
          RIGHT_SIGNAL: 0,
        },
      });
      expect(emittedFrames.at(-1)).toMatchObject({
        elapsedMs: stream.totalDurationMs,
        state: {
          HEADLIGHTS: 0,
          HIGH_BEAM: 0,
          LEFT_SIGNAL: 0,
          RIGHT_SIGNAL: 0,
          FRONT_LEFT_DOOR_OPEN: 0,
          FRONT_RIGHT_DOOR_OPEN: 0,
          REAR_LEFT_DOOR_OPEN: 0,
          REAR_RIGHT_DOOR_OPEN: 0,
        },
      });
      expect(stateForData(emittedFrames, "0406002A00")).toMatchObject({
        HEADLIGHTS: 2,
        HIGH_BEAM: 0,
        LEFT_SIGNAL: 0,
        RIGHT_SIGNAL: 0,
      });
      expect(stateForData(emittedFrames, "06060000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_SIGNAL: 0,
        RIGHT_SIGNAL: 0,
      });
      expect(stateForData(emittedFrames, "06260000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_SIGNAL: 1,
        RIGHT_SIGNAL: 0,
      });
      expect(stateForData(emittedFrames, "06460000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_SIGNAL: 0,
        RIGHT_SIGNAL: 1,
      });
      expect(stateForData(emittedFrames, "040E000000")).toMatchObject({
        HEADLIGHTS: 2,
        HIGH_BEAM: 1,
        LEFT_SIGNAL: 0,
        RIGHT_SIGNAL: 0,
      });
      expect(stateForData(emittedFrames, "06660000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_SIGNAL: 1,
        RIGHT_SIGNAL: 1,
      });

      await car.unsubscribe([
        "HEADLIGHTS",
        "HIGH_BEAM",
        "LEFT_SIGNAL",
        "RIGHT_SIGNAL",
        "FRONT_LEFT_DOOR_OPEN",
        "FRONT_RIGHT_DOOR_OPEN",
        "REAR_LEFT_DOOR_OPEN",
        "REAR_RIGHT_DOOR_OPEN",
      ]);
      expect(car.subscriptionCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface CapturedFrame {
  canId: number;
  data: string;
  timestamp: number;
}

interface StreamedFrame extends CapturedFrame {
  elapsedMs: number;
  state: Record<string, unknown>;
}

function streamCsvFramesAtRecordedTimes(
  csv: string,
  transport: MockTransport,
  onFrame: (frame: Omit<StreamedFrame, "state">) => void,
): { frames: CapturedFrame[]; totalDurationMs: number } {
  const frames = parseCsvFrames(csv);
  const firstTimestamp = frames[0]?.timestamp;
  if (firstTimestamp === undefined) {
    throw new Error("CSV must include at least one frame");
  }

  for (const frame of frames) {
    const elapsedMs = timestampDeltaMs(firstTimestamp, frame.timestamp);
    setTimeout(() => {
      transport.emitFrame({
        canId: frame.canId,
        data: hexToBytes(frame.data),
      });
      onFrame({
        ...frame,
        elapsedMs,
      });
    }, elapsedMs);
  }

  return {
    frames,
    totalDurationMs: timestampDeltaMs(firstTimestamp, frames.at(-1)?.timestamp ?? firstTimestamp),
  };
}

function parseCsvFrames(csv: string): CapturedFrame[] {
  const frames: CapturedFrame[] = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const [canId, data, timestamp] = line.split(",");
    if (canId === undefined || data === undefined || timestamp === undefined) {
      throw new Error(`Invalid CSV row: ${line}`);
    }

    frames.push({
      canId: Number.parseInt(canId, 16),
      data,
      timestamp: Number(timestamp),
    });
  }

  return frames;
}

function stateForData(frames: StreamedFrame[], data: string): Record<string, unknown> {
  const frame = frames.find((candidate) => candidate.data === data);
  if (frame === undefined) {
    throw new Error(`Expected CSV frame ${data}`);
  }

  return frame.state;
}

function timestampDeltaMs(firstTimestamp: number, timestamp: number): number {
  return Math.round((timestamp - firstTimestamp) * 1000);
}

function stateChanged(previous: Record<string, unknown> | undefined, current: Record<string, unknown>): boolean {
  if (previous === undefined) {
    return true;
  }

  return normalizedStateKeys.some((key) => previous[key] !== current[key]);
}

function formatStateChange(frame: Omit<StreamedFrame, "state">, state: Record<string, unknown>): string {
  const normalizedStates = normalizedStateKeys.map((key) => `${key}=${String(state[key])}`).join(" ");
  return `[lights.csv +${frame.elapsedMs}ms] can_id=${frame.canId.toString(16).toUpperCase()} data=${frame.data} ${normalizedStates}`;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2).padEnd(2, "0"), 16);
  }
  return bytes;
}

const normalizedStateKeys = [
  "HEADLIGHTS",
  "HIGH_BEAM",
  "LEFT_SIGNAL",
  "RIGHT_SIGNAL",
  "FRONT_LEFT_DOOR_OPEN",
  "FRONT_RIGHT_DOOR_OPEN",
  "REAR_LEFT_DOOR_OPEN",
  "REAR_RIGHT_DOOR_OPEN",
];

const normalizedNissanSignalNames = [
  "STEERING_ANGLE",
  "HEADLIGHTS",
  "HIGH_BEAM",
  "LEFT_SIGNAL",
  "RIGHT_SIGNAL",
  "FRONT_LEFT_DOOR_OPEN",
  "FRONT_RIGHT_DOOR_OPEN",
  "REAR_LEFT_DOOR_OPEN",
  "REAR_RIGHT_DOOR_OPEN",
];
