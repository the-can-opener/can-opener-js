import { ActionController } from "../controllers/ActionController.js";
import { QueryController } from "../controllers/QueryController.js";
import type {
  QueryRoundRobinController,
  QueryRoundRobinStatus,
} from "../controllers/QueryRoundRobinController.js";
import type {
  SubscriptionController,
  SubscriptionRefreshStatus,
  SubscriptionRequest,
} from "../controllers/SubscriptionController.js";
import { decodeSignalValue, isCodecSignal } from "../dbc/codec.js";
import type { DbcController } from "../dbc/DbcController.js";
import type {
  ActionOptions,
  CanFrame,
  DbcFile,
  PollingOptions,
  QuerySubscriptionHandle,
  VehicleSignal,
  VehicleSignalState,
} from "../dbc/types.js";
import { SignalProtocolError, VirtualVehicleError } from "../errors.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { decodeField } from "../profile/decode.js";
import { applyValueNormalization } from "../profile/normalize.js";
import { ProfileLoader } from "../profile/ProfileLoader.js";
import type {
  ActionRunResult,
  ProfileAction,
  ProfileAlias,
  ProfileDbcSignal,
  ProfileMonitorSignal,
  VehicleProfileSource,
  VssValue,
  WriteResult,
} from "../profile/types.js";
import type {
  VehicleDisconnectOptions,
  VehicleTransport,
} from "../transport/types.js";
import type {
  BusActivity,
  BusActivityListener,
  BusActivityMonitor,
} from "./BusActivityMonitor.js";
import {
  configureCanBuses,
  mergeCanBusTimingReports,
  type CanBusTimingReport,
} from "./canBusTiming.js";
import type { VehicleState } from "./VehicleState.js";

export interface VirtualVehicleInternals {
  subscriptions: SubscriptionController;
  queries: QueryController;
  queryRoundRobin: QueryRoundRobinController;
  busActivity: BusActivityMonitor;
  actions: ActionController;
  capabilities: CapabilityRegistry;
  disposeFrames: () => void;
  /** What the transport reported when each bus's profile timing was applied. */
  busTiming: CanBusTimingReport[];
}

/**
 * The alias methods. They take legacy keyword names only, never a VSS path.
 * `read`, `subscribe`, `unsubscribe`, and `set` take a property alias such
 * as `SPEED` or `LOCKED`. `command` takes a command alias such as `LOCK`,
 * `UNLOCK`, or `HORN`, or the name of an action.
 */
export interface VehicleAliasMethods {
  /** Reads the property a property alias names. */
  read<T = VssValue>(name: string): Promise<T | undefined>;
  /** Subscribes to the property; its value lands in `state` under the VSS path. */
  subscribe(name: string): Promise<boolean>;
  subscribe(names: readonly string[]): Promise<boolean>;
  unsubscribe(name: string): Promise<void>;
  unsubscribe(names: readonly string[]): Promise<void>;
  /** Writes `value` to the property a property alias names. */
  set(name: string, value: VssValue): Promise<WriteResult>;
  /** Runs a command alias: `LOCK` writes `true` to the central lock, `SIGNAL_OFF` invokes that action. */
  command(name: string): Promise<WriteResult>;
  /** Every alias the loaded profiles answer to. */
  list(): ProfileAlias[];
}

export class VirtualVehicle {
  private busTimingQueue: Promise<unknown> = Promise.resolve();

  readonly alias: VehicleAliasMethods = {
    // Each method is async so a wrong name rejects instead of throwing.
    read: async <T = VssValue>(name: string) => await this.read<T>(this.propertyAliasPath(name)),
    subscribe: async (names: string | readonly string[]) =>
      typeof names === "string"
        ? await this.subscribe(this.propertyAliasPath(names))
        : await this.subscribe(this.propertyAliasPaths(names)),
    unsubscribe: async (names: string | readonly string[]) =>
      typeof names === "string"
        ? await this.unsubscribe(this.propertyAliasPath(names))
        : await this.unsubscribe(this.propertyAliasPaths(names)),
    set: async (name: string, value: VssValue) => await this.set(this.propertyAliasPath(name), value),
    command: async (name: string) => {
      const alias = this.internals.capabilities.resolveAlias(name);
      if (alias.kind === "property") {
        throw new VirtualVehicleError(
          `${name} is a property alias of ${alias.path}. It names no command; use alias.set().`,
        );
      }
      return "action" in alias
        ? await this.invoke(alias.action)
        : await this.set(alias.path, alias.target);
    },
    list: () => this.internals.capabilities.aliases(),
  };

