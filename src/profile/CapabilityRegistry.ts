import { signalBitPositions, writeSignalValue } from "../dbc/codec.js";
import { UnknownVehicleSignalError, VirtualVehicleError } from "../errors.js";
import { encodeField } from "./decode.js";
import { mergeProfileCanBusConfigs } from "./ProfileLoader.js";
import { canonicalTarget, keywordsForPath, vocabularyEntry } from "./loaders/vocabulary.js";
import type {
  LoadedVehicleProfile,
  ProfileAction,
  ProfileAlias,
  ProfileCanBusConfig,
  ProfileCanFdConfig,
  ProfileEndpoint,
  ProfileMonitorSignal,
  ProfileNumberInput,
  ProfileProperty,
  ProfileQuery,
  ProfileWrite,
  RequestStep,
  ResolvedProfileEndpoint,
  VssValue,
} from "./types.js";

/** Input name a property write passes its target under. */
const WRITE_INPUT = "value";

export class CapabilityRegistry {
  private readonly endpoints = new Map<string, ResolvedProfileEndpoint>();
  private readonly properties = new Map<string, ProfileProperty>();
  private readonly queries = new Map<string, ProfileQuery>();
  private readonly actions = new Map<string, ProfileAction>();
  private readonly aliasTable = new Map<string, ProfileAlias>();
  private readonly buses = new Map<number, ProfileCanBusConfig>();
  private profileBacked = false;

  /**
   * Loads profiles in order; later profiles override earlier names. A
   * property keeps the read and write bindings a later profile does not
   * replace. Throws when profiles disagree on a bus, or when anything sends
   * CAN FD on a bus no profile declares `fd`.
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
      for (const property of profile.properties) {
        this.properties.set(property.path, mergeProperty(this.properties.get(property.path), property));
      }
      for (const query of profile.queries) {
        this.queries.set(query.name, query);
      }
      for (const action of profile.actions) {
        this.actions.set(action.name, action);
      }
    }

    for (const endpoint of this.endpoints.values()) {
      this.endpoints.set(endpoint.name, this.resolveEndpointFd(endpoint));
    }
    for (const action of this.allActions()) {
      for (const step of action.steps) {
        if (step.requestId !== undefined) {
          this.inlineStepCanFd(step, action.name);
        }
      }
    }
    this.loadAliases();
  }

  clear(): void {
    this.endpoints.clear();
    this.properties.clear();
    this.queries.clear();
    this.actions.clear();
    this.aliasTable.clear();
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

  /** Every loaded property, keyed by VSS path. */
  allProperties(): ProfileProperty[] {
    return Array.from(this.properties.values());
  }

  hasProperty(path: string): boolean {
    return this.properties.has(path);
  }

  /** The property at a VSS path. An alias name is rejected: aliases go through the alias methods. */
  resolveProperty(path: string): ProfileProperty {
    const property = this.properties.get(path);
    if (property !== undefined) {
      return property;
    }
    const alias = this.aliasTable.get(path);
    if (alias !== undefined) {
      throw new VirtualVehicleError(
        "path" in alias
          ? `${path} is an alias of ${alias.path}. Pass the VSS path, or use the alias methods.`
          : `${path} is an alias of an action. Use invoke() or alias.command().`,
      );
    }
    throw new UnknownVehicleSignalError(path);
  }

  /** The passive read binding of a property. */
  resolveSignal(path: string): ProfileMonitorSignal {
    const signal = this.resolveProperty(path).signal;
    if (signal === undefined) {
      throw new UnknownVehicleSignalError(path);
    }
    return signal;
  }

  hasSignal(path: string): boolean {
    return this.properties.get(path)?.signal !== undefined;
  }

  /** A named query: a read that has no VSS path. */
  resolveQuery(name: string): ProfileQuery {
    const query = this.queries.get(name);
    if (query === undefined) {
      if (this.properties.get(name)?.query !== undefined) {
        throw new VirtualVehicleError(`${name} is a property. Use read() for it.`);
      }
      throw new UnknownVehicleSignalError(name);
    }
    return available(query);
  }

  allQueries(): ProfileQuery[] {
    return Array.from(this.queries.values());
  }

  /** The query to poll for a name: a property's query binding, or a named query. */
  resolvePolledQuery(name: string): ProfileQuery {
    const query = this.properties.get(name)?.query ?? this.queries.get(name);
    if (query === undefined) {
      // Rejects an alias with the reason; anything else is unknown.
      this.resolveProperty(name);
      throw new UnknownVehicleSignalError(name);
    }
    return available(query);
  }

