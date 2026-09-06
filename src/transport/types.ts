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

export interface VehicleRequest {
  signalName?: string;
  txFrame: CanFrame;
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
