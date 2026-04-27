import { DbcParser } from "./DbcParser.js";
import { SignalClassifier, type SignalClassifierOptions } from "./SignalClassifier.js";
import { SignalRegistry } from "./SignalRegistry.js";
import { decodeFrameSignals, decodeSignalValue, encodeSignalValue, isCodecSignal } from "./codec.js";
import type { CanFrame, DbcFile, DecodedSignalValue, VehicleSignal } from "./types.js";

export interface DbcControllerOptions {
  classifier?: SignalClassifierOptions;
}

export class DbcController {
  private readonly parser = new DbcParser();
  private readonly classifier: SignalClassifier;
  private readonly signals = new SignalRegistry();

  constructor(options: DbcControllerOptions = {}) {
    this.classifier = new SignalClassifier(options.classifier);
  }

  load(files: DbcFile[]): void {
    this.signals.clear();

    for (const file of files) {
      const parsed = this.parser.parse(file);
      const classified = this.classifier.classify(parsed);
      this.signals.load(classified);
    }
  }

  resolve(name: string): VehicleSignal {
    return this.signals.resolve(name);
  }

  all(): VehicleSignal[] {
    return this.signals.values();
  }

  decodeFrame(frame: CanFrame): DecodedSignalValue[] {
    return decodeFrameSignals(frame, this.signals.findByCanId(frame.canId)).map(({ signal, value }) => ({
      name: signal.name,
      value,
      signal,
    }));
  }

  decodeSignal(signalName: string, payload: Uint8Array): unknown {
    const signal = this.resolve(signalName);
    if (!isCodecSignal(signal)) {
      return payload;
    }

    return decodeSignalValue(
      {
        canId: signal.canId,
        data: payload,
      },
      signal,
    );
  }

  encodeSignal(name: string, value: unknown): CanFrame {
    const signal = this.resolve(name);
    if (!isCodecSignal(signal)) {
      throw new Error(`${name} does not define bit layout metadata`);
    }

    return encodeSignalValue(signal, value);
  }
}
