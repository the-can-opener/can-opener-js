import type { CanFrame, CanPayload } from "../dbc/types.js";
import { NoEcuResponseError } from "../errors.js";
import type {
  CanBusConfigRequest,
  CanBusConfigResponse,
  MonitorControlRequest,
  MonitorControlResponse,
  MonitorSnapshot,
  VehicleBatchRequest,
  VehicleBatchResponse,
  VehicleBatchStepResult,
  VehicleRequest,
  VehicleTransport,
} from "./types.js";

type SnapshotCallback = (snapshot: MonitorSnapshot) => void;

const MAX_MONITOR_IDS = 16;

export class MockTransport implements VehicleTransport {
  /** Aggregate compatibility view of monitored IDs across all buses. */
  readonly monitorCanIds = new Set<number>();
  /** Every step sent, whether individually or as part of a batch. */
  readonly requests: VehicleRequest[] = [];
  /** Batches received through `sendRequestBatch`, in order. */
  readonly batches: VehicleBatchRequest[] = [];
  readonly monitorUpdates: MonitorControlRequest[] = [];
  readonly busConfigUpdates: CanBusConfigRequest[] = [];

  private readonly callbacks = new Set<SnapshotCallback>();
  private readonly pidResponses = new Map<string, CanPayload>();
  private readonly monitorCanIdsByBus = new Map<number, Set<number>>();
  private readonly monitorFrames = new Map<string, CanFrame>();
  private connected = false;
  private snapshotSequence = 0;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async configureBus(req: CanBusConfigRequest): Promise<CanBusConfigResponse> {
    this.assertConnected();
    this.busConfigUpdates.push({ ...req });
    if (!isValidBus(req.bus)) return { status: "invalid_bus", bus: req.bus };
    if ((req.bitrate !== "auto" && !isValidBitrate(req.bitrate)) ||
        (req.dataBitrate !== undefined && !isValidBitrate(req.dataBitrate))) {
      return { status: "invalid_bitrate", bus: req.bus };
    }
    return {
      status: "ok",
      bus: req.bus,
      ...(typeof req.bitrate === "number" ? { bitrate: req.bitrate } : {}),
      ...(req.dataBitrate !== undefined ? { dataBitrate: req.dataBitrate } : {}),
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.callbacks.clear();
    this.monitorCanIds.clear();
    this.monitorCanIdsByBus.clear();
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
      throw new Error(
        `No mock response registered for CAN${normalizeBus(req.txFrame.bus)} ID ${req.txFrame.canId}`,
      );
    }
    return response.slice();
  }

  /**
   * Mirrors the device's batch semantics on top of `sendRequest`: steps run in
   * order on one bus, a `NoEcuResponseError` maps to `no_response`, any other
   * failure maps to `error`, and later steps are `skipped` after the first
   * failure unless `continueOnError` is set.
   */
  async sendRequestBatch(req: VehicleBatchRequest): Promise<VehicleBatchResponse> {
    this.assertConnected();
    if (req.steps.length === 0) {
      throw new Error("Batch request must contain at least one step");
    }
    const bus = normalizeBus(req.bus);
    const mismatched = req.steps.find((step) => normalizeBus(step.txFrame.bus) !== bus);
    if (mismatched !== undefined) {
      throw new Error(
        `Batch step on CAN${normalizeBus(mismatched.txFrame.bus)} does not match batch bus CAN${bus}`,
      );
    }
    this.batches.push(cloneBatchRequest(req));

    const results: VehicleBatchStepResult[] = [];
    let aborted = false;
    for (const step of req.steps) {
      if (aborted) {
        results.push({ status: "skipped" });
        continue;
      }
      const result = await this.runBatchStep(step);
      results.push(result);
      if (result.status !== "ok" && req.continueOnError !== true) {
        aborted = true;
      }
    }
    return { steps: results };
  }

