# can-opener-js

React-style vehicle state management for cars. `can-opener-js` gives TypeScript apps a
virtual vehicle object that monitors the state of a car through named signals and
uses named actions to control that state. It abstracts DBC files, CAN IDs, byte order,
scaling, masks, and bit-level signal packing behind named vehicle state.

Under the hood, it is a signal-first library for modeling virtual vehicles on
top of a interpreter layer. Can Opener interfaces with the OBD device.
Each connected vehicle owns its own vehicle profile, transport, controllers, APIs, and state, so multi-vehicle
apps do not need globals or shared registries. That makes vehicle scripts
portable: the same code can run across different cars by swapping the profile,
DBC files, and transport.

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
const bodySubscribed = await car.subscribe(["TURN_SIGNAL_LEFT", "Vehicle.Body.Lights.Beam.High.IsOn"]); // true
const activeSubscriptions = car.subscriptionCount();

const speed = await car.query("VEHICLE_SPEED");
const rpm = car.state.engine_rpm;
const alsoRpm = car.state.get<number>("ENGINE_RPM");

await car.set("Vehicle.Body.Horn.IsActive", true);

await car.unsubscribe("ENGINE_RPM");
await car.unsubscribe(["TURN_SIGNAL_LEFT", "Vehicle.Body.Lights.Beam.High.IsOn"]);
```

## Profile formats

Format 2 of the Vehicle Profile Standard is the default. The canonical
specification, the VSS catalog, the keyword vocabulary, and example packages
live in [the-can-opener/vehicle-profile-spec](https://github.com/the-can-opener/vehicle-profile-spec).

A format 2 package is a manifest (`manifest: 1`, `format: 2`) with the
documents and DBC files it lists. Pass the manifest as `content` and each
listed document under `documents`, named by the path the manifest gives it:

```ts
const car = await vv.connect({
  id: "versa",
  transport,
  profiles: [{
    name: "org.canopener.nissan.versa",
    content: manifestYaml,
    documents: [
      { name: "base.yaml", content: baseYaml },
      { name: "body.yaml", content: bodyYaml },
    ],
    dbcFiles: [{ name: "signals.dbc", content: signalsDbc }],
  }],
});
```

A loaded vehicle exposes properties keyed by VSS path, plus named queries and
named actions for what has no VSS path. The VSS methods take VSS paths only:

```ts
await car.subscribe("Vehicle.Speed");
car.state.get<number>("Vehicle.Speed");

await car.read<number>("Vehicle.Speed");                    // asks the ECU when the property has a query
await car.set("Vehicle.Cabin.IsCentralLockEngaged", true);  // "acknowledged" | "sent" | "rejected" | "unknown"
await car.invoke("SIGNAL_OFF");                             // named action
await car.query("SUPPORTED_PIDS_01_20");                    // named query
```

A write never changes `car.state`; only an observation of the property does.
Setting a target the package has no request for throws and sends nothing.

The alias methods take legacy keywords only, never a VSS path. A property
alias names a path (`SPEED`, `LOCKED`). A command alias names one write target
(`LOCK` writes `true`, `UNLOCK` writes `false`, `HORN` writes `true`) or a
named action (`SIGNAL_OFF`):

```ts
await car.alias.read("SPEED");
await car.alias.subscribe("SPEED");          // the value lands in state under "Vehicle.Speed"
await car.alias.set("DRIVER_TEMP_SETTING", 22);
await car.alias.command("LOCK");             // same request as set("Vehicle.Cabin.IsCentralLockEngaged", true)
car.alias.list();                            // every alias the loaded profiles answer to
```

Passing `SPEED` or `LOCK` to a VSS method throws, and so does passing a VSS
path or a command alias to `alias.read`, `alias.subscribe`, or `alias.set`.

`allowedKeys` on a profile source limits what loads from it: `signals` and
`queries` list the property paths (and named queries) to keep, `actions` lists
the writable paths and named actions. A write case name such as
`Vehicle.Cabin.IsCentralLockEngaged=true` in `actions` keeps that one case of
the property. An omitted list keeps everything of that kind.

Format 1 (`version: 1` and `version: 1.1`) is legacy and still loads. The
loader maps its keywords onto VSS paths with the spec vocabulary: a `SPEED`
query becomes the query of `Vehicle.Speed`, `DOORS.lock` becomes the `true`
target of `Vehicle.Cabin.IsCentralLockEngaged`. A keyword the vocabulary gives
no path keeps its original name, so `ENGINE_RPM` and `VEHICLE_SPEED` in the
examples below still work as written. The rest of this README describes format
1 profiles.

Not supported yet in format 2: a `repeat` write and a request longer than one
ISO-TP frame load as unavailable and throw with the reason when used. A
package whose `depends` id is not loaded before it is skipped with a warning.

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
actions, monitor subscriptions, applicability, and DBC mapping references. The
library does not ship a built-in catalog of PIDs, actions, request bytes, or
DBC mappings; loaded YAML+DBC files are the source of truth.

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
    send: [0x02, 0x01, 0x0D, 0, 0, 0, 0, 0]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: OBD_Response_7E8
      signal: SPEED
```

