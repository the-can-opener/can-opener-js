import { signalBitPositions, writeSignalValue } from "../dbc/codec.js";
import { UnknownVehicleSignalError, VirtualVehicleError } from "../errors.js";
import { actionName, mergeProfileCanBusConfigs } from "./ProfileLoader.js";
import type {
  LoadedVehicleProfile,
  ProfileAction,
  ProfileCanBusConfig,
  ProfileCanFdConfig,
  ProfileEndpoint,
  ProfileMonitorSignal,
  ProfileNumberInput,
  ProfileQuery,
  RequestStep,
  ResolvedProfileEndpoint,
} from "./types.js";

export class CapabilityRegistry {
  private readonly endpoints = new Map<string, ResolvedProfileEndpoint>();
  private readonly queries = new Map<string, ProfileQuery>();
  private readonly actions = new Map<string, ProfileAction>();
  private readonly signals = new Map<string, ProfileMonitorSignal>();
  private readonly buses = new Map<number, ProfileCanBusConfig>();
  private profileBacked = false;

  /**
   * Loads profiles in order; later profiles override earlier names. Throws
   * when profiles disagree on a bus, or when anything sends CAN FD on a bus
   * no profile declares `fd`.
   */
  load(profiles: readonly LoadedVehicleProfile[]): void {
    const buses = mergeProfileCanBusConfigs(profiles);
    this.clear();
    this.profileBacked = profiles.length > 0;

    for (const config of buses) {
      this.buses.set(config.bus, config);
    }
    for (const profile of profiles) {
      for (const endpoint of profile.endpoints) {
        this.endpoints.set(endpoint.name, endpoint);
      }
      for (const query of profile.queries) {
        this.queries.set(query.name, query);
      }
      for (const action of profile.actions) {
        this.actions.set(action.name, action);
      }
      for (const signal of profile.signals) {
        this.signals.set(signal.name, signal);
      }
    }

    for (const endpoint of this.endpoints.values()) {
      this.endpoints.set(endpoint.name, this.resolveEndpointFd(endpoint));
    }
    for (const action of this.actions.values()) {
      for (const step of action.steps) {
        if (step.requestId !== undefined) {
          this.inlineStepCanFd(step, action.name);
        }
      }
    }
  }

  clear(): void {
    this.endpoints.clear();
    this.queries.clear();
    this.actions.clear();
    this.signals.clear();
    this.buses.clear();
    this.profileBacked = false;
  }

  hasProfiles(): boolean {
    return this.profileBacked;
  }

  /** Bus settings merged across the loaded profiles, sorted by bus. */
  busConfigs(): ProfileCanBusConfig[] {
    return Array.from(this.buses.values(), (config) => ({ ...config }));
  }

  resolveEndpoint(name: string): ResolvedProfileEndpoint {
    const endpoint = this.endpoints.get(name);
    if (endpoint === undefined) {
      throw new VirtualVehicleError(`Unknown profile endpoint: ${name}`);
    }
    return endpoint;
  }

  /**
   * CAN FD setting for an inline `request_id` step: its own `fd`, else the
   * bus default. The step's bytes are sent as one frame, so FD uses `txDl` 8.
   */
  inlineStepCanFd(step: RequestStep, actionName: string): ProfileCanFdConfig | undefined {
    const bus = step.bus ?? 0;
    const busFd = this.buses.get(bus)?.fd;
    if (!(step.fd ?? busFd !== undefined)) {
      return undefined;
    }
    if (busFd === undefined) {
      throw fdOnClassicBusError(`Action ${actionName}`, bus);
    }
    return { txDl: 8 };
  }

  resolveQuery(name: string): ProfileQuery {
    const query = this.queries.get(name);
    if (query === undefined) {
      throw new UnknownVehicleSignalError(name);
    }
    return query;
  }

  resolveAction(name: string): ProfileAction {
    const action = this.actions.get(name);
    if (action === undefined) {
      throw new VirtualVehicleError(`Unknown vehicle action: ${name}`);
    }
    return action;
  }

  /**
   * Resolves a stateful entity target (`{ value }`): looks up `ENTITY.value`
   * for discrete string targets, or encodes a numeric value into the action's
   * `encode` step(s).
   */
  resolveActionTarget(entity: string, value: string | number): ProfileAction {
    if (typeof value === "string") {
      return this.resolveAction(actionName(entity, value));
    }
    if (!Number.isFinite(value)) {
      throw new VirtualVehicleError(`Action ${entity} target value must be a finite number`);
    }
    const action = this.actions.get(entity);
    if (action === undefined) {
      throw new VirtualVehicleError(`Unknown vehicle action: ${entity}`);
    }
    if (action.input === undefined || !action.steps.some((step) => step.encode !== undefined)) {
      throw new VirtualVehicleError(`Action ${entity} does not accept a numeric value`);
    }
    if (action.input.min !== undefined && value < action.input.min) {
      throw new VirtualVehicleError(`Action ${entity} value ${value} is below minimum ${action.input.min}`);
    }
    if (action.input.max !== undefined && value > action.input.max) {
      throw new VirtualVehicleError(`Action ${entity} value ${value} exceeds maximum ${action.input.max}`);
    }

    const steps = action.steps.map((step) => {
      if (step.encode === undefined) {
        return step;
      }
      const maxBit = Math.max(...signalBitPositions(step.encode));
      const requiredBytes = Math.floor(maxBit / 8) + 1;
      const send = new Uint8Array(Math.max(step.send.length, requiredBytes));
      send.set(step.send);
      try {
        writeSignalValue(send, { canId: 0, ...step.encode }, value);
      } catch (error) {
        throw new VirtualVehicleError(
          `Action ${entity} value ${value} could not be encoded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ...step, send };
    });

    return {
      ...action,
      steps,
    };
  }

  hasAction(name: string): boolean {
    return this.actions.has(name);
  }

  /** Commands the loaded profiles can run on an entity, e.g. `["open", "close"]` for `TRUNK`. */
  actionValues(entity: string): string[] {
    const values: string[] = [];
    for (const action of this.actions.values()) {
      if (action.entity === entity && action.value !== undefined) {
        values.push(action.value);
      }
    }
    return values;
  }

  /** Bounds and step increment for a numeric-input action entity, or `undefined` when not numeric. */
  actionInput(entity: string): ProfileNumberInput | undefined {
    const action = this.actions.get(entity);
    if (action?.input === undefined) {
      return undefined;
    }
    return { ...action.input };
  }

  resolveSignal(name: string): ProfileMonitorSignal {
    const signal = this.signals.get(name);
    if (signal === undefined) {
      throw new UnknownVehicleSignalError(name);
    }
    return signal;
  }

  hasSignal(name: string): boolean {
    return this.signals.has(name);
  }

  private resolveEndpointFd(endpoint: ProfileEndpoint): ResolvedProfileEndpoint {
    const bus = endpoint.bus ?? 0;
    const busFd = this.buses.get(bus)?.fd;
    const fd = endpoint.fd ?? busFd !== undefined;
    if (fd === false) {
      return endpoint;
    }
    if (busFd === undefined) {
      throw fdOnClassicBusError(`Endpoint ${endpoint.name}`, bus);
    }
    return { ...endpoint, canFd: fd === true ? { txDl: busFd.isotpTxDl } : fd };
  }
}

function fdOnClassicBusError(subject: string, bus: number): VirtualVehicleError {
  return new VirtualVehicleError(
    `${subject} sends CAN FD on bus ${bus}, but no loaded profile declares can.buses.${bus}.fd`,
  );
}
