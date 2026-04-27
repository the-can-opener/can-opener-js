import type { DbcController } from "../dbc/DbcController.js";
import type { CanFrame, SubscriptionOptions, Unsubscribe, VehicleSignal, VehicleSignalState } from "../dbc/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

type Timer = ReturnType<typeof setTimeout>;

interface ActiveSubscription {
  state: VehicleSignalState;
  opts: SubscriptionOptions;
  startedAt: number;
  timer?: Timer;
}

interface SubscriptionRequest {
  state: VehicleSignalState;
  opts?: SubscriptionOptions;
}

export class SubscriptionController {
  private readonly activeBySignal = new Map<string, ActiveSubscription>();
  private readonly activeByCanId = new Map<number, Map<string, ActiveSubscription>>();

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
  ) {}

  async add(signal: VehicleSignal, opts: SubscriptionOptions = {}): Promise<Unsubscribe> {
    const unsubscribe = await this.addMany([{ state: { name: signal.name, signal }, opts }]);
    return unsubscribe;
  }

  async addMany(requests: SubscriptionRequest[]): Promise<Unsubscribe> {
    const affectedCanIds = new Set<number>();
    const startedAt = Date.now();

    for (const { state } of requests) {
      this.removeActive(state.name, affectedCanIds);
    }

    for (const request of requests) {
      const opts = request.opts ?? {};
      const active: ActiveSubscription = {
        state: request.state,
        opts,
        startedAt,
      };

      if (opts.durationMs !== undefined) {
        active.timer = setTimeout(() => {
          void this.cancel(request.state.name);
        }, opts.durationMs);
      }

      this.activeBySignal.set(request.state.name, active);
      this.getOrCreateFrameSubscriptions(request.state.signal.canId).set(request.state.name, active);
      affectedCanIds.add(request.state.signal.canId);
    }

    await this.syncTransportSubscriptions(affectedCanIds);
    return () => this.cancelMany(requests.map((request) => request.state.name));
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

        this.state.update(active.state.name, decodeSubscriptionStateValue(active.state, value));
      }
    }
  }

  async cancel(signalName: string): Promise<void> {
    await this.cancelMany([signalName]);
  }

  cancelAll(): void {
    void this.cancelMany(Array.from(this.activeBySignal.keys()));
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

  private async cancelMany(signalNames: string[]): Promise<void> {
    const affectedCanIds = new Set<number>();

    for (const signalName of signalNames) {
      this.removeActive(signalName, affectedCanIds);
    }

    await this.syncTransportSubscriptions(affectedCanIds);
  }

  private removeActive(signalName: string, affectedCanIds: Set<number>): void {
    const active = this.activeBySignal.get(signalName);
    if (active === undefined) {
      return;
    }

    if (active.timer !== undefined) {
      clearTimeout(active.timer);
    }

    this.activeBySignal.delete(signalName);
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
      await this.transport.unsubscribe(canId);
      return;
    }

    await this.transport.subscribe({
      signalNames: Array.from(frameSubscriptions.keys()),
      frame: {
        canId,
        data: new Uint8Array(8),
      },
      ...mergeSubscriptionOptions(Array.from(frameSubscriptions.values())),
    });
  }
}

function decodeSubscriptionStateValue(state: VehicleSignalState, value: unknown): unknown {
  if (state.enumValue === undefined) {
    return value;
  }

  return value === state.enumValue ? 1 : 0;
}

function mergeSubscriptionOptions(active: ActiveSubscription[]): SubscriptionOptions {
  const frequencyHz = active.reduce<number | undefined>((max, subscription) => {
    if (subscription.opts.frequencyHz === undefined) {
      return max;
    }
    return max === undefined ? subscription.opts.frequencyHz : Math.max(max, subscription.opts.frequencyHz);
  }, undefined);

  const remainingDurations = active.map((subscription) => {
    if (subscription.opts.durationMs === undefined) {
      return undefined;
    }
    return Math.max(0, subscription.opts.durationMs - (Date.now() - subscription.startedAt));
  });
  const allFiniteDuration = remainingDurations.every((duration) => duration !== undefined);
  const durationMs = allFiniteDuration
    ? Math.max(...remainingDurations.map((duration) => duration ?? 0))
    : undefined;

  return {
    ...(frequencyHz !== undefined ? { frequencyHz } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
