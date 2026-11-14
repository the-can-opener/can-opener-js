import type { ByteOrder, DbcFile } from "../dbc/types.js";
import type { CanFdTxDl } from "../transport/types.js";

export type ProfileByte = number | "*";

/** A value of a VSS property: boolean, number, or string per its datatype. */
export type VssValue = boolean | number | string;

export interface VehicleProfileSource {
  name: string;
  /** Format 2: the package manifest. Format 1: the profile. */
  content: string;
  dbcFiles: DbcFile[];
  /** Format 2 documents, named by the path the manifest lists them under. */
  documents?: { name: string; content: string }[];
  /**
   * When a list is present, keys missing from it are dropped after the
   * package is composed. `signals` filters passive read bindings by property
   * key, `queries` filters property query bindings and named queries, and
   * `actions` filters property writes and named actions. A property path in
   * `actions` keeps every write of that property; a write case name such as
   * `Vehicle.Cabin.IsCentralLockEngaged=true` keeps that one case.
   */
  allowedKeys?: {
    signals?: string[];
    queries?: string[];
    actions?: string[];
  };
}

export type CanBitrate = number | "auto";

export interface ProfileCanBusConfig {
  /** Logical CAN controller selected by endpoint/signal `bus`. */
  bus: number;
  /**
   * Nominal (arbitration) bitrate in bits per second. Every frame, classic or
   * FD, is arbitrated and acknowledged at this rate.
   */
  bitrate: CanBitrate;
  /**
   * CAN FD data-phase bitrate in bits per second. Only the data bytes of FD
   * frames sent with bit-rate switching use it. Omitted: the nominal rate.
   */
  dataBitrate?: number;
  /** Frames sent on this bus default to CAN FD. Omitted: classic CAN. */
  fd?: ProfileCanBusFd;
}

export interface ProfileCanBusFd {
  /** ISO-TP frame size for endpoints on this bus that do not set their own. */
  isotpTxDl: CanFdTxDl;
}

export interface ResponseIdRange {
  start: number;
  end: number;
}

export interface ProfileCanFdConfig {
  /** ISO-TP frame size: `8` keeps the classic PCI in an FD frame, `64` uses the 2016 escape form. */
  txDl: CanFdTxDl;
}

/** `true`: CAN FD at the bus's ISO-TP frame size. `{ txDl }`: CAN FD at that size. `false`: classic CAN. */
export type ProfileEndpointFd = boolean | ProfileCanFdConfig;

/**
 * ISO 15765-2 addressing that puts an address byte in front of the PCI of
 * every frame. Omitted on an endpoint means normal addressing.
 */
export type IsotpAddressing =
  | {
    /** Extended addressing: the ECU's address goes out, our address comes back (BMW `6F1`/`6xx` diagnostics). */
    mode: "extended";
    /** N_TA, byte 0 of every frame sent to the ECU. */
    targetAddress: number;
    /** N_SA, byte 0 of every frame the ECU sends back. */
    sourceAddress: number;
  }
  | {
    /** Mixed addressing: one address extension in both directions. */
    mode: "mixed";
    /** N_AE, byte 0 of every frame in both directions. */
    addressExtension: number;
  };

export interface ProfileEndpoint {
  name: string;
  requestId: number;
  responseRanges: ResponseIdRange[];
  /** Logical CAN controller. Omitted values default to bus 0. */
  bus?: number;
  extended?: boolean;
  timeoutMs?: number;
  /** Frame format as declared. Omitted: the bus default (`can.buses.<n>.fd`). */
  fd?: ProfileEndpointFd;
  /** ISO-TP extended or mixed addressing. Omitted: normal addressing. */
  addressing?: IsotpAddressing;
}

/** An endpoint with its bus default applied, as `CapabilityRegistry` returns it. */
export interface ResolvedProfileEndpoint extends ProfileEndpoint {
  /** CAN FD setting for this endpoint's requests. Omitted: classic CAN. */
  canFd?: ProfileCanFdConfig;
}

export interface ExpectPattern {
  pattern: ProfileByte[];
  exact: boolean;
  /** Bytes the response must carry after the pattern. Omitted: none. */
  minDataBytes?: number;
}

