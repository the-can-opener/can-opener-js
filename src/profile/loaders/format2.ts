import { parse } from "yaml";
import { VirtualVehicleError } from "../../errors.js";
import type { CanFdTxDl } from "../../transport/types.js";
import type {
  ExpectPattern,
  FrameDecoder,
  IsotpAddressing,
  LoadedVehicleProfile,
  ProfileAction,
  ProfileByte,
  ProfileCanBusConfig,
  ProfileEncodedField,
  ProfileEndpoint,
  ProfileEndpointFd,
  ProfileMonitorSignal,
  ProfileNumberInput,
  ProfileProperty,
  ProfileQuery,
  ProfileWrite,
  QueryDecoder,
  RequestStep,
  VehicleProfileSource,
  VssValue,
} from "../types.js";
import { composePackage } from "./format2/compose.js";
import type {
  Channel,
  ComposedPackage,
  DbcSignalBinding,
  Endpoint,
  Format2Document,
  Format2Manifest,
  FrameFormat,
  InlineQueryBinding,
  InlineSignalBinding,
  NamedQuery,
  Property,
  SourceRefBinding,
  Step,
  Write,
  WriteBody,
} from "./format2/types.js";
import { vssLeaf } from "./vocabulary.js";

const DEFAULT_CHANNEL = "can0";
const DEFAULT_BITRATE = 500_000;
const CLASSIC_FRAME_BYTES = 8;
/** Payload bytes of a classic ISO-TP single frame, after its PCI byte. */
const ISOTP_SINGLE_FRAME_BYTES = 7;
const MAX_CALL_DEPTH = 64;
const BOOLEAN_ENUM: Record<string, VssValue> = { "0": false, "1": true };

/**
 * YAML 1.2 reads `7E8` as the float 7e8. CAN IDs and bytes are hex text, so
 * exponent floats are left as strings.
 */
const YAML_OPTIONS = {
  customTags: (tags: unknown[]): never[] =>
    tags.filter((tag) => {
      const { tag: name, format } = tag as { tag?: string; format?: string };
      return !(name === "tag:yaml.org,2002:float" && format === "EXP");
    }) as never[],
};

interface Context {
  source: string;
  manifest: Format2Manifest;
  composed: ComposedPackage;
  buses: Map<string, number>;
}

type LoweredRequest =
  | { send: Uint8Array; fields: ProfileEncodedField[] }
  | { unavailable: string };

/** Parses package YAML the way the loader does, keeping hex text such as `7E8` a string. */
export function parsePackageYaml(content: string): unknown {
  return parse(content, YAML_OPTIONS);
}

