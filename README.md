# can-opener-js

Signal-first TypeScript library for modeling virtual vehicles on top of DBC
metadata and a pluggable CAN transport. Each connected vehicle owns its own DBC
bindings, transport, controllers, APIs, and state, so multi-vehicle apps do not
need globals or shared registries.

`can-opener-js` is intentionally small: it turns signal names like
`ENGINE_RPM`, `TURN_SIGNAL_LEFT`, and `VEHICLE_SPEED` into DBC-aware operations
while leaving real CAN, BLE, firmware, and ISO-TP details to the transport layer.

## Install

```sh
npm install can-opener-js
```

## Quick Start

```ts
import { MockTransport, VirtualVehicleManager } from "can-opener-js";

const vv = new VirtualVehicleManager();
const car = await vv.connect({
  id: "tesla-1",
  transport: new MockTransport(),
  dbcFiles: [powertrainDbc, bodyDbc],
});

// Subscribe to one signal.
await car.subscribe("ENGINE_RPM", {
  frequencyHz: 10,
  durationMs: 30_000,
});

// Or declare a registry of subscriptions at once.
await car.subscribe({
  TURN_SIGNAL_LEFT: { frequencyHz: 5 },
  HIGH_BEAMS: { frequencyHz: 20 },
});

const speed = await car.pid("VEHICLE_SPEED");
const rpm = car.state.engine_rpm;
const alsoRpm = car.state.get<number>("ENGINE_RPM");

await car.command("HORN", {
  value: true,
  frequencyHz: 2,
  durationMs: 1000,
  mask: 0b00000001,
});
```

## Core Ideas

- Applications use signal names. The DBC controller maps those names to CAN IDs,
  bit layout, protocol metadata, and diagnostic bindings.
- `frame` signals are decoded from incoming CAN frames, can be subscribed to,
  and can be sent as commands.
- `pid` signals are requested on demand through `pid()`.
- A transport only sends and receives frames. It does not need to parse DBC
  files, know app-level signal names, or implement vehicle state.
- Multiple vehicles can be connected at the same time. Each vehicle has isolated
  state and DBC bindings.

## DBC Metadata

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

Supported signal-level attributes:

- `SignalProtocol`: `"frame"` or `"pid"`.
- `Pid`: OBD-style PID number for diagnostic PID requests.
- `RequestCanId`: CAN ID used for diagnostic requests.
- `ResponseCanId`: CAN ID expected for diagnostic responses.
- `UdsServiceId`: UDS service ID for UDS-style diagnostic metadata.
- `UdsDid`: UDS data identifier.

## Connecting Vehicles

Use `VirtualVehicleManager` to connect and track vehicles:

```ts
const manager = new VirtualVehicleManager();

const car = await manager.connect({
  id: "car-a",
  transport: new MockTransport(),
  dbcFiles: [vehicleDbc],
});

manager.get("car-a");
manager.list();
await manager.disconnect("car-a");
await manager.disconnectAll();
```

Calling `connect()` loads the DBC files, creates isolated controllers and state,
connects the transport, and wires incoming transport frames into subscription
decoding.

## Subscriptions

Subscriptions are requested by signal name, but the underlying transport
subscription is tracked per CAN frame. If `TURN_SIGNAL_LEFT` and `HIGH_BEAMS`
are encoded in the same CAN ID, the vehicle keeps one frame subscription and
modifies it as signal names are added or removed.

```ts
const unsubscribeRpm = await car.subscribe("ENGINE_RPM", {
  frequencyHz: 10,
  durationMs: 30_000,
});

await unsubscribeRpm();
```

You can also declare related subscriptions as a registry:

```ts
const unsubscribeBody = await car.subscribe({
  TURN_SIGNAL_LEFT: { frequencyHz: 5 },
  HIGH_BEAMS: { frequencyHz: 20 },
});

await unsubscribeBody();
```

When multiple signals share a CAN frame, the transport receives one merged
subscription request. `frequencyHz` uses the highest active frequency for that
frame. `durationMs` is preserved only when every active signal on that frame has
a finite duration; otherwise the frame subscription stays open until explicitly
unsubscribed.

Incoming frames update `car.state` only for actively subscribed signals:

```ts
transport.emitFrame(car.dbc.encodeSignal("ENGINE_RPM", 900));

car.state.get<number>("ENGINE_RPM"); // 900
car.state.engine_rpm; // 900
```

## PID Reads

Use `pid()` for signals marked with `SignalProtocol` set to `"pid"`:

```ts
const speed = await car.pid<number>("VEHICLE_SPEED");
```

The DBC metadata describes the request and response CAN IDs plus the PID or UDS
details. The transport receives a raw CAN frame through `sendPid()` and returns
the raw response payload; the vehicle decodes that payload back into the signal
value.

Calling `pid()` for a non-`pid` signal throws a protocol error.

## Commands

Use `command()` to send a DBC-encoded frame signal:

```ts
await car.command("HORN", {
  value: true,
  frequencyHz: 2,
  durationMs: 1000,
  mask: 0b00000001,
});
```

Commands are frame-based. The command controller encodes the signal value into a
CAN frame, applies optional masks, and passes the request to the transport with
the original signal name and scheduling options.

## Vehicle State

Each vehicle exposes a `VehicleState` instance backed by `valtio/vanilla`:

```ts
const rpm = car.state.get<number>("ENGINE_RPM");
const sameRpm = car.state.engine_rpm;

const dispose = car.state.subscribe(() => {
  console.log(car.state.snapshot());
});

dispose();
```

State keys are stored by DBC signal name. Property access also accepts common
camelCase or snake_case variants by converting them to upper snake case.

## Transport

The core transport is intentionally dumb:

- it connects and disconnects;
- it sends raw PID and command frames;
- it registers raw incoming CAN frames for subscriptions;
- it does not parse DBC, ISO-TP, UDS, or app-level signal names.

`MockTransport` ships with the library for tests and local simulations. Real BLE
transports can implement `VehicleTransport` later.

```ts
import type {
  CanFrame,
  CanPayload,
  CommandRequest,
  SubscribeRequest,
  VehicleTransport,
} from "can-opener-js";

class MyTransport implements VehicleTransport {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendPid(frame: CanFrame): Promise<CanPayload> {
    return new Uint8Array();
  }
  async subscribe(req: SubscribeRequest): Promise<void> {}
  async unsubscribe(canId: number): Promise<void> {}
  async sendCommand(req: CommandRequest): Promise<void> {}
  onFrame(cb: (frame: CanFrame) => void): () => void {
    return () => {};
  }
}
```

`onFrame()` should register a callback for incoming CAN frames and return a
dispose function. The vehicle calls that dispose function when disconnected.

## Multiple vehicles

`VirtualVehicleManager` never uses globals. Each connected vehicle has isolated
state, DBC registry, controller instances, and transport.

```ts
const vehicleA = await manager.connect({
  id: "car-a",
  transport: transportA,
  dbcFiles,
});

const vehicleB = await manager.connect({
  id: "car-b",
  transport: transportB,
  dbcFiles,
});

vehicleA.state.engine_rpm;
vehicleB.state.engine_rpm;
```

## Development

```sh
npm test
npm run typecheck
npm run build
```

The test suite uses `MockTransport` to simulate PID responses, command sends,
subscription registration, and incoming CAN frames.

## Out of scope for v1

- Web Bluetooth or Node BLE transport.
- ISO-TP assembly/disassembly, which should remain firmware-side.
- React bindings. The core uses `valtio/vanilla`, so a React entry point can be
  added without changing the vehicle model.
