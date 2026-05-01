import { buildPidRequest, decodePidResponse } from "../dbc/UdsBuilder.js";
import type { DbcController } from "../dbc/DbcController.js";
import type { PidSubscriptionHandle, PollingOptions, VehicleSignal } from "../dbc/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

type Timer = ReturnType<typeof setTimeout>;

interface ActivePidSubscription {
  handle: PidSubscriptionHandle;
  signal: VehicleSignal;
  interval: Timer;
  durationTimer?: Timer;
  inFlight?: Promise<unknown>;
}

const DEFAULT_PID_SUBSCRIPTION_FREQUENCY_HZ = 1;

export class PidController {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeBySignal = new Map<string, ActivePidSubscription>();
  private nextSubscriptionId = 1;

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
  ) {}

  async request(signal: VehicleSignal): Promise<unknown> {
    const frame = buildPidRequest(signal);
    const responseCanId = signal.diagnostic?.response.canId;
    const promise = this.transport.sendRequest({
      signalName: signal.name,
      txFrame: frame,
      expectCanResponse: true,
      ...(responseCanId !== undefined
        ? {
            responseIdStart: responseCanId,
            responseIdEnd: responseCanId,
          }
        : {}),
      ...(signal.diagnostic !== undefined ? { diagnostic: signal.diagnostic } : {}),
    }).then((payload) => {
      if (payload === undefined) {
        throw new Error(`No response payload returned for PID signal ${signal.name}`);
      }
      const decodedPayload = decodePidResponse(signal, payload);
      const value = this.dbc.decodeSignal(signal.name, decodedPayload);
      this.state.update(signal.name, value);
      return value;
    });

    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }

  async subscribe(signal: VehicleSignal, opts: PollingOptions = {}): Promise<PidSubscriptionHandle> {
    this.cancel(signal.name);

    const frequencyHz = opts.frequencyHz ?? DEFAULT_PID_SUBSCRIPTION_FREQUENCY_HZ;
    if (frequencyHz <= 0) {
      throw new Error(`PID subscription frequency must be greater than 0, received ${frequencyHz}`);
    }

    const handle: PidSubscriptionHandle = {
      id: String(this.nextSubscriptionId++),
      signalName: signal.name,
    };
    const active: ActivePidSubscription = {
      handle,
      signal,
      interval: setInterval(() => {
        this.poll(active);
      }, 1000 / frequencyHz),
    };

    if (opts.durationMs !== undefined) {
      active.durationTimer = setTimeout(() => {
        this.cancel(signal.name);
      }, opts.durationMs);
    }

    this.activeBySignal.set(signal.name, active);
    this.poll(active);

    return handle;
  }

  clearPending(): void {
    this.pending.clear();
  }

  cancel(signalName: string): void {
    const active = this.activeBySignal.get(signalName);
    if (active === undefined) {
      return;
    }

    clearInterval(active.interval);
    if (active.durationTimer !== undefined) {
      clearTimeout(active.durationTimer);
    }
    this.activeBySignal.delete(signalName);
  }

  cancelHandle(handle: PidSubscriptionHandle): void {
    const active = this.activeBySignal.get(handle.signalName);
    if (active === undefined || active.handle.id !== handle.id) {
      return;
    }

    this.cancel(handle.signalName);
  }

  cancelAllSubscriptions(): void {
    for (const signalName of Array.from(this.activeBySignal.keys())) {
      this.cancel(signalName);
    }
  }

  private poll(active: ActivePidSubscription): void {
    if (active.inFlight !== undefined) {
      return;
    }

    active.inFlight = this.request(active.signal)
      .catch(() => undefined)
      .finally(() => {
        delete active.inFlight;
      });
  }
}
