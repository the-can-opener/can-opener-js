import { parse } from "yaml";
import { VirtualVehicleError } from "../errors.js";
import type { CanFdTxDl } from "../transport/types.js";
import type {
  BuiltInDecoderRef,
  DbcDecoderRef,
  ExpectPattern,
  IsotpAddressing,
  LoadedVehicleProfile,
  ProfileAction,
  ProfileCanBusConfig,
  ProfileCanBusFd,
  ProfileByte,
  ProfileEndpoint,
  ProfileEndpointFd,
  ProfileMonitorSignal,
  ProfileQuery,
  ProfileValueNormalization,
  RequestStep,
  ResponseIdRange,
  VehicleProfileSource,
} from "./types.js";

interface RawProfile {
  version?: unknown;
  can?: {
    buses?: Record<string, RawCanBusConfig>;
  };
  dbc?: {
    files?: Array<{ path?: unknown }>;
  };
  endpoints?: Record<string, RawEndpoint>;
  sequences?: Record<string, RawSequence>;
  signals?: Record<string, RawSignal>;
  queries?: Record<string, RawQuery>;
  actions?: Record<string, RawAction>;
}

interface RawCanBusConfig {
  bitrate?: unknown;
  data_bitrate?: unknown;
  fd?: unknown;
}

interface RawEndpoint {
  request_id?: unknown;
  response_id?: unknown;
  response_ids?: unknown[];
  bus?: unknown;
  extended?: unknown;
  timeout_ms?: unknown;
  fd?: unknown;
  addressing?: unknown;
}

interface RawSequence {
  endpoint?: unknown;
  steps?: RawStep[];
}

interface RawSignal {
  monitor?: {
    message?: unknown;
    signal?: unknown;
    bus?: unknown;
  };
  normalize?: unknown;
  state?: unknown;
}

interface RawQuery {
  endpoint?: unknown;
  send?: unknown[];
  expect?: unknown;
  dbc_mapping?: unknown;
  decoder?: unknown;
  length?: unknown;
  timeout_ms?: unknown;
  normalize?: unknown;
}

interface RawAction {
  endpoint?: unknown;
  send?: unknown;
  expect?: unknown;
  batch?: unknown;
  steps?: RawStep[];
  /** Stateful entity: one request definition per target value. */
  values?: unknown;
}

/**
 * Profile spec versions this loader reads. `1` is spec 1.0; `1.1` added
 * `values` on actions. Minor versions are backward compatible.
 */
export const SUPPORTED_PROFILE_VERSIONS: ReadonlySet<number> = new Set([1, 1.1]);

/** Separates an entity from its target value in an action name: `TRUNK.open`. */
export const ACTION_VALUE_SEPARATOR = ".";

export function actionName(entity: string, value: string): string {
  return `${entity}${ACTION_VALUE_SEPARATOR}${value}`;
}

type RawStep = {
  endpoint?: unknown;
  ref?: unknown;
  send?: unknown;
  expect?: unknown;
  timeout_ms?: unknown;
  delay_ms?: unknown;
};

export class ProfileLoader {
  load(sources: readonly VehicleProfileSource[]): LoadedVehicleProfile[] {
    return sources.map((source) => this.loadOne(source));
  }

  private loadOne(source: VehicleProfileSource): LoadedVehicleProfile {
    const raw = parse(source.content) as RawProfile | undefined;
    if (raw === undefined || typeof raw !== "object") {
      throw new VirtualVehicleError(`Profile ${source.name} must contain a YAML object`);
    }
    if (!SUPPORTED_PROFILE_VERSIONS.has(raw.version as number)) {
      throw new VirtualVehicleError(`Profile ${source.name} must declare version: 1 or 1.1`);
    }

    const sequences = raw.sequences ?? {};
    const endpoints = Object.entries(raw.endpoints ?? {}).map(([name, endpoint]) => normalizeEndpoint(name, endpoint));
    const declaredDbcPaths = new Set((raw.dbc?.files ?? []).map((file) => readString(file.path, "dbc.files.path")));
    const dbcFiles = declaredDbcPaths.size === 0
      ? source.dbcFiles
      : source.dbcFiles.filter((file) => declaredDbcPaths.has(file.name));

    return {
      name: source.name,
      dbcFiles,
      canBuses: normalizeCanBuses(raw.can?.buses),
      endpoints,
      queries: Object.entries(raw.queries ?? {}).map(([name, query]) => normalizeQuery(name, query)),
      actions: Object.entries(raw.actions ?? {}).flatMap(([name, action]) => normalizeActionEntry(name, action, sequences)),
      signals: Object.entries(raw.signals ?? {}).flatMap(([name, signal]) => normalizeSignal(name, signal)),
    };
  }
}

