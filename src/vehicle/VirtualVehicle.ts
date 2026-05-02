import { ActionController } from "../controllers/ActionController.js";
import { QueryController } from "../controllers/QueryController.js";
import { SubscriptionController } from "../controllers/SubscriptionController.js";
import type { DbcController } from "../dbc/DbcController.js";
import type {
  ActionOptions,
  DbcFile,
  PollingOptions,
  QuerySubscriptionHandle,
  VehicleSignalState,
} from "../dbc/types.js";
import { SignalProtocolError, VirtualVehicleError } from "../errors.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import type { ProfileValueNormalization } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "./VehicleState.js";

export interface VirtualVehicleInternals {
  subscriptions: SubscriptionController;
  queries: QueryController;
  actions: ActionController;
  capabilities: CapabilityRegistry;
  disposeFrames: () => void;
}

interface ResolvedSubscriptionRequest {
  state: VehicleSignalState;
  normalize?: ProfileValueNormalization;
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
    if (this.internals.capabilities.hasProfiles()) {
      return await this.internals.queries.requestProfile(this.internals.capabilities.resolveQuery(signalName)) as T;
    }

    throw new VirtualVehicleError(`Query ${signalName} requires a vehicle profile`);
  }

  async subscribe(signalName: string): Promise<boolean>;
  async subscribe(signalNames: readonly string[]): Promise<boolean>;
  async subscribe(signalNameOrSubscriptions: string | readonly string[]): Promise<boolean> {
    if (typeof signalNameOrSubscriptions !== "string") {
      const requests: ResolvedSubscriptionRequest[] = signalNameOrSubscriptions.map((signalName) => {
        return this.resolveSubscriptionRequest(signalName);
      });

      return await this.internals.subscriptions.addMany(requests);
    }

    const signalName = signalNameOrSubscriptions;
    return await this.internals.subscriptions.addMany([this.resolveSubscriptionRequest(signalName)]);
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
    if (this.internals.capabilities.hasProfiles()) {
      return await this.internals.queries.subscribe(this.internals.capabilities.resolveQuery(signalName), opts);
    }

    throw new VirtualVehicleError(`Query subscription ${signalName} requires a vehicle profile`);
  }

  unsubscribeQuery(handle: QuerySubscriptionHandle): void {
    this.internals.queries.cancelHandle(handle);
  }

  async action(actionName: string): Promise<boolean | void>;
  async action(signalName: string, opts: ActionOptions): Promise<void>;
  async action(name: string, opts?: ActionOptions): Promise<boolean | void> {
    if (this.internals.capabilities.hasProfiles()) {
      if (opts !== undefined) {
        throw new VirtualVehicleError(`Profile action ${name} does not accept raw frame action options`);
      }
      return await this.internals.actions.run(this.internals.capabilities.resolveAction(name));
    }

    if (opts === undefined) {
      throw new VirtualVehicleError(`Raw DBC action ${name} requires action options`);
    }

    const signal = this.dbc.resolve(name);
    if (signal.protocol !== "frame") {
      throw new SignalProtocolError(name, "frame", signal.protocol);
    }

    await this.internals.actions.send(signal, opts);
  }

  reloadDbc(files: DbcFile[]): void {
    this.state.clear();
    this.dbc.load(files);
    this.internals.capabilities.clear();
    this.internals.subscriptions.cancelAll();
    this.internals.queries.cancelAllSubscriptions();
    this.internals.queries.clearPending();
    this.internals.actions.clearScheduled();
  }

  handleFrame(frame: Parameters<SubscriptionController["handleFrame"]>[0]): void {
    this.internals.subscriptions.handleFrame(frame);
  }

  async disconnect(): Promise<void> {
    this.internals.subscriptions.cancelAll();
    this.internals.queries.cancelAllSubscriptions();
    this.internals.queries.clearPending();
    this.internals.actions.clearScheduled();
    this.internals.disposeFrames();
    await this.transport.disconnect();
  }

  private resolveSubscriptionRequest(signalName: string): ResolvedSubscriptionRequest {
    if (this.internals.capabilities.hasProfiles()) {
      const monitor = this.internals.capabilities.resolveSignal(signalName);
      return {
        state: {
          name: monitor.name,
          signal: this.dbc.resolveMessageSignal(monitor.message, monitor.signal),
        },
        ...(monitor.normalize !== undefined ? { normalize: monitor.normalize } : {}),
      };
    }

    const state = this.dbc.resolveState(signalName);
    if (state.signal.protocol !== "frame") {
      throw new SignalProtocolError(signalName, "frame", state.signal.protocol);
    }

    return {
      state,
    };
  }
}
