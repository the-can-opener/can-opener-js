import { UnknownVehicleSignalError } from "../errors.js";
import type { VehicleSignal } from "./types.js";

export class SignalRegistry {
  private readonly signals = new Map<string, VehicleSignal>();

  clear(): void {
    this.signals.clear();
  }

  set(signal: VehicleSignal): void {
    this.signals.set(signal.name, signal);
  }

  load(signals: Iterable<VehicleSignal>): void {
    for (const signal of signals) {
      this.set(signal);
    }
  }

  resolve(name: string): VehicleSignal {
    const signal = this.signals.get(name);
    if (signal === undefined) {
      throw new UnknownVehicleSignalError(name);
    }
    return signal;
  }

  findByCanId(canId: number): VehicleSignal[] {
    return Array.from(this.signals.values()).filter((signal) => signal.canId === canId);
  }

  values(): VehicleSignal[] {
    return Array.from(this.signals.values());
  }
}
