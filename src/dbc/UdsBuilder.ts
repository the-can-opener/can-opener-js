import type { CanFrame, CanPayload, VehicleSignal } from "./types.js";

const DEFAULT_PID_SERVICE = 0x01;

export function buildPidRequest(signal: VehicleSignal): CanFrame {
  const request = signal.diagnostic?.request;
  if (request === undefined) {
    throw new Error(`${signal.name} does not define PID request metadata`);
  }

  if (request.payload !== undefined) {
    return {
      canId: request.canId,
      data: padFrame(request.payload),
    };
  }

  if (request.did !== undefined) {
    const serviceId = request.serviceId ?? 0x22;
    return {
      canId: request.canId,
      data: padFrame(Uint8Array.of(serviceId, request.did >> 8 & 0xff, request.did & 0xff)),
    };
  }

  if (request.pid !== undefined) {
    const serviceId = request.serviceId ?? DEFAULT_PID_SERVICE;
    return {
      canId: request.canId,
      data: padFrame(Uint8Array.of(serviceId, request.pid & 0xff)),
    };
  }

  throw new Error(`${signal.name} does not define PID request payload metadata`);
}

export function decodePidResponse(signal: VehicleSignal, payload: CanPayload): CanPayload {
  const response = signal.diagnostic?.response;
  if (response === undefined) {
    return payload;
  }

  if (response.did !== undefined && response.serviceId !== undefined && payload[0] === response.serviceId) {
    return payload.slice(3);
  }

  if (response.pid !== undefined && response.serviceId !== undefined && payload[0] === response.serviceId && payload[1] === response.pid) {
    return payload.slice(2);
  }

  if (response.serviceId !== undefined && payload[0] === response.serviceId) {
    return payload.slice(1);
  }

  return payload;
}

function padFrame(payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(8);
  data.set(payload.slice(0, 8));
  return data;
}
