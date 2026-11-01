# can-opener-js Vehicle Profile and Library Specification

Profile spec version 1.1. See the [changelog](#changelog) at the end.

This document defines the concepts used by `can-opener-js`: vehicle
profiles, DBC files, capabilities, and the `VehicleTransport` boundary. The
common capability names are listed in [Vehicle Keywords](./vehicle-keywords.md).

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

await vehicle.subscribe(["SPEED", "TRUNK"]);
const speed = vehicle.state.get<number>("SPEED");
const rpm = await vehicle.query("RPM");
await vehicle.action("HORN");                        // trigger
await vehicle.action("DOORS", { value: "lock" });    // present-tense command
vehicle.state.get<string>("DOORS");                  // "locked" | "unlocked"
vehicle.state.get<string>("TRUNK");                  // "open" | "closed"
```

Each connected vehicle has isolated profiles, DBC mappings, subscriptions,
state, and transport.

## 3. Capability names

Profiles should use the common names below when a capability has the stated
meaning, so that an application written against one profile works with the
next. A profile may add vehicle-specific names for anything not listed.

### 3.1 Naming convention

The convention follows the model of COVESA VSS, the vocabulary behind the W3C
VISS protocol, written in the flat `SCREAMING_SNAKE` form that DBC files and
profiles already use.

- A name identifies a thing on the vehicle, an *entity*: `TRUNK`,
  `FRONT_LEFT_DOOR`, `LOW_BEAMS`. It is never a predicate or a verb, so not
  `TRUNK_OPEN`, `OPEN_TRUNK`, or `IS_TRUNK_OPEN`.
- One keyword covers every way a profile touches the entity. The same
  `LEFT_SIGNAL` may be declared under `signals` (the indicator state the body
  module broadcasts), `queries`, and `actions` (driving the indicator), and a
  profile declares whichever its vehicle supports. Reported values and action
  commands use the vocabularies in section 3.2. After `subscribe("TRUNK")`,
  `state.get("TRUNK")` is `"open"` or `"closed"`;
  `action("TRUNK", { value: "close" })` is the command that produces `"closed"`.
- Position prefixes are `FRONT_`/`REAR_` and `LEFT_`/`RIGHT_`, as seen from
  the driver's seat facing forward. They are physical sides, not
  driver/passenger, because DBC signals are physical. Place them before the
  entity: `FRONT_LEFT_DOOR`, `REAR_RIGHT_WINDOW`.
- An action takes one of two forms. With `values` it runs one present-tense
  command per value, such as `lock` or `close` (section 14). Without
  `values` it is a *trigger*, a momentary routine such as `HORN` with nothing
  to set back. A trigger that shares an entity's name pulses that entity:
  `LEFT_SIGNAL` as a trigger flashes the indicator once. A profile for a
  vehicle whose body module latches the indicator declares
  `LEFT_SIGNAL: { values: { on, off } }` instead.
- After a value action reaches the bus, the library records the resulting
  condition in state under the entity name: `lock` records `locked`, and
  `close` records `closed`. A command that already names the condition, such
  as `open` or `on`, is recorded unchanged. A monitor or query for the same
  entity then overwrites it with what the vehicle reports.

A rough VSS correspondence, for readers who know that vocabulary:

- `FRONT_LEFT_DOOR` = `Vehicle.Cabin.Door.Row1.DriverSide.IsOpen` (LHD)
- `DOORS` = `Vehicle.Cabin.Door.*.IsLocked`, central locking
- `TRUNK` = `Vehicle.Body.Trunk.Rear.IsOpen`
- `SUNROOF` = `Vehicle.Cabin.Sunroof.Switch` / `Position`
- `LOW_BEAMS` = `Vehicle.Body.Lights.Beam.Low.IsOn`
- `LEFT_SIGNAL` = `Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling`
- `HORN` = `Vehicle.Body.Horn.IsActive`

### 3.2 Value vocabularies

- Numeric entities use the physical value and unit defined by the DBC.
- Apertures (doors, trunk, hood, sunroof, windows, fuel door, charge port)
  report `open` or `closed`. Their actions are `open` and `close`. An
  aperture with a known travel also has a numeric `<ENTITY>_POSITION` entity
  in percent, `0` closed and `100` fully open.
- Switchable things (lights, climate, defrost, seat heaters, cruise control,
  engine, charging) report and accept `on` or `off`. Multi-level entities
  (wipers, seat heaters) list their own levels in the keyword registry; those
  level names are both the reported value and the action command.
- Locks report `locked` or `unlocked`. Their actions are `lock` and `unlock`.
- Belts report `fastened` or `unfastened`. Mirrors report `folded` or
  `unfolded`; their actions are `fold` and `unfold`.
- DBC enum labels are returned when a `VAL_` entry matches, so a DBC that
  labels a bit `0 "closed" 1 "open"` needs no further mapping.
- `normalize.enum` translates vehicle-specific labels into the portable state
  words.

Reported values are lowercase conditions. Action commands are lowercase
present-tense verbs when that word differs from the condition: `close`, not
`closed`, and `lock`, not `locked`. `open`, `on`, `off`, and level names are
already the command, so the action uses the same word.

### 3.3 Common keywords

The registry of common keywords, with a description, kind, and value
vocabulary for each, is maintained separately in
[Vehicle Keywords](./vehicle-keywords.md). It also lists deprecated names from
earlier profiles and a mapping from WiCAN parameter names.

`ECU_WAKE` is the one reserved action: the library runs it to wake a sleeping
bus before retrying another action (section 14). Applications do not offer it
as a control.

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

Only `version` is required by the parser. It is the profile spec version the
profile is written against.

```yaml
version: 1.1

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

The current library accepts `version: 1` (spec 1.0) and `version: 1.1`. A
profile that uses 1.1 features, such as `values` on an action, should declare
`version: 1.1` so that a 1.0 loader rejects it instead of silently dropping
those actions. Minor versions are backward compatible: a 1.1 loader reads a
1.0 profile unchanged.

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

Bus fields:

- `bitrate`: nominal bitrate in bit/s, or `auto` to have the transport detect
  it. Every frame, classic or FD, is arbitrated and acknowledged at this rate.
- `data_bitrate`: CAN FD data-phase bitrate in bit/s. Only the data bytes of
  FD frames sent with bit-rate switching use it. Omitted: the nominal rate.
- `fd`: frames sent on this bus default to CAN FD. See section 8.1.

A CAN FD bus therefore has two rates. On a typical FD bus, `bitrate: 500000`
and `data_bitrate: 2000000` means each frame starts at 500 kbit/s so classic
and FD nodes can arbitrate together, then switches to 2 Mbit/s for its data.

`data_bitrate` is timing only; it does not make requests FD. Declare it on
every bus that carries FD frames with bit-rate switching, even if the profile
never sends FD. The Can Opener SE controller is always FD-capable, and without
the right data rate it cannot decode those frames and flags them with error
frames.

A bus that no profile configures stays on the adapter's default timing. On
Can Opener SE that is 500 kbit/s on bus 0 and 125 kbit/s on bus 1, with no data
rate.

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
those frames decode while the adapter listens. On a silent bus, Can Opener SE
listens for up to about 2.5 s before it reports `auto_detect_failed`, so a
transport must wait at least that long for the reply.

If several loaded profiles configure the same bus, all of its fields must
match. A bus may be declared by one profile and used by another: a shared
profile can define endpoints without `can`, and a vehicle-specific profile
loaded with it can declare the buses.

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
- `fd`: frame format for this endpoint's requests, overriding the bus default.
  See section 8.1.
- `addressing`: ISO-TP extended or mixed addressing. Omitted means normal
  addressing. See section 8.2.

The library currently reduces multiple response ranges to their lowest start
and highest end when constructing a transport request. Do not use disjoint
ranges if IDs between them must be rejected.

### 8.1 CAN FD

Received frames describe themselves: an FD-capable adapter receives classic
and FD frames on the same bus, so nothing needs declaring to listen beyond
the bus timing in section 7. Only frames the library sends need a format, and
the bus sets the default once:

```yaml
can:
  buses:
    0:
      bitrate: 500000
      data_bitrate: 2000000
      fd:
        isotp:
          tx_dl: 64

endpoints:
  obd:                  # CAN FD, tx_dl 64 from the bus
    request_id: 0x7DF
    response_ids:
      - range: [0x7E8, 0x7EF]
  bcm:                  # CAN FD, but this ECU wants 8-byte ISO-TP frames
    request_id: 0x7A0
    response_id: 0x7A8
    fd: { tx_dl: 8 }
  legacy:               # a classic-only ECU on the same bus
    request_id: 0x7B0
    response_id: 0x7B8
    fd: false
```

Bus `fd` accepts `true`, `false`, or an object:

- `true` or `{}`: frames sent on this bus are CAN FD; ISO-TP endpoints use
  `tx_dl` 8.
- `isotp.tx_dl`: the ISO-TP frame size endpoints on this bus use, `8` or `64`.
- `false` or omitted: frames sent on this bus are classic.

Endpoint `fd` overrides the bus default with `true` (FD at the bus's
`isotp.tx_dl`), `{ tx_dl: 8 | 64 }`, or `false` (classic). Inline
`{ request_id, request }` actions take a boolean `fd` the same way (section
14). The library sends each request in the first format it finds:

1. the endpoint's or inline action's own `fd`;
2. the bus `fd`;
3. classic CAN.

Sending CAN FD on a bus that no loaded profile declares `fd` is a load error.
A classic node that sees an FD frame flags it with an error frame, so the
library never sends FD on a bus that has not been declared FD.

`tx_dl` is the ISO-TP frame size. It sets how a diagnostic request is packed
and the frame size of flow control for the reply:

- `8` sends the profile's 8 `send` bytes unchanged as one CAN FD frame. The
  classic single-frame PCI stays: `02 01 0D` is sent as
  `02 01 0D 00 00 00 00 00`.
- `64` sends the same application payload with the ISO 15765-2:2016 escape
  form, padded to 64 bytes: `00 02 01 0D` followed by 60 bytes of `00`.

ISO 15765-2 also allows 12 to 48. The library supports only 8 and 64.

Replies are reassembled by their frame length, so a CAN FD reply of 8 bytes or
less uses the classic PCI and a longer one uses the 2016 PCI. The transport
returns the application payload either way, so `expect` and decoders do not
change.

Profile `send` bytes stay one classic ISO-TP single frame, with the PCI byte
first. The library removes that PCI for `tx_dl` 64, so the same `send` and
`expect` work on classic and FD buses. A request whose first byte is not a
single-frame PCI cannot use `tx_dl` 64.

Inline actions are raw frames, not ISO-TP, so `tx_dl` does not apply. An FD
inline frame carries the action's bytes zero-padded to 8.

The bit-rate switch bit is set only when the bus `data_bitrate` is set and
differs from `bitrate`. Without a `data_bitrate`, FD frames are sent at the
nominal rate throughout. An ECU that expects bit-rate switching may not decode
them.

Monitored signals decode the first 8 data bytes of a frame, classic or FD. Can
Opener SE monitor records carry at most 8 data bytes and do not say whether a
frame was FD, so a signal past byte 8 of an FD message cannot be monitored.

The adapter's transceiver must be CAN FD capable. A classic transceiver faults
the bus during the data phase. The Can Opener SE uses TCAN3414 transceivers,
which support CAN FD.

### 8.2 ISO-TP addressing

ISO 15765-2 defines how an ISO-TP exchange names its two ends. With normal
addressing, the default, the CAN IDs alone do that and the PCI is the first
data byte. With extended and mixed addressing, every frame of the exchange,
single, first, consecutive and flow control, in both directions, carries one
address byte in front of the PCI. The two modes differ only in what that byte
holds:

- `extended`: frames sent to the ECU carry the ECU's address, `N_TA`; frames
  the ECU sends back carry the tester's address, `N_SA`.
- `mixed`: both directions carry the same address extension, `N_AE`.

BMW diagnostics use extended addressing: every ECU listens on `0x6F1`, the
tester is `0xF1`, and each ECU answers on `0x600` plus its own address. The
`F1 10 ...` first byte of a BMW reply is this address byte, not a separate
transport protocol.

```yaml
endpoints:
  dme:                  # BMW engine ECU, address 0x12
    request_id: 0x6F1
    response_id: 0x612
    addressing:
      mode: extended
      target_address: 0x12   # N_TA, first byte of every frame sent
      source_address: 0xF1   # N_SA, first byte of every frame received

  body:                 # mixed addressing, one extension both ways
    request_id: 0x7A0
    response_id: 0x7A8
    addressing:
      mode: mixed
      address_extension: 0xA5

queries:
  VIN:
    endpoint: dme
    send: [0x03, 0x22, 0xF1, 0x90]
    expect: [0x62, 0xF1, 0x90]
    decoder: ascii
    length: 17
```

Each mode accepts only its own fields; `target_address` and `source_address`
belong to `extended`, `address_extension` to `mixed`. Every address is one
byte.

`send` and `expect` do not change. `send` is still the ISO-TP frame with its
PCI first; the library inserts the transmit address in front of it, so the
`VIN` query above goes out as `6F1: 12 03 22 F1 90 00 00 00`. `expect` still
matches the application payload: the transport removes the address byte and
the PCI from each reply frame. Reply frames whose first byte is not the
expected receive address belong to another exchange and are ignored.

The address byte takes one data byte from every frame:

- a classic single frame carries 6 application bytes instead of 7, so `send`
  may hold at most 7 bytes after the address is added (trailing zero padding
  may be dropped);
- a first frame carries `tx_dl - 3` and a consecutive frame `tx_dl - 2`;
- a CAN FD `tx_dl` 64 single frame carries 61 bytes, laid out as
  `address 00 length payload`;
- flow control is `address 30 BS STmin`, padded to the frame size.

Flow control for an addressed exchange goes to the endpoint's `request_id`
with the transmit address first. The OBD-II convention of answering a standard
11-bit response ID at `response_id - 8` does not apply, because an addressed
ECU selects the exchange by the address byte, not by a private CAN ID.

Normal fixed addressing, the 29-bit `0x18DAttss` scheme of OBD-II and UDS on
CAN, needs no `addressing` field: it is normal addressing with the addresses
encoded in the CAN ID, so declare it with a 29-bit `request_id` and
`extended: true`.

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

Request payloads longer than one classic single frame (7 application bytes,
or 6 on an endpoint with ISO-TP extended or mixed addressing) are not
expressible through the current profile and `VehicleRequest` API, including
on CAN FD endpoints. Responses of any length up to the transport limit are
reassembled.

### 9.1 Probing CAN FD vehicles

Some vehicles answer diagnostics only over CAN FD, for example GM Global B
trucks such as the Sierra and Yukon. A scan tool can try classic first and fall
back to CAN FD. Classic probes are safe on any bus, because FD nodes accept
classic frames. FD probes are not: every classic node that sees one flags an
error frame, and Can Opener SE retransmits a failed frame up to 3 times, so
one FD probe on a classic bus can cause up to 4 error frames. A few error
frames do not take nodes off the bus, but they are visible disruption and may
set fault codes. Only escalate to FD when classic has positively failed:

1. Send the classic 11-bit probe, then the classic 29-bit probe.
2. Read how each probe failed:
   - Transmit failure (Can Opener SE `CAN_TX_FAIL`): no node acknowledged the
     frame. The bus is asleep or the bitrate is wrong. Wake the vehicle (the
     `ECU_WAKE` action, or ignition on), wait for traffic, and retry classic.
     Do not try FD.
   - Response timeout (`NoEcuResponseError`): nodes acknowledged the frame,
     but no ECU answered. FD may be needed.
3. Only after both classic probes timed out on an acknowledged bus, configure
   the bus with `data_bitrate: 2000000` and `fd: true`, then repeat the probes.
   If they time out, try `fd: { isotp: { tx_dl: 64 } }`.
4. Record the bus `fd` setting that answered in the vehicle's profile.

Some gateways accept an 8-byte FD frame. Others require 64. Confirm the result
on a real vehicle before fixing a profile at `tx_dl: 64`.

FD traffic observed while listening would be a safer signal than a failed
classic probe. Can Opener SE monitor records do not yet carry the FD flag, so
a scan tool cannot detect FD traffic that way today.

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
  FRONT_LEFT_DOOR:
    monitor:
      bus: 1
      message: BODY_STATUS
      signal: DRIVER_DOOR_OPEN
    normalize:
      enum:
        inactive: closed
        active: open
```

The signal name is the portable entity (section 3); `monitor.signal` is the
DBC's own name, which may be a predicate such as `DRIVER_DOOR_OPEN`. The
library resolves the DBC message ID, asks the transport to monitor that ID,
decodes received frames, and updates vehicle state under the entity name.

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

A trigger is an action named for what it does once. An endpoint-backed
trigger may wait for and validate a response:

```yaml
actions:
  HORN:
    endpoint: body
    send: [0x04, 0x30, 0x30, 0x00, 0x01, 0, 0, 0]
    expect: [0x70, 0x30, 0x01]
```

A stateful entity declares `values`, one request definition per present-tense
command. `endpoint` and `batch` on the entity are defaults for every command:

```yaml
actions:
  DOORS:
    endpoint: body
    values:
      lock:
        send: [0x04, 0x30, 0x38, 0x00, 0x01, 0, 0, 0]
        expect: [0x70, 0x38, 0x01]
      unlock:
        send: [0x04, 0x30, 0x38, 0x00, 0x02, 0, 0, 0]
        expect: [0x70, 0x38, 0x02]
  TRUNK:
    endpoint: body
    values:
      open:
        steps:
          - ref: sequences.body_session_prep
          - send: [0x04, 0x30, 0x40, 0x00, 0x01, 0, 0, 0]
            expect: [0x70, 0x40, "*"]
```

Each value loads as an action named `ENTITY.value`, so `DOORS.lock`,
`DOORS.unlock`, and `TRUNK.open`, with `entity` and `value` set on the
loaded `ProfileAction`. A profile may also write that flat form directly,
`DOORS.lock:`, which is equivalent. A name may contain at most one `.`, and
an entity with `values` cannot also declare its own `send`, `steps`, or
`expect`.

```ts
await vehicle.action("DOORS", { value: "lock" });  // runs DOORS.lock
await vehicle.action("DOORS.lock");                // the same action
vehicle.state.get("DOORS");                        // "locked"
```

`action(entity, { value })` resolves `entity.value` and rejects with
`Unknown vehicle action: DOORS.ajar` when the profile has no such value.
`CapabilityRegistry.actionValues("DOORS")` lists the commands a loaded profile
offers, such as `lock` and `unlock`. When the result is not `false`, that is,
the request was verified, request-only, or reached the bus with an unverified
retry, the library records the resulting condition in state under the entity
name (`lock` records `locked`, `close` records `closed`, `open` records
`open`). A monitor or query for the same entity overwrites it with the
reported value. A `false` result leaves state alone.

A numeric entity such as `CABIN_TEMP_SETPOINT` or `CHARGE_LIMIT` declares
`encode` instead of `values`. At runtime `action(entity, { value: 22 })`
validates `min` and `max` when present, encodes `round((value - offset) / scale)`
into the target byte or bit range of `send`, and records the number in state:

```yaml
actions:
  CABIN_TEMP_SETPOINT:
    endpoint: climate
    encode:
      byte: 4
      scale: 0.5
      offset: -40
      min: 16
      max: 32
      step: 0.5
    send: [0x04, 0x2E, 0x12, 0x34, 0, 0, 0, 0]
    expect: [0x6E, 0x12, 0x34]
```

`encode` accepts `byte` (`0`..`7`, shorthand for `start_bit: byte * 8` and
`length: 8`) or `start_bit` (`0`..`63`) and `length` (`1`..`52`, default `8`),
along with optional `byte_order` (`little` or `big`, default `little`),
`signed` (default `false`), `scale` (default `1`), `offset` (default `0`), and
input bounds `min`, `max`, and `step`. On a multi-step action, `encode` on the
action applies to its direct `send` steps (not expanded `ref` sequence steps),
or `encode` may be placed directly on the target step in `steps`.
`CapabilityRegistry.actionInput("CABIN_TEMP_SETPOINT")` returns `{ min, max, step }`
for rendering a number input. An action cannot declare both `values` and `encode`.

An inline request is always request-only:

```yaml
actions:
  LEFT_SIGNAL:
    send:
      bus: 1
      request_id: 0x123
      request: [0x01, 0x00, 0x00, 0x00]
```

An inline request follows its bus's `fd` default (section 8.1). Set
`fd: false` for a frame the vehicle carries as classic on an FD bus:

```yaml
actions:
  CHIME:
    send:
      bus: 0
      request_id: 0x3F1
      fd: false
      request: [0x02, 0x10]
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
response, or no node acknowledges its frame (the bus is asleep), the library
runs `ECU_WAKE` and retries the original action. If background queries have
already established that the bus is asleep, the library starts with
`ECU_WAKE` instead of first paying for an action request that is expected to
fail. A woken ECU can take a moment to answer, so this is repeated up to five
times with a short, growing settle delay (100 ms, 200 ms, ... 500 ms); each
retry also waits out the step's `timeout_ms`, so a ready ECU is found quickly
without long blind waits.
`ECU_WAKE` frames themselves are expected to go
unanswered on a sleeping bus: they are sent with `continueOnError` and their
own `no_response` / `tx_failed` outcomes are ignored. A mismatching response
during a retry may be the ECU answering mid-wake and is retried too; if no
attempt is verified the action resolves to `"unknown"`. Outside the wake path
an unexpected response payload is never retried.

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

A request the profile sends as CAN FD (section 8.1) carries
`VehicleRequest.canFd`:

- `{ txDl: 8 }`: send `txFrame` unchanged as one 8-byte CAN FD frame. Inline
  actions and endpoints with `tx_dl` 8 use this form.
- `{ txDl: 64, payload }`: send `payload`, the application payload of
  `txFrame` without its PCI byte, in 64-byte frames with ISO 15765-2:2016 PCI.

In both forms `txFrame` holds the 8-byte frame the profile describes. The
transport sets bit-rate switching from the bus timing it applied. A transport
that cannot send CAN FD must reject a request with `canFd`, as `SlcanTransport`
does unless it is created with `canFd: true` for CANable 2 firmware. It must
not fall back to classic CAN silently. A request without `canFd` must be sent
as classic CAN.

`sendRequestBatch` steps may carry `canFd`. A transport whose device batches
only 8-byte frames sends a `txDl` 64 step outside the batch or splits the batch
around it.

A request to an endpoint with ISO-TP extended or mixed addressing (section
8.2) carries `VehicleRequest.isotpAddressing`, `{ tx, rx }`:

- `txFrame.data[0]` already holds `tx` and the PCI follows it, so a classic
  request goes out unchanged. With `canFd.txDl` 64 the transport lays the
  frame out as `tx 00 length payload`.
- Every reply frame must start with `rx`; the transport ignores frames that do
  not and strips `rx` and the PCI from those that do, including consecutive
  frames.
- Flow control goes to `txFrame.canId` with `tx` first: `tx 30 00 00`, padded
  to the request's frame size. The `response_id - 8` rule for 11-bit IDs does
  not apply to addressed exchanges.
- A transport whose device performs ISO-TP, such as Can Opener SE, passes both
  bytes to the device rather than reimplementing this. A transport that cannot
  do either must reject the request; it must not send the frame with normal
  addressing.

`sendRequestBatch` steps may carry `isotpAddressing` the same way.

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
version: 1.1

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
  RPM:
    monitor:
      bus: 0
      message: ENGINE_STATUS
      signal: ENGINE_RPM
```

This profile still requires its referenced DBC files and a
`VehicleTransport`. For Can Opener SE, implement the transport according to
the separate BLE protocol specification.

## Changelog

### 1.1

- Capability names follow an entity convention borrowed from COVESA VSS:
  a name identifies a thing (`TRUNK`, `FRONT_LEFT_DOOR`), never a predicate
  or verb. The monitor signal, query, and action for one entity share that
  name. Reported values are conditions, and action commands are present tense
  (`lock` records `locked`, `close` records `closed`) (section 3).
- The common keyword list moved to [Vehicle Keywords](./vehicle-keywords.md),
  with a description for each keyword, and grew to cover sunroof, windows,
  hood, fuel door, charge port, mirrors, odometer, range, ignition, gear,
  parking brake, tire pressure, climate, 12 V and traction batteries, and
  charging.
- Actions for stateful entities declare `values`, one request definition per
  present-tense command, loading as `ENTITY.value` actions with `entity` and
  `value` set. The flat `ENTITY.value:` key is equivalent (section 14).
- `VirtualVehicle.action(entity, { value })` runs the matching command and
  records the resulting condition in vehicle state when the request reached
  the bus. `CapabilityRegistry.actionValues(entity)` lists the commands a
  profile offers.
- Renamed: `FRONT_LEFT_DOOR_OPEN` and the other doors drop `_OPEN`;
  `LOCK`/`UNLOCK` become `DOORS` with commands `lock`/`unlock`;
  `OPEN_TRUNK`/`CLOSE_TRUNK` become `TRUNK` with commands `open`/`close`;
  `HIGH_BEAM`/`LOW_BEAM` become `HIGH_BEAMS`/`LOW_BEAMS`. Old names are
  listed as deprecated in the keyword registry; the library does not alias
  them.
- `version: 1.1` is accepted alongside `version: 1`.

### 1.0

- Initial specification: DBC-backed profiles, logical buses, CAN FD, ISO-TP
  addressing, endpoints, sequences, signals, queries, actions, `ECU_WAKE`
  retry, and the `VehicleTransport` contract.
