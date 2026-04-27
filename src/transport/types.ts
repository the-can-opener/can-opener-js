import type { CanFrame, CanPayload, CommandOptions, DiagnosticBinding, SubscriptionOptions } from "../dbc/types.js";

export interface SubscribeRequest extends SubscriptionOptions {
  signalNames: string[];
  frame: CanFrame;
}

export interface CommandRequest extends CommandOptions {
  signalName: string;
  frame: CanFrame;
}

export interface PidRequestContext {
  signalName: string;
  diagnostic: DiagnosticBinding;
}

export interface VehicleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendPid(frame: CanFrame, context?: PidRequestContext): Promise<CanPayload>;
  subscribe(req: SubscribeRequest): Promise<void>;
  unsubscribe(canId: number): Promise<void>;
  sendCommand(req: CommandRequest): Promise<void>;
  onFrame(cb: (frame: CanFrame) => void): () => void;
}