  /** A named action, with `input` values encoded into its steps. */
  resolveAction(name: string, input?: Readonly<Record<string, number>>): ProfileAction {
    const action = this.actions.get(name);
    if (action === undefined) {
      throw new VirtualVehicleError(`Unknown vehicle action: ${name}`);
    }
    const subject = `Action ${name}`;
    if (input !== undefined && !takesInput(action)) {
      throw new VirtualVehicleError(`${subject} does not accept a numeric value`);
    }
    const value = input?.[WRITE_INPUT];
    if (value !== undefined) {
      assertConstraints(`${subject} value`, value, action.input, false);
    }
    return encodeInputs(available(action), subject, input);
  }

  hasAction(name: string): boolean {
    return this.actions.has(name);
  }

  /** Named actions, without the write cases of properties. */
  namedActions(): ProfileAction[] {
    return Array.from(this.actions.values());
  }

  /** Bounds and step increment for a numeric-input named action, or `undefined` when not numeric. */
  actionInput(name: string): ProfileNumberInput | undefined {
    const action = this.actions.get(name);
    if (action?.input === undefined) {
      return undefined;
    }
    return { ...action.input };
  }

  /** Whether `set(path, value)` has a request to send. */
  hasWrite(path: string, value: VssValue): boolean {
    const write = this.properties.get(path)?.write;
    return write !== undefined && (write.cases?.[canonicalTarget(value)] ?? write.direct) !== undefined;
  }

  /**
   * The request that sets a property to `value`: the write case for that
   * target, else the property's direct write with the value encoded. A target
   * with no case is unsupported and nothing is sent.
   */
  resolveWrite(path: string, value: VssValue): ProfileAction {
    const property = this.resolveProperty(path);
    if (property.write === undefined) {
      throw new VirtualVehicleError(`${path} is not writable`);
    }
    assertDatatype(property, value);
    const target = canonicalTarget(value);
    const action = property.write.cases?.[target] ?? property.write.direct;
    if (action === undefined) {
      throw new VirtualVehicleError(`${path} does not support the target ${target}`);
    }
    if (typeof value !== "number") {
      return available(action);
    }
    // Format 1 `encode` rounds to the nearest raw value, so its targets need not sit on the step grid.
    const exact = action.steps.every((step) => step.encode === undefined);
    assertConstraints(`${path} value`, value, property.write.constraints, exact);
    return encodeInputs(available(action), path, { [WRITE_INPUT]: value });
  }

  /**
   * An alias by name. A VSS path is rejected: paths go through the VSS
   * methods.
   */
  resolveAlias(name: string): ProfileAlias {
    const alias = this.aliasTable.get(name);
    if (alias !== undefined) {
      return alias;
    }
    if (this.properties.has(name)) {
      throw new VirtualVehicleError(`${name} is a VSS path, not an alias. Use the VSS methods.`);
    }
    throw new VirtualVehicleError(`Unknown alias: ${name}`);
  }

  /**
   * Every alias the loaded profiles answer to: the names packages declare,
   * the vocabulary keywords of each loaded path, and each named action.
   */
  aliases(): ProfileAlias[] {
    return Array.from(this.aliasTable.values());
  }

  private allActions(): ProfileAction[] {
    const actions = Array.from(this.actions.values());
    for (const property of this.properties.values()) {
      actions.push(...Object.values(property.write?.cases ?? {}));
      if (property.write?.direct !== undefined) {
        actions.push(property.write.direct);
      }
    }
    return actions;
  }

