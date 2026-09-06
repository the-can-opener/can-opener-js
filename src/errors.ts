export class VirtualVehicleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualVehicleError";
  }
}

export class UnknownVehicleSignalError extends VirtualVehicleError {
  constructor(signalName: string) {
    super(`Unknown vehicle signal: ${signalName}`);
    this.name = "UnknownVehicleSignalError";
  }
}

export class SignalProtocolError extends VirtualVehicleError {
  constructor(signalName: string, expected: string, actual: string) {
    super(`${signalName} is not a ${expected} signal (actual protocol: ${actual})`);
    this.name = "SignalProtocolError";
  }
}

export class VehicleConnectionError extends VirtualVehicleError {
  constructor(message: string) {
    super(message);
    this.name = "VehicleConnectionError";
  }
}

export class NoEcuResponseError extends VirtualVehicleError {
  constructor(message = "ECU did not respond") {
    super(message);
    this.name = "NoEcuResponseError";
  }
}

/**
 * Thrown by `VehicleTransport.sendRequestBatch` when the connected device does
 * not implement batched requests. Nothing was transmitted on the bus, so the
 * caller can safely replay the same steps as individual requests.
 */
export class BatchUnsupportedError extends VirtualVehicleError {
  constructor(message = "Device does not support batched requests") {
    super(message);
    this.name = "BatchUnsupportedError";
  }
}