/** The `manifest` field of a package manifest, or `undefined` when the YAML has none or does not parse. */
export function readManifestVersion(content: string): unknown {
  try {
    const raw = parsePackageYaml(content);
    return raw !== null && typeof raw === "object" ? (raw as { manifest?: unknown }).manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads one format 2 package: composes the manifest and its documents, then
 * lowers the result onto the runtime model. `source.content` is the manifest
 * and `source.documents` holds the documents it lists.
 *
 * Not carried over: `applies_to` on a document (every listed document is
 * composed), `deadline_ms`, `duration`, and `release`. A `repeat` write and a
 * request longer than one frame load as unavailable with the reason.
 */
export function loadFormat2(source: VehicleProfileSource): LoadedVehicleProfile {
  const manifest = parseDocument(source.content, source.name) as Format2Manifest;
  if (manifest.format !== 2) {
    throw new VirtualVehicleError(`Package ${source.name} must declare format: 2`);
  }

  const documents: Format2Document[] = [
    manifest,
    ...(manifest.documents ?? []).map((ref) => {
      const document = source.documents?.find((candidate) => candidate.name === ref.path);
      if (document === undefined) {
        throw new VirtualVehicleError(`Package ${source.name} lists document ${ref.path}, which was not provided`);
      }
      return parseDocument(document.content, `${source.name}/${ref.path}`) as Format2Document;
    }),
  ];
  const composed = composePackage(documents);
  const context: Context = { source: source.name, manifest, composed, buses: channelBuses(manifest, composed) };
  const dbcPaths = new Set(Object.values(manifest.dbc ?? {}).map((dbc) => dbc.path));

  return {
    name: source.name,
    id: manifest.id,
    ...(manifest.depends !== undefined && manifest.depends.length > 0
      ? { depends: manifest.depends.map((dependency) => dependency.id) }
      : {}),
    dbcFiles: source.dbcFiles.filter((file) => dbcPaths.has(file.name)),
    canBuses: lowerChannels(context),
    endpoints: Object.entries(composed.endpoints).map(([name, endpoint]) => lowerEndpoint(name, endpoint, context)),
    properties: Object.entries(composed.properties).map(([path, property]) => lowerProperty(path, property, context)),
    queries: Object.entries(composed.queries).map(([name, query]) => lowerNamedQuery(name, query, context)),
    actions: Object.entries(composed.actions).map(([name, action]) => lowerBody(name, action, context)),
  };
}

function parseDocument(content: string, name: string): object {
  const raw = parsePackageYaml(content);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VirtualVehicleError(`${name} must contain a YAML object`);
  }
  return raw;
}

/**
 * Channel `canN` is bus N. Any other channel name takes the lowest bus no
 * `canN` channel uses, in declaration order.
 */
function channelBuses(manifest: Format2Manifest, composed: ComposedPackage): Map<string, number> {
  const names = new Set<string>(Object.keys(composed.channels));
  for (const endpoint of Object.values(composed.endpoints)) {
    names.add(endpoint.channel ?? DEFAULT_CHANNEL);
  }
  for (const dbc of Object.values(manifest.dbc ?? {})) {
    names.add(dbc.channel ?? DEFAULT_CHANNEL);
  }

  const buses = new Map<string, number>();
  for (const name of names) {
    const match = /^can(\d+)$/u.exec(name);
    if (match?.[1] !== undefined) {
      buses.set(name, Number(match[1]));
    }
  }
  const used = new Set(buses.values());
  let next = 0;
  for (const name of names) {
    if (buses.has(name)) continue;
    while (used.has(next)) next += 1;
    buses.set(name, next);
    used.add(next);
  }
  return buses;
}

function busOf(channel: string | undefined, context: Context): number {
  const name = channel ?? DEFAULT_CHANNEL;
  const bus = context.buses.get(name) ?? /^can(\d+)$/u.exec(name)?.[1];
  if (bus === undefined) {
    throw new VirtualVehicleError(`Package ${context.source} uses channel ${name}, which it does not declare`);
  }
  return Number(bus);
}

/** A `configuration: runtime` channel declares no timing, so the adapter's own is kept. */
function lowerChannels(context: Context): ProfileCanBusConfig[] {
  const configs: ProfileCanBusConfig[] = [];
  for (const [name, channel] of Object.entries(context.composed.channels)) {
    if (channel.configuration === "runtime") continue;
    configs.push({
      bus: busOf(name, context),
      bitrate: channel.bitrate ?? DEFAULT_BITRATE,
      ...(channel.data_bitrate != null ? { dataBitrate: channel.data_bitrate } : {}),
      ...(channel.protocol === "canfd" ? { fd: { isotpTxDl: frameTxDl(channel.fd) ?? 8 } } : {}),
    });
  }
  return configs.sort((left, right) => left.bus - right.bus);
}

function frameTxDl(fd: FrameFormat | null | undefined): CanFdTxDl | undefined {
  return typeof fd === "object" && fd !== null ? fd.tx_dl : undefined;
}

function sendsClassicByDefault(channel: Channel | undefined): boolean {
  return channel?.protocol === "canfd" && (channel.fd == null || channel.fd === false);
}

function lowerEndpoint(name: string, endpoint: Endpoint, context: Context): ProfileEndpoint {
  const path = `endpoints.${name}`;
  const bus = busOf(endpoint.channel, context);
  const channel = context.composed.channels[endpoint.channel ?? DEFAULT_CHANNEL];
  // A CAN FD channel that sends classic frames by default still lets an endpoint opt in.
  const fd = endpoint.fd ?? (sendsClassicByDefault(channel) ? false : undefined);
  const responseRanges = endpoint.responder != null
    ? [singleId(hexId(endpoint.responder, `${path}.responder`))]
    : (endpoint.rx ?? []).map((rx) =>
        typeof rx === "object" && rx !== null
          ? { start: hexId(rx.range[0], `${path}.rx`), end: hexId(rx.range[1], `${path}.rx`) }
          : singleId(hexId(rx, `${path}.rx`)));

  return {
    name,
    requestId: hexId(endpoint.tx, `${path}.tx`),
    responseRanges,
    ...(bus !== 0 ? { bus } : {}),
    ...(endpoint.id_format === "extended" ? { extended: true } : {}),
    ...(endpoint.timeout_ms != null ? { timeoutMs: endpoint.timeout_ms } : {}),
    ...(fd != null ? { fd: lowerEndpointFd(fd) } : {}),
    ...(endpoint.addressing != null ? { addressing: lowerAddressing(endpoint.addressing, path) } : {}),
  };
}

function singleId(id: number): { start: number; end: number } {
  return { start: id, end: id };
}

function lowerEndpointFd(fd: FrameFormat): ProfileEndpointFd {
  return typeof fd === "boolean" ? fd : { txDl: fd.tx_dl };
}

function lowerAddressing(addressing: NonNullable<Endpoint["addressing"]>, path: string): IsotpAddressing {
  switch (addressing.mode) {
    case "extended":
      return {
        mode: "extended",
        targetAddress: hexId(addressing.target_address, `${path}.addressing.target_address`),
        sourceAddress: hexId(addressing.source_address, `${path}.addressing.source_address`),
      };
    case "mixed":
      return {
        mode: "mixed",
        addressExtension: hexId(addressing.address_extension, `${path}.addressing.address_extension`),
      };
    default: {
      const unhandled: never = addressing;
      throw new VirtualVehicleError(`${path}.addressing has an unknown mode: ${JSON.stringify(unhandled)}`);
    }
  }
}

function lowerProperty(path: string, property: Property, context: Context): ProfileProperty {
  const signal = property.read?.signal;
  const query = property.read?.query;
  return {
    path,
    ...vssLeaf(path),
    ...(property.aliases !== undefined && property.aliases.length > 0 ? { aliases: property.aliases } : {}),
    ...(signal != null ? { signal: lowerSignal(path, signal, context) } : {}),
    ...(query != null ? { query: lowerPropertyQuery(path, query, context) } : {}),
    ...(property.write != null ? { write: lowerWrite(path, property.write, context) } : {}),
  };
}

function lowerSignal(
  path: string,
  binding: DbcSignalBinding | InlineSignalBinding | SourceRefBinding,
  context: Context,
): ProfileMonitorSignal {
  if ("source" in binding) {
    const source = context.composed.sources[binding.source];
    if (source === undefined || source.kind !== "signal") {
      throw new VirtualVehicleError(`${path} reads signal source ${binding.source}, which is not declared`);
    }
    if ("dbc" in source) {
      return lowerDbcSignal(path, { ...binding, dbc: source.dbc, message: source.message, signal: binding.output }, context);
    }
    return lowerFrameSignal(path, { ...source, decode: sourceOutput(path, source.outputs, binding) }, context);
  }
  return "dbc" in binding ? lowerDbcSignal(path, binding, context) : lowerFrameSignal(path, binding, context);
}

/**
 * A DBC signal publishes its physical value. With `enum` or `decode_as` the
 * raw integer is mapped instead, and a raw value with no entry is invalid.
 */
function lowerDbcSignal(path: string, binding: DbcSignalBinding, context: Context): ProfileMonitorSignal {
  const dbc = context.manifest.dbc?.[binding.dbc];
  if (dbc === undefined) {
    throw new VirtualVehicleError(`${path} reads DBC ${binding.dbc}, which the manifest does not declare`);
  }
  const bus = busOf(dbc.channel, context);
  const mapping = bindingEnum(binding);
  return {
    name: path,
    message: binding.message,
    signal: binding.signal,
    ...(bus !== 0 ? { bus } : {}),
    ...(mapping !== undefined
      ? { value: "raw" as const, normalize: { enum: mapping, strict: true } }
      : { value: "physical" as const }),
  };
}

function lowerFrameSignal(
  path: string,
  binding: Pick<InlineSignalBinding, "channel" | "id" | "length" | "decode">,
  context: Context,
): ProfileMonitorSignal {
  const bus = busOf(binding.channel, context);
  return {
    name: path,
    ...(bus !== 0 ? { bus } : {}),
    frame: {
      canId: hexId(binding.id, `${path}.read.signal.id`),
      length: binding.length,
      decode: binding.decode as FrameDecoder,
    },
  };
}

function bindingEnum(
  binding: Pick<DbcSignalBinding, "enum" | "decode_as">,
): Record<string, VssValue> | undefined {
  if (binding.enum != null) {
    return binding.enum as Record<string, VssValue>;
  }
  return binding.decode_as === "boolean" ? BOOLEAN_ENUM : undefined;
}

function sourceOutput(path: string, outputs: Record<string, unknown>, binding: SourceRefBinding): FrameDecoder {
  const output = outputs[binding.output] as FrameDecoder | undefined;
  if (output === undefined) {
    throw new VirtualVehicleError(`${path} reads output ${binding.output}, which source ${binding.source} does not declare`);
  }
  const mapping = bindingEnum(binding);
  return mapping === undefined ? output : { ...output, enum: mapping };
}

function lowerPropertyQuery(
  path: string,
  binding: InlineQueryBinding | SourceRefBinding,
  context: Context,
): ProfileQuery {
  if (!("source" in binding)) {
    return lowerQuery(path, binding, { type: "frame", decode: binding.decode as FrameDecoder }, context);
  }
  const source = context.composed.sources[binding.source];
  if (source === undefined || source.kind !== "query") {
    throw new VirtualVehicleError(`${path} reads query source ${binding.source}, which is not declared`);
  }
  return lowerQuery(path, source, { type: "frame", decode: sourceOutput(path, source.outputs, binding) }, context);
}

function lowerNamedQuery(name: string, query: NamedQuery, context: Context): ProfileQuery {
  const decoder: QueryDecoder = query.outputs != null
    ? { type: "outputs", outputs: query.outputs as Record<string, FrameDecoder> }
    : { type: "frame", decode: query.decode as FrameDecoder };
  return {
    ...lowerQuery(name, query, decoder, context),
    ...(query.datatype != null ? { datatype: query.datatype } : {}),
    ...(query.unit != null ? { unit: query.unit } : {}),
  };
}

function lowerQuery(
  name: string,
  query: { endpoint: string; request: unknown; response: unknown },
  decoder: QueryDecoder,
  context: Context,
): ProfileQuery {
  const request = lowerRequest(query.request, resolveEndpoint(name, query.endpoint, context), name);
  const unavailable = "unavailable" in request
    ? request.unavailable
    : request.fields.length > 0
      ? "queries that take an input are not supported"
      : undefined;
  return {
    name,
    endpoint: query.endpoint,
    send: "unavailable" in request ? new Uint8Array() : request.send,
    expect: lowerPattern(query.response, name),
    decoder,
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function lowerWrite(path: string, write: Write, context: Context): ProfileWrite {
  const constraints = write.constraints as ProfileNumberInput | null | undefined;
  return {
    ...("cases" in write
      ? {
          cases: Object.fromEntries(
            Object.entries(write.cases).map(([target, body]) => [target, lowerBody(`${path}=${target}`, body, context)]),
          ),
        }
      : { direct: lowerBody(path, write, context) }),
    ...(constraints != null
      ? {
          constraints: {
            ...(constraints.min != null ? { min: constraints.min } : {}),
            ...(constraints.max != null ? { max: constraints.max } : {}),
            ...(constraints.step != null ? { step: constraints.step } : {}),
          },
        }
      : {}),
  };
}

/** Lowers a write case, a direct write, or a named action. Sequence calls run on the caller's endpoint. */
function lowerBody(name: string, body: WriteBody, context: Context): ProfileAction {
  const endpoint = resolveEndpoint(name, body.endpoint, context);
  if (body.repeat != null) {
    return { name, endpoint: body.endpoint, steps: [], unavailable: "repeat writes are not supported" };
  }

  const steps: RequestStep[] = [];
  let unavailable: string | undefined;
  const expand = (items: readonly Step[], depth: number): void => {
    for (const step of items) {
      if ("call" in step) {
        const sequence = context.composed.sequences[step.call];
        if (sequence === undefined) {
          throw new VirtualVehicleError(`${name} calls sequence ${step.call}, which is not declared`);
        }
        if (depth >= MAX_CALL_DEPTH) {
          throw new VirtualVehicleError(`${name} nests more than ${MAX_CALL_DEPTH} sequence calls`);
        }
        expand(sequence.steps, depth + 1);
      } else if ("wait_ms" in step) {
        const previous = steps.at(-1);
        if (previous !== undefined) {
          previous.delayMs = (previous.delayMs ?? 0) + step.wait_ms;
        }
      } else {
        const request = lowerRequest(step.request, endpoint, name);
        if ("unavailable" in request) {
          unavailable ??= request.unavailable;
          continue;
        }
        steps.push({
          send: request.send,
          ...(request.fields.length > 0 ? { fields: request.fields } : {}),
          ...(step.expect != null ? { expect: lowerPattern(step.expect, name) } : {}),
        });
      }
    }
  };
  expand(body.steps ?? [{ request: body.request, ...(body.expect != null ? { expect: body.expect } : {}) }], 0);

  return {
    name,
    endpoint: body.endpoint,
    steps,
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function resolveEndpoint(name: string, endpointName: string, context: Context): Endpoint {
  const endpoint = context.composed.endpoints[endpointName];
  if (endpoint === undefined) {
    throw new VirtualVehicleError(`${name} uses endpoint ${endpointName}, which is not declared`);
  }
  return endpoint;
}

/**
 * The frame bytes for a request. An `isotp` endpoint's request is the
 * application payload, so the single-frame PCI byte is added here; a `can`
 * endpoint's request is the CAN data field as written.
 */
function lowerRequest(request: unknown, endpoint: Endpoint, name: string): LoweredRequest {
  const parts: unknown[] = typeof request === "object" && request !== null
    ? (request as { parts: unknown[] }).parts
    : [request];
  const bytes: number[] = [];
  const fields: ProfileEncodedField[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) {
      bytes.push(...hexBytes(part, `${name} request`));
      continue;
    }
    const field = part as { input: string; type: "uint" | "int"; bytes: number; endian?: string; scale?: number; offset?: number };
    fields.push({
      input: field.input,
      at: bytes.length,
      bytes: field.bytes,
      signed: field.type === "int",
      endian: field.endian === "little" ? "little" : "big",
      scale: field.scale ?? 1,
      offset: field.offset ?? 0,
    });
    bytes.push(...new Array<number>(field.bytes).fill(0));
  }

  if (endpoint.protocol !== "isotp") {
    return bytes.length > CLASSIC_FRAME_BYTES
      ? { unavailable: `a ${bytes.length}-byte request is longer than one classic CAN frame` }
      : { send: Uint8Array.from(bytes), fields };
  }
  const capacity = ISOTP_SINGLE_FRAME_BYTES - (endpoint.addressing != null ? 1 : 0);
  if (bytes.length > capacity) {
    return { unavailable: `a ${bytes.length}-byte request is longer than one ISO-TP frame` };
  }
  return {
    send: Uint8Array.from([bytes.length, ...bytes]),
    fields: fields.map((field) => ({ ...field, at: field.at + 1 })),
  };
}

function lowerPattern(pattern: unknown, name: string): ExpectPattern {
  const { prefix, exact, min_data_bytes: minDataBytes } = pattern as {
    prefix: unknown;
    exact?: boolean | null;
    min_data_bytes?: number | null;
  };
  return {
    pattern: hexTokens(prefix, `${name} response`).map((token): ProfileByte => token === "*" ? "*" : parseHex(token, `${name} response`)),
    exact: exact === true,
    ...(minDataBytes != null && minDataBytes > 0 ? { minDataBytes } : {}),
  };
}

/** Hex text as YAML gives it: a string, or a number when every digit is decimal (`745`). */
function hexTokens(value: unknown, path: string): string[] {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new VirtualVehicleError(`${path} must be hex text`);
  }
  return String(value).trim().split(/\s+/u);
}

function parseHex(token: string, path: string): number {
  if (!/^[0-9A-Fa-f]+$/u.test(token)) {
    throw new VirtualVehicleError(`${path} must be hex text, received ${token}`);
  }
  return Number.parseInt(token, 16);
}

function hexId(value: unknown, path: string): number {
  const tokens = hexTokens(value, path);
  if (tokens.length !== 1 || tokens[0] === undefined) {
    throw new VirtualVehicleError(`${path} must be one hex value`);
  }
  return parseHex(tokens[0], path);
}

function hexBytes(value: unknown, path: string): number[] {
  return hexTokens(value, path).map((token) => {
    const byte = parseHex(token, path);
    if (byte > 0xff) {
      throw new VirtualVehicleError(`${path} must be hex bytes, received ${token}`);
    }
    return byte;
  });
}
