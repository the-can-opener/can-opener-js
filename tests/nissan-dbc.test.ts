import { describe, expect, it, vi } from "vitest";
import { DbcController } from "../src/dbc/DbcController.js";
import { DbcParser } from "../src/dbc/DbcParser.js";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/MockTransport.js";
import type { DbcFile } from "../src/dbc/types.js";
import lightsCsv from "./fixtures/lights.csv?raw";
import nissanDbcContent from "./fixtures/nissan-sentra-2010.dbc?raw";

const nissanDbc: DbcFile = {
  name: "nissan-sentra-2010.dbc",
  content: nissanDbcContent,
};

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
    expect(parsed.messages[1]?.signals).toHaveLength(7);
    expect(parsed.valueTables.find((table) => table.signalName === "TurnSignalTick")?.values).toEqual({
      0: "off",
      1: "LEFT_TURN_SIGNAL",
      2: "RIGHT_TURN_SIGNAL",
      3: "HAZARD_LIGHTS",
    });
  });

  it("contains normalized names for the known Nissan signals", () => {
    const dbc = new DbcController();
    dbc.load([nissanDbc]);

    for (const signalName of normalizedNissanSignalNames) {
      expect(dbc.resolveState(signalName).name).toBe(signalName);
    }
    expect(dbc.resolveState("LEFT_TURN_SIGNAL")).toMatchObject({
      enumValue: 1,
      signal: {
        name: "TurnSignalTick",
      },
    });
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
      { name: "TurnSignalTick", value: 1 },
      { name: "FRONT_LEFT_DOOR_OPEN", value: 1 },
      { name: "FRONT_RIGHT_DOOR_OPEN", value: 0 },
      { name: "REAR_LEFT_DOOR_OPEN", value: 0 },
      { name: "REAR_RIGHT_DOOR_OPEN", value: 1 },
    ]);
  });

  it("streams captured lights CSV frames at recorded timestamps into vehicle state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const manager = new VirtualVehicleManager();
    const transport = new MockTransport();
    const car = await manager.connect({
      id: "sentra",
      transport,
      dbcFiles: [nissanDbc],
    });

    try {
      const unsubscribe = await car.subscribe({
        HEADLIGHTS: { frequencyHz: 10 },
        HIGH_BEAM: { frequencyHz: 10 },
        LEFT_TURN_SIGNAL: { frequencyHz: 10 },
        RIGHT_TURN_SIGNAL: { frequencyHz: 10 },
        HAZARD_LIGHTS: { frequencyHz: 10 },
        FRONT_LEFT_DOOR_OPEN: { frequencyHz: 10 },
        FRONT_RIGHT_DOOR_OPEN: { frequencyHz: 10 },
        REAR_LEFT_DOOR_OPEN: { frequencyHz: 10 },
        REAR_RIGHT_DOOR_OPEN: { frequencyHz: 10 },
      });
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

      expect(transport.subscriptions).toHaveLength(1);
      expect(transport.subscriptions[0]).toMatchObject({
        signalNames: [
          "HEADLIGHTS",
          "HIGH_BEAM",
          "LEFT_TURN_SIGNAL",
          "RIGHT_TURN_SIGNAL",
          "HAZARD_LIGHTS",
          "FRONT_LEFT_DOOR_OPEN",
          "FRONT_RIGHT_DOOR_OPEN",
          "REAR_LEFT_DOOR_OPEN",
          "REAR_RIGHT_DOOR_OPEN",
        ],
        frequencyHz: 10,
      });
      expect(emittedFrames).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(stream.totalDurationMs);

      expect(emittedFrames).toHaveLength(stream.frames.length);
      expect(emittedFrames[0]).toMatchObject({
        elapsedMs: 0,
        state: {
          HEADLIGHTS: 0,
          HIGH_BEAM: 0,
          LEFT_TURN_SIGNAL: 0,
          RIGHT_TURN_SIGNAL: 0,
          HAZARD_LIGHTS: 0,
        },
      });
      expect(emittedFrames.at(-1)).toMatchObject({
        elapsedMs: stream.totalDurationMs,
        state: {
          HEADLIGHTS: 0,
          HIGH_BEAM: 0,
          LEFT_TURN_SIGNAL: 0,
          RIGHT_TURN_SIGNAL: 0,
          HAZARD_LIGHTS: 0,
          FRONT_LEFT_DOOR_OPEN: 0,
          FRONT_RIGHT_DOOR_OPEN: 0,
          REAR_LEFT_DOOR_OPEN: 0,
          REAR_RIGHT_DOOR_OPEN: 0,
        },
      });
      expect(stateForData(emittedFrames, "0406002A00")).toMatchObject({
        HEADLIGHTS: 2,
        HIGH_BEAM: 0,
        LEFT_TURN_SIGNAL: 0,
        RIGHT_TURN_SIGNAL: 0,
        HAZARD_LIGHTS: 0,
      });
      expect(stateForData(emittedFrames, "06060000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_TURN_SIGNAL: 0,
        RIGHT_TURN_SIGNAL: 0,
        HAZARD_LIGHTS: 0,
      });
      expect(stateForData(emittedFrames, "06260000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_TURN_SIGNAL: 1,
        RIGHT_TURN_SIGNAL: 0,
        HAZARD_LIGHTS: 0,
      });
      expect(stateForData(emittedFrames, "06460000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_TURN_SIGNAL: 0,
        RIGHT_TURN_SIGNAL: 1,
        HAZARD_LIGHTS: 0,
      });
      expect(stateForData(emittedFrames, "040E000000")).toMatchObject({
        HEADLIGHTS: 2,
        HIGH_BEAM: 1,
        LEFT_TURN_SIGNAL: 0,
        RIGHT_TURN_SIGNAL: 0,
        HAZARD_LIGHTS: 0,
      });
      expect(stateForData(emittedFrames, "06660000000020")).toMatchObject({
        HEADLIGHTS: 3,
        HIGH_BEAM: 0,
        LEFT_TURN_SIGNAL: 0,
        RIGHT_TURN_SIGNAL: 0,
        HAZARD_LIGHTS: 1,
      });

      await unsubscribe();
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
  "LEFT_TURN_SIGNAL",
  "RIGHT_TURN_SIGNAL",
  "HAZARD_LIGHTS",
  "FRONT_LEFT_DOOR_OPEN",
  "FRONT_RIGHT_DOOR_OPEN",
  "REAR_LEFT_DOOR_OPEN",
  "REAR_RIGHT_DOOR_OPEN",
];

const normalizedNissanSignalNames = [
  "STEERING_ANGLE",
  "HEADLIGHTS",
  "HIGH_BEAM",
  "LEFT_TURN_SIGNAL",
  "RIGHT_TURN_SIGNAL",
  "HAZARD_LIGHTS",
  "FRONT_LEFT_DOOR_OPEN",
  "FRONT_RIGHT_DOOR_OPEN",
  "REAR_LEFT_DOOR_OPEN",
  "REAR_RIGHT_DOOR_OPEN",
];
