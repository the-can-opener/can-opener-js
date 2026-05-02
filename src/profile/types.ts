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

export interface RequestStep {
  endpoint?: string;
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
}

export interface ProfileAction {
  name: string;
  endpoint?: string;
  steps: RequestStep[];
}

export interface ProfileMonitorSignal {
  name: string;
  message: string;
  signal: string;
}

export interface LoadedVehicleProfile {
  name: string;
  dbcFiles: DbcFile[];
  endpoints: ProfileEndpoint[];
  queries: ProfileQuery[];
  actions: ProfileAction[];
  signals: ProfileMonitorSignal[];
}
