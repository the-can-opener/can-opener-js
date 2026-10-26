# can-opener-js Vehicle Profile and Library Specification

This document defines the concepts used by `can-opener-js`: vehicle
profiles, DBC files, capabilities, and the `VehicleTransport` boundary.

For Bluetooth packet format. See
[Can Opener SE BLE Protocol](./can-opener-se-ble-protocol.md) when implementing
a BLE transport for the Can Opener SE firmware.

## 1. Architecture

`can-opener-js` separates vehicle behavior into three layers:

1. DBC files define CAN messages and decode their physical signals.
2. YAML profiles define capabilities, requests, workflows, monitor sources,
   and references to DBC signals.
3. A `VehicleTransport` moves CAN requests and frames between the library and
   a device.

DBC files own bit layout, byte order, signedness, scaling, offsets, units,
ranges, and enum labels. Profiles own workflow and transport intent. A
transport owns the connection and device protocol.

The library does not ship a BLE transport. Applications provide a
`VehicleTransport`, such as the included SLCAN transport or a BLE transport
implemented for a particular adapter.

## 2. Basic library use

```ts
import { VirtualVehicleManager } from "can-opener-js";
import type { VehicleTransport } from "can-opener-js/transport";

const transport: VehicleTransport = createMyTransport();
const manager = new VirtualVehicleManager();

const vehicle = await manager.connect({
  id: "my-car",
  transport,
  profiles: profileSources,
});

await vehicle.subscribe("SPEED");
const speed = vehicle.state.get<number>("SPEED");
const rpm = await vehicle.query("RPM");
await vehicle.action("LOCK");
```

Each connected vehicle has isolated profiles, DBC mappings, subscriptions,
state, and transport.

## 3. Capability names

Profiles should use these common names when the capability has the stated
meaning. A profile may add vehicle-specific names for capabilities that are
not listed.

Common actions:

- `UNLOCK`
- `LOCK`
- `LEFT_SIGNAL`
- `RIGHT_SIGNAL`
- `OPEN_TRUNK`
- `CLOSE_TRUNK`
- `HORN`
- `ECU_WAKE`

Common monitored signals:

- `SPEED`
- `RPM`
- `LEFT_SIGNAL`
- `RIGHT_SIGNAL`
- `BRAKE_LIGHTS`
- `FUEL_LEVEL`
- `TPS`
- `STEERING_ANGLE`
- `LOW_BEAMS`
- `HIGH_BEAMS`
- `FRONT_LEFT_DOOR_OPEN`
- `FRONT_RIGHT_DOOR_OPEN`
- `REAR_LEFT_DOOR_OPEN`
- `REAR_RIGHT_DOOR_OPEN`

Common query names:

- `RPM`
- `SPEED`
- `ECT`
- `IAT`
- `MAP`
- `MAF`
- `TPS`
- `STFT_B1`
- `LTFT_B1`
- `STFT_B2`
- `LTFT_B2`
- `FUEL_PRESSURE`
- `TIMING_ADVANCE`
- `ENGINE_LOAD`
- `RUNTIME`
- `FUEL_LEVEL`
- `DIST_SINCE_CLEAR`
- `BARO`
- `LAMBDA`
- `O2_DATA`
- `MODULE_VOLTAGE`
- `OIL_TEMP`
- `DRIVER_TORQUE_DEMAND`
- `ACTUAL_TORQUE`
- `FUEL_RATE`
- `ODOMETER`
- `VIN`
- `MIL_STATUS`
- `READINESS_STATUS`

Recommended portable values:

- Numeric signals use the physical value and unit defined by the DBC.
- Light and indicator state uses `"off"` or `"on"`.
- Door state uses `"closed"` or `"open"`.
- DBC enum labels are returned when a `VAL_` entry matches.
- `normalize.enum` may translate vehicle-specific labels into portable labels.

## 4. Profile source

A `VehicleProfileSource` contains:

- `name`: a diagnostic name for errors.
- `content`: the YAML profile text.
- `dbcFiles`: the DBC files available to that profile.

The library receives already selected profile sources. It does not currently
select files by `applies_to`, inspect a VIN, scan a directory, or load DBC
paths from disk. Catalog tooling may use `applies_to` and `dbc.files` as
metadata before constructing `VehicleProfileSource` objects.

`VirtualVehicle.reloadProfiles(sources)` replaces the loaded capability set.
It does not restart active monitors. Callers should subscribe again after a
reload.

## 5. YAML root

Only `version` is required by the parser.

```yaml
version: 1

applies_to: {}

can:
  buses: {}

dbc:
  files: []

endpoints: {}
sequences: {}
signals: {}
queries: {}
actions: {}
```

