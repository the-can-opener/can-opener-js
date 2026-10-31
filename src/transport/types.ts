import type { ActionOptions, CanFrame, CanPayload, DiagnosticBinding } from "../dbc/types.js";

export type CanBusConfigStatus =
  | "ok"
  | "invalid_bus"
  | "invalid_bitrate"
  | "auto_detect_failed"
  | "internal_error";

export type CanBitrate = number | "auto";

export interface CanBusConfigRequest {
  bus: number;
  /** Arbitration/nominal bitrate in bits per second. */
  bitrate: CanBitrate;
  /** Optional CAN FD data-phase bitrate in bits per second. */
  dataBitrate?: number;
}

export interface CanBusConfigResponse {
  status: CanBusConfigStatus;
  bus: number;
  /** Applied nominal bitrate when firmware reports it. */
  bitrate?: number;
  /** Applied distinct CAN FD data-phase bitrate; zero means the data phase follows nominal. */
  dataBitrate?: number;
}

export type MonitorControlStatus =
  | "ok"
  | "invalid_opcode"
  | "invalid_length"
  | "monitor_full"
  | "duplicate_id"
  | "invalid_can_id"
  | "internal_error"
  | "invalid_bus"
  | "invalid_bitrate"
  | "auto_detect_failed";

export type MonitorControlRequest =
  | {
      operation: "add" | "remove";
      canIds: readonly number[];
      /** Logical CAN controller. Omitted values default to bus 0. */
      bus?: number;
    }
  | {
      operation: "clear";
      /** Logical CAN controller. Omitted values default to bus 0. */
      bus?: number;
    };

export interface MonitorControlResponse {
  status: MonitorControlStatus;
  currentMonitorCount: number;
  /** Bus whose monitor table produced this response. */
  bus?: number;
  /** Optional extended bus-config ACK fields. */
  bitrate?: number;
  dataBitrate?: number;
}

export interface MonitorSnapshot {
  sequence: number;
  frames: readonly CanFrame[];
}

export interface VehicleDisconnectOptions {
  cancelConnection?: boolean;
}

/** ISO-TP frame size for a CAN FD request: the frame length used for segmentation and flow control. */
export type CanFdTxDl = 8 | 64;

export type VehicleCanFdRequest =
  /** Send `txFrame` unchanged as one 8-byte CAN FD frame. */
  | { txDl: 8 }
  | {
    /** Send `payload` in 64-byte CAN FD frames with ISO 15765-2:2016 PCI. */
    txDl: 64;
    /** ISO-TP application payload carried by `txFrame`, without its single-frame PCI byte. */
    payload: CanPayload;
  };

/**
 * ISO 15765-2 extended or mixed addressing, resolved to the address byte each
 * direction carries in front of the PCI. Extended addressing sends the target
 * address and receives the source address; mixed addressing uses the same
 * address extension both ways. Transports treat both the same way.
 */
export interface IsotpAddressBytes {
  /** Byte 0 of every frame sent to the ECU: single, first, consecutive and flow control. */
  tx: number;
  /** Byte 0 the ECU puts on every frame of its reply; frames with another value are not part of the exchange. */
  rx: number;
}

export interface VehicleRequest {
  signalName?: string;
  txFrame: CanFrame;
  /**
   * Send this request as CAN FD, with bit-rate switching when the bus has a
   * data bitrate. Omitted means classic CAN. ISO-TP flow control for the
   * reply uses the same frame size.
   */
  canFd?: VehicleCanFdRequest;
  /**
   * ISO-TP extended or mixed addressing. `txFrame.data[0]` already holds `tx`
   * and the PCI follows it. The transport requires `rx` at byte 0 of every
   * reply frame, strips it, and sends flow control to `txFrame.canId` with
   * `tx` first. Omitted means normal addressing: the PCI is byte 0.
   */
  isotpAddressing?: IsotpAddressBytes;
  expectCanResponse: boolean;
  notifyTxStatus?: boolean;
  responseIdStart?: number;
  responseIdEnd?: number;
  responseIdExtended?: boolean;
  timeoutMs?: number;
  diagnostic?: DiagnosticBinding;
  action?: ActionOptions;
}

/**
 * One step of a batched request. Steps share the batch's bus; `txFrame.bus`
 * must therefore match `VehicleBatchRequest.bus` (or be omitted).
 */
export interface VehicleBatchStep extends VehicleRequest {
  /** Gap the device inserts after this step before transmitting the next one. */
  delayAfterMs?: number;
}

export interface VehicleBatchRequest {
  signalName?: string;
  /** Logical CAN controller for every step. Omitted values default to bus 0. */
  bus?: number;
  /**
   * Keep executing later steps after a step fails at the transport level
   * (timeout, TX failure, ISO-TP error). Defaults to stopping at the first
   * failure so the remaining steps are reported as `skipped`.
   */
  continueOnError?: boolean;
  steps: readonly VehicleBatchStep[];
}

export type VehicleBatchStepStatus =
  /** The frame was sent and, if a response was expected, one arrived. */
  | "ok"
  /** A response was expected but the ECU did not answer within the timeout. */
  | "no_response"
  /** The device could not transmit the frame (no ACK on the bus, TX error). */
  | "tx_failed"
  /** The device reported a transport error for this step. */
  | "error"
  /** An earlier step failed and the device never executed this one. */
  | "skipped";

export interface VehicleBatchStepResult {
  status: VehicleBatchStepStatus;
  /** Response payload for `ok` steps that expected a response. */
  payload?: CanPayload;
  responseCanId?: number;
  /** Human-readable detail for `error` results. */
  error?: string;
}

export interface VehicleBatchResponse {
  /** One entry per requested step, in request order. */
  steps: VehicleBatchStepResult[];
}

export interface VehicleTransport {
  connect(): Promise<void>;
  /** Optional transport capability used when a profile declares `can.buses`. */
  configureBus?(req: CanBusConfigRequest): Promise<CanBusConfigResponse>;
  disconnect(options?: VehicleDisconnectOptions): Promise<void>;
  sendRequest(req: VehicleRequest): Promise<CanPayload | undefined>;
  /**
   * Optional capability: transmit several CAN frames back-to-back on one bus in
   * a single device transaction. Batch-level failures (malformed request,
   * device busy, link loss) reject the promise; per-step outcomes are reported
   * in the response so callers can decide how to treat partial execution.
   */
  sendRequestBatch?(req: VehicleBatchRequest): Promise<VehicleBatchResponse>;
  updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse>;
  onMonitorSnapshot(cb: (snapshot: MonitorSnapshot) => void): () => void;
}