export function mergeProfileCanBusConfigs(profiles: readonly LoadedVehicleProfile[]): ProfileCanBusConfig[] {
  const merged = new Map<number, ProfileCanBusConfig>();
  for (const profile of profiles) {
    for (const config of profile.canBuses) {
      const existing = merged.get(config.bus);
      if (existing === undefined) {
        merged.set(config.bus, { ...config });
      } else if (
        existing.bitrate !== config.bitrate ||
        existing.dataBitrate !== config.dataBitrate ||
        existing.fd?.isotpTxDl !== config.fd?.isotpTxDl
      ) {
        throw new VirtualVehicleError(`Conflicting CAN bus ${config.bus} settings across loaded profiles`);
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.bus - b.bus);
}

function normalizeCanBuses(raw: Record<string, RawCanBusConfig> | undefined): ProfileCanBusConfig[] {
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError("can.buses must be an object keyed by logical bus");
  }
  return Object.entries(raw).map(([busKey, config]) => {
    const path = `can.buses.${busKey}`;
    const bus = readBus(busKey, path);
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new VirtualVehicleError(`${path} must be an object`);
    }
    const fd = config.fd !== undefined ? readCanBusFd(config.fd, `${path}.fd`) : undefined;
    return {
      bus,
      bitrate: readCanBitrate(config.bitrate, `${path}.bitrate`),
      ...(config.data_bitrate !== undefined ? { dataBitrate: readPositiveUint32(config.data_bitrate, `${path}.data_bitrate`) } : {}),
      ...(fd !== undefined ? { fd } : {}),
    };
  }).sort((a, b) => a.bus - b.bus);
}

function readCanBusFd(raw: unknown, path: string): ProfileCanBusFd | undefined {
  if (typeof raw === "boolean") {
    return raw ? { isotpTxDl: 8 } : undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError(`${path} must be a boolean or an object`);
  }
  const isotp = (raw as { isotp?: unknown }).isotp;
  if (isotp === undefined) {
    return { isotpTxDl: 8 };
  }
  if (isotp === null || typeof isotp !== "object" || Array.isArray(isotp)) {
    throw new VirtualVehicleError(`${path}.isotp must be an object`);
  }
  return { isotpTxDl: readTxDl((isotp as { tx_dl?: unknown }).tx_dl, `${path}.isotp.tx_dl`) };
}

function normalizeEndpoint(name: string, raw: RawEndpoint): ProfileEndpoint {
  const responseRanges: ResponseIdRange[] = [];
  if (raw.response_id !== undefined) {
    const id = readNumber(raw.response_id, `endpoints.${name}.response_id`);
    responseRanges.push({ start: id, end: id });
  }
  for (const response of raw.response_ids ?? []) {
    responseRanges.push(normalizeResponseRange(response, `endpoints.${name}.response_ids`));
  }

  return {
    name,
    requestId: readNumber(raw.request_id, `endpoints.${name}.request_id`),
    responseRanges,
    ...(raw.bus !== undefined ? { bus: readBus(raw.bus, `endpoints.${name}.bus`) } : {}),
    ...(raw.extended !== undefined ? { extended: readBoolean(raw.extended, `endpoints.${name}.extended`) } : {}),
    ...(raw.timeout_ms !== undefined ? { timeoutMs: readNumber(raw.timeout_ms, `endpoints.${name}.timeout_ms`) } : {}),
    ...(raw.fd !== undefined ? { fd: readEndpointFd(raw.fd, `endpoints.${name}.fd`) } : {}),
    ...(raw.addressing !== undefined
      ? { addressing: readIsotpAddressing(raw.addressing, `endpoints.${name}.addressing`) }
      : {}),
  };
}

