import type { DbcController } from "../dbc/DbcController.js";
import type { CanFrame, VehicleSignal, VehicleSignalState } from "../dbc/types.js";
import { applyValueNormalization } from "../profile/normalize.js";
import type { ProfileValueNormalization } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

interface ActiveSubscription {
  state: VehicleSignalState;
  normalize?: ProfileValueNormalization;
}

interface SubscriptionRequest {
  state: VehicleSignalState;
  normalize?: ProfileValueNormalization;
}

export interface SubscriptionRefreshStatus {
  hzByName: Record<string, number>;
}

const REFRESH_HZ_WINDOW_MS = 1000;

export class SubscriptionController {
  private readonly activeBySignal = new Map<string, ActiveSubscription>();
  private readonly activeByCanId = new Map<number, Map<string, ActiveSubscription>>();
  private readonly monitoredCanIdSet = new Set<number>();
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
    const affectedCanIds = new Set<number>();

    for (const { state } of requests) {
      this.removeActive(state.name, affectedCanIds);
    }

    for (const request of requests) {
      const active: ActiveSubscription = {
        state: request.state,
        ...(request.normalize !== undefined ? { normalize: request.normalize } : {}),
      };

      this.activeBySignal.set(request.state.name, active);
      this.getOrCreateFrameSubscriptions(request.state.signal.canId).set(request.state.name, active);
      affectedCanIds.add(request.state.signal.canId);
    }

    await this.syncTransportSubscriptions(affectedCanIds);
    return true;
  }

  handleFrame(frame: CanFrame): void {
    const activeSignals = this.activeByCanId.get(frame.canId);
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
    const affectedCanIds = new Set<number>();

    for (const signalName of signalNames) {
      this.removeActive(signalName, affectedCanIds);
    }

    await this.syncTransportSubscriptions(affectedCanIds);
  }

  count(): number {
    return this.activeBySignal.size;
  }

  monitoredCanIds(): number[] {
    return Array.from(this.monitoredCanIdSet);
  }

  cancelAll(): void {
    this.activeBySignal.clear();
    this.activeByCanId.clear();
    this.monitoredCanIdSet.clear();
    this.frameHistoryByName.clear();
    void this.transport.updateMonitor({ operation: "clear" });
  }

  private getOrCreateFrameSubscriptions(canId: number): Map<string, ActiveSubscription> {
    const existing = this.activeByCanId.get(canId);
    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, ActiveSubscription>();
    this.activeByCanId.set(canId, created);
    return created;
  }

  private removeActive(signalName: string, affectedCanIds: Set<number>): void {
    const active = this.activeBySignal.get(signalName);
    if (active === undefined) {
      return;
    }

    this.activeBySignal.delete(signalName);
    this.frameHistoryByName.delete(signalName);
    const frameSubscriptions = this.activeByCanId.get(active.state.signal.canId);
    frameSubscriptions?.delete(signalName);

    if (frameSubscriptions?.size === 0) {
      this.activeByCanId.delete(active.state.signal.canId);
    }

    affectedCanIds.add(active.state.signal.canId);
  }

  private async syncTransportSubscriptions(canIds: Set<number>): Promise<void> {
    for (const canId of canIds) {
      await this.syncTransportSubscription(canId);
    }
  }

  private async syncTransportSubscription(canId: number): Promise<void> {
    const frameSubscriptions = this.activeByCanId.get(canId);
    if (frameSubscriptions === undefined || frameSubscriptions.size === 0) {
      if (this.monitoredCanIdSet.has(canId)) {
        await this.applyMonitorUpdate({ operation: "remove", canIds: [canId] });
        this.monitoredCanIdSet.delete(canId);
      }
      return;
    }

    if (!this.monitoredCanIdSet.has(canId)) {
      await this.applyMonitorUpdate({ operation: "add", canIds: [canId] });
      this.monitoredCanIdSet.add(canId);
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

function decodeSubscriptionStateValue(state: VehicleSignalState, value: unknown): unknown {
  if (state.enumValue === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return value === state.name ? 1 : 0;
  }

  return value === state.enumValue ? 1 : 0;
}
