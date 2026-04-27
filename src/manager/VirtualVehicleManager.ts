import { CommandController } from "../controllers/CommandController.js";
import { PidController } from "../controllers/PidController.js";
import { SubscriptionController } from "../controllers/SubscriptionController.js";
import { DbcController, type DbcControllerOptions } from "../dbc/DbcController.js";
import type { DbcFile } from "../dbc/types.js";
import { VehicleConnectionError } from "../errors.js";
import type { VehicleTransport } from "../transport/types.js";
import { VehicleState } from "../vehicle/VehicleState.js";
import { VirtualVehicle } from "../vehicle/VirtualVehicle.js";

export interface ConnectVehicleOptions {
  id: string;
  transport: VehicleTransport;
  dbcFiles: DbcFile[];
  dbc?: DbcControllerOptions;
}

export class VirtualVehicleManager {
  private readonly vehicles = new Map<string, VirtualVehicle>();

  async connect(options: ConnectVehicleOptions): Promise<VirtualVehicle> {
    if (this.vehicles.has(options.id)) {
      throw new VehicleConnectionError(`Vehicle already connected: ${options.id}`);
    }

    const state = new VehicleState();
    const dbc = new DbcController(options.dbc);
    dbc.load(options.dbcFiles);

    const subscriptions = new SubscriptionController(state, dbc, options.transport);
    const pids = new PidController(state, dbc, options.transport);
    const commands = new CommandController(dbc, options.transport);

    await options.transport.connect();

    const disposeFrames = options.transport.onFrame((frame) => {
      subscriptions.handleFrame(frame);
    });

    const vehicle = new VirtualVehicle(options.id, state, dbc, options.transport, {
      subscriptions,
      pids,
      commands,
      disposeFrames,
    });

    this.vehicles.set(options.id, vehicle);
    return vehicle;
  }

  get(id: string): VirtualVehicle | undefined {
    return this.vehicles.get(id);
  }

  async disconnect(id: string): Promise<void> {
    const vehicle = this.vehicles.get(id);
    if (vehicle === undefined) {
      return;
    }

    await vehicle.disconnect();
    this.vehicles.delete(id);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.vehicles.keys(), (id) => this.disconnect(id)));
  }

  list(): VirtualVehicle[] {
    return Array.from(this.vehicles.values());
  }
}
