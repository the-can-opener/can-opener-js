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

export class SubscriptionController {
  private readonly activeBySignal = new Map<string, ActiveSubscription>();
  private readonly activeByCanId = new Map<number, Map<string, ActiveSubscription>>();

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
  ) {}

  async add(signal: VehicleSignal, opts: SubscriptionOptions = {}): Promise<Unsubscribe> {
    await this.cancel(signal.name);

    const active: ActiveSubscription = {
      signal,
      opts,
      startedAt: Date.now(),
    };

    if (opts.durationMs !== undefined) {
      active.timer = setTimeout(() => {
        void this.cancel(signal.name);
      }, opts.durationMs);
    }

    this.activeBySignal.set(signal.name, active);
    this.getOrCreateFrameSubscriptions(signal.canId).set(signal.name, active);
    await this.syncTransportSubscription(signal.canId);
    return () => this.cancel(signal.name);
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

    if (frameSubscriptions === undefined || frameSubscriptions.size === 0) {
      this.activeByCanId.delete(active.signal.canId);
      await this.transport.unsubscribe(active.signal.canId);
      return;
    }

    await this.syncTransportSubscription(active.signal.canId);
  }

  cancelAll(): void {
    for (const signalName of Array.from(this.activeBySignal.keys())) {
      void this.cancel(signalName);
    }
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