The current library accepts only `version: 1`.

### 5.1 Applicability metadata

Catalogs may describe compatible vehicles with:

```yaml
applies_to:
  manufacturers: [Nissan]
  models: [Sentra, Versa]
  years:
    - 2011
    - range: [2012, 2015]
  trims: [S, SV]
  engines: [2.0L]
  markets: [NA]
```

Missing fields act as wildcards in catalog tooling. This metadata is not
evaluated by the current `ProfileLoader`.

### 5.2 DBC metadata

Profiles may list DBC paths for a catalog or bundler:

```yaml
dbc:
  files:
    - path: signals.dbc
```

The current library parses the `dbcFiles` supplied in
`VehicleProfileSource`. It does not read the paths in this YAML block.

## 6. DBC requirements

A DBC message provides:

- CAN ID
- payload length
- signal bit positions
- byte order
- signedness
- scaling and offset
- physical units
- optional enum labels

Example:

```dbc
BO_ 2024 OBD_Response_7E8: 8 ECU
 SG_ RESPONSE_SERVICE : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ PID M : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ SPEED m13 : 16|8@1+ (1,0) [0|255] "km/h" Vector__XXX

VAL_ 2024 SPEED 0 "stopped";
```

Profiles reference DBC message and signal names. Profiles should not duplicate
DBC bit math.

For passive monitoring, the DBC message ID determines which CAN ID is
subscribed. For a query, the selected DBC signal decodes the returned
application payload.

## 7. Logical CAN buses

Endpoints and monitor signals may select a logical bus. Omitted values mean
bus `0`.

```yaml
can:
  buses:
    0:
      bitrate: 500000
    1:
      bitrate: auto
      data_bitrate: 2000000

endpoints:
  engine:
    bus: 0
    request_id: 0x7E0
    response_id: 0x7E8

  body:
    bus: 1
    request_id: 0x745
    response_id: 0x765
```

`bitrate` is the nominal or arbitration bitrate. `auto` asks the transport to
detect it. `data_bitrate` is an optional CAN FD data-phase rate. A bus that no
profile configures stays on the adapter's default timing, 500 kbit/s on Can
Opener SE.

The library applies bus timing when the vehicle connects. After
`reloadProfiles()`, call `configureBuses()` to apply timing the new profiles
declare. A bus whose requested timing has not changed is not sent again, so a
reload does not repeat an auto-detect. `busTiming()` returns what the adapter
reported for each configured bus: the requested timing, the status, and the
`bitrate` and `dataBitrate` in use.

A failed `auto` detection, for example with the ignition off, does not fail
the connection. The adapter keeps its previous timing, and `busTiming()`
reports `auto_detect_failed` with that timing. Any other configuration error
fails the connection.

Auto-detect searches only the nominal bitrate. The reported `dataBitrate` is
the profile's `data_bitrate`, not a detected value. Declare `data_bitrate` with
`bitrate: auto` on a bus that carries CAN FD frames with bit-rate switching, so
those frames decode while the adapter listens.

Bus timing does not change frame format. A request is sent as CAN FD only when
its endpoint declares `can_fd` (section 8.1). A 500 kbit/s bus with a
`data_bitrate` still carries classic requests unchanged.

If several loaded profiles configure the same bus, their timing values must
match.

The profile layer accepts bus numbers from `0` through `255`. A transport may
support fewer buses. Can Opener SE currently supports buses `0` and `1`.

## 8. Endpoints

An endpoint defines a reusable request target and accepted response IDs.

```yaml
endpoints:
  obd:
    bus: 0
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]
    timeout_ms: 500

  body:
    bus: 1
    request_id: 0x745
    response_id: 0x765
    timeout_ms: 500
```

Supported fields:

- `request_id`: transmit CAN ID.
- `response_id`: one accepted response CAN ID.
- `response_ids`: accepted response IDs or inclusive ranges.
- `bus`: logical bus, default `0`.
- `extended`: whether IDs are extended 29-bit IDs.
- `timeout_ms`: response timeout.
- `can_fd`: send this endpoint's requests as CAN FD. See section 8.1.

The library currently reduces multiple response ranges to their lowest start
and highest end when constructing a transport request. Do not use disjoint
ranges if IDs between them must be rejected.

### 8.1 CAN FD endpoints

Timing belongs to the bus. The frame size belongs to the diagnostic endpoint:

```yaml
can:
  buses:
    0:
      bitrate: 500000
      data_bitrate: 2000000

endpoints:
  obd:
    bus: 0
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]
    can_fd:
      tx_dl: 64
```

`can_fd.tx_dl` is the ISO-TP frame size and must be `8` or `64`:

