export type SignalProtocol = "frame" | "pid";
export type SignalValueType = "number" | "ascii" | "bytes";
export type DiagnosticTransport = "single" | "isotp";
export type ByteOrder = "little" | "big";
export type CanPayload = Uint8Array;
export type AttributeValue = string | number | boolean;

export interface DiagnosticRequest {
  canId: number;
  serviceId?: number;
  pid?: number;
  did?: number;
  payload?: Uint8Array;
}

export interface DiagnosticResponse {
  canId?: number;
  serviceId?: number;
  pid?: number;
  did?: number;
}

export interface DiagnosticBinding {
  request: DiagnosticRequest;
  response: DiagnosticResponse;
  transport?: DiagnosticTransport;
  responseLength?: number;
}

export interface VehicleSignal {
  name: string;
  protocol: SignalProtocol;
  canId: number;
  startBit?: number;
  length?: number;
  byteOrder?: ByteOrder;
  signed?: boolean;
  scale?: number;
  offset?: number;
  unit?: string;
  valueType?: SignalValueType;
  enumValues?: Record<number, string>;
  diagnostic?: DiagnosticBinding;
}

export interface VehicleSignalState {
  name: string;
  signal: VehicleSignal;
  enumValue?: number;
}

export interface CanFrame {
  canId: number;
  data: Uint8Array;
  extended?: boolean;
}

export interface DbcFile {
  name: string;
  content: string;
}

export interface RawDbcSignal {
  name: string;
  messageId: number;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
  receivers: string[];
}

export interface RawDbcMessage {
  id: number;
  name: string;
  size: number;
  transmitter: string;
  signals: RawDbcSignal[];
}

export interface RawDbcAttributeDefinition {
  name: string;
  scope?: "SG_" | "BO_" | "BU_" | "EV_";
  type: "STRING" | "INT" | "FLOAT" | "ENUM" | "HEX";
  enumValues?: string[];
}

export interface RawDbcAttribute {
  name: string;
  scope?: "SG_" | "BO_" | "BU_" | "EV_";
  messageId?: number;
  signalName?: string;
  value: AttributeValue;
}

export interface RawDbcValueTable {
  messageId: number;
  signalName: string;
  values: Record<number, string>;
}

export interface RawDbc {
  fileName: string;
  messages: RawDbcMessage[];
  attributeDefinitions: RawDbcAttributeDefinition[];
  attributes: RawDbcAttribute[];
  valueTables: RawDbcValueTable[];
}

export interface DecodedSignalValue {
  name: string;
  value: unknown;
  signal: VehicleSignal;
}

export interface SubscriptionOptions {
  frequencyHz?: number;
  durationMs?: number;
}

export type SubscriptionRegistry = Record<
  string,
  SubscriptionOptions | undefined
>;

export interface CommandOptions extends SubscriptionOptions {
  value: unknown;
  mask?: number;
}

export type Unsubscribe = () => void | Promise<void>;
