# can-opener-js

React-style vehicle state for cars. `can-opener-js` gives TypeScript apps a
virtual vehicle object that monitors the state of a car through named signals and
uses named actions to control that state, without forcing the app to speak raw
CAN. It abstracts DBC files, CAN IDs, byte order, scaling, masks, and bit-level
signal packing behind named vehicle state.

Under the hood, it is a signal-first library for modeling virtual vehicles on
top of DBC metadata and a pluggable CAN transport. Each connected vehicle owns
its own DBC bindings, transport, controllers, APIs, and state, so multi-vehicle
apps do not need globals or shared registries. That makes vehicle scripts
portable: the same code can run across different cars by swapping the DBC files
and transport.

It turns signal names like `ENGINE_RPM`, `TURN_SIGNAL_LEFT`, and
`VEHICLE_SPEED` into DBC-aware state reads, subscriptions, queries, and actions while
leaving real CAN, BLE, firmware, and ISO-TP details to the transport layer.

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
  profiles: [vehicleProfile],
});

// Subscribe to one signal. Firmware owns the streaming cadence.
const rpmSubscribed = await car.subscribe("ENGINE_RPM"); // true

// Or subscribe to related signals at once.
const bodySubscribed = await car.subscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]); // true
const activeSubscriptions = car.subscriptionCount();

const speed = await car.query("VEHICLE_SPEED");
const rpm = car.state.engine_rpm;
const alsoRpm = car.state.get<number>("ENGINE_RPM");

await car.action("HORN");

await car.unsubscribe("ENGINE_RPM");
await car.unsubscribe(["TURN_SIGNAL_LEFT", "HIGH_BEAMS"]);
```

## Core Ideas

- Treat the vehicle like app state: subscribe to signals, read the latest values
  from `car.state`, and run queries or actions through a consistent API.
- Applications use signal names. The DBC controller maps those names to CAN IDs,
  bit layout, protocol metadata, and diagnostic bindings.
- `frame` signals are decoded from incoming CAN frames and can be subscribed to.
- Diagnostic signals are requested on demand through `query()` or polled through
  `subscribeQuery()`.
- A transport only sends and receives frames. It does not need to parse DBC
  files, know app-level signal names, or implement vehicle state.
- Multiple vehicles can be connected at the same time. Each vehicle has isolated
  state and DBC bindings.

## Profiles And DBC

DBC files define received CAN messages and signal bit layouts. YAML profiles
define the executable capabilities: endpoints, request/response queries,
actions, monitor subscriptions, applicability, and DBC decoder references. The
library does not ship a built-in catalog of PIDs, actions, request bytes, or
decoder mappings; loaded YAML+DBC files are the source of truth.

```yaml
version: 1

dbc:
  files:
    - path: signals.dbc

endpoints:
  obd:
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]
    timeout_ms: 500

queries:
  SPEED:
    endpoint: obd
    send: [0x01, 0x0D]
    expect: [0x41, 0x0D]
    decoder:
      dbc_message: OBD_Response_7E8
      signal: SPEED
```

```dbc
BO_ 2024 OBD_Response_7E8: 8 ECU
 SG_ RESPONSE_SERVICE : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ PID M : 16|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ SPEED m13 : 24|8@1+ (1,0) [0|255] "km/h" Vector__XXX
```

Raw DBC-only loading is still supported for simple frame subscriptions and
legacy tests. In profile-backed vehicles, executable names come from YAML
`queries`, `actions`, and `signals` declarations.

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

The test fixtures include `tests/fixtures/vehicles/universal/pid/profile.yaml`
and `tests/fixtures/vehicles/universal/pid/signals.dbc` as a starter profile
pair for common OBD-II PID queries.

## Connecting Vehicles

Use `VirtualVehicleManager` to connect and track vehicles:

```ts
const manager = new VirtualVehicleManager();

const car = await manager.connect({
  id: "car-a",
  transport: new MockTransport(),
  profiles: [profile],
});

manager.get("car-a");
manager.list();
await manager.disconnect("car-a");
await manager.disconnectAll();
```

Calling `connect()` loads profile-declared DBC files, creates isolated
controllers and state, connects the transport, and wires incoming transport
frames into subscription decoding.

## Subscriptions

Frame subscriptions are requested by signal name, and the underlying transport
subscription is tracked per CAN frame. Firmware owns the streaming cadence, so
`subscribe()` returns `true` once the firmware monitor list has accepted the
request. Frame subscriptions stay open until `unsubscribe()` is called.
If `TURN_SIGNAL_LEFT` and `HIGH_BEAMS` are encoded in the same CAN ID, the
vehicle keeps one frame subscription and modifies it as signal names are added
or removed. Diagnostic query polling is intentionally a separate API.

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

Query polling subscriptions use `subscribeQuery()`, which returns a handle that
can be passed to `unsubscribeQuery()` later:

```ts
const speedSubscription = await car.subscribeQuery("VEHICLE_SPEED", {
  frequencyHz: 2,
});

car.unsubscribeQuery(speedSubscription);
```

## Queries

Use `query()` for names declared under profile `queries`:

```ts
const speed = await car.query<number>("SPEED");
```

The YAML profile describes the endpoint, request bytes, accepted response IDs,
expected response prefix, and decoder. The transport receives a raw request
frame through `sendRequest()` with `expectCanResponse: true`. The response is
validated against `expect` and decoded by the referenced DBC signal or built-in
decoder.

Calling `query()` for a name not declared in the profile throws an unknown
signal error.

## Actions

Use `action()` for names declared under profile `actions`:

```ts
await car.action("flash_lights");
```

Actions can be request-only, verified request/response, or multi-step flows.
Legacy raw DBC-only vehicles can still use `action()` with action options to send
encoded frame signals.

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

- `sendRequest()` maps to the Request characteristic. Actions use
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

The test suite uses `MockTransport` to simulate PID responses, action sends,
subscription registration, and incoming CAN frames.

## Out of scope for v1

- Web Bluetooth or Node BLE transport.
- ISO-TP assembly/disassembly, which should remain firmware-side.
- React bindings. The core uses `valtio/vanilla`, so a React entry point can be
  added without changing the vehicle model.
