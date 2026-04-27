import { CommandController } from "../controllers/CommandController.js";
import { PidController } from "../controllers/PidController.js";
import { SubscriptionController } from "../controllers/SubscriptionController.js";
import type { DbcController } from "../dbc/DbcController.js";
import type { CommandOptions, DbcFile, SubscriptionOptions, SubscriptionRegistry, Unsubscribe, VehicleSignal } from "../dbc/types.js";
import { SignalProtocolError } from "../errors.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "./VehicleState.js";

export interface VirtualVehicleInternals {
  subscriptions: SubscriptionController;
  pids: PidController;
  commands: CommandController;
  disposeFrames: () => void;
}

interface ResolvedSubscriptionRequest {
  signal: VehicleSignal;
  opts: SubscriptionOptions;
}

export class VirtualVehicle {
  constructor(
    readonly id: string,
    readonly state: VehicleState,
    readonly dbc: DbcController,
    readonly transport: VehicleTransport,
    private readonly internals: VirtualVehicleInternals,
  ) {}

  async pid<T = unknown>(signalName: string): Promise<T> {
    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "pid") {
      throw new SignalProtocolError(signalName, "PID", signal.protocol);
    }

    return await this.internals.pids.request(signal) as T;
  }

  async subscribe(signalName: string, opts?: SubscriptionOptions): Promise<Unsubscribe>;
  async subscribe(subscriptions: SubscriptionRegistry): Promise<Unsubscribe>;
  async subscribe(signalNameOrSubscriptions: string | SubscriptionRegistry, opts: SubscriptionOptions = {}): Promise<Unsubscribe> {
    if (typeof signalNameOrSubscriptions !== "string") {
      const requests: ResolvedSubscriptionRequest[] = Object.entries(signalNameOrSubscriptions).map(([signalName, subscriptionOptions]) => {
        const signal = this.dbc.resolve(signalName);
        if (signal.protocol !== "frame") {
          throw new SignalProtocolError(signalName, "frame", signal.protocol);
        }

        return {
          signal,
          opts: subscriptionOptions ?? {},
        };
      });

      return await this.internals.subscriptions.addMany(requests);
    }

    const signalName = signalNameOrSubscriptions;
    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "frame") {
      throw new SignalProtocolError(signalName, "frame", signal.protocol);
    }

    return await this.internals.subscriptions.add(signal, opts);
  }

  async subscribePid(signalName: string, opts: SubscriptionOptions = {}): Promise<Unsubscribe> {
    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "pid") {
      throw new SignalProtocolError(signalName, "PID", signal.protocol);
    }

    return await this.internals.pids.subscribe(signal, opts);
  }

  async command(signalName: string, opts: CommandOptions): Promise<void> {
    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "frame") {
      throw new SignalProtocolError(signalName, "frame", signal.protocol);
    }

    await this.internals.commands.send(signal, opts);
  }

  reloadDbc(files: DbcFile[]): void {
    this.state.clear();
    this.dbc.load(files);
    this.internals.subscriptions.cancelAll();
    this.internals.pids.cancelAllSubscriptions();
    this.internals.pids.clearPending();
    this.internals.commands.clearScheduled();
  }

  handleFrame(frame: Parameters<SubscriptionController["handleFrame"]>[0]): void {
    this.internals.subscriptions.handleFrame(frame);
  }

  async disconnect(): Promise<void> {
    this.internals.subscriptions.cancelAll();
    this.internals.pids.cancelAllSubscriptions();
    this.internals.pids.clearPending();
    this.internals.commands.clearScheduled();
    this.internals.disposeFrames();
    await this.transport.disconnect();
  }
}
