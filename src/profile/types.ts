import type { DbcFile } from "../dbc/types.js";

export type ProfileByte = number | "*";

export interface VehicleProfileSource {
  name: string;
  content: string;
  dbcFiles: DbcFile[];
}

export interface ResponseIdRange {
  start: number;
  end: number;
}

export interface ProfileEndpoint {
  name: string;
  requestId: number;
  responseRanges: ResponseIdRange[];
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
  send: Uint8Array;
  expect?: ExpectPattern;
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
  normalize?: ProfileValueNormalization;
}

export interface LoadedVehicleProfile {
  name: string;
  dbcFiles: DbcFile[];
  endpoints: ProfileEndpoint[];
  queries: ProfileQuery[];
  actions: ProfileAction[];
  signals: ProfileMonitorSignal[];
}
