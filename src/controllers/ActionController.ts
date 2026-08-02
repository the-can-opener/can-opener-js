import type { DbcController } from "../dbc/DbcController.js";
import type { CanFrame, ActionOptions, VehicleSignal } from "../dbc/types.js";
import { NoEcuResponseError } from "../errors.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { assertExpectedResponse, buildStepFrame, responseBounds } from "../profile/RequestBuilder.js";
import type { ProfileAction } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
const ECU_WAKE_ACTION = "ECU_WAKE";

export class ActionController {
  private readonly scheduled = new Set<Timer>();

  constructor(
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
    private readonly capabilities?: CapabilityRegistry,
  ) {}

  async send(signal: VehicleSignal, opts: ActionOptions): Promise<void> {
    const frame = this.applyMask(this.dbc.encodeSignal(signal.name, opts.value), opts);
    await this.transport.sendRequest({
      signalName: signal.name,
      txFrame: frame,
      expectCanResponse: false,
      action: opts,
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

  async run(action: ProfileAction): Promise<boolean | void> {
    try {
      return await this.runSteps(action);
    } catch (error: unknown) {
      if (!(error instanceof NoEcuResponseError) || action.name === ECU_WAKE_ACTION) {
        throw error;
      }

      const wakeAction = this.resolveEcuWakeAction();
      if (wakeAction === undefined) {
        throw error;
      }

      await this.runSteps(wakeAction);
      return this.runSteps(action);
    }
  }

  private async runSteps(action: ProfileAction): Promise<boolean | void> {
    let verified = false;
    for (const step of action.steps) {
      const endpointName = step.endpoint ?? action.endpoint;
      const endpoint = step.requestId === undefined && endpointName !== undefined
        ? this.resolveEndpoint(endpointName)
        : undefined;
      if (step.requestId === undefined && endpoint === undefined) {
        throw new Error(`Action ${action.name} step does not declare an endpoint or request_id`);
      }
      const payload = await this.transport.sendRequest({
        signalName: action.name,
        txFrame: buildStepFrame(step, endpoint),
        expectCanResponse: step.expect !== undefined,
        ...(endpoint !== undefined ? responseBounds(endpoint) : {}),
        ...(endpoint?.extended !== undefined ? { responseIdExtended: endpoint.extended } : {}),
        ...(endpoint?.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      });

      if (step.expect === undefined) {
        continue;
      }
      if (payload === undefined) {
        throw new NoEcuResponseError(`ECU did not respond to action ${action.name}`);
      }
      try {
        assertExpectedResponse(step.expect, payload);
      } catch {
        return false;
      }
      verified = true;
    }

    return verified ? true : undefined;
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
    const value = typeof opts.value === "boolean" ? (opts.value ? opts.mask : 0) : Number(opts.value) & opts.mask;
    data[0] = (data[0] ?? 0) & ~opts.mask | value;
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
