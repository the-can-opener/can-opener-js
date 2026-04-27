# can-opener-js

Signal-first TypeScript library for modeling multiple vehicles. Each vehicle owns its
own DBC bindings, transport, controllers, APIs, and state.

```ts
import { MockTransport, VirtualVehicleManager } from "can-opener-js";

const vv = new VirtualVehicleManager();
const car = await vv.connect({
  id: "tesla-1",
  transport: new MockTransport(),
  dbcFiles: [powertrainDbc, bodyDbc],
});

await car.subscribe("ENGINE_RPM", {
  frequencyHz: 10,
  durationMs: 30_000,
});
await car.subscribe("TURN_SIGNAL_LEFT", { frequencyHz: 5 });
await car.subscribe("HIGH_BEAMS", { frequencyHz: 20 });

const speed = await car.pid("VEHICLE_SPEED");
const rpm = car.state.engine_rpm;

await car.command("HORN", {
  value: true,
  frequencyHz: 2,
  durationMs: 1000,
  mask: 0b00000001,
});
```

## DBC metadata

DBC files define CAN messages and signals. This library uses standard `BA_`
attributes to mark diagnostic PID signals. Regular DBC signals are `frame`
signals, which can be subscribed to or used as commands depending on the API
call:

```dbc
BA_DEF_ SG_ "SignalProtocol" STRING;
BA_DEF_ SG_ "Pid" INT 0 65535;
BA_DEF_ SG_ "RequestCanId" INT 0 536870911;
BA_DEF_ SG_ "ResponseCanId" INT 0 536870911;
BA_DEF_ SG_ "UdsServiceId" INT 0 255;
BA_DEF_ SG_ "UdsDid" INT 0 65535;

BA_ "SignalProtocol" SG_ 201 VEHICLE_SPEED "pid";
BA_ "Pid" SG_ 201 VEHICLE_SPEED 13;
BA_ "RequestCanId" SG_ 201 VEHICLE_SPEED 200;
BA_ "ResponseCanId" SG_ 201 VEHICLE_SPEED 201;
```

Signals without `SignalProtocol` default to `frame`.

Subscriptions are requested by keyword, but the transport subscription is tracked
per CAN frame. If `TURN_SIGNAL_LEFT` and `HIGH_BEAMS` are encoded in the same
CAN ID, the vehicle keeps one underlying frame subscription and modifies it as
keywords are added or removed.

## Transport

The core transport is intentionally dumb:

- it connects and disconnects;
- it sends raw PID and command frames;
- it registers firmware-decoded CAN frames for subscriptions;
- it does not parse DBC, ISO-TP, UDS, or app-level signal names.

`MockTransport` ships with the library for tests and local simulations. Real BLE
transports can implement `VehicleTransport` later.

## Multiple vehicles

`VirtualVehicleManager` never uses globals. Each connected vehicle has isolated
state, DBC registry, controller instances, and transport.

```ts
const vehicleA = await manager.connect({ id: "car-a", transport, dbcFiles });
const vehicleB = await manager.connect({ id: "car-b", transport, dbcFiles });

vehicleA.state.engine_rpm;
vehicleB.state.engine_rpm;
```

## Out of scope for v1

- Web Bluetooth or Node BLE transport.
- ISO-TP assembly/disassembly, which should remain firmware-side.
- React bindings. The core uses `valtio/vanilla`, so a React entry point can be
  added without changing the vehicle model.