/**
 * `addressing: { mode: extended, target_address, source_address }` or
 * `addressing: { mode: mixed, address_extension }`. Each mode accepts only its
 * own address fields so a profile cannot silently mix the two vocabularies.
 */
function readIsotpAddressing(raw: unknown, path: string): IsotpAddressing {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError(`${path} must be an object with a mode`);
  }
  const addressing = raw as {
    mode?: unknown;
    target_address?: unknown;
    source_address?: unknown;
    address_extension?: unknown;
  };
  switch (addressing.mode) {
    case "extended":
      if (addressing.address_extension !== undefined) {
        throw new VirtualVehicleError(`${path}.address_extension is only valid with mode mixed`);
      }
      return {
        mode: "extended",
        targetAddress: readByte(addressing.target_address, `${path}.target_address`),
        sourceAddress: readByte(addressing.source_address, `${path}.source_address`),
      };
    case "mixed":
      if (addressing.target_address !== undefined || addressing.source_address !== undefined) {
        throw new VirtualVehicleError(`${path}.target_address and source_address are only valid with mode extended`);
      }
      return {
        mode: "mixed",
        addressExtension: readByte(addressing.address_extension, `${path}.address_extension`),
      };
    default:
      throw new VirtualVehicleError(`${path}.mode must be extended or mixed`);
  }
}

function readEndpointFd(raw: unknown, path: string): ProfileEndpointFd {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError(`${path} must be a boolean or an object`);
  }
  return { txDl: readTxDl((raw as { tx_dl?: unknown }).tx_dl, `${path}.tx_dl`) };
}

function readTxDl(raw: unknown, path: string): CanFdTxDl {
  const txDl = readNumber(raw, path);
  if (txDl !== 8 && txDl !== 64) {
    throw new VirtualVehicleError(`${path} must be 8 or 64`);
  }
  return txDl;
}

function normalizeResponseRange(raw: unknown, path: string): ResponseIdRange {
  if (typeof raw === "number" || typeof raw === "string") {
    const id = readNumber(raw, path);
    return { start: id, end: id };
  }
  if (raw !== null && typeof raw === "object" && "range" in raw) {
    const range = (raw as { range?: unknown }).range;
    if (!Array.isArray(range) || range.length !== 2) {
      throw new VirtualVehicleError(`${path}.range must contain [start, end]`);
    }
    return {
      start: readNumber(range[0], `${path}.range[0]`),
      end: readNumber(range[1], `${path}.range[1]`),
    };
  }
  throw new VirtualVehicleError(`${path} must be a response ID or range`);
}

function normalizeQuery(name: string, raw: RawQuery): ProfileQuery {
  const decoder = normalizeQueryDecoder(name, raw);
  return {
    name,
    endpoint: readString(raw.endpoint, `queries.${name}.endpoint`),
    send: Uint8Array.from(readByteArray(raw.send, `queries.${name}.send`)),
    ...(raw.expect !== undefined ? { expect: normalizeExpect(raw.expect, `queries.${name}.expect`) } : {}),
    ...(decoder !== undefined ? { decoder } : {}),
    ...(raw.length !== undefined ? { length: readNumber(raw.length, `queries.${name}.length`) } : {}),
    ...(raw.timeout_ms !== undefined ? { timeoutMs: readNumber(raw.timeout_ms, `queries.${name}.timeout_ms`) } : {}),
    ...(raw.normalize !== undefined ? { normalize: normalizeValueNormalization(raw.normalize, `queries.${name}.normalize`) } : {}),
  };
}

/**
 * One `actions.<NAME>` entry. A trigger (`HORN`) yields one action. A stateful
 * entity with `values` (`TRUNK: { values: { open, closed } }`) yields one
 * action per value, named `TRUNK.open` and `TRUNK.closed`, each carrying its
 * entity and value. A dotted key (`TRUNK.open:`) is the same thing written
 * flat. Placeholder entries without request bytes are skipped.
 */
