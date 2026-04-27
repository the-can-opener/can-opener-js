import type { CanFrame, CanPayload } from "../dbc/types.js";
import type { CommandRequest, SubscribeRequest, VehicleTransport } from "./types.js";

type FrameCallback = (frame: CanFrame) => void;

export class MockTransport implements VehicleTransport {
  readonly subscriptions: SubscribeRequest[] = [];
  readonly commands: CommandRequest[] = [];
  readonly pidRequests: CanFrame[] = [];

  private readonly callbacks = new Set<FrameCallback>();
  private readonly pidResponses = new Map<string, CanPayload>();
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.callbacks.clear();
  }

  async sendPid(frame: CanFrame): Promise<CanPayload> {
    this.assertConnected();
    this.pidRequests.push(cloneFrame(frame));
    const response = this.pidResponses.get(frameKey(frame));
    if (response === undefined) {
      throw new Error(`No mock PID response registered for CAN ID ${frame.canId}`);
    }
    return response.slice();
  }

  async subscribe(req: SubscribeRequest): Promise<void> {
    this.assertConnected();
    const kept = this.subscriptions.filter((subscription) => subscription.frame.canId !== req.frame.canId);
    this.subscriptions.splice(0, this.subscriptions.length, ...kept);
    this.subscriptions.push({
      ...req,
      signalNames: [...req.signalNames],
      frame: cloneFrame(req.frame),
    });
  }

  async unsubscribe(canId: number): Promise<void> {
    const kept = this.subscriptions.filter((subscription) => subscription.frame.canId !== canId);
    this.subscriptions.splice(0, this.subscriptions.length, ...kept);
  }

  async sendCommand(req: CommandRequest): Promise<void> {
    this.assertConnected();
    this.commands.push({
      ...req,
      frame: cloneFrame(req.frame),
    });
  }

  onFrame(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  scriptPidResponse(frame: CanFrame, payload: CanPayload): void {
    this.pidResponses.set(frameKey(frame), payload.slice());
  }

  emitFrame(frame: CanFrame): void {
    for (const callback of this.callbacks) {
      callback(cloneFrame(frame));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("MockTransport is not connected");
    }
  }
}

function cloneFrame(frame: CanFrame): CanFrame {
  return {
    canId: frame.canId,
    data: frame.data.slice(),
    ...(frame.extended !== undefined ? { extended: frame.extended } : {}),
  };
}

function frameKey(frame: CanFrame): string {
  return `${frame.canId}:${Array.from(frame.data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
