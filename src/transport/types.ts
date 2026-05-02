import type { ActionOptions, CanFrame, CanPayload, DiagnosticBinding } from "../dbc/types.js";

export type MonitorControlStatus =
  | "ok"
  | "invalid_opcode"
  | "invalid_length"
  | "monitor_full"
  | "duplicate_id"
  | "invalid_can_id"
  | "internal_error";

export type MonitorControlRequest =
  | {
      operation: "add" | "remove";
      canIds: readonly number[];
    }
  | {
      operation: "clear";
    };

export interface MonitorControlResponse {
  status: MonitorControlStatus;
  currentMonitorCount: number;
}

export interface MonitorSnapshot {
  sequence: number;
  frames: readonly CanFrame[];
}

export interface VehicleRequest {
  signalName?: string;
  txFrame: CanFrame;
  expectCanResponse: boolean;
  notifyTxStatus?: boolean;
  responseIdStart?: number;
  responseIdEnd?: number;
  timeoutMs?: number;
  diagnostic?: DiagnosticBinding;
  action?: ActionOptions;
}

export interface VehicleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendRequest(req: VehicleRequest): Promise<CanPayload | undefined>;
  updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse>;
  onMonitorSnapshot(cb: (snapshot: MonitorSnapshot) => void): () => void;
}