function normalizeActionEntry(
  name: string,
  raw: RawAction,
  sequences: Record<string, RawSequence>,
): ProfileAction[] {
  if (raw === null || typeof raw !== "object") {
    throw new VirtualVehicleError(`actions.${name} must be an object`);
  }
  if (raw.values === undefined) {
    const action = normalizeAction(name, raw, sequences, `actions.${name}`);
    return action === undefined ? [] : [withEntityFromName(action)];
  }
  if (raw.send !== undefined || raw.steps !== undefined || raw.expect !== undefined) {
    throw new VirtualVehicleError(`actions.${name} cannot declare both values and its own send, steps, or expect`);
  }
  if (name.includes(ACTION_VALUE_SEPARATOR)) {
    throw new VirtualVehicleError(`actions.${name} cannot declare values on a dotted entity name`);
  }
  if (raw.values === null || typeof raw.values !== "object" || Array.isArray(raw.values)) {
    throw new VirtualVehicleError(`actions.${name}.values must be an object keyed by target value`);
  }

  return Object.entries(raw.values as Record<string, RawAction>).flatMap(([value, branch]) => {
    const path = `actions.${name}.values.${value}`;
    if (value.length === 0 || value.includes(ACTION_VALUE_SEPARATOR)) {
      throw new VirtualVehicleError(`${path} is not a valid target value`);
    }
    if (branch === null || typeof branch !== "object") {
      throw new VirtualVehicleError(`${path} must be an object`);
    }
    if (branch.values !== undefined) {
      throw new VirtualVehicleError(`${path} cannot nest values`);
    }
    const action = normalizeAction(actionName(name, value), {
      ...branch,
      ...(branch.endpoint === undefined && raw.endpoint !== undefined ? { endpoint: raw.endpoint } : {}),
      ...(branch.batch === undefined && raw.batch !== undefined ? { batch: raw.batch } : {}),
    }, sequences, path);
    return action === undefined ? [] : [{ ...action, entity: name, value }];
  });
}

function withEntityFromName(action: ProfileAction): ProfileAction {
  const separator = action.name.indexOf(ACTION_VALUE_SEPARATOR);
  if (separator <= 0 || separator === action.name.length - 1) {
    return action;
  }
  const value = action.name.slice(separator + 1);
  if (value.includes(ACTION_VALUE_SEPARATOR)) {
    throw new VirtualVehicleError(`actions.${action.name} may contain only one "${ACTION_VALUE_SEPARATOR}"`);
  }
  return { ...action, entity: action.name.slice(0, separator), value };
}

function normalizeAction(
  name: string,
  raw: RawAction,
  sequences: Record<string, RawSequence>,
  path: string,
): ProfileAction | undefined {
  const endpoint = raw.endpoint !== undefined
    ? readString(raw.endpoint, `${path}.endpoint`)
    : undefined;
  const steps = raw.steps !== undefined
    ? expandSteps(raw.steps, sequences, raw.endpoint)
    : raw.send !== undefined
      ? [{
          ...readSendStep(raw.send, `${path}.send`, endpoint),
          ...(raw.expect !== undefined ? { expect: normalizeExpect(raw.expect, `${path}.expect`) } : {}),
        }]
      : undefined;

  if (steps === undefined || steps.length === 0) {
    return undefined;
  }

  return {
    name,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(raw.batch !== undefined ? { batch: readBoolean(raw.batch, `${path}.batch`) } : {}),
    steps,
  };
}

function normalizeSignal(name: string, raw: RawSignal): ProfileMonitorSignal[] {
  if (raw.monitor === undefined) {
    return [];
  }
  const normalize = readSignalNormalization(name, raw);
  return [{
    name,
    message: readString(raw.monitor.message, `signals.${name}.monitor.message`),
    signal: readString(raw.monitor.signal, `signals.${name}.monitor.signal`),
    ...(raw.monitor.bus !== undefined ? { bus: readBus(raw.monitor.bus, `signals.${name}.monitor.bus`) } : {}),
    ...(normalize !== undefined ? { normalize } : {}),
  }];
}