- `8` sends the profile's 8 `send` bytes unchanged as one CAN FD frame. The
  classic single-frame PCI stays: `02 01 0D` is sent as
  `02 01 0D 00 00 00 00 00`.
- `64` sends the same application payload with the ISO 15765-2:2016 escape
  form, padded to 64 bytes: `00 02 01 0D` followed by 60 bytes of `00`.

Flow control for a multi-frame reply uses the same frame size as the request.
Replies are reassembled by their frame length, so a CAN FD reply of 8 bytes or
less uses the classic PCI and a longer one uses the 2016 PCI. The transport
returns the application payload either way, so `expect` and decoders do not
change.

Profile `send` bytes stay one classic ISO-TP single frame, with the PCI byte
first. The library removes that PCI for `tx_dl` 64, so the same `send` and
`expect` work on both classic and CAN FD endpoints. A request whose first byte
is not a single-frame PCI cannot use a CAN FD endpoint.

The bit-rate switch bit is set only when the bus `data_bitrate` is set and
differs from `bitrate`. Without a `data_bitrate`, a CAN FD endpoint still sends
FD-format frames at the nominal rate. An ECU that expects bit-rate switch may
not decode them, and the adapter will not decode a reply sent at a data rate it
was not configured for. Declare the bus timing whenever an endpoint uses
`can_fd`.

Inline `{ request_id, request }` actions and monitored signals are always
classic. Monitor frames carry at most 8 data bytes. A 64-byte frame on the live
stream shows its first 8.

The adapter's transceiver must be CAN FD capable. A classic transceiver faults
the bus during the data phase. The Can Opener SE uses TCAN3414 transceivers,
which support CAN FD.

## 9. Request bytes and ISO-TP

In profile version 1, `send` contains the bytes of one classic CAN frame. It
is not automatically an ISO-TP application payload. The library copies at
most eight bytes into `VehicleRequest.txFrame`.

For diagnostics over classic CAN, include the ISO-TP Protocol Control
Information byte and any desired padding in the profile.

Correct OBD-II example:

```yaml
queries:
  SPEED:
    endpoint: obd
    send: [0x02, 0x01, 0x0D, 0x00, 0x00, 0x00, 0x00, 0x00]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: OBD_Response_7E8
      signal: SPEED
```

Here `0x02` is the ISO-TP single-frame length. The transport returns the
reassembled application payload without ISO-TP PCI bytes, so `expect` begins
with `0x41`, not the response frame's PCI byte.

Request payloads longer than one classic single frame (7 application bytes)
are not expressible through the current profile and `VehicleRequest` API,
including on CAN FD endpoints. Responses of any length up to the transport
limit are reassembled.

### 9.1 Probing CAN FD vehicles

Some vehicles answer diagnostics only over CAN FD, for example GM Global B
trucks such as the Sierra and Yukon. A scan tool can try classic first and fall
back to CAN FD:

1. Send the classic 11-bit probe, then the classic 29-bit probe.
2. If both time out, configure bus 0 with `bitrate: 500000` and
   `data_bitrate: 2000000`.
3. Repeat both probes as CAN FD with `tx_dl: 8`, then with `tx_dl: 64`.
4. Record the `tx_dl` that answered in the vehicle's profile.

Some gateways accept an 8-byte FD frame. Others require 64. Confirm the result
on a real vehicle before fixing a profile at `tx_dl: 64`.

## 10. Response matching

An `expect` array is a prefix match:

```yaml
expect: [0x41, 0x0D]
```

Use `"*"` for one wildcard byte:

```yaml
expect: [0x70, 0x30, "*"]
```

Use exact matching when trailing bytes must be rejected:

```yaml
expect:
  pattern: [0x70, 0x30, 0x01]
  exact: true
```

For compatibility with transports that return one leading framing byte,
non-exact matching checks offsets `0` and `1`. New transports should return
the application payload with device and ISO-TP framing removed.

## 11. Sequences and steps

Sequences provide reusable groups of steps:

```yaml
sequences:
  body_session_prep:
    endpoint: body
    steps:
      - send: [0x02, 0x10, 0x81, 0, 0, 0, 0, 0]
        expect: [0x50, 0x81]
      - send: [0x02, 0x10, 0xC0, 0, 0, 0, 0, 0]
        expect: [0x50, 0xC0]
        delay_ms: 20
```

A step may reference another sequence:

```yaml
- ref: sequences.body_session_prep
```

Rules:

- References expand in place.
- Sequences may be nested.
- Circular and unknown references are errors.
- A sequence endpoint overrides the inherited action endpoint.
- `timeout_ms` applies to a response step.
- `delay_ms` is the gap after the step and defaults to 20 ms.
- Omitting `expect` creates a request-only step.

## 12. Signals

