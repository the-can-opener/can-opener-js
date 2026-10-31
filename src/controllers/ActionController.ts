import type { DbcController } from "../dbc/DbcController.js";
import type {
  CanFrame,
  ActionOptions,
  CanPayload,
  VehicleSignal,
} from "../dbc/types.js";
import {
  BatchUnsupportedError,
  CanTransmitError,
  NoEcuResponseError,
} from "../errors.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { isotpAddressingFields } from "../profile/isotpAddressing.js";
import {
  assertExpectedResponse,
  buildStepFrame,
  canFdRequestFields,
  responseBounds,
} from "../profile/RequestBuilder.js";
import type {
  ActionRunResult,
  ProfileAction,
  RequestStep,
} from "../profile/types.js";
import type {
  VehicleBatchStep,
  VehicleBatchStepResult,
  VehicleTransport,
} from "../transport/types.js";

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
const ECU_WAKE_ACTION = "ECU_WAKE";
/**
 * A woken ECU needs a moment on the bus before it answers, and one wake is not
 * always enough, so the request is retried with a growing settle delay. Each
 * retry already waits out the step's response timeout when the ECU is not up
 * yet, so the settle delay is kept short and the ECU is probed often rather
 * than waited on.
 */
const ECU_WAKE_ATTEMPTS = 5;
const ECU_WAKE_SETTLE_MS = 100;
/** Used when a step omits `delay_ms`. Set `delay_ms: 0` to send the next frame immediately. */
const DEFAULT_STEP_DELAY_MS = 0;

function stepDelayMs(step: RequestStep): number {
  return step.delayMs ?? DEFAULT_STEP_DELAY_MS;
}

interface ResolvedStep {
  step: RequestStep;
  request: VehicleBatchStep;
}

type StepVerdict = "verified" | "unverified" | "mismatch";

interface RunStepsOptions {
  /**
   * Keep transmitting after a step that nothing on the bus acknowledged or
   * answered. Used for `ECU_WAKE`, whose frames are expected to go unanswered
   * on a sleeping bus: each one still reaches the wire and helps wake nodes.
   */
  tolerateSilentBus?: boolean;
}

interface RunActionOptions {
  /** Skip the guaranteed-to-fail first probe when the bus is already known asleep. */
  wakeFirst?: boolean;
}

