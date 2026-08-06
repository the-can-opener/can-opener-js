import type { DbcController } from "../dbc/DbcController.js";
import type { CanPayload, PollingOptions, QuerySubscriptionHandle } from "../dbc/types.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { applyValueNormalization } from "../profile/normalize.js";
import {
  alignExpectedPrefix,
  assertExpectedResponse,
  buildRequestFrame,
  responseBounds,
  stripExpectedPrefix,
} from "../profile/RequestBuilder.js";
import type { ProfileQuery, QueryDecoder } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";
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

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
    private readonly capabilities?: CapabilityRegistry,
  ) {}

  async requestProfile(query: ProfileQuery): Promise<unknown> {
    const endpoint = this.resolveEndpoint(query.endpoint);
    const frame = buildRequestFrame(endpoint, query.send);
    const timeoutMs = query.timeoutMs ?? endpoint.timeoutMs;
    const promise = this.transport.sendRequest({
      signalName: query.name,
      txFrame: frame,
      expectCanResponse: true,
      ...responseBounds(endpoint),
      ...(endpoint.extended !== undefined ? { responseIdExtended: endpoint.extended } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }).then((payload) => {
      if (payload === undefined) {
        throw new Error(`No response payload returned for query ${query.name}`);
      }
      assertExpectedResponse(query.expect, payload);
      const value = this.decodeProfileQuery(query, payload);
      if (this.capabilities?.hasSignal(query.name) !== true) {
        this.state.update(query.name, value);
      }
      return value;
    });

    void promise.catch(() => undefined);
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
    if (active.inFlight !== undefined) {
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
    if (query.decoder === undefined) {
      return applyValueNormalization(stripExpectedPrefix(query.expect, payload), query.normalize);
    }
    const decoderPayload =
      query.decoder.type === "dbc"
        ? alignExpectedPrefix(query.expect, payload)
        : stripExpectedPrefix(query.expect, payload);
    return applyValueNormalization(
      decodeProfilePayload(this.dbc, query.decoder, decoderPayload, query.length),
      query.normalize,
    );
  }
}

function decodeProfilePayload(
  dbc: DbcController,
  decoder: QueryDecoder,
  payload: CanPayload,
  queryLength: number | undefined,
): unknown {
  switch (decoder.type) {
    case "dbc":
      return dbc.decodeMessageSignal(decoder.message, decoder.signal, payload);
    case "ascii": {
      const length = decoder.length ?? queryLength;
      const bytes = length === undefined ? payload : payload.slice(0, length);
      return new TextDecoder().decode(bytes).replace(/\0+$/u, "");
    }
    case "bytes":
      return decoder.length === undefined ? payload : payload.slice(0, decoder.length);
    default: {
      const exhaustive: never = decoder;
      return exhaustive;
    }
  }
}
