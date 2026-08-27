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
  /** Applied CAN FD data-phase bitrate; omitted/zero means disabled. */
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

export interface VehicleTransport {
  connect(): Promise<void>;
  /** Optional transport capability used when a profile declares `can.buses`. */
  configureBus?(req: CanBusConfigRequest): Promise<CanBusConfigResponse>;
  disconnect(options?: VehicleDisconnectOptions): Promise<void>;
  sendRequest(req: VehicleRequest): Promise<CanPayload | undefined>;
  updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse>;
  onMonitorSnapshot(cb: (snapshot: MonitorSnapshot) => void): () => void;
}