/** The request reached the wire but nothing acknowledged or answered it: the bus may be asleep. */
function isSilentBusError(error: unknown): boolean {
  return (
    error instanceof NoEcuResponseError || error instanceof CanTransmitError
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Splits steps into runs of consecutive steps that share a logical bus. */
function groupStepsByBus(steps: readonly ResolvedStep[]): ResolvedStep[][] {
  const groups: ResolvedStep[][] = [];
  let current: ResolvedStep[] = [];
  let currentBus: number | undefined;
  for (const resolved of steps) {
    const bus = resolved.request.txFrame.bus ?? 0;
    if (current.length > 0 && bus !== currentBus) {
      groups.push(current);
      current = [];
    }
    current.push(resolved);
    currentBus = bus;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

export class ActionController {
  private readonly scheduled = new Set<Timer>();

  constructor(
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
    private readonly capabilities?: CapabilityRegistry,
  ) {}

  async send(signal: VehicleSignal, opts: ActionOptions): Promise<void> {
    const frame = this.applyMask(
      this.dbc.encodeSignal(signal.name, opts.value),
      opts,
    );
    await this.transport.sendRequest({
      signalName: signal.name,
      txFrame: frame,
      expectCanResponse: false,
      action: opts,
    });

    if (
      opts.frequencyHz === undefined ||
      opts.durationMs === undefined ||
      opts.durationMs <= 0
    ) {
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
        action: opts,
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

  async run(
    action: ProfileAction,
    options: RunActionOptions = {},
  ): Promise<ActionRunResult> {
    if (options.wakeFirst === true && action.name !== ECU_WAKE_ACTION) {
      const wakeAction = this.resolveEcuWakeAction();
      if (wakeAction !== undefined) {
        return this.runAfterEcuWake(action, wakeAction);
      }
    }

    try {
      return await this.runSteps(action);
    } catch (error: unknown) {
      if (!isSilentBusError(error) || action.name === ECU_WAKE_ACTION) {
        throw error;
      }

      const wakeAction = this.resolveEcuWakeAction();
      if (wakeAction === undefined) {
        throw error;
      }

      return this.runAfterEcuWake(action, wakeAction);
    }
  }

  /**
   * Wakes the bus and retries `action`. On a sleeping bus the first frame of
   * each attempt is typically the one nothing acknowledges (`tx_failed`), and
   * a woken ECU can take a few hundred milliseconds before it answers, so the
   * wake is repeated with a growing settle delay. A mismatch during this
   * window may still be the ECU answering mid-wake and is retried rather than
   * reported as a refusal.
   */
  private async runAfterEcuWake(
    action: ProfileAction,
    wakeAction: ProfileAction,
  ): Promise<ActionRunResult> {
    for (let attempt = 1; attempt <= ECU_WAKE_ATTEMPTS; attempt += 1) {
      try {
        await this.runSteps(wakeAction, { tolerateSilentBus: true });
      } catch (wakeError: unknown) {
        if (!isSilentBusError(wakeError)) {
          throw wakeError;
        }
      }

      await delay(ECU_WAKE_SETTLE_MS * attempt);

      try {
        const retried = await this.runSteps(action);
        if (retried !== false) {
          return retried;
        }
      } catch (retryError: unknown) {
        if (!isSilentBusError(retryError)) {
          throw retryError;
        }
      }
    }

    // Every attempt reached the bus, so the request may still have applied;
    // report an unknown outcome instead of a hard failure.
    return "unknown";
  }

  private async runSteps(
    action: ProfileAction,
    options: RunStepsOptions = {},
  ): Promise<boolean | undefined> {
    const resolved = action.steps.map((step) => this.resolveStep(action, step));
    const batch = this.transport.sendRequestBatch?.bind(this.transport);
    const useBatch =
      batch !== undefined && action.batch !== false && resolved.length > 1;

    let verified = false;
    const groups = useBatch
      ? groupStepsByBus(resolved)
      : resolved.map((step) => [step]);
    for (const [groupIndex, group] of groups.entries()) {
      const verdicts =
        useBatch && group.length > 1
          ? await this.runBatchedGroupOrFallback(action, group, batch, options)
          : await this.runSequentialGroup(action, group, options);
      for (const verdict of verdicts) {
        if (verdict === "mismatch") {
          return false;
        }
        if (verdict === "verified") {
          verified = true;
        }
      }

      // Honour the trailing gap of a group when the next group runs on another
      // bus (or another transport transaction).
      const last = group[group.length - 1];
      const gapMs = last !== undefined ? stepDelayMs(last.step) : 0;
      if (gapMs > 0 && groupIndex < groups.length - 1) {
        await delay(gapMs);
      }
    }

    return verified ? true : undefined;
  }

  private async runSequentialGroup(
    action: ProfileAction,
    group: readonly ResolvedStep[],
    options: RunStepsOptions,
  ): Promise<StepVerdict[]> {
    const verdicts: StepVerdict[] = [];
    for (const [index, { step, request }] of group.entries()) {
      let verdict: StepVerdict;
      try {
        const payload = await this.transport.sendRequest(request);
        verdict = this.verifyStep(action, step, payload);
      } catch (error: unknown) {
        if (options.tolerateSilentBus !== true || !isSilentBusError(error)) {
          throw error;
        }
        // The frame was still put on the wire; nothing answered, so there is
        // nothing to verify.
        verdict = "unverified";
      }
      verdicts.push(verdict);
      // Stop before transmitting further steps once one has been rejected,
      // matching the historical one-transaction-per-step behaviour.
      if (verdict === "mismatch") {
        break;
      }
      const gapMs = stepDelayMs(step);
      if (gapMs > 0 && index < group.length - 1) {
        await delay(gapMs);
      }
    }
    return verdicts;
  }

  /**
   * A transport may only discover at runtime that the connected device lacks
   * batch support. Nothing has been transmitted in that case, so the same
   * steps are replayed one request at a time.
   */
  private async runBatchedGroupOrFallback(
    action: ProfileAction,
    group: readonly ResolvedStep[],
    batch: NonNullable<VehicleTransport["sendRequestBatch"]>,
    options: RunStepsOptions,
  ): Promise<StepVerdict[]> {
    try {
      return await this.runBatchedGroup(action, group, batch, options);
    } catch (error) {
      if (error instanceof BatchUnsupportedError) {
        return this.runSequentialGroup(action, group, options);
      }
      throw error;
    }
  }

  /**
   * Sends a same-bus group as one device transaction. The device stops at the
   * first transport failure, but it cannot evaluate `expect` patterns, so a
   * mismatching response does not prevent later steps in the same batch from
   * having been transmitted. Profiles that need strict gating between steps
   * should set `batch: false`.
   */
  private async runBatchedGroup(
    action: ProfileAction,
    group: readonly ResolvedStep[],
    batch: NonNullable<VehicleTransport["sendRequestBatch"]>,
    options: RunStepsOptions,
  ): Promise<StepVerdict[]> {
    const bus = group[0]?.request.txFrame.bus;
    const tolerateSilentBus = options.tolerateSilentBus === true;
    const response = await batch({
      signalName: action.name,
      ...(bus !== undefined ? { bus } : {}),
      // The device normally stops at the first failed step; a wake sequence
      // wants every frame on the wire even when the first ones go unanswered.
      ...(tolerateSilentBus ? { continueOnError: true } : {}),
      steps: group.map(({ request }) => request),
    });
    if (response.steps.length !== group.length) {
      throw new Error(
        `Action ${action.name} batch returned ${response.steps.length} results for ${group.length} steps`,
      );
    }

    const verdicts: StepVerdict[] = [];
    for (const [index, { step }] of group.entries()) {
      const result = response.steps[index] as VehicleBatchStepResult;
      const verdict = this.verifyBatchStep(
        action,
        step,
        result,
        tolerateSilentBus,
      );
      verdicts.push(verdict);
      if (verdict === "mismatch") {
        break;
      }
    }
    return verdicts;
  }

  private verifyBatchStep(
    action: ProfileAction,
    step: RequestStep,
    result: VehicleBatchStepResult,
    tolerateSilentBus: boolean,
  ): StepVerdict {
    switch (result.status) {
      case "ok":
        return this.verifyStep(action, step, result.payload);
      case "no_response":
        if (tolerateSilentBus) {
          return "unverified";
        }
        throw new NoEcuResponseError(
          `ECU did not respond to action ${action.name}`,
        );
      case "tx_failed":
        if (tolerateSilentBus) {
          return "unverified";
        }
        throw new CanTransmitError(
          `Action ${action.name} frame was not transmitted on the bus`,
        );
      case "error":
        throw new Error(
          `Action ${action.name} step failed: ${result.error ?? "transport error"}`,
        );
      case "skipped":
        // Only reachable if the transport skipped a step without reporting the
        // failure that caused it; treat it as a transport fault.
        throw new Error(
          `Action ${action.name} step was not executed by the transport`,
        );
      default: {
        const exhaustiveStatus: never = result.status;
        throw new Error(
          `Unhandled batch step status: ${String(exhaustiveStatus)}`,
        );
      }
    }
  }

  private verifyStep(
    action: ProfileAction,
    step: RequestStep,
    payload: CanPayload | undefined,
  ): StepVerdict {
    if (step.expect === undefined) {
      return "unverified";
    }
    if (payload === undefined) {
      throw new NoEcuResponseError(
        `ECU did not respond to action ${action.name}`,
      );
    }
    try {
      assertExpectedResponse(step.expect, payload);
    } catch {
      return "mismatch";
    }
    return "verified";
  }

  private resolveStep(action: ProfileAction, step: RequestStep): ResolvedStep {
    const endpointName = step.endpoint ?? action.endpoint;
    const endpoint =
      step.requestId === undefined && endpointName !== undefined
        ? this.resolveEndpoint(endpointName)
        : undefined;
    if (step.requestId === undefined && endpoint === undefined) {
      throw new Error(
        `Action ${action.name} step does not declare an endpoint or request_id`,
      );
    }
    const timeoutMs = step.timeoutMs ?? endpoint?.timeoutMs;
    const canFd =
      endpoint !== undefined
        ? endpoint.canFd
        : this.capabilities?.inlineStepCanFd(step, action.name);
    const txFrame = buildStepFrame(step, endpoint, canFd);
    return {
      step,
      request: {
        signalName: action.name,
        txFrame,
        ...canFdRequestFields(
          canFd,
          txFrame,
          endpoint !== undefined
            ? `Endpoint ${endpoint.name}`
            : `Action ${action.name}`,
          endpoint?.addressing,
        ),
        ...isotpAddressingFields(endpoint),
        expectCanResponse: step.expect !== undefined,
        ...(endpoint !== undefined ? responseBounds(endpoint) : {}),
        ...(endpoint?.extended !== undefined
          ? { responseIdExtended: endpoint.extended }
          : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        delayAfterMs: stepDelayMs(step),
      },
    };
  }

  private resolveEcuWakeAction(): ProfileAction | undefined {
    if (this.capabilities?.hasAction(ECU_WAKE_ACTION) !== true) {
      return undefined;
    }
    return this.capabilities.resolveAction(ECU_WAKE_ACTION);
  }

  private applyMask(frame: CanFrame, opts: ActionOptions): CanFrame {
    if (opts.mask === undefined) {
      return frame;
    }

    const data = frame.data.slice();
    const value =
      typeof opts.value === "boolean"
        ? opts.value
          ? opts.mask
          : 0
        : Number(opts.value) & opts.mask;
    data[0] = ((data[0] ?? 0) & ~opts.mask) | value;
    return {
      ...frame,
      data,
    };
  }

  private resolveEndpoint(name: string) {
    if (this.capabilities === undefined) {
      throw new Error(`No capability registry configured for endpoint ${name}`);
    }
    return this.capabilities.resolveEndpoint(name);
  }
}