  constructor(
    readonly id: string,
    readonly state: VehicleState,
    readonly dbc: DbcController,
    readonly transport: VehicleTransport,
    private readonly internals: VirtualVehicleInternals,
  ) {}

  /**
   * Reads a property by VSS path. A property with a query binding asks the
   * ECU; one with only a passive signal returns its latest observed value
   * and sends nothing.
   */
  async read<T = VssValue>(path: string): Promise<T | undefined> {
    const property = this.internals.capabilities.resolveProperty(path);
    if (property.query === undefined) {
      return this.state.get<T>(path);
    }
    return (await this.internals.queries.requestProfile(property.query)) as T;
  }

  /** Runs a named query: a read that has no VSS path. */
  async query<T = unknown>(name: string): Promise<T> {
    if (this.internals.capabilities.hasProfiles()) {
      return (await this.internals.queries.requestProfile(
        this.internals.capabilities.resolveQuery(name),
      )) as T;
    }

    throw new VirtualVehicleError(
      `Query ${name} requires a vehicle profile`,
    );
  }

  async subscribe(signalName: string): Promise<boolean>;
  async subscribe(signalNames: readonly string[]): Promise<boolean>;
  async subscribe(
    signalNameOrSubscriptions: string | readonly string[],
  ): Promise<boolean> {
    if (typeof signalNameOrSubscriptions !== "string") {
      const requests: SubscriptionRequest[] = [];
      for (const signalName of signalNameOrSubscriptions) {
        try {
          requests.push(this.resolveSubscriptionRequest(signalName));
        } catch {
          // Skip signals that cannot be resolved against the loaded DBC.
        }
      }

      if (requests.length === 0) {
        return false;
      }

      return await this.internals.subscriptions.addMany(requests);
    }

    const signalName = signalNameOrSubscriptions;
    return await this.internals.subscriptions.addMany([
      this.resolveSubscriptionRequest(signalName),
    ]);
  }

  async unsubscribe(signalName: string): Promise<void>;
  async unsubscribe(signalNames: readonly string[]): Promise<void>;
  async unsubscribe(
    signalNameOrSubscriptions: string | readonly string[],
  ): Promise<void> {
    if (typeof signalNameOrSubscriptions !== "string") {
      await this.internals.subscriptions.cancelMany(signalNameOrSubscriptions);
      return;
    }

    await this.internals.subscriptions.cancel(signalNameOrSubscriptions);
  }

  subscriptionCount(): number {
    return this.internals.subscriptions.count();
  }

  async subscribeQuery(
    signalName: string,
    opts: PollingOptions = {},
  ): Promise<QuerySubscriptionHandle> {
    if (this.internals.capabilities.hasProfiles()) {
      return await this.internals.queries.subscribe(
        this.internals.capabilities.resolvePolledQuery(signalName),
        opts,
      );
    }

    throw new VirtualVehicleError(
      `Query subscription ${signalName} requires a vehicle profile`,
    );
  }

  unsubscribeQuery(handle: QuerySubscriptionHandle): void {
    this.internals.queries.cancelHandle(handle);
  }

  updateQueryRoundRobin(signalNames: readonly string[]): void {
    if (this.internals.capabilities.hasProfiles()) {
      this.internals.queryRoundRobin.update(
        signalNames.map((signalName) =>
          this.internals.capabilities.resolvePolledQuery(signalName),
        ),
      );
      return;
    }

    throw new VirtualVehicleError(
      "Query round-robin subscriptions require a vehicle profile",
    );
  }

  pauseQueryRoundRobin(): void {
    this.internals.queryRoundRobin.pause();
  }

  resumeQueryRoundRobin(): void {
    this.internals.queryRoundRobin.resume();
  }

  subscribeQueriesRoundRobin(signalNames: readonly string[]): void {
    this.updateQueryRoundRobin(signalNames);
  }

  queryRoundRobinStatus(): QueryRoundRobinStatus {
    return this.internals.queryRoundRobin.status();
  }

