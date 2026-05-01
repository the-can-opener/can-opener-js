import type { DbcController } from "../dbc/DbcController.js";
import type { CanFrame, CommandOptions, VehicleSignal } from "../dbc/types.js";
import type { VehicleTransport } from "../transport/types.js";

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

export class CommandController {
  private readonly scheduled = new Set<Timer>();

  constructor(
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
  ) {}

  async send(signal: VehicleSignal, opts: CommandOptions): Promise<void> {
    const frame = this.applyMask(this.dbc.encodeSignal(signal.name, opts.value), opts);
    await this.transport.sendRequest({
      signalName: signal.name,
      txFrame: frame,
      expectCanResponse: false,
      command: opts,
    });

    if (opts.frequencyHz === undefined || opts.durationMs === undefined || opts.durationMs <= 0) {
      return;
    }

    const intervalMs = Math.max(1, Math.round(1000 / opts.frequencyHz));
    const interval = setInterval(() => {
      void this.transport.sendRequest({
        signalName: signal.name,
        txFrame: {
          ...frame,
          data: frame.data.slice(),
        },
        expectCanResponse: false,
        command: opts,
      });
    }, intervalMs);
    this.scheduled.add(interval);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      this.scheduled.delete(interval);
      this.scheduled.delete(timeout);
    }, opts.durationMs);
    this.scheduled.add(timeout);
  }

  clearScheduled(): void {
    for (const timer of this.scheduled) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.scheduled.clear();
  }

  private applyMask(frame: CanFrame, opts: CommandOptions): CanFrame {
    if (opts.mask === undefined) {
      return frame;
    }

    const data = frame.data.slice();
    const value = typeof opts.value === "boolean" ? (opts.value ? opts.mask : 0) : Number(opts.value) & opts.mask;
    data[0] = (data[0] ?? 0) & ~opts.mask | value;
    return {
      ...frame,
      data,
    };
  }
}