function readSignalNormalization(name: string, raw: RawSignal): ProfileValueNormalization | undefined {
  if (raw.normalize !== undefined && raw.state !== undefined) {
    throw new VirtualVehicleError(`signals.${name} cannot declare both normalize and state`);
  }
  const value = raw.normalize ?? raw.state;
  if (value === undefined) {
    return undefined;
  }
  return normalizeValueNormalization(value, `signals.${name}.${raw.normalize !== undefined ? "normalize" : "state"}`);
}

function expandSteps(
  rawSteps: RawStep[],
  sequences: Record<string, RawSequence>,
  inheritedEndpoint: unknown,
  seen: string[] = [],
): RequestStep[] {
  return rawSteps.flatMap((step) => {
    if (step.ref !== undefined) {
      const ref = readString(step.ref, "steps.ref").replace(/^sequences\./u, "");
      if (seen.includes(ref)) {
        throw new VirtualVehicleError(`Circular sequence reference: ${[...seen, ref].join(" -> ")}`);
      }
      const sequence = sequences[ref];
      if (sequence === undefined) {
        throw new VirtualVehicleError(`Unknown sequence reference: ${ref}`);
      }
      return expandSteps(sequence.steps ?? [], sequences, sequence.endpoint ?? inheritedEndpoint, [...seen, ref]);
    }

    const stepEndpoint = step.endpoint !== undefined || inheritedEndpoint !== undefined
      ? readString(step.endpoint ?? inheritedEndpoint, "steps.endpoint")
      : undefined;

    return [{
      ...readSendStep(step.send, "steps.send", stepEndpoint),
      ...(step.expect !== undefined ? { expect: normalizeExpect(step.expect, "steps.expect") } : {}),
      ...(step.timeout_ms !== undefined ? { timeoutMs: readDurationMs(step.timeout_ms, "steps.timeout_ms") } : {}),
      ...(step.delay_ms !== undefined ? { delayMs: readDurationMs(step.delay_ms, "steps.delay_ms") } : {}),
    }];
  });
}

function normalizeQueryDecoder(name: string, raw: RawQuery): DbcDecoderRef | BuiltInDecoderRef | undefined {
  if (raw.dbc_mapping !== undefined) {
    if (raw.decoder !== undefined) {
      throw new VirtualVehicleError(`queries.${name} cannot declare both dbc_mapping and decoder`);
    }
    return normalizeDbcMapping(raw.dbc_mapping, `queries.${name}.dbc_mapping`);
  }
  if (raw.decoder === undefined) {
    return undefined;
  }
  return normalizeDecoder(raw.decoder, `queries.${name}.decoder`);
}

function normalizeDbcMapping(raw: unknown, path: string): DbcDecoderRef {
  if (raw !== null && typeof raw === "object") {
    const mapping = raw as { message?: unknown; signal?: unknown };
    return {
      type: "dbc",
      message: readString(mapping.message, `${path}.message`),
      signal: readString(mapping.signal, `${path}.signal`),
    };
  }
  throw new VirtualVehicleError(`${path} must reference a DBC message and signal`);
}

function normalizeDecoder(raw: unknown, path: string): BuiltInDecoderRef {
  if (raw === "ascii" || raw === "bytes") {
    return { type: raw };
  }
  if (raw !== null && typeof raw === "object") {
    const decoder = raw as { type?: unknown; length?: unknown };
    if (decoder.type === "ascii" || decoder.type === "bytes") {
      return {
        type: decoder.type,
        ...(decoder.length !== undefined ? { length: readNumber(decoder.length, `${path}.length`) } : {}),
      };
    }
  }
  throw new VirtualVehicleError(`${path} must be a built-in decoder name`);
}

function normalizeValueNormalization(raw: unknown, path: string): ProfileValueNormalization {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError(`${path} must be an object`);
  }

  const value = raw as {
    enum?: unknown;
  };
  return {
    ...(value.enum !== undefined ? { enum: readStringMap(value.enum, `${path}.enum`) } : {}),
  };
}

