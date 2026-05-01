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
import { VirtualVehicleManager } from "can-opener-js";
import { MockTransport } from "can-opener-js/transport";

const vv = new VirtualVehicleManager();
const car = await vv.connect({
  id: "tesla-1",
  transport: new MockTransport(),
  dbcFiles: [powertrainDbc, bodyDbc],
});

// Subscribe to one signal. Firmware owns the streaming cadence.
const rpmSubscribed = await car.subscribe("ENGINE_RPM"); // true

// Or subscribe to related signals at once.
const bodySubscribed = await car.subscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]); // true
const activeSubscriptions = car.subscriptionCount();

const speed = await car.pid("VEHICLE_SPEED");
const rpm = car.state.engine_rpm;
const alsoRpm = car.state.get<number>("ENGINE_RPM");

await car.command("HORN", {
  value: true,
  frequencyHz: 2,
  durationMs: 1000,
  mask: 0b00000001,
});

await car.unsubscribe("ENGINE_RPM");
await car.unsubscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]);
```

## Core Ideas

- Applications use signal names. The DBC controller maps those names to CAN IDs,
  bit layout, protocol metadata, and diagnostic bindings.
- `frame` signals are decoded from incoming CAN frames, can be subscribed to,
  and can be sent as commands.
- `pid` signals are requested on demand through `pid()` or polled through
  `subscribePid()`.
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
BA_DEF_ SG_ "DiagnosticServiceId" INT 0 255;
BA_DEF_ SG_ "UdsDid" INT 0 65535;
BA_DEF_ SG_ "DiagnosticTransport" STRING;
BA_DEF_ SG_ "ResponseLength" INT 0 4095;
BA_DEF_ SG_ "SignalValueType" STRING;

BA_ "SignalProtocol" SG_ 201 VEHICLE_SPEED "pid";
BA_ "Pid" SG_ 201 VEHICLE_SPEED 13;
BA_ "RequestCanId" SG_ 201 VEHICLE_SPEED 200;
BA_ "ResponseCanId" SG_ 201 VEHICLE_SPEED 201;
BA_ "DiagnosticTransport" SG_ 201 VEHICLE_SPEED "single";
```

Signals without `SignalProtocol` default to `frame`.

DBC `VAL_` entries can also expose normalized state names for enum-like signal
values. This is useful when one physical signal encodes mutually exclusive
states, but the app wants to subscribe to those states by keyword:

```dbc
BO_ 1549 LIGHTS_STATUS_60D: 8 BCM
 SG_ TurnSignalTick : 13|2@1+ (1,0) [0|3] "" Vector__XXX

VAL_ 1549 TurnSignalTick 0 "off" 1 "LEFT_TURN_SIGNAL" 2 "RIGHT_TURN_SIGNAL" 3 "HAZARD_LIGHTS";
```

`TurnSignalTick` remains the physical DBC signal. `LEFT_TURN_SIGNAL`,
`RIGHT_TURN_SIGNAL`, and `HAZARD_LIGHTS` are subscribable enum states derived
from its `VAL_` table.

Supported signal-level attributes:

- `SignalProtocol`: `"frame"` or `"pid"`.
- `Pid`: OBD-style PID number for diagnostic PID requests.
- `RequestCanId`: CAN ID used for diagnostic requests.
- `ResponseCanId`: CAN ID expected for diagnostic responses.
- `DiagnosticServiceId`: diagnostic service/mode ID, such as OBD-II service
  `0x01` for current data or `0x09` for vehicle information.
- `UdsDid`: UDS data identifier.
- `DiagnosticTransport`: `"single"` or `"isotp"`. ISO-TP means the
  transport/device should gather a reassembled logical response before returning.
- `ResponseLength`: expected logical response length after the response service
  and PID/DID bytes are stripped.
- `SignalValueType`: `"number"`, `"ascii"`, or `"bytes"` for payload decoding.

The test fixtures include `tests/fixtures/obd2-pids.dbc` as a starter DBC for
common OBD-II PIDs. It models the logical diagnostic payload, not CAN or ISO-TP
frame bytes.

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

Frame subscriptions are requested by signal name, and the underlying transport
subscription is tracked per CAN frame. Firmware owns the streaming cadence, so
`subscribe()` returns `true` once the firmware monitor list has accepted the
request. Frame subscriptions stay open until `unsubscribe()` is called.
If `TURN_SIGNAL_LEFT` and `HIGH_BEAMS` are encoded in the same CAN ID, the
vehicle keeps one frame subscription and modifies it as signal names are added
or removed. PID polling is intentionally a separate API.