Passive signals map state names to monitored DBC signals:

```yaml
signals:
  DOOR_OPEN:
    monitor:
      bus: 1
      message: BODY_STATUS
      signal: DRIVER_DOOR_OPEN
    normalize:
      enum:
        inactive: closed
        active: open
```

The library resolves the DBC message ID, asks the transport to monitor that
ID, decodes received frames, and updates vehicle state.

Subscriptions are keyed by bus and CAN ID, so the same CAN ID may be used on
both buses.

Batch `subscribe([...])` skips names that cannot be resolved against the
loaded DBC files.

## 13. Queries

Queries perform request and response transactions.

DBC-backed query:

```yaml
queries:
  RPM:
    endpoint: obd
    send: [0x02, 0x01, 0x0C, 0, 0, 0, 0, 0]
    expect: [0x41, 0x0C]
    dbc_mapping:
      message: OBD_Response_7E8
      signal: RPM
```

Built-in decoder:

```yaml
queries:
  VIN:
    endpoint: obd
    send: [0x02, 0x09, 0x02, 0, 0, 0, 0, 0]
    expect: [0x49, 0x02]
    decoder:
      type: ascii
      length: 17
```

Supported built-in decoder types are `ascii` and `bytes`. They consume the
payload after a non-exact `expect` prefix is removed. ASCII decoding trims
trailing null bytes.

## 14. Actions

An endpoint-backed action may wait for and validate a response:

```yaml
actions:
  LOCK:
    endpoint: body
    send: [0x04, 0x30, 0x38, 0x00, 0x01, 0, 0, 0]
    expect: [0x70, 0x38, 0x01]
```

An inline request is always request-only:

```yaml
actions:
  LEFT_SIGNAL:
    send:
      bus: 1
      request_id: 0x123
      request: [0x01, 0x00, 0x00, 0x00]
```

A multi-step action can reuse a sequence:

```yaml
actions:
  HORN:
    endpoint: body
    steps:
      - ref: sequences.body_session_prep
      - send: [0x04, 0x30, 0x30, 0x00, 0x01, 0, 0, 0]
        expect: [0x70, 0x30, 0x01]
```

When the transport implements `sendRequestBatch`, the library groups
consecutive same-bus steps into batches. The transport may split a group to
meet device limits.

Device batches report transport outcomes, not application-level `expect`
matches. Later steps may already have run before the library discovers that
an earlier payload did not match. Use `batch: false` when each response must
gate the next transmission.

`ECU_WAKE` is a reserved recovery action. When another action gets no ECU
response, the library runs `ECU_WAKE` and retries the original action once.
It does not retry an unexpected response payload.

## 15. VehicleTransport contract

A transport must implement:

- `connect()`
- `disconnect()`
- `sendRequest(req)`
- `updateMonitor(req)`
- `onMonitorSnapshot(callback)`

Optional capabilities:

- `configureBus(req)`
- `sendRequestBatch(req)`

A request built from a CAN FD endpoint carries `VehicleRequest.canFd`:

- `txDl`: `8` or `64`, copied from `can_fd.tx_dl`.
- `payload`: the application payload of `txFrame`, without its PCI byte.

`txFrame` is still the 8-byte classic single frame, so a transport can send it
as-is for `txDl` 8. A transport that cannot send CAN FD must reject a request
with `canFd`, as `SlcanTransport` does unless it is created with `canFd: true`
for CANable 2 firmware. It must not fall back to classic CAN silently. A request
without `canFd` must be sent as classic CAN.

`sendRequestBatch` steps may carry `canFd`. A transport whose device batches
only 8-byte frames sends a `txDl` 64 step outside the batch or splits the batch
around it.

Transport responsibilities:

- Preserve logical bus identity.
- Serialize or correlate requests as required by the device protocol.
- Return reassembled application payloads without device framing.
- Report a response timeout distinctly from malformed data and link failure.
- Convert monitor notifications into `CanFrame` values.
- Stop callbacks and reject pending work when disconnected.

Library responsibilities:

- Resolve profile capabilities.
- Build `VehicleRequest` values.
- Match expected response payloads.
- Decode DBC signals.
- Normalize values.
- Maintain vehicle state.
- Retry an action through `ECU_WAKE` when appropriate.

## 16. Complete small profile

```yaml
version: 1

can:
  buses:
    0:
      bitrate: 500000

endpoints:
  obd:
    bus: 0
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

signals:
  ENGINE_RPM:
    monitor:
      bus: 0
      message: ENGINE_STATUS
      signal: ENGINE_RPM
```

This profile still requires its referenced DBC files and a
`VehicleTransport`. For Can Opener SE, implement the transport according to
the separate BLE protocol specification.