function normalizeExpect(raw: unknown, path: string): ExpectPattern {
  if (raw === "none") {
    return { pattern: [], exact: true };
  }
  if (Array.isArray(raw)) {
    return {
      pattern: readPattern(raw, path),
      exact: false,
    };
  }
  if (raw !== null && typeof raw === "object") {
    const expect = raw as { pattern?: unknown; exact?: unknown };
    if (!Array.isArray(expect.pattern)) {
      throw new VirtualVehicleError(`${path}.pattern must be an array`);
    }
    return {
      pattern: readPattern(expect.pattern, `${path}.pattern`),
      exact: expect.exact === true,
    };
  }
  throw new VirtualVehicleError(`${path} must be an array, object, or none`);
}

function readPattern(raw: unknown[], path: string): ProfileByte[] {
  return raw.map((byte, index) => byte === "*" ? "*" : readByte(byte, `${path}[${index}]`));
}

function readSendStep(
  raw: unknown,
  path: string,
  endpoint?: string,
): Pick<RequestStep, "endpoint" | "requestId" | "bus" | "fd" | "send"> {
  if (Array.isArray(raw)) {
    return {
      ...(endpoint !== undefined ? { endpoint } : {}),
      send: Uint8Array.from(readByteArray(raw, path)),
    };
  }

  if (raw !== null && typeof raw === "object") {
    const send = raw as { request_id?: unknown; bus?: unknown; fd?: unknown; request?: unknown };
    if (send.request_id !== undefined && send.request !== undefined) {
      return {
        requestId: readNumber(send.request_id, `${path}.request_id`),
        ...(send.bus !== undefined ? { bus: readBus(send.bus, `${path}.bus`) } : {}),
        ...(send.fd !== undefined ? { fd: readBoolean(send.fd, `${path}.fd`) } : {}),
        send: Uint8Array.from(readByteArray(
          Array.isArray(send.request) ? send.request : undefined,
          `${path}.request`,
        )),
      };
    }
  }

  throw new VirtualVehicleError(`${path} must be a byte array or { request_id, request } object`);
}

function readByteArray(raw: unknown[] | undefined, path: string): number[] {
  if (!Array.isArray(raw)) {
    throw new VirtualVehicleError(`${path} must be an array`);
  }
  return raw.map((byte, index) => readByte(byte, `${path}[${index}]`));
}

function readByte(raw: unknown, path: string): number {
  const value = readNumber(raw, path);
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new VirtualVehicleError(`${path} must be a byte between 0 and 255`);
  }
  return value;
}

function readBus(raw: unknown, path: string): number {
  const value = readNumber(raw, path);
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new VirtualVehicleError(`${path} must be an integer between 0 and 255`);
  }
  return value;
}

function readCanBitrate(raw: unknown, path: string): number | "auto" {
  if (raw === "auto") {
    return "auto";
  }
  return readPositiveUint32(raw, path);
}

function readDurationMs(raw: unknown, path: string): number {
  const value = readNumber(raw, path);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new VirtualVehicleError(`${path} must be an integer between 0 and 65535 milliseconds`);
  }
  return value;
}

function readPositiveUint32(raw: unknown, path: string): number {
  const value = readNumber(raw, path);
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new VirtualVehicleError(`${path} must be a positive 32-bit integer`);
  }
  return value;
}

function readNumber(raw: unknown, path: string): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const value = /^0x[\da-f]+$/iu.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number(raw);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  throw new VirtualVehicleError(`${path} must be numeric`);
}

function readString(raw: unknown, path: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new VirtualVehicleError(`${path} must be a non-empty string`);
  }
  return raw;
}

function readBoolean(raw: unknown, path: string): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  throw new VirtualVehicleError(`${path} must be a boolean`);
}

function readStringMap(raw: unknown, path: string): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError(`${path} must be an object`);
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key] = readString(value, `${path}.${key}`);
  }
  return values;
}