  signalRefreshStatus(): SubscriptionRefreshStatus {
    return this.internals.subscriptions.refreshStatus();
  }

  /**
   * Whether the bus looks awake. While it is `asleep` the query round-robin
   * and query subscriptions send nothing; they resume on the next received
   * CAN traffic, ECU reply, successful action, or `wakeBus()`.
   */
  busActivity(): BusActivity {
    return this.internals.busActivity.state();
  }

  onBusActivityChange(listener: BusActivityListener): () => void {
    return this.internals.busActivity.onChange(listener);
  }

  wakeBus(): void {
    this.internals.busActivity.wake();
  }

  /**
   * Writes a property by VSS path. The write case for `value` is sent, or
   * the property's direct write with `value` encoded. A target the profile
   * has no request for throws and nothing is sent. A write never changes
   * `state`; only an observation of the property does.
   */
  async set(path: string, value: VssValue): Promise<WriteResult> {
    return await this.runAction(this.internals.capabilities.resolveWrite(path, value));
  }

  /** Runs a named action: a command that has no single VSS actuator. */
  async invoke(name: string, input?: Readonly<Record<string, number>>): Promise<WriteResult> {
    return await this.runAction(this.internals.capabilities.resolveAction(name, input));
  }

  /** Encodes and sends a raw DBC frame signal; only without loaded profiles. */
  async action(signalName: string, opts: ActionOptions): Promise<void> {
    if (this.internals.capabilities.hasProfiles()) {
      throw new VirtualVehicleError(
        `Raw DBC action ${signalName} is not available with a vehicle profile loaded. Use set() or invoke().`,
      );
    }

    const signal = this.dbc.resolve(signalName);
    if (signal.protocol !== "frame") {
      throw new SignalProtocolError(signalName, "frame", signal.protocol);
    }

    await this.internals.actions.send(signal, opts);
  }

  reloadDbc(files: DbcFile[]): void {
    this.state.clear();
    this.dbc.load(files);
    this.internals.capabilities.clear();
    this.internals.subscriptions.cancelAll();
    this.internals.queries.cancelAllSubscriptions();
    this.internals.queryRoundRobin.clear();
    this.internals.queries.clearPending();
    this.internals.actions.clearScheduled();
  }

  /**
   * Swaps the loaded profiles. Bus timing they declare is not sent until
   * `configureBuses()` runs, so call it before sending requests that need it.
   */
  reloadProfiles(sources: readonly VehicleProfileSource[]): void {
    const profiles = new ProfileLoader().load(sources);
    this.internals.capabilities.load(profiles);
    this.dbc.load(profiles.flatMap((profile) => profile.dbcFiles));
  }

