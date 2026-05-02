import type { CanFrame, CanPayload } from "../dbc/types.js";
import type { MonitorControlRequest, MonitorControlResponse, MonitorSnapshot, VehicleRequest, VehicleTransport } from "./types.js";

type SnapshotCallback = (snapshot: MonitorSnapshot) => void;

const MAX_MONITOR_IDS = 16;

export class MockTransport implements VehicleTransport {
  readonly monitorCanIds = new Set<number>();
  readonly requests: VehicleRequest[] = [];
  readonly monitorUpdates: MonitorControlRequest[] = [];

  private readonly callbacks = new Set<SnapshotCallback>();
  private readonly pidResponses = new Map<string, CanPayload>();
  private readonly monitorFrames = new Map<number, CanFrame>();
  private connected = false;
  private snapshotSequence = 0;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.callbacks.clear();
    this.monitorCanIds.clear();
    this.monitorFrames.clear();
  }

  async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    this.assertConnected();
    this.requests.push(cloneRequest(req));
    if (!req.expectCanResponse) {
      return undefined;
    }

    const response = this.pidResponses.get(frameKey(req.txFrame));
    if (response === undefined) {
      throw new Error(`No mock response registered for CAN ID ${req.txFrame.canId}`);
    }
    return response.slice();
  }

  async updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse> {
    this.assertConnected();
    this.monitorUpdates.push(cloneMonitorControlRequest(req));

    if (req.operation === "clear") {
      this.monitorCanIds.clear();
      this.monitorFrames.clear();
      return this.monitorResponse("ok");
    }

    const invalidCanId = req.canIds.find((canId) => !isValidCanId(canId));
    if (invalidCanId !== undefined) {
      return this.monitorResponse("invalid_can_id");
    }

    if (req.operation === "remove") {
      for (const canId of req.canIds) {
        this.monitorCanIds.delete(canId);
        this.monitorFrames.delete(canId);
      }
      return this.monitorResponse("ok");
    }

    const uniqueCanIds = new Set(req.canIds);
    if (uniqueCanIds.size !== req.canIds.length || req.canIds.some((canId) => this.monitorCanIds.has(canId))) {
      return this.monitorResponse("duplicate_id");
    }

    if (this.monitorCanIds.size + uniqueCanIds.size > MAX_MONITOR_IDS) {
      return this.monitorResponse("monitor_full");
    }

    for (const canId of uniqueCanIds) {
      this.monitorCanIds.add(canId);
    }
    return this.monitorResponse("ok");
  }

  onMonitorSnapshot(cb: SnapshotCallback): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  scriptPidResponse(frame: CanFrame, payload: CanPayload): void {
    this.pidResponses.set(frameKey(frame), payload.slice());
  }

  emitFrame(frame: CanFrame): void {
    if (!this.monitorCanIds.has(frame.canId)) {
      return;
    }
    this.monitorFrames.set(frame.canId, cloneFrame(frame));
    this.emitMonitorSnapshot();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("MockTransport is not connected");
    }
  }

  private monitorResponse(status: MonitorControlResponse["status"]): MonitorControlResponse {
    return {
      status,
      currentMonitorCount: this.monitorCanIds.size,
    };
  }

  private emitMonitorSnapshot(): void {
    const snapshot = {
      sequence: this.snapshotSequence,
      frames: Array.from(this.monitorFrames.values(), cloneFrame),
    };
    this.snapshotSequence = (this.snapshotSequence + 1) & 0xffff;
    for (const callback of this.callbacks) {
      callback(snapshot);
    }
  }
}

function cloneFrame(frame: CanFrame): CanFrame {
  return {
    canId: frame.canId,
    ...(frame.dlc !== undefined ? { dlc: frame.dlc } : {}),
    data: frame.data.slice(),
    ...(frame.extended !== undefined ? { extended: frame.extended } : {}),
  };
}

function cloneRequest(req: VehicleRequest): VehicleRequest {
  return {
    ...req,
    txFrame: cloneFrame(req.txFrame),
    ...(req.diagnostic !== undefined
      ? {
          diagnostic: {
            request: { ...req.diagnostic.request },
            response: { ...req.diagnostic.response },
            ...(req.diagnostic.transport !== undefined ? { transport: req.diagnostic.transport } : {}),
            ...(req.diagnostic.responseLength !== undefined ? { responseLength: req.diagnostic.responseLength } : {}),
          },
        }
      : {}),
    ...(req.action !== undefined ? { action: { ...req.action } } : {}),
  };
}

function cloneMonitorControlRequest(req: MonitorControlRequest): MonitorControlRequest {
  if (req.operation === "clear") {
    return { operation: "clear" };
  }

  return {
    operation: req.operation,
    canIds: [...req.canIds],
  };
}

function frameKey(frame: CanFrame): string {
  return `${frame.canId}:${Array.from(frame.data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function isValidCanId(canId: number): boolean {
  return Number.isInteger(canId) && canId >= 0 && canId <= 0x1fffffff;
}
