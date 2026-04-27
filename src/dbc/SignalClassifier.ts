import type { DiagnosticBinding, RawDbc, RawDbcAttribute, RawDbcSignal, SignalProtocol, VehicleSignal } from "./types.js";

export interface SignalClassifierAttributeMap {
  protocol: string;
  pid: string;
  requestCanId: string;
  responseCanId: string;
  udsServiceId: string;
  udsDid: string;
  udsPayload: string;
}

export interface SignalClassifierOptions {
  attributeMap?: Partial<SignalClassifierAttributeMap>;
  defaultProtocol?: SignalProtocol;
}

const DEFAULT_ATTRIBUTE_MAP: SignalClassifierAttributeMap = {
  protocol: "SignalProtocol",
  pid: "Pid",
  requestCanId: "RequestCanId",
  responseCanId: "ResponseCanId",
  udsServiceId: "UdsServiceId",
  udsDid: "UdsDid",
  udsPayload: "UdsPayload",
};

export class SignalClassifier {
  private readonly attributeMap: SignalClassifierAttributeMap;
  private readonly defaultProtocol: SignalProtocol;

  constructor(options: SignalClassifierOptions = {}) {
    this.attributeMap = {
      ...DEFAULT_ATTRIBUTE_MAP,
      ...options.attributeMap,
    };
    this.defaultProtocol = options.defaultProtocol ?? "frame";
  }

  classify(raw: RawDbc): VehicleSignal[] {
    const signals: VehicleSignal[] = [];

    for (const message of raw.messages) {
      for (const rawSignal of message.signals) {
        const attributes = raw.attributes.filter(
          (attribute) =>
            attribute.scope === "SG_" &&
            attribute.messageId === message.id &&
            attribute.signalName === rawSignal.name,
        );

        signals.push(this.classifySignal(raw, rawSignal, attributes));
      }
    }

    return signals;
  }

  private classifySignal(raw: RawDbc, rawSignal: RawDbcSignal, attributes: RawDbcAttribute[]): VehicleSignal {
    const protocol = this.readSignalProtocol(attributes);
    const pid = this.readNumberAttribute(attributes, this.attributeMap.pid);
    const requestCanId = this.readNumberAttribute(attributes, this.attributeMap.requestCanId);
    const responseCanId = this.readNumberAttribute(attributes, this.attributeMap.responseCanId);
    const serviceId = this.readNumberAttribute(attributes, this.attributeMap.udsServiceId);
    const did = this.readNumberAttribute(attributes, this.attributeMap.udsDid);
    const payload = this.readPayloadAttribute(attributes, this.attributeMap.udsPayload);
    const enumValues = raw.valueTables.find(
      (table) => table.messageId === rawSignal.messageId && table.signalName === rawSignal.name,
    )?.values;

    return {
      name: rawSignal.name,
      protocol,
      canId: responseCanId ?? rawSignal.messageId,
      startBit: rawSignal.startBit,
      length: rawSignal.length,
      byteOrder: rawSignal.byteOrder,
      signed: rawSignal.signed,
      scale: rawSignal.scale,
      offset: rawSignal.offset,
      ...(rawSignal.unit !== undefined ? { unit: rawSignal.unit } : {}),
      ...(enumValues !== undefined ? { enumValues } : {}),
      ...(protocol === "pid"
        ? {
            diagnostic: this.buildDiagnosticBinding(rawSignal, buildDiagnosticMetadata({
              pid,
              requestCanId,
              responseCanId,
              serviceId,
              did,
              payload,
            })),
          }
        : {}),
    };
  }

  private readSignalProtocol(attributes: RawDbcAttribute[]): SignalProtocol {
    const value = this.readAttribute(attributes, this.attributeMap.protocol);
    if (value === undefined) {
      return this.defaultProtocol;
    }

    if (value === "frame" || value === "pid") {
      return value;
    }

    throw new Error(`Unsupported signal protocol: ${String(value)}`);
  }

  private buildDiagnosticBinding(
    rawSignal: RawDbcSignal,
    metadata: {
      pid?: number;
      requestCanId?: number;
      responseCanId?: number;
      serviceId?: number;
      did?: number;
      payload?: Uint8Array;
    },
  ): DiagnosticBinding {
    if (metadata.payload === undefined && metadata.pid === undefined && metadata.did === undefined) {
      throw new Error(`PID signal ${rawSignal.name} must define Pid, UdsDid, or UdsPayload metadata`);
    }

    const serviceId = metadata.serviceId ?? (metadata.did !== undefined ? 0x22 : 0x01);
    return {
      request: {
        canId: metadata.requestCanId ?? rawSignal.messageId,
        serviceId,
        ...(metadata.pid !== undefined ? { pid: metadata.pid } : {}),
        ...(metadata.did !== undefined ? { did: metadata.did } : {}),
        ...(metadata.payload !== undefined ? { payload: metadata.payload } : {}),
      },
      response: {
        canId: metadata.responseCanId ?? rawSignal.messageId,
        serviceId: serviceId | 0x40,
        ...(metadata.pid !== undefined ? { pid: metadata.pid } : {}),
        ...(metadata.did !== undefined ? { did: metadata.did } : {}),
      },
    };
  }

  private readNumberAttribute(attributes: RawDbcAttribute[], name: string): number | undefined {
    const value = this.readAttribute(attributes, name);
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Attribute ${name} must be numeric`);
    }

    return value;
  }

  private readPayloadAttribute(attributes: RawDbcAttribute[], name: string): Uint8Array | undefined {
    const value = this.readAttribute(attributes, name);
    if (value === undefined) {
      return undefined;
    }

    if (typeof value === "number") {
      return Uint8Array.of(value & 0xff);
    }

    if (typeof value !== "string") {
      throw new Error(`Attribute ${name} must be a hex string or number`);
    }

    const normalized = value.replace(/^0x/i, "").replace(/\s+/g, "");
    if (normalized.length % 2 !== 0 || /[^\da-f]/i.test(normalized)) {
      throw new Error(`Attribute ${name} must be an even-length hex string`);
    }

    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private readAttribute(attributes: RawDbcAttribute[], name: string): RawDbcAttribute["value"] | undefined {
    return attributes.find((attribute) => attribute.name === name)?.value;
  }
}

export function classifySignals(raw: RawDbc, options?: SignalClassifierOptions): VehicleSignal[] {
  return new SignalClassifier(options).classify(raw);
}

function buildDiagnosticMetadata(input: {
  pid: number | undefined;
  requestCanId: number | undefined;
  responseCanId: number | undefined;
  serviceId: number | undefined;
  did: number | undefined;
  payload: Uint8Array | undefined;
}): {
  pid?: number;
  requestCanId?: number;
  responseCanId?: number;
  serviceId?: number;
  did?: number;
  payload?: Uint8Array;
} {
  return {
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.requestCanId !== undefined ? { requestCanId: input.requestCanId } : {}),
    ...(input.responseCanId !== undefined ? { responseCanId: input.responseCanId } : {}),
    ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
    ...(input.did !== undefined ? { did: input.did } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };
}
