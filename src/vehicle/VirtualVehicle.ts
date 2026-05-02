import { CommandController } from "../controllers/CommandController.js";
import { QueryController } from "../controllers/QueryController.js";
import { SubscriptionController } from "../controllers/SubscriptionController.js";
import type { DbcController } from "../dbc/DbcController.js";
import type {
  CommandOptions,
  DbcFile,
  PollingOptions,
  QuerySubscriptionHandle,
  VehicleSignalState,
} from "../dbc/types.js";
import { SignalProtocolError } from "../errors.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "./VehicleState.js";

export interface VirtualVehicleInternals {
  subscriptions: SubscriptionController;
  queries: QueryController;
  commands: CommandController;
  disposeFrames: () => void;
}

interface ResolvedSubscriptionRequest {
  state: VehicleSignalState;
}

export class VirtualVehicle {
  constructor(
    readonly id: string,
    readonly state: VehicleState,
    readonly dbc: DbcController,
    readonly transport: VehicleTransport,
    private readonly internals: VirtualVehicleInternals,
  ) {}

  async query<T = unknown>(signalName: string): Promise<T> {
    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "pid") {
      throw new SignalProtocolError(signalName, "query", signal.protocol);
    }

    return await this.internals.queries.request(signal) as T;
  }

  async subscribe(signalName: string): Promise<boolean>;
  async subscribe(signalNames: readonly string[]): Promise<boolean>;
  async subscribe(signalNameOrSubscriptions: string | readonly string[]): Promise<boolean> {
    if (typeof signalNameOrSubscriptions !== "string") {
      const requests: ResolvedSubscriptionRequest[] = signalNameOrSubscriptions.map((signalName) => {
        const state = this.dbc.resolveState(signalName);
        if (state.signal.protocol !== "frame") {
          throw new SignalProtocolError(signalName, "frame", state.signal.protocol);
        }

        return {
          state,
        };
      });

      return await this.internals.subscriptions.addMany(requests);
    }

    const signalName = signalNameOrSubscriptions;
    const state = this.dbc.resolveState(signalName);
    if (state.signal.protocol !== "frame") {
      throw new SignalProtocolError(signalName, "frame", state.signal.protocol);
    }

    return await this.internals.subscriptions.addMany([{ state }]);
  }

  async unsubscribe(signalName: string): Promise<void>;
  async unsubscribe(signalNames: readonly string[]): Promise<void>;
  async unsubscribe(signalNameOrSubscriptions: string | readonly string[]): Promise<void> {
    if (typeof signalNameOrSubscriptions !== "string") {
      await this.internals.subscriptions.cancelMany(signalNameOrSubscriptions);
      return;
    }

    await this.internals.subscriptions.cancel(signalNameOrSubscriptions);
  }

  subscriptionCount(): number {
    return this.internals.subscriptions.count();
  }

  async subscribeQuery(signalName: string, opts: PollingOptions = {}): Promise<QuerySubscriptionHandle> {
    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "pid") {
      throw new SignalProtocolError(signalName, "query", signal.protocol);
    }

    return await this.internals.queries.subscribe(signal, opts);
  }

  unsubscribeQuery(handle: QuerySubscriptionHandle): void {
    this.internals.queries.cancelHandle(handle);
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
    this.internals.queries.cancelAllSubscriptions();
    this.internals.queries.clearPending();
    this.internals.commands.clearScheduled();
  }

  handleFrame(frame: Parameters<SubscriptionController["handleFrame"]>[0]): void {
    this.internals.subscriptions.handleFrame(frame);
  }

  async disconnect(): Promise<void> {
    this.internals.subscriptions.cancelAll();
    this.internals.queries.cancelAllSubscriptions();
    this.internals.queries.clearPending();
    this.internals.commands.clearScheduled();
    this.internals.disposeFrames();
    await this.transport.disconnect();
  }
}
