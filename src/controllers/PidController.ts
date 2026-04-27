import { buildPidRequest, decodePidResponse } from "../dbc/UdsBuilder.js";
import type { DbcController } from "../dbc/DbcController.js";
import type { VehicleSignal } from "../dbc/types.js";
import type { VehicleTransport } from "../transport/types.js";
import type { VehicleState } from "../vehicle/VehicleState.js";

export class PidController {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly state: VehicleState,
    private readonly dbc: DbcController,
    private readonly transport: VehicleTransport,
  ) {}

  async request(signal: VehicleSignal): Promise<unknown> {
    const frame = buildPidRequest(signal);
    const promise = this.transport.sendPid(frame).then((payload) => {
      const decodedPayload = decodePidResponse(signal, payload);
      const value = this.dbc.decodeSignal(signal.name, decodedPayload);
      this.state.update(signal.name, value);
      return value;
    });

    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }

  clearPending(): void {
    this.pending.clear();
  }
}
