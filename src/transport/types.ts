import type { CanFrame, CanPayload, CommandOptions, SubscriptionOptions } from "../dbc/types.js";

export interface SubscribeRequest extends SubscriptionOptions {
  signalNames: string[];
  frame: CanFrame;
}

export interface CommandRequest extends CommandOptions {
  signalName: string;
  frame: CanFrame;
}

export interface VehicleTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendPid(frame: CanFrame): Promise<CanPayload>;
  subscribe(req: SubscribeRequest): Promise<void>;
  unsubscribe(canId: number): Promise<void>;
  sendCommand(req: CommandRequest): Promise<void>;
  onFrame(cb: (frame: CanFrame) => void): () => void;
}