```dbc
BO_ 2024 OBD_Response_7E8: 8 ECU
 SG_ RESPONSE_SERVICE : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ PID M : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ SPEED m13 : 16|8@1+ (1,0) [0|255] "km/h" Vector__XXX
```

Raw DBC-only loading is still supported for simple frame subscriptions and
legacy tests. In profile-backed vehicles, executable names come from YAML
`queries`, `actions`, and `signals` declarations.

See the [Vehicle Profile and Library Specification](docs/vehicle-profile-spec.md)
for legacy format 1 YAML profiles, DBC files, capabilities, and the library contract, and
[Vehicle Keywords](docs/vehicle-keywords.md) for the common capability names
profiles should use. See the
[BLE Transport Protocol](docs/can-opener-se-ble-protocol.md) and
[Security Protocol](docs/can-opener-se-security-protocol.md) when implementing
an app for current Can Opener SE firmware.

DBC `VAL_` entries expose enum-like signal values as labels by default. Numeric
signals without matching `VAL_` entries return their DBC-scaled physical values:

```dbc
BO_ 100 DRIVE_STATUS: 8 BCM
 SG_ DRIVE_MODE : 0|2@1+ (1,0) [0|3] "" Vector__XXX

VAL_ 100 DRIVE_MODE 0 "park" 1 "reverse" 2 "drive" 3 "low";
```

`DRIVE_MODE` remains the physical DBC signal, and subscribing to it updates
state to labels like `"park"` or `"drive"`. Profile `normalize` blocks can
remap car-specific DBC labels when a portable script needs a canonical
vocabulary.

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
const subscribed = await car.subscribe(["TURN_SIGNAL_LEFT", "Vehicle.Body.Lights.Beam.High.IsOn"]); // true
const activeCount = car.subscriptionCount(); // 2

await car.unsubscribe(["TURN_SIGNAL_LEFT", "Vehicle.Body.Lights.Beam.High.IsOn"]);
```

Profile-backed subscriptions use names declared under YAML `signals`. Without
profile normalization, incoming values are the DBC-decoded values: enum labels
from `VAL_` when present, otherwise scaled physical numbers. A profile can add
`normalize.enum` to remap enum labels before values are written to `car.state`.

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

Use `read()` for a property with a query binding, and `query()` for a named
query, which is a name declared under profile `queries` that has no VSS path:

```ts
const speed = await car.read<number>("Vehicle.Speed");
const sameSpeed = await car.alias.read<number>("SPEED");
const supported = await car.query("SUPPORTED_PIDS_01_20");
```

The YAML profile describes the endpoint, request bytes, accepted response IDs,
expected response prefix, and either a `dbc_mapping` or built-in `decoder`. The
transport receives a raw request frame through `sendRequest()` with
`expectCanResponse: true`. The response is validated against `expect` and
decoded by the referenced DBC signal or built-in decoder.

Calling `query()` for a name not declared in the profile throws an unknown
signal error.

## Actions

Use `set()` to write a property and `invoke()` for a named action, which is a
name declared under profile `actions` that has no single VSS actuator:

```ts
await car.set("Vehicle.Body.Horn.IsActive", true);
await car.invoke("FLASH_LIGHTS");
```

Actions can be request-only, verified request/response, or multi-step flows.
Raw DBC-only vehicles, with no profile loaded, can still use `action()` with
action options to send encoded frame signals.

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

State keys are stored by the subscribed name. In profile-backed vehicles, that
is the VSS path, or the YAML `signals` or `queries` key for a format 1 keyword
outside the vocabulary. Property access also accepts common
camelCase or snake_case variants by converting them to upper snake case.

## Transport

The core transport is intentionally dumb:

- it connects and disconnects;
- it sends raw CAN requests through one request path;
- it configures the firmware monitor list for subscriptions;
- it receives monitor snapshots containing the latest raw CAN frames;
- it does not parse DBC, ISO-TP, UDS, or app-level signal names.

`MockTransport` ships with the library for tests and local simulations.
`SlcanTransport` speaks Lawicel SLCAN over a byte port, including ISO-TP
reassembly for `sendRequest()`. A browser opens that port with Web Serial:

```ts
import { SlcanTransport, openWebSerialSlcanPort, requestWebSerialPort } from "can-opener-js/transport";

