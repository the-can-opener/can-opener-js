import { UnknownVehicleSignalError } from "../errors.js";
import type { VehicleSignal, VehicleSignalState } from "./types.js";

export class SignalRegistry {
  private readonly signals = new Map<string, VehicleSignal>();
  private readonly enumStates = new Map<string, VehicleSignalState>();

  clear(): void {
    this.signals.clear();
    this.enumStates.clear();
  }

  set(signal: VehicleSignal): void {
    this.signals.set(signal.name, signal);
    this.setEnumStates(signal);
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

  resolveState(name: string): VehicleSignalState {
    const signal = this.signals.get(name);
    if (signal !== undefined) {
      return {
        name: signal.name,
        signal,
      };
    }

    const enumState = this.enumStates.get(name);
    if (enumState === undefined) {
      throw new UnknownVehicleSignalError(name);
    }
    return enumState;
  }

  findByCanId(canId: number): VehicleSignal[] {
    return Array.from(this.signals.values()).filter((signal) => signal.canId === canId);
  }

  findByMessageSignal(messageName: string, signalName: string): VehicleSignal | undefined {
    return Array.from(this.signals.values()).find(
      (signal) => signal.messageName === messageName && signal.name === signalName,
    );
  }

  values(): VehicleSignal[] {
    return Array.from(this.signals.values());
  }

  private setEnumStates(signal: VehicleSignal): void {
    if (signal.enumValues === undefined) {
      return;
    }

    for (const [value, label] of Object.entries(signal.enumValues)) {
      this.enumStates.set(label, {
        name: label,
        signal,
        enumValue: Number(value),
      });
    }
  }
}