/**
 * A format 2 decoder, as the spec writes it. `byte`/`bytes` select whole
 * bytes; `start_bit`/`bits`/`bit_order` select a bit field.
 */
export interface FrameDecoder {
  type: "uint" | "int" | "ascii" | "hex";
  byte?: number;
  bytes?: number;
  endian?: "big" | "little";
  start_bit?: number;
  bits?: number;
  bit_order?: "msb0" | "lsb0";
  scale?: number;
  offset?: number;
  enum?: Record<string, VssValue>;
  invalid_raw?: number[];
  unit?: string;
  datatype?: string;
}

/** Decodes the bytes after the validated response prefix. */
export interface FrameDecoderRef {
  type: "frame";
  decode: FrameDecoder;
}

/** Decodes several named outputs from one response. */
export interface OutputsDecoderRef {
  type: "outputs";
  outputs: Record<string, FrameDecoder>;
}

export interface DbcDecoderRef {
  type: "dbc";
  message: string;
  signal: string;
}

export interface BuiltInDecoderRef {
  type: "ascii" | "bytes";
  length?: number;
}

export type QueryDecoder = DbcDecoderRef | BuiltInDecoderRef | FrameDecoderRef | OutputsDecoderRef;

export interface ProfileValueNormalization {
  enum?: Record<string, VssValue>;
  /** A value missing from `enum` is invalid and is not published. */
  strict?: boolean;
  /** VSS datatype the value is converted to after `enum`. */
  datatype?: string;
  /** VSS unit of the property. A DBC value in a known other unit is scaled into it. */
  unit?: string;
}

export interface ProfileNumberInput {
  min?: number;
  max?: number;
  step?: number;
}

export interface ProfileStepEncoding {
  startBit: number;
  length: number;
  byteOrder?: ByteOrder;
  signed?: boolean;
  scale?: number;
  offset?: number;
}

/** A request field that carries an input value. The encoding must be exact. */
export interface ProfileEncodedField {
  /** Input name. A property write supplies its target as `value`. */
  input: string;
  /** Index of the field's first byte in `send`. */
  at: number;
  bytes: number;
  signed: boolean;
  endian: "big" | "little";
  scale: number;
  offset: number;
}

export interface RequestStep {
  endpoint?: string;
  requestId?: number;
  /** Used by inline request_id actions. Endpoint-backed steps inherit endpoint.bus. */
  bus?: number;
  /**
   * Inline request_id steps only: send the frame as CAN FD (`true`) or
   * classic (`false`). Omitted: the bus default. Endpoint-backed steps use
   * the endpoint's setting.
   */
  fd?: boolean;
  send: Uint8Array;
  encode?: ProfileStepEncoding;
  /** Format 2 encoded request parts. */
  fields?: ProfileEncodedField[];
  expect?: ExpectPattern;
  /** Overrides the endpoint response timeout for this step. */
  timeoutMs?: number;
  /** Gap inserted after this step before the next step is transmitted. Defaults to 20 ms. */
  delayMs?: number;
}

export interface ProfileQuery {
  name: string;
  endpoint: string;
  send: Uint8Array;
  expect?: ExpectPattern;
  decoder?: QueryDecoder;
  length?: number;
  timeoutMs?: number;
  normalize?: ProfileValueNormalization;
  /** Named queries only: the declared datatype and unit of the result. */
  datatype?: string;
  unit?: string;
  /** Why this query loaded but cannot run. */
  unavailable?: string;
}

export interface ProfileAction {
  /** Full action name. For a value branch this is `ENTITY.value`, e.g. `DOORS.lock`. */
  name: string;
  /**
   * Set when the action is one command of a stateful entity, declared
   * under `actions.<ENTITY>.values.<command>` or as a dotted `ENTITY.command` key,
   * or when the action encodes a numeric target value via `encode`.
   * `entity` is the portable signal name whose state this action sets.
   */
  entity?: string;
  /** Profile-declared action value, recorded unchanged in state after the action reaches the bus. */
  value?: string;
  /** Bounds and step increment when this action encodes a numeric input. */
  input?: ProfileNumberInput;
  endpoint?: string;
  /**
   * When `false`, multi-step actions are sent one transport transaction at a
   * time even if the transport can batch them. Defaults to batching, which
   * lets the device run the steps back-to-back without BLE round trips.
   */
  batch?: boolean;
  steps: RequestStep[];
  /** Why this action loaded but cannot run, e.g. a request longer than one ISO-TP frame. */
  unavailable?: string;
}

