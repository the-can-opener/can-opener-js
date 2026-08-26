import { ActionController } from "../controllers/ActionController.js";
import { QueryController } from "../controllers/QueryController.js";
import { QueryRoundRobinController } from "../controllers/QueryRoundRobinController.js";
import { SubscriptionController } from "../controllers/SubscriptionController.js";
import { DbcController, type DbcControllerOptions } from "../dbc/DbcController.js";
import type { DbcFile } from "../dbc/types.js";
import { VehicleConnectionError } from "../errors.js";
import { CapabilityRegistry } from "../profile/CapabilityRegistry.js";
import { mergeProfileCanBusConfigs, ProfileLoader } from "../profile/ProfileLoader.js";
import type { VehicleProfileSource } from "../profile/types.js";
import type { VehicleDisconnectOptions, VehicleTransport } from "../transport/types.js";
import { VehicleState } from "../vehicle/VehicleState.js";
import { VirtualVehicle } from "../vehicle/VirtualVehicle.js";

export interface ConnectVehicleOptions {
  id: string;
  transport: VehicleTransport;
  dbcFiles?: DbcFile[];
  profiles?: VehicleProfileSource[];
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
    const capabilities = new CapabilityRegistry();
    const profiles = new ProfileLoader().load(options.profiles ?? []);
    capabilities.load(profiles);
    dbc.load([
      ...(options.dbcFiles ?? []),
      ...profiles.flatMap((profile) => profile.dbcFiles),
    ]);

    const subscriptions = new SubscriptionController(state, dbc, options.transport);
    const queries = new QueryController(state, dbc, options.transport, capabilities);
    const queryRoundRobin = new QueryRoundRobinController(queries);
    const actions = new ActionController(dbc, options.transport, capabilities);

    const busConfigs = mergeProfileCanBusConfigs(profiles);
    await options.transport.connect();
    try {
      if (busConfigs.length > 0 && options.transport.configureBus === undefined) {
        throw new VehicleConnectionError("Vehicle profile declares CAN bus timing but transport cannot configure it");
      }
      for (const config of busConfigs) {
        const response = await options.transport.configureBus?.(config);
        if (response !== undefined && response.status !== "ok") {
          throw new VehicleConnectionError(`Failed to configure CAN bus ${config.bus}: ${response.status}`);
        }
      }
    } catch (error: unknown) {
      await options.transport.disconnect();
      throw error;
    }

    const disposeFrames = options.transport.onMonitorSnapshot((snapshot) => {
      for (const frame of snapshot.frames) {
        subscriptions.handleFrame(frame);
      }
    });

    const vehicle = new VirtualVehicle(options.id, state, dbc, options.transport, {
      subscriptions,
      queries,
      queryRoundRobin,
      actions,
      capabilities,
      disposeFrames,
    });

    this.vehicles.set(options.id, vehicle);
    return vehicle;
  }

  get(id: string): VirtualVehicle | undefined {
    return this.vehicles.get(id);
  }

  async disconnect(
    id: string,
    options: VehicleDisconnectOptions = {},
  ): Promise<void> {
    const vehicle = this.vehicles.get(id);
    if (vehicle === undefined) {
      return;
    }

    await vehicle.disconnect(options);
    this.vehicles.delete(id);
  }

  async disconnectAll(options: VehicleDisconnectOptions = {}): Promise<void> {
    await Promise.all(
      Array.from(this.vehicles.keys(), (id) => this.disconnect(id, options)),
    );
  }

  list(): VirtualVehicle[] {
    return Array.from(this.vehicles.values());
  }
}
