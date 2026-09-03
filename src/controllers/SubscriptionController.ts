import type { DbcController } from "../dbc/DbcController.js";
import type { CanFrame, VehicleSignal, VehicleSignalState } from "../dbc/types.js";
import { applyValueNormalization } from "../profile/normalize.js";
import type { ProfileValueNormalization } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

interface ActiveSubscription {
  state: VehicleSignalState;
  bus: number;
  normalize?: ProfileValueNormalization;
}

interface SubscriptionRequest {
  state: VehicleSignalState;
  bus?: number;
  normalize?: ProfileValueNormalization;
}

interface FrameRef {
  bus: number;
  canId: number;
}

export interface SubscriptionRefreshStatus {
  hzByName: Record<string, number>;
}

const REFRESH_HZ_WINDOW_MS = 1000;

export class SubscriptionController {
  private readonly activeBySignal = new Map<string, ActiveSubscription>();
  private readonly activeByFrameKey = new Map<string, Map<string, ActiveSubscription>>();
  private readonly monitoredFrameKeys = new Set<string>();
  private readonly frameHistoryByName = new Map<string, number[]>();

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
  ) {}

  async add(signal: VehicleSignal): Promise<boolean> {
    return await this.addMany([{ state: { name: signal.name, signal } }]);
  }

  async addMany(requests: SubscriptionRequest[]): Promise<boolean> {
    const affectedFrames = new Map<string, FrameRef>();

    for (const { state } of requests) {
      this.removeActive(state.name, affectedFrames);
    }

    for (const request of requests) {
      const bus = normalizeBus(request.bus);
      const active: ActiveSubscription = {
        state: request.state,
        bus,
        ...(request.normalize !== undefined ? { normalize: request.normalize } : {}),
      };
      const ref = { bus, canId: request.state.signal.canId };
      const key = frameKey(ref.bus, ref.canId);

      this.activeBySignal.set(request.state.name, active);
      this.getOrCreateFrameSubscriptions(ref).set(request.state.name, active);
      affectedFrames.set(key, ref);
    }

    await this.syncTransportSubscriptions(affectedFrames);
    return true;
  }

  handleFrame(frame: CanFrame): void {
    const bus = normalizeBus(frame.bus);
    const activeSignals = this.activeByFrameKey.get(frameKey(bus, frame.canId));
    if (activeSignals === undefined) {
      return;
    }

    const decoded = this.dbc.decodeFrame(frame);
    for (const { signal, value } of decoded) {
      for (const active of activeSignals.values()) {
        if (active.state.signal.name !== signal.name) {
          continue;
        }

        const stateValue = decodeSubscriptionStateValue(active.state, value);
        this.state.update(active.state.name, applyValueNormalization(stateValue, active.normalize));
        this.recordFrame(active.state.name);
      }
    }
  }

  refreshStatus(): SubscriptionRefreshStatus {
    const now = Date.now();
    const hzByName = Object.fromEntries(
      Array.from(this.activeBySignal.keys(), (signalName) => [
        signalName,
        this.recentHistory(signalName, now).length /
          (REFRESH_HZ_WINDOW_MS / 1000),
      ]),
    );

    return { hzByName };
  }

  async cancel(signalName: string): Promise<void> {
    await this.cancelMany([signalName]);
  }

  async cancelMany(signalNames: readonly string[]): Promise<void> {
    const affectedFrames = new Map<string, FrameRef>();

    for (const signalName of signalNames) {
      this.removeActive(signalName, affectedFrames);
    }

    await this.syncTransportSubscriptions(affectedFrames);
  }

  count(): number {
    return this.activeBySignal.size;
  }

  monitoredCanIds(): number[] {
    return Array.from(
      new Set(Array.from(this.monitoredFrameKeys, (key) => parseFrameKey(key).canId)),
    );
  }

  cancelAll(): void {
    const buses = new Set<number>([0]);
    for (const key of this.monitoredFrameKeys) {
      buses.add(parseFrameKey(key).bus);
    }

    this.activeBySignal.clear();
    this.activeByFrameKey.clear();
    this.monitoredFrameKeys.clear();
    this.frameHistoryByName.clear();

    for (const bus of buses) {
      void this.transport.updateMonitor({ operation: "clear", bus });
    }
  }

  private getOrCreateFrameSubscriptions(ref: FrameRef): Map<string, ActiveSubscription> {
    const key = frameKey(ref.bus, ref.canId);
    const existing = this.activeByFrameKey.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, ActiveSubscription>();
    this.activeByFrameKey.set(key, created);
    return created;
  }

  private removeActive(signalName: string, affectedFrames: Map<string, FrameRef>): void {
    const active = this.activeBySignal.get(signalName);
    if (active === undefined) {
      return;
    }

    this.activeBySignal.delete(signalName);
    this.frameHistoryByName.delete(signalName);
    const ref = { bus: active.bus, canId: active.state.signal.canId };
    const key = frameKey(ref.bus, ref.canId);
    const frameSubscriptions = this.activeByFrameKey.get(key);
    frameSubscriptions?.delete(signalName);

    if (frameSubscriptions?.size === 0) {
      this.activeByFrameKey.delete(key);
    }

    affectedFrames.set(key, ref);
  }

  private async syncTransportSubscriptions(affectedFrames: Map<string, FrameRef>): Promise<void> {
    for (const ref of affectedFrames.values()) {
      await this.syncTransportSubscription(ref);
    }
  }

  private async syncTransportSubscription(ref: FrameRef): Promise<void> {
    const key = frameKey(ref.bus, ref.canId);
    const frameSubscriptions = this.activeByFrameKey.get(key);
    if (frameSubscriptions === undefined || frameSubscriptions.size === 0) {
      if (this.monitoredFrameKeys.has(key)) {
        await this.applyMonitorUpdate({ operation: "remove", canIds: [ref.canId], bus: ref.bus });
        this.monitoredFrameKeys.delete(key);
      }
      return;
    }

    if (!this.monitoredFrameKeys.has(key)) {
      await this.applyMonitorUpdate({ operation: "add", canIds: [ref.canId], bus: ref.bus });
      this.monitoredFrameKeys.add(key);
    }
  }

  private async applyMonitorUpdate(req: Parameters<VehicleTransport["updateMonitor"]>[0]): Promise<void> {
    const response = await this.transport.updateMonitor(req);
    if (response.status !== "ok") {
      throw new Error(`Monitor ${req.operation} failed with status ${response.status}`);
    }
  }

  private recordFrame(signalName: string): void {
    const now = Date.now();
    const history = this.recentHistory(signalName, now);
    history.push(now);
    this.frameHistoryByName.set(signalName, history);
  }

  private recentHistory(signalName: string, now: number): number[] {
    const history = this.frameHistoryByName.get(signalName) ?? [];
    const recentHistory = history.filter(
      (timestamp) => now - timestamp <= REFRESH_HZ_WINDOW_MS,
    );
    this.frameHistoryByName.set(signalName, recentHistory);
    return recentHistory;
  }
}

function normalizeBus(bus: number | undefined): number {
  return bus ?? 0;
}

function frameKey(bus: number, canId: number): string {
  return `${bus}:${canId}`;
}

function parseFrameKey(key: string): FrameRef {
  const separator = key.indexOf(":");
  return {
    bus: Number(key.slice(0, separator)),
    canId: Number(key.slice(separator + 1)),
  };
}

function decodeSubscriptionStateValue(state: VehicleSignalState, value: unknown): unknown {
  if (state.enumValue === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value === state.name ? 1 : 0;
  }

  return value === state.enumValue ? 1 : 0;
}