const port = await requestWebSerialPort();
const transport = new SlcanTransport(await openWebSerialSlcanPort(port), { bitrate: 500_000 });
```

Pass `canFd: true` when the adapter runs CANable 2 firmware. The transport then
sends CAN FD requests with that firmware's `d`/`b` commands, accepts
`dataBitrate` 2 or 5 Mbit/s in `configureBus` (`Y2`/`Y5`, which turns on bit
rate switching), and parses received CAN FD frames. Without it, CAN FD requests
are rejected, because CANable 1 firmware ignores those commands silently.

`examples/slcan-web` is a small page that connects a CANable and runs the Nissan
Versa profile through this transport. `npm run dev:slcan` starts it.

### Can Opener SE over BLE

`CanOpenerBleTransport` (`can-opener-js/ble`) speaks the
[BLE Transport Protocol](docs/can-opener-se-ble-protocol.md): requests,
CAN FD payloads, batches, monitoring, and bus timing. It does not depend on a
BLE stack. The app connects the adapter, discovers services, and passes the
transport a `CanOpenerGattLink`. `can-opener-js/react-native-ble` provides one
for react-native-ble-plx:

```ts
import { Platform } from "react-native";
import { BleManager } from "react-native-ble-plx";
import { CanOpenerBleTransport } from "can-opener-js/ble";
import { bleplxGattLink, bleplxSecurityWritePolicy } from "can-opener-js/react-native-ble";
import { credentialAuthorizer } from "can-opener-js/security";

const ble = new BleManager();
const device = await ble.connectToDevice(deviceId, { requestMTU: 247 });
await device.discoverAllServicesAndCharacteristics();

const transport = new CanOpenerBleTransport(bleplxGattLink(ble, device.id), {
  authorize: credentialAuthorizer(credentialStore),
  securityWritePolicy: bleplxSecurityWritePolicy(Platform.OS === "android" ? "android" : "ios"),
  subscribeSettleMs: Platform.OS === "android" ? 80 : 0,
});
```

The adapter rejects vehicle notifications until the phone proves a key on the
security characteristic, so `authorize` runs inside `connect()` before they are
enabled. `credentialStore` is the app's `CredentialStore`: it lists the keys
saved for adapters and saves what authentication reports, such as a redeemed
guest invite. `can-opener-js/security` also covers claiming an adapter
(`withSecuritySession(link, (session) => session.claim(seed))`), backup codes,
invite links, and guest management through `transport.accessSession`.

The firmware matches replies by sequence byte only. When another client shares
the link, such as an iOS Siri extension using `0x80`-`0xFF`, give each one a
disjoint `sequenceRange`; the default is `0x00`-`0x7F`.

Other transports implement `VehicleTransport` the same way. `CanOpenerBleTransport`
maps its methods onto the firmware characteristics:

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
subscription registration, and incoming CAN frames. The example packages of
the vehicle-profile-spec repository are copied under `tests/fixtures/spec` and
their fixture files run as tests.

The keyword vocabulary and the VSS leaf map under `src/profile/loaders` are
generated from a checkout of the spec repository:

```sh
node scripts/generate-vss-leaves.mjs ../vehicle-profile-spec
```

## Out of scope for v1

- BLE link adapters other than react-native-ble-plx. Web Bluetooth or Node BLE
  only need a `CanOpenerGattLink`; `CanOpenerBleTransport` stays the same.
- ISO-TP assembly/disassembly, which should remain firmware-side.
- React bindings. The core uses `valtio/vanilla`, so a React entry point can be
  added without changing the vehicle model.