  private loadAliases(): void {
    const add = (alias: ProfileAlias): void => {
      if (!this.aliasTable.has(alias.name)) {
        this.aliasTable.set(alias.name, alias);
      }
    };
    for (const action of this.actions.values()) {
      add({ name: action.name, kind: "command", action: action.name, declared: true });
    }
    for (const property of this.properties.values()) {
      for (const name of property.aliases ?? []) {
        add(pathAlias(name, property.path, true));
      }
    }
    for (const property of this.properties.values()) {
      for (const name of keywordsForPath(property.path)) {
        add(pathAlias(name, property.path, false));
      }
    }
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

/** A keyword the vocabulary gives a target is a command alias; any other name is a property alias. */
function pathAlias(name: string, path: string, declared: boolean): ProfileAlias {
  const target = vocabularyEntry(name)?.target;
  return target === undefined
    ? { name, kind: "property", path, declared }
    : { name, kind: "command", path, target, declared };
}

function mergeProperty(existing: ProfileProperty | undefined, next: ProfileProperty): ProfileProperty {
  if (existing === undefined) {
    return next;
  }
  const aliases = Array.from(new Set([...(existing.aliases ?? []), ...(next.aliases ?? [])]));
  const write = mergeWrite(existing.write, next.write);
  return {
    ...existing,
    ...next,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(write !== undefined ? { write } : {}),
  };
}

function mergeWrite(existing: ProfileWrite | undefined, next: ProfileWrite | undefined): ProfileWrite | undefined {
  if (existing === undefined || next === undefined) {
    return next ?? existing;
  }
  return {
    ...existing,
    ...next,
    ...(existing.cases !== undefined || next.cases !== undefined
      ? { cases: { ...existing.cases, ...next.cases } }
      : {}),
  };
}

function available<T extends { name: string; unavailable?: string }>(entry: T): T {
  if (entry.unavailable !== undefined) {
    throw new VirtualVehicleError(`${entry.name} is unavailable: ${entry.unavailable}`);
  }
  return entry;
}

function assertDatatype(property: ProfileProperty, value: VssValue): void {
  const { datatype, path } = property;
  if (datatype === undefined) {
    return;
  }
  const expected = datatype === "boolean" || datatype === "string" ? datatype : "number";
  if (typeof value !== expected || (typeof value === "number" && !Number.isFinite(value))) {
    throw new VirtualVehicleError(`${path} takes a ${expected}, received ${JSON.stringify(value)}`);
  }
  if (typeof value === "string" && property.allowed !== undefined && !property.allowed.includes(value)) {
    throw new VirtualVehicleError(`${path} does not allow the value ${value}`);
  }
}

function assertConstraints(
  subject: string,
  value: number,
  constraints: ProfileNumberInput | undefined,
  onStepGrid: boolean,
): void {
  if (constraints === undefined) {
    return;
  }
  if (constraints.min !== undefined && value < constraints.min) {
    throw new VirtualVehicleError(`${subject} ${value} is below minimum ${constraints.min}`);
  }
  if (constraints.max !== undefined && value > constraints.max) {
    throw new VirtualVehicleError(`${subject} ${value} exceeds maximum ${constraints.max}`);
  }
  if (onStepGrid && constraints.step !== undefined) {
    const steps = (value - (constraints.min ?? 0)) / constraints.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) {
      throw new VirtualVehicleError(`${subject} ${value} is off the step grid of ${constraints.step}`);
    }
  }
}

function takesInput(action: ProfileAction): boolean {
  return action.steps.some((step) => step.encode !== undefined || step.fields !== undefined);
}

/**
 * Writes input values into the steps that carry them. Format 1 `encode`
 * rounds to the nearest raw value; a format 2 field must encode exactly.
 */
function encodeInputs(
  action: ProfileAction,
  subject: string,
  input: Readonly<Record<string, number>> | undefined,
): ProfileAction {
  if (!takesInput(action)) {
    return action;
  }

  const read = (name: string): number => {
    const value = input?.[name];
    if (value === undefined) {
      throw new VirtualVehicleError(`${subject} requires a numeric target value`);
    }
    if (!Number.isFinite(value)) {
      throw new VirtualVehicleError(`${subject} target value must be a finite number`);
    }
    return value;
  };

  const steps = action.steps.map((step) => {
    if (step.encode === undefined && step.fields === undefined) {
      return step;
    }
    let send = step.send;
    try {
      if (step.encode !== undefined) {
        const value = read(WRITE_INPUT);
        const requiredBytes = Math.floor(Math.max(...signalBitPositions(step.encode)) / 8) + 1;
        send = new Uint8Array(Math.max(step.send.length, requiredBytes));
        send.set(step.send);
        writeSignalValue(send, { canId: 0, ...step.encode }, value);
      }
      for (const field of step.fields ?? []) {
        if (send === step.send) {
          send = step.send.slice();
        }
        encodeField(send, field, read(field.input));
      }
    } catch (error) {
      if (error instanceof VirtualVehicleError) {
        throw error;
      }
      throw new VirtualVehicleError(
        `${subject} value could not be encoded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ...step, send };
  });

  return { ...action, steps };
}

function fdOnClassicBusError(subject: string, bus: number): VirtualVehicleError {
  return new VirtualVehicleError(
    `${subject} sends CAN FD on bus ${bus}, but no loaded profile declares can.buses.${bus}.fd`,
  );
}