```ts
const subscribed = await car.subscribe("ENGINE_RPM"); // true
const activeCount = car.subscriptionCount(); // 1

await car.unsubscribe("ENGINE_RPM");
```

You can also declare related subscriptions together:

```ts
const subscribed = await car.subscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]); // true
const activeCount = car.subscriptionCount(); // 2

await car.unsubscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]);
```

Subscriptions may target either a physical DBC signal name or a normalized
enum-state name defined in a signal's `VAL_` table. For example, subscribing to
`LEFT_TURN_SIGNAL` watches the parent `TurnSignalTick` CAN frame and updates
`LEFT_TURN_SIGNAL` to `1` only when `TurnSignalTick` decodes to the matching
enum value; otherwise it updates to `0`.

When multiple signals share a CAN frame, the transport receives one merged
subscription request for that frame. Removing the last active signal for a CAN
frame unsubscribes the transport from that frame.

Incoming frames update `car.state` only for actively subscribed signals:

```ts
transport.emitFrame(car.dbc.encodeSignal("ENGINE_RPM", 900));

car.state.get<number>("ENGINE_RPM"); // 900
car.state.engine_rpm; // 900
```

PID polling subscriptions use `subscribePid()`, which returns a handle that can
be passed to `unsubscribePid()` later:

```ts
const speedSubscription = await car.subscribePid("VEHICLE_SPEED", {
  frequencyHz: 2,
});

car.unsubscribePid(speedSubscription);
```

## PID Reads

Use `pid()` for signals marked with `SignalProtocol` set to `"pid"`:

```ts
const speed = await car.pid<number>("VEHICLE_SPEED");
```

The DBC metadata describes the request and response CAN IDs plus the diagnostic
service and PID/DID details. The transport receives a raw request frame through
`sendRequest()` with `expectCanResponse: true` and optional diagnostic context
such as `DiagnosticTransport` and `ResponseLength`. It returns the logical
response payload; the vehicle strips the response service and PID/DID bytes,
then decodes the remaining payload back into the signal value.

For ISO-TP responses, the DBC should still describe the reassembled payload
structure. The transport/device is responsible for ISO-TP segmentation and
reassembly.

Calling `pid()` for a non-`pid` signal throws a protocol error.

## Commands

Use `command()` to send a DBC-encoded frame signal:

```ts
await car.command("HORN");
```

Commands are frame-based. The command controller encodes the signal into a CAN
frame and passes the request to the transport with the original signal name.

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

State keys are stored by the subscribed name. For physical DBC signals, that is
the signal name. For `VAL_` enum-state subscriptions, that is the enum-state
name, such as `LEFT_TURN_SIGNAL`. Property access also accepts common camelCase
or snake_case variants by converting them to upper snake case.

## Transport

The core transport is intentionally dumb:

- it connects and disconnects;
- it sends raw CAN requests through one request path;
- it configures the firmware monitor list for subscriptions;
- it receives monitor snapshots containing the latest raw CAN frames;
- it does not parse DBC, ISO-TP, UDS, or app-level signal names.

`MockTransport` ships with the library for tests and local simulations. Real BLE
transports can implement `VehicleTransport` by mapping these methods onto the
firmware characteristics:

- `sendRequest()` maps to the Request characteristic. Commands use
  `expectCanResponse: false`; PID and diagnostic reads use
  `expectCanResponse: true`.
- `updateMonitor()` maps to the Monitor Control characteristic with `add`,
  `remove`, and `clear` operations.
- `onMonitorSnapshot()` maps to Monitor Data notifications. Each snapshot
  contains the current monitored frame set, with CAN ID, DLC, and up to 8 data
  bytes per frame.

```ts
import type {
  CanPayload,
  MonitorControlRequest,
  MonitorControlResponse,
  MonitorSnapshot,
  VehicleRequest,
  VehicleTransport,
} from "can-opener-js/transport";

class MyTransport implements VehicleTransport {
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    if (!req.expectCanResponse) {
      return undefined;
    }
    if (req.diagnostic?.transport === "isotp") {
      // Gather and return the reassembled logical diagnostic payload here.
    }
    return new Uint8Array();
  }
  async updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse> {
    return { status: "ok", currentMonitorCount: 0 };
  }
  onMonitorSnapshot(cb: (snapshot: MonitorSnapshot) => void): () => void {
    return () => {};
  }
}
```

`onMonitorSnapshot()` should register a callback for monitor data notifications
and return a dispose function. The vehicle calls that dispose function when
disconnected.

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
