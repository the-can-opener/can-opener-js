import { parse } from "yaml";
import { VirtualVehicleError } from "../errors.js";
import type {
  BuiltInDecoderRef,
  DbcDecoderRef,
  ExpectPattern,
  LoadedVehicleProfile,
  ProfileAction,
  ProfileByte,
  ProfileEndpoint,
  ProfileMonitorSignal,
  ProfileQuery,
  RequestStep,
  ResponseIdRange,
  VehicleProfileSource,
} from "./types.js";

interface RawProfile {
  version?: unknown;
  dbc?: {
    files?: Array<{ path?: unknown }>;
  };
  endpoints?: Record<string, RawEndpoint>;
  sequences?: Record<string, RawSequence>;
  signals?: Record<string, RawSignal>;
  queries?: Record<string, RawQuery>;
  actions?: Record<string, RawAction>;
}

interface RawEndpoint {
  request_id?: unknown;
  response_id?: unknown;
  response_ids?: unknown[];
  timeout_ms?: unknown;
}

interface RawSequence {
  endpoint?: unknown;
  steps?: RawStep[];
}

interface RawSignal {
  monitor?: {
    message?: unknown;
    signal?: unknown;
  };
}

interface RawQuery {
  endpoint?: unknown;
  send?: unknown[];
  expect?: unknown;
  decoder?: unknown;
  length?: unknown;
}

interface RawAction {
  endpoint?: unknown;
  send?: unknown[];
  expect?: unknown;
  steps?: RawStep[];
}

type RawStep = {
  endpoint?: unknown;
  ref?: unknown;
  send?: unknown[];
  expect?: unknown;
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
    if (raw.version !== 1) {
      throw new VirtualVehicleError(`Profile ${source.name} must declare version: 1`);
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
      endpoints,
      queries: Object.entries(raw.queries ?? {}).map(([name, query]) => normalizeQuery(name, query)),
      actions: Object.entries(raw.actions ?? {}).map(([name, action]) => normalizeAction(name, action, sequences)),
      signals: Object.entries(raw.signals ?? {}).flatMap(([name, signal]) => normalizeSignal(name, signal)),
    };
  }
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
    ...(raw.timeout_ms !== undefined ? { timeoutMs: readNumber(raw.timeout_ms, `endpoints.${name}.timeout_ms`) } : {}),
  };
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
  return {
    name,
    endpoint: readString(raw.endpoint, `queries.${name}.endpoint`),
    send: Uint8Array.from(readByteArray(raw.send, `queries.${name}.send`)),
    ...(raw.expect !== undefined ? { expect: normalizeExpect(raw.expect, `queries.${name}.expect`) } : {}),
    ...(raw.decoder !== undefined ? { decoder: normalizeDecoder(raw.decoder, `queries.${name}.decoder`) } : {}),
    ...(raw.length !== undefined ? { length: readNumber(raw.length, `queries.${name}.length`) } : {}),
  };
}

function normalizeAction(name: string, raw: RawAction, sequences: Record<string, RawSequence>): ProfileAction {
  const steps = raw.steps !== undefined
    ? expandSteps(raw.steps, sequences, raw.endpoint)
    : [{
        ...(raw.endpoint !== undefined ? { endpoint: readString(raw.endpoint, `actions.${name}.endpoint`) } : {}),
        send: Uint8Array.from(readByteArray(raw.send, `actions.${name}.send`)),
        ...(raw.expect !== undefined ? { expect: normalizeExpect(raw.expect, `actions.${name}.expect`) } : {}),
      }];

  return {
    name,
    ...(raw.endpoint !== undefined ? { endpoint: readString(raw.endpoint, `actions.${name}.endpoint`) } : {}),
    steps,
  };
}

function normalizeSignal(name: string, raw: RawSignal): ProfileMonitorSignal[] {
  if (raw.monitor === undefined) {
    return [];
  }
  return [{
    name,
    message: readString(raw.monitor.message, `signals.${name}.monitor.message`),
    signal: readString(raw.monitor.signal, `signals.${name}.monitor.signal`),
  }];
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

    return [{
      ...(step.endpoint !== undefined || inheritedEndpoint !== undefined
        ? { endpoint: readString(step.endpoint ?? inheritedEndpoint, "steps.endpoint") }
        : {}),
      send: Uint8Array.from(readByteArray(step.send, "steps.send")),
      ...(step.expect !== undefined ? { expect: normalizeExpect(step.expect, "steps.expect") } : {}),
    }];
  });
}

function normalizeDecoder(raw: unknown, path: string): DbcDecoderRef | BuiltInDecoderRef {
  if (raw === "ascii" || raw === "bytes") {
    return { type: raw };
  }
  if (raw !== null && typeof raw === "object") {
    const decoder = raw as { dbc_message?: unknown; signal?: unknown; type?: unknown; length?: unknown };
    if (decoder.dbc_message !== undefined || decoder.signal !== undefined) {
      return {
        type: "dbc",
        message: readString(decoder.dbc_message, `${path}.dbc_message`),
        signal: readString(decoder.signal, `${path}.signal`),
      };
    }
    if (decoder.type === "ascii" || decoder.type === "bytes") {
      return {
        type: decoder.type,
        ...(decoder.length !== undefined ? { length: readNumber(decoder.length, `${path}.length`) } : {}),
      };
    }
  }
  throw new VirtualVehicleError(`${path} must be a DBC decoder or built-in decoder name`);
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
