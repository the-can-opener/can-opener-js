import type { DbcController } from "../dbc/DbcController.js";
import type { ActionInputs, ActionOptions, CanFrame, VehicleSignal } from "../dbc/types.js";
import { VirtualVehicleError } from "../errors.js";
import type { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { assertExpectedResponse, buildStepFrame, responseBounds } from "../profile/RequestBuilder.js";
import type { ActionInputSpec, ProfileAction } from "../profile/types.js";
import type { VehicleTransport } from "../transport/types.js";

type Timer = ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;

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

  async run(action: ProfileAction, inputs: ActionInputs = {}): Promise<boolean | void> {
    validateActionInputs(action, inputs);
    let verified = false;
    for (const step of action.steps) {
      const endpointName = step.endpoint ?? action.endpoint;
      if (endpointName === undefined) {
        throw new Error(`Action ${action.name} step does not declare an endpoint`);
      }
      const endpoint = this.resolveEndpoint(endpointName);
      const payload = await this.transport.sendRequest({
        signalName: action.name,
        txFrame: buildStepFrame(step, endpoint, inputs),
        expectCanResponse: step.expect !== undefined,
        ...responseBounds(endpoint),
        ...(endpoint.timeoutMs !== undefined ? { timeoutMs: endpoint.timeoutMs } : {}),
      });

      if (step.expect === undefined) {
        continue;
      }
      if (payload === undefined) {
        return false;
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

function validateActionInputs(action: ProfileAction, inputs: ActionInputs): void {
  const specs = action.inputs ?? [];
  const declared = new Map(specs.map((input) => [input.name, input]));
  const providedNames = Object.keys(inputs);
  if (specs.length === 0 && providedNames.length > 0) {
    throw new VirtualVehicleError(`Action ${action.name} does not accept inputs`);
  }

  for (const input of specs) {
    const value = inputs[input.name];
    if (value === undefined) {
      if (input.required) {
        throw new VirtualVehicleError(`Action ${action.name} requires input ${input.name}`);
      }
      continue;
    }
    validateActionInputValue(action.name, input, value);
  }

  for (const name of providedNames) {
    if (!declared.has(name)) {
      throw new VirtualVehicleError(`Action ${action.name} does not declare input ${name}`);
    }
  }

  for (const step of action.steps) {
    for (const field of step.encode ?? []) {
      if (inputs[field.input] === undefined) {
        throw new VirtualVehicleError(`Action ${action.name} requires input ${field.input} for request encoding`);
      }
    }
  }
}

function validateActionInputValue(actionName: string, input: ActionInputSpec, value: unknown): void {
  if (input.type === "string") {
    if (typeof value !== "string") {
      throw new VirtualVehicleError(`Action ${actionName} input ${input.name} must be a string`);
    }
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VirtualVehicleError(`Action ${actionName} input ${input.name} must be a finite number`);
  }
  if (input.type === "integer" && !Number.isInteger(value)) {
    throw new VirtualVehicleError(`Action ${actionName} input ${input.name} must be an integer`);
  }
  if (input.min !== undefined && value < input.min) {
    throw new VirtualVehicleError(`Action ${actionName} input ${input.name} must be >= ${input.min}`);
  }
  if (input.max !== undefined && value > input.max) {
    throw new VirtualVehicleError(`Action ${actionName} input ${input.name} must be <= ${input.max}`);
  }
  if (input.step !== undefined && !isStepAligned(value, input)) {
    throw new VirtualVehicleError(`Action ${actionName} input ${input.name} must align to step ${input.step}`);
  }
}

function isStepAligned(value: number, input: ActionInputSpec): boolean {
  const base = input.min ?? 0;
  const ratio = (value - base) / (input.step ?? 1);
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}
