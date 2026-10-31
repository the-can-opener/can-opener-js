import { CanTransmitError, NoEcuResponseError } from "../errors.js";

export type BusActivity = "awake" | "asleep";

export type BusActivityListener = (activity: BusActivity) => void;

// Requests to a sleeping bus can wake its ECUs, so background senders stop once
// several requests in a row go unanswered and no CAN traffic has been seen for
// a while. Requiring both keeps a single unsupported query on a live bus from
// silencing everything else.
const SILENT_FAILURES_BEFORE_SLEEP = 3;
const QUIET_MS_BEFORE_SLEEP = 5000;

/**
 * Tracks whether the vehicle bus is awake. While it is asleep the round-robin
 * and polled query subscriptions stop transmitting; explicit queries and
 * actions still go out. Received CAN traffic, an ECU reply, or `wake()` marks
 * the bus awake again and lets the background senders resume.
 */
export class BusActivityMonitor {
  private activity: BusActivity = "awake";
  private silentFailures = 0;
  private lastActivityAtMs = Date.now();
  private readonly listeners = new Set<BusActivityListener>();

  state(): BusActivity {
    return this.activity;
  }

  isAwake(): boolean {
    return this.activity === "awake";
  }

  /** CAN traffic was received or an ECU answered a request. */
  recordActivity(): void {
    this.silentFailures = 0;
    this.lastActivityAtMs = Date.now();
    this.setActivity("awake");
  }

  /** Records a request failure; only failures that show a silent bus count toward sleep. */
  recordRequestFailure(error: unknown): void {
    if (!isSilentBusFailure(error) || this.activity === "asleep") {
      return;
    }

    this.silentFailures += 1;
    if (
      this.silentFailures >= SILENT_FAILURES_BEFORE_SLEEP &&
      Date.now() - this.lastActivityAtMs >= QUIET_MS_BEFORE_SLEEP
    ) {
      this.setActivity("asleep");
    }
  }

  /** Treats the bus as awake without having seen traffic, e.g. when the user asks for fresh data. */
  wake(): void {
    this.recordActivity();
  }

  onChange(listener: BusActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  private setActivity(activity: BusActivity): void {
    if (this.activity === activity) {
      return;
    }

    this.activity = activity;
    for (const listener of Array.from(this.listeners)) {
      listener(activity);
    }
  }
}

function isSilentBusFailure(error: unknown): boolean {
  return error instanceof NoEcuResponseError || error instanceof CanTransmitError;
}
