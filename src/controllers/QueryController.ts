import type { DbcController } from "../dbc/DbcController.js";
import type { CanPayload, PollingOptions, QuerySubscriptionHandle } from "../dbc/types.js";
import { VirtualVehicleError } from "../errors.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { decodeField } from "../profile/decode.js";
import { isotpAddressingFields } from "../profile/isotpAddressing.js";
import { applyValueNormalization } from "../profile/normalize.js";
import {
  alignExpectedPrefix,
  assertExpectedResponse,
  buildRequestFrame,
  canFdRequestFields,
  responseBounds,
  responseData,
  stripExpectedPrefix,
} from "../profile/RequestBuilder.js";
import type { ProfileQuery } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { BusActivityMonitor } from "../vehicle/BusActivityMonitor.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

type Timer = ReturnType<typeof setTimeout>;

interface ActiveQuerySubscription {
  handle: QuerySubscriptionHandle;
  query: ProfileQuery;
  interval: Timer;
  durationTimer?: Timer;
  inFlight?: Promise<unknown>;
}

const DEFAULT_QUERY_SUBSCRIPTION_FREQUENCY_HZ = 1;

export class QueryController {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activeBySignal = new Map<string, ActiveQuerySubscription>();
  private nextSubscriptionId = 1;
  /** Outstanding `holdPolling()` calls; subscriptions skip their ticks while any is active. */
  private pollHolds = 0;

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
    private readonly capabilities?: CapabilityRegistry,
    private readonly busActivity?: BusActivityMonitor,
  ) {}

  async requestProfile(query: ProfileQuery): Promise<unknown> {
    if (query.unavailable !== undefined) {
      throw new VirtualVehicleError(`${query.name} is unavailable: ${query.unavailable}`);
    }
    const endpoint = this.resolveEndpoint(query.endpoint);
    const frame = buildRequestFrame(endpoint, query.send);
    const timeoutMs = query.timeoutMs ?? endpoint.timeoutMs;
    const promise = this.transport.sendRequest({
      signalName: query.name,
      txFrame: frame,
      ...canFdRequestFields(endpoint.canFd, frame, `Endpoint ${endpoint.name}`, endpoint.addressing),
      ...isotpAddressingFields(endpoint),
      expectCanResponse: true,
      ...responseBounds(endpoint),
      ...(endpoint.extended !== undefined ? { responseIdExtended: endpoint.extended } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }).then((payload) => {
      if (payload === undefined) {
        throw new Error(`No response payload returned for query ${query.name}`);
      }
      this.busActivity?.recordActivity();
      assertExpectedResponse(query.expect, payload);
      const value = this.decodeProfileQuery(query, payload);
      // A passive signal owns the state of its property, and an invalid
      // observation publishes nothing.
      if (value !== undefined && this.capabilities?.hasSignal(query.name) !== true) {
        this.state.update(query.name, value);
      }
      return value;
    });

    void promise.catch((error: unknown) => {
      this.busActivity?.recordRequestFailure(error);
    });
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }

  async subscribe(query: ProfileQuery, opts: PollingOptions = {}): Promise<QuerySubscriptionHandle> {
    this.cancel(query.name);

    const frequencyHz = opts.frequencyHz ?? DEFAULT_QUERY_SUBSCRIPTION_FREQUENCY_HZ;
    if (frequencyHz <= 0) {
      throw new Error(`Query subscription frequency must be greater than 0, received ${frequencyHz}`);
    }

    const handle: QuerySubscriptionHandle = {
      id: String(this.nextSubscriptionId++),
      signalName: query.name,
    };
    const active: ActiveQuerySubscription = {
      handle,
      query,
      interval: setInterval(() => {
        this.poll(active);
      }, 1000 / frequencyHz),
    };

    if (opts.durationMs !== undefined) {
      active.durationTimer = setTimeout(() => {
        this.cancel(query.name);
      }, opts.durationMs);
    }

    this.activeBySignal.set(query.name, active);
    this.poll(active);

    return handle;
  }

  clearPending(): void {
    this.pending.clear();
  }

  /**
   * Keeps polled subscriptions from sending until the matching
   * `releasePolling()`, e.g. while an action needs the bus to itself.
   * Explicit `requestProfile` calls are not affected.
   */
  holdPolling(): void {
    this.pollHolds += 1;
  }

  releasePolling(): void {
    if (this.pollHolds > 0) {
      this.pollHolds -= 1;
    }
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

  cancelHandle(handle: QuerySubscriptionHandle): void {
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

  private poll(active: ActiveQuerySubscription): void {
    if (
      active.inFlight !== undefined ||
      this.pollHolds > 0 ||
      this.busActivity?.isAwake() === false
    ) {
      return;
    }

    active.inFlight = this.requestProfile(active.query)
      .catch(() => undefined)
      .finally(() => {
        delete active.inFlight;
      });
  }

  private resolveEndpoint(name: string) {
    if (this.capabilities === undefined) {
      throw new Error(`No capability registry configured for endpoint ${name}`);
    }
    return this.capabilities.resolveEndpoint(name);
  }

  private decodeProfileQuery(query: ProfileQuery, payload: CanPayload): unknown {
    const decoder = query.decoder;
    if (decoder === undefined) {
      return applyValueNormalization(stripExpectedPrefix(query.expect, payload), query.normalize);
    }
    switch (decoder.type) {
      case "dbc": {
        const aligned = alignExpectedPrefix(query.expect, payload);
        return applyValueNormalization(
          this.dbc.decodeMessageSignal(decoder.message, decoder.signal, aligned),
          query.normalize,
          this.dbc.resolveMessageSignal(decoder.message, decoder.signal).unit,
        );
      }
      case "ascii": {
        const stripped = stripExpectedPrefix(query.expect, payload);
        const length = decoder.length ?? query.length;
        const bytes = length === undefined ? stripped : stripped.slice(0, length);
        return applyValueNormalization(new TextDecoder().decode(bytes).replace(/\0+$/u, ""), query.normalize);
      }
      case "bytes": {
        const stripped = stripExpectedPrefix(query.expect, payload);
        return applyValueNormalization(
          decoder.length === undefined ? stripped : stripped.slice(0, decoder.length),
          query.normalize,
        );
      }
      case "frame":
        return decodeField(responseData(query.expect, payload), decoder.decode);
      case "outputs": {
        const data = responseData(query.expect, payload);
        return Object.fromEntries(
          Object.entries(decoder.outputs).map(([name, decode]) => [name, decodeField(data, decode)]),
        );
      }
      default: {
        const exhaustive: never = decoder;
        return exhaustive;
      }
    }
  }
}
