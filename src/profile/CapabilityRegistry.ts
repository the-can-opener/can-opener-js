import { UnknownVehicleSignalError, VirtualVehicleError } from "../errors.js";
import type { LoadedVehicleProfile, ProfileAction, ProfileEndpoint, ProfileMonitorSignal, ProfileQuery } from "./types.js";

export class CapabilityRegistry {
  private readonly endpoints = new Map<string, ProfileEndpoint>();
  private readonly queries = new Map<string, ProfileQuery>();
  private readonly actions = new Map<string, ProfileAction>();
  private readonly signals = new Map<string, ProfileMonitorSignal>();
  private profileBacked = false;

  load(profiles: readonly LoadedVehicleProfile[]): void {
    this.clear();
    this.profileBacked = profiles.length > 0;

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
  }

  clear(): void {
    this.endpoints.clear();
    this.queries.clear();
    this.actions.clear();
    this.signals.clear();
    this.profileBacked = false;
  }

  hasProfiles(): boolean {
    return this.profileBacked;
  }

  resolveEndpoint(name: string): ProfileEndpoint {
    const endpoint = this.endpoints.get(name);
    if (endpoint === undefined) {
      throw new VirtualVehicleError(`Unknown profile endpoint: ${name}`);
    }
    return endpoint;
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

  hasAction(name: string): boolean {
    return this.actions.has(name);
  }

  resolveSignal(name: string): ProfileMonitorSignal {
    const signal = this.signals.get(name);
    if (signal === undefined) {
      throw new UnknownVehicleSignalError(name);
    }
    return signal;
  }
}
