import type { DbcFile } from "../dbc/types.js";
import type { CanFdTxDl } from "../transport/types.js";

export type ProfileByte = number | "*";

export interface VehicleProfileSource {
  name: string;
  content: string;
  dbcFiles: DbcFile[];
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

export type QueryDecoder = DbcDecoderRef | BuiltInDecoderRef;

export interface ProfileValueNormalization {
  enum?: Record<string, string>;
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
}

export interface ProfileAction {
  name: string;
  endpoint?: string;
  /**
   * When `false`, multi-step actions are sent one transport transaction at a
   * time even if the transport can batch them. Defaults to batching, which
   * lets the device run the steps back-to-back without BLE round trips.
   */
  batch?: boolean;
  steps: RequestStep[];
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

export interface ProfileMonitorSignal {
  name: string;
  message: string;
  signal: string;
  /** Logical CAN controller. Omitted values default to bus 0. */
  bus?: number;
  normalize?: ProfileValueNormalization;
}

export interface LoadedVehicleProfile {
  name: string;
  dbcFiles: DbcFile[];
  canBuses: ProfileCanBusConfig[];
  endpoints: ProfileEndpoint[];
  queries: ProfileQuery[];
  actions: ProfileAction[];
  signals: ProfileMonitorSignal[];
}
