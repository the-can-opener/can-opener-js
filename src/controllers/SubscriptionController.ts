import type { DbcController } from "../dbc/DbcController.js";
import type { CanFrame, SubscriptionOptions, Unsubscribe, VehicleSignal } from "../dbc/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

type Timer = ReturnType<typeof setTimeout>;

interface ActiveSubscription {
  signal: VehicleSignal;
  opts: SubscriptionOptions;
  startedAt: number;
  timer?: Timer;
}

interface SubscriptionRequest {
  signal: VehicleSignal;
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
    const unsubscribe = await this.addMany([{ signal, opts }]);
    return unsubscribe;
  }

  async addMany(requests: SubscriptionRequest[]): Promise<Unsubscribe> {
    const affectedCanIds = new Set<number>();
    const startedAt = Date.now();

    for (const { signal } of requests) {
      this.removeActive(signal.name, affectedCanIds);
    }

    for (const request of requests) {
      const opts = request.opts ?? {};
      const active: ActiveSubscription = {
        signal: request.signal,
        opts,
        startedAt,
      };

      if (opts.durationMs !== undefined) {
        active.timer = setTimeout(() => {
          void this.cancel(request.signal.name);
        }, opts.durationMs);
      }

      this.activeBySignal.set(request.signal.name, active);
      this.getOrCreateFrameSubscriptions(request.signal.canId).set(request.signal.name, active);
      affectedCanIds.add(request.signal.canId);
    }

    await this.syncTransportSubscriptions(affectedCanIds);
    return () => this.cancelMany(requests.map((request) => request.signal.name));
  }

  handleFrame(frame: CanFrame): void {
    const activeSignals = this.activeByCanId.get(frame.canId);
    if (activeSignals === undefined) {
      return;
    }

    const decoded = this.dbc.decodeFrame(frame);
    for (const { name, value } of decoded) {
      if (activeSignals.has(name)) {
        this.state.update(name, value);
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
    const frameSubscriptions = this.activeByCanId.get(active.signal.canId);
    frameSubscriptions?.delete(signalName);

    if (frameSubscriptions?.size === 0) {
      this.activeByCanId.delete(active.signal.canId);
    }

    affectedCanIds.add(active.signal.canId);
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