  /**
   * Applies bus timing declared by the loaded profiles and returns the
   * adapter's report for every bus configured so far. Buses whose requested
   * timing has not changed are not sent again. Calls run one at a time, so
   * overlapping reloads never repeat an auto-detect; a bus applied before a
   * failure keeps its report.
   */
  configureBuses(): Promise<readonly CanBusTimingReport[]> {
    const run = this.busTimingQueue.then(() => this.applyBusTiming());
    this.busTimingQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Timing the adapter reported per bus, including a bitrate it found when the
   * profile asked for `auto`. Buses no profile configured are absent; they run
   * on the adapter's default timing.
   */
  busTiming(): readonly CanBusTimingReport[] {
    return this.internals.busTiming.map((report) => ({
      ...report,
      requested: { ...report.requested },
    }));
  }

  private async applyBusTiming(): Promise<readonly CanBusTimingReport[]> {
    await configureCanBuses(
      this.transport,
      this.internals.capabilities.busConfigs(),
      this.internals.busTiming,
      (report) => {
        this.internals.busTiming = mergeCanBusTimingReports(this.internals.busTiming, [report]);
      },
    );
    return this.busTiming();
  }

  handleFrame(
    frame: Parameters<SubscriptionController["handleFrame"]>[0],
  ): void {
    this.internals.subscriptions.handleFrame(frame);
  }

  async disconnect(options: VehicleDisconnectOptions = {}): Promise<void> {
    this.internals.subscriptions.cancelAll();
    this.internals.queries.cancelAllSubscriptions();
    this.internals.queryRoundRobin.clear();
    this.internals.queries.clearPending();
    this.internals.actions.clearScheduled();
    this.internals.busActivity.clearListeners();
    this.internals.disposeFrames();
    await this.transport.disconnect(options);
  }

  private async runAction(action: ProfileAction): Promise<WriteResult> {
    // Background queries would otherwise queue up on the transport and the
    // device ahead of each step and retry, and on a half-awake bus every
    // one of them waits out its full timeout first.
    this.internals.queryRoundRobin.hold();
    this.internals.queries.holdPolling();
    try {
      const wakeFirst = this.internals.busActivity.isAwake() === false;
      const result = await this.internals.actions.run(action, { wakeFirst });
      if (result === true || result === undefined) {
        this.internals.busActivity.recordActivity();
      }
      return writeResult(result);
    } finally {
      this.internals.queries.releasePolling();
      this.internals.queryRoundRobin.release();
    }
  }

  private propertyAliasPath(name: string): string {
    const alias = this.internals.capabilities.resolveAlias(name);
    if (alias.kind === "command") {
      throw new VirtualVehicleError(
        `${name} is a command alias. Run it with alias.command(), or read and write its VSS path.`,
      );
    }
    return alias.path;
  }

  /** Like `subscribe` with a list, names that do not resolve are skipped. */
  private propertyAliasPaths(names: readonly string[]): string[] {
    return names.flatMap((name) => {
      try {
        return [this.propertyAliasPath(name)];
      } catch {
        return [];
      }
    });
  }

  private resolveSubscriptionRequest(signalName: string): SubscriptionRequest {
    if (this.internals.capabilities.hasProfiles()) {
      return this.profileSubscription(this.internals.capabilities.resolveSignal(signalName));
    }

    const state = this.dbc.resolveState(signalName);
    if (state.signal.protocol !== "frame") {
      throw new SignalProtocolError(signalName, "frame", state.signal.protocol);
    }
    return rawDbcSubscription(state);
  }

  private profileSubscription(monitor: ProfileMonitorSignal): SubscriptionRequest {
    const bus = monitor.bus !== undefined ? { bus: monitor.bus } : {};
    if ("frame" in monitor) {
      const { canId, length, decode } = monitor.frame;
      return {
        name: monitor.name,
        canId,
        ...bus,
        decode: (frame) =>
          (frame.dlc ?? frame.data.length) < length ? undefined : decodeField(frame.data, decode),
      };
    }

    const signal = this.dbc.resolveMessageSignal(monitor.message, monitor.signal);
    return {
      name: monitor.name,
      canId: signal.canId,
      ...bus,
      decode: (frame) =>
        applyValueNormalization(decodeDbcSignal(frame, signal, monitor.value), monitor.normalize, signal.unit),
    };
  }
}

function writeResult(result: ActionRunResult): WriteResult {
  switch (result) {
    case true:
      return "acknowledged";
    case false:
      return "rejected";
    case "unknown":
      return "unknown";
    case undefined:
      return "sent";
    default: {
      const unhandled: never = result;
      throw new Error(`Unknown action result ${String(unhandled)}`);
    }
  }
}

/** A raw DBC signal, subscribed by its DBC name while no profile is loaded. */
function rawDbcSubscription(state: VehicleSignalState): SubscriptionRequest {
  return {
    name: state.name,
    canId: state.signal.canId,
    decode: (frame) => {
      const value = decodeDbcSignal(frame, state.signal, "label");
      if (state.enumValue === undefined) {
        return value;
      }
      if (typeof value === "string") {
        return value === state.name ? 1 : 0;
      }
      return value === state.enumValue ? 1 : 0;
    },
  };
}

function decodeDbcSignal(
  frame: CanFrame,
  signal: VehicleSignal,
  value: ProfileDbcSignal["value"] = "label",
): unknown {
  if (!isCodecSignal(signal)) {
    return undefined;
  }
  switch (value) {
    case "label":
      return decodeSignalValue(frame, signal);
    case "physical": {
      const { enumValues: _labels, ...physical } = signal;
      return decodeSignalValue(frame, physical);
    }
    case "raw": {
      const { enumValues: _labels, scale: _scale, offset: _offset, ...raw } = signal;
      return decodeSignalValue(frame, raw);
    }
    default: {
      const unhandled: never = value;
      throw new Error(`Unknown DBC value kind ${String(unhandled)}`);
    }
  }
}
