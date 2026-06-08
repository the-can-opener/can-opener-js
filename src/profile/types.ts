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

export interface ProfileValueNormalization {
  enum?: Record<string, string>;
}

export type ActionInputValueType = "number" | "integer" | "string";

export interface ActionInputSpec {
  name: string;
  type: ActionInputValueType;
  required: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  length?: number;
}

export interface NumericActionEncodeField {
  type: "numeric";
  input: string;
  startBit: number;
  length: number;
  signed: boolean;
  scale: number;
  offset: number;
  byteOrder: "big" | "little";
}

export interface AsciiActionEncodeField {
  type: "ascii";
  input: string;
  startByte: number;
  length: number;
  pad: number;
}

export type ActionEncodeField = NumericActionEncodeField | AsciiActionEncodeField;

export interface RequestStep {
  endpoint?: string;
  send: Uint8Array;
  encode?: ActionEncodeField[];
  expect?: ExpectPattern;
}

export interface ProfileQuery {
  name: string;
  endpoint: string;
  send: Uint8Array;
  expect?: ExpectPattern;
  decoder?: QueryDecoder;
  length?: number;
  normalize?: ProfileValueNormalization;
}

export interface ProfileAction {
  name: string;
  endpoint?: string;
  inputs?: ActionInputSpec[];
  steps: RequestStep[];
}

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
