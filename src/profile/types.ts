import type { DbcFile } from "../dbc/types.js";

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
  /** Arbitration/nominal bitrate in bits per second. */
  bitrate: CanBitrate;
  /** Optional CAN FD data-phase bitrate in bits per second. */
  dataBitrate?: number;
}

export interface ResponseIdRange {
  start: number;
  end: number;
}

export interface ProfileEndpoint {
  name: string;
  requestId: number;
  responseRanges: ResponseIdRange[];
  /** Logical CAN controller. Omitted values default to bus 0. */
  bus?: number;
  extended?: boolean;
  timeoutMs?: number;
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