/**
 * Outcome of running a profile action:
 * - `true`: a step's expected response was verified. A retry that succeeds
 *   after an ECU wake still counts as a verified success.
 * - `false`: the ECU responded but the response did not match the expectation.
 * - `"unknown"`: the action was re-sent after an ECU wake, so the request
 *   reached the bus, but the retry's outcome could not be verified.
 * - `undefined`: the action declares no expected responses to verify.
 */
export type ActionRunResult = boolean | "unknown" | undefined;

/**
 * Outcome of a property write, a named action, or a command alias:
 * - `"acknowledged"`: every expected response matched.
 * - `"sent"`: the request declares no expected response.
 * - `"rejected"`: the ECU answered, but not with the expected response.
 * - `"unknown"`: the request reached the bus after an ECU wake, but its
 *   outcome could not be verified.
 */
export type WriteResult = "acknowledged" | "sent" | "rejected" | "unknown";

interface ProfileSignalBase {
  /** State key: the VSS path, or the original keyword outside the vocabulary. */
  name: string;
  /** Logical CAN controller. Omitted values default to bus 0. */
  bus?: number;
}

export interface ProfileDbcSignal extends ProfileSignalBase {
  message: string;
  signal: string;
  /**
   * What the DBC yields before `normalize`: the `VAL_` label when one exists
   * (format 1, the default), the physical value, or the raw integer.
   */
  value?: "label" | "physical" | "raw";
  normalize?: ProfileValueNormalization;
}

/** A signal decoded straight from a CAN frame, without a DBC. */
export interface ProfileFrameSignal extends ProfileSignalBase {
  frame: {
    canId: number;
    /** Required CAN data length in bytes. */
    length: number;
    decode: FrameDecoder;
  };
}

export type ProfileMonitorSignal = ProfileDbcSignal | ProfileFrameSignal;

export interface ProfileWrite {
  /** One action per canonical target: `"true"`, `"false"`, an allowed value, or a decimal number. */
  cases?: Record<string, ProfileAction>;
  /** A request that carries the target itself. Used when no case matches. */
  direct?: ProfileAction;
  constraints?: ProfileNumberInput;
}

export interface ProfileProperty {
  /** VSS path. A format 1 keyword outside the vocabulary keeps its original name. */
  path: string;
  datatype?: string;
  unit?: string;
  allowed?: string[];
  /** Legacy names the package declares for this property. */
  aliases?: string[];
  /** Passive read from broadcast CAN traffic. */
  signal?: ProfileMonitorSignal;
  /** Active read: a request sent to an ECU. */
  query?: ProfileQuery;
  write?: ProfileWrite;
}

/**
 * A legacy keyword. A property alias names a path (`SPEED`). A command alias
 * names one write target (`LOCK` writes `true`) or a named action.
 */
export type ProfileAlias =
  | { name: string; kind: "property"; path: string; declared: boolean }
  | { name: string; kind: "command"; path: string; target: VssValue; declared: boolean }
  | { name: string; kind: "command"; action: string; declared: boolean };

export interface LoadedVehicleProfile {
  name: string;
  /** Format 2 package id. */
  id?: string;
  /** Format 2 package ids that must be loaded before this one. */
  depends?: string[];
  dbcFiles: DbcFile[];
  canBuses: ProfileCanBusConfig[];
  endpoints: ProfileEndpoint[];
  properties: ProfileProperty[];
  /** Named queries: reads with no VSS path. */
  queries: ProfileQuery[];
  /** Named actions: commands with no single VSS actuator. */
  actions: ProfileAction[];
}