  private async runBatchStep(step: VehicleRequest): Promise<VehicleBatchStepResult> {
    try {
      const payload = await this.sendRequest(step);
      return {
        status: "ok",
        ...(payload !== undefined ? { payload, responseCanId: step.responseIdStart ?? step.txFrame.canId } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof NoEcuResponseError) {
        return { status: "no_response" };
      }
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse> {
    this.assertConnected();
    this.monitorUpdates.push(cloneMonitorControlRequest(req));

    const bus = normalizeBus(req.bus);
    if (!isValidBus(bus)) {
      return this.monitorResponse("invalid_bus", bus, req.bus !== undefined);
    }

    const busCanIds = this.getOrCreateBusCanIds(bus);
    if (req.operation === "clear") {
      busCanIds.clear();
      this.clearFramesForBus(bus);
      this.refreshAggregateMonitorCanIds();
      return this.monitorResponse("ok", bus, req.bus !== undefined);
    }

    const invalidCanId = req.canIds.find((canId) => !isValidCanId(canId));
    if (invalidCanId !== undefined) {
      return this.monitorResponse("invalid_can_id", bus, req.bus !== undefined);
    }

    if (req.operation === "remove") {
      for (const canId of req.canIds) {
        busCanIds.delete(canId);
        this.monitorFrames.delete(monitorKey(bus, canId));
      }
      this.refreshAggregateMonitorCanIds();
      return this.monitorResponse("ok", bus, req.bus !== undefined);
    }

    const uniqueCanIds = new Set(req.canIds);
    if (uniqueCanIds.size !== req.canIds.length || req.canIds.some((canId) => busCanIds.has(canId))) {
      return this.monitorResponse("duplicate_id", bus, req.bus !== undefined);
    }

    if (busCanIds.size + uniqueCanIds.size > MAX_MONITOR_IDS) {
      return this.monitorResponse("monitor_full", bus, req.bus !== undefined);
    }

    for (const canId of uniqueCanIds) {
      busCanIds.add(canId);
    }
    this.refreshAggregateMonitorCanIds();
    return this.monitorResponse("ok", bus, req.bus !== undefined);
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

  clearPidResponses(): void {
    this.pidResponses.clear();
  }

  emitFrame(frame: CanFrame): void {
    const bus = normalizeBus(frame.bus);
    if (!this.monitorCanIdsByBus.get(bus)?.has(frame.canId)) {
      return;
    }
    const normalizedFrame = cloneFrame({ ...frame, bus });
    this.monitorFrames.set(monitorKey(bus, frame.canId), normalizedFrame);
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

  private getOrCreateBusCanIds(bus: number): Set<number> {
    const existing = this.monitorCanIdsByBus.get(bus);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<number>();
    this.monitorCanIdsByBus.set(bus, created);
    return created;
  }

  private clearFramesForBus(bus: number): void {
    for (const [key, frame] of this.monitorFrames) {
      if (normalizeBus(frame.bus) === bus) {
        this.monitorFrames.delete(key);
      }
    }
  }

  private refreshAggregateMonitorCanIds(): void {
    this.monitorCanIds.clear();
    for (const ids of this.monitorCanIdsByBus.values()) {
      for (const canId of ids) {
        this.monitorCanIds.add(canId);
      }
    }
  }

  private monitorResponse(
    status: MonitorControlResponse["status"],
    bus: number,
    includeBus: boolean,
  ): MonitorControlResponse {
    const response: MonitorControlResponse = {
      status,
      currentMonitorCount: this.monitorCanIdsByBus.get(bus)?.size ?? 0,
    };
    if (includeBus) {
      response.bus = bus;
    }
    return response;
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
    ...(frame.bus !== undefined ? { bus: frame.bus } : {}),
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

function cloneBatchRequest(req: VehicleBatchRequest): VehicleBatchRequest {
  return {
    ...(req.signalName !== undefined ? { signalName: req.signalName } : {}),
    ...(req.bus !== undefined ? { bus: req.bus } : {}),
    ...(req.continueOnError !== undefined ? { continueOnError: req.continueOnError } : {}),
    steps: req.steps.map((step) => ({
      ...cloneRequest(step),
      ...(step.delayAfterMs !== undefined ? { delayAfterMs: step.delayAfterMs } : {}),
    })),
  };
}

function cloneMonitorControlRequest(req: MonitorControlRequest): MonitorControlRequest {
  if (req.operation === "clear") {
    return {
      operation: "clear",
      ...(req.bus !== undefined ? { bus: req.bus } : {}),
    };
  }

  return {
    operation: req.operation,
    canIds: [...req.canIds],
    ...(req.bus !== undefined ? { bus: req.bus } : {}),
  };
}

function frameKey(frame: Pick<CanFrame, "canId" | "bus" | "data">): string {
  return `${normalizeBus(frame.bus)}:${frame.canId}:${Array.from(frame.data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function monitorKey(bus: number, canId: number): string {
  return `${bus}:${canId}`;
}

function normalizeBus(bus: number | undefined): number {
  return bus ?? 0;
}

function isValidBus(bus: number): boolean {
  return Number.isInteger(bus) && bus >= 0 && bus <= 0xff;
}

function isValidBitrate(bitrate: number): boolean {
  return Number.isInteger(bitrate) && bitrate > 0 && bitrate <= 0xffffffff;
}

function isValidCanId(canId: number): boolean {
  return Number.isInteger(canId) && canId >= 0 && canId <= 0x1fffffff;
}
