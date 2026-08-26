# Vehicle Profile, DBC, and BLE Interface Specification

This document defines the stable vehicle capability vocabulary, the YAML profile
format, the DBC responsibilities, and the BLE firmware packet interface used by
`can-opener-js`.

## Core Architecture

`can-opener-js` keeps three layers separate:

- DBC files decode received CAN frames into named signals.
- YAML profiles define requests, command flows, monitor subscriptions,
  applicability, and references to DBC mappings.
- BLE firmware exposes three primitives: configure monitor, request with
  response, and request only.

DBC never defines workflow. YAML never defines bit math.

DBC also owns physical decode metadata such as units, scaling, offsets, byte
order, signedness, ranges, and enum tables. YAML only points standardized
capability names at the DBC messages and signals that decode them.

## Standard Capability Keywords

These names are the stable app-facing vocabulary. Vehicle profiles map them to
vehicle-specific CAN IDs, request bytes, response IDs, and DBC mappings.

YAML profile keys must use the standardized names when a capability is listed in
this document. For capabilities not listed here, profiles may define additional
vehicle-specific names. DBC message and signal names should match the
standardized names when practical, but this is a recommendation rather than a
requirement because DBC files often reflect OEM, reverse-engineering, or tool
export naming.

### Actions

- `UNLOCK`
- `LOCK`
- `LEFT_SIGNAL`
- `RIGHT_SIGNAL`
- `OPEN_TRUNK`
- `CLOSE_TRUNK`
- `HORN`
- `ECU_WAKE`

### Queries

Queries expose supported PIDs and structured diagnostic reads. The common query
namespace is the PID list below.

### Signals

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

`TPS` means throttle position.

Standard signal values should use these script-facing domains. Numeric units
come from the DBC. Enum labels come from DBC `VAL_` entries unless a profile
uses `normalize.enum` to translate car-specific labels:

- `SPEED`: number, typically `km/h`
- `RPM`: number, typically `rpm`
- `TPS`: number, typically `%`
- `STEERING_ANGLE`: number, typically `deg`
- `FUEL_LEVEL`: number, typically `%`
- `LEFT_SIGNAL`, `RIGHT_SIGNAL`, `BRAKE_LIGHTS`, `LOW_BEAMS`, `HIGH_BEAMS`:
  `"off"` or `"on"`
- `FRONT_LEFT_DOOR_OPEN`, `FRONT_RIGHT_DOOR_OPEN`, `REAR_LEFT_DOOR_OPEN`,
  `REAR_RIGHT_DOOR_OPEN`: `"closed"` or `"open"`

If no `normalize` block is declared, the script-facing value is the DBC-decoded
value. Signals with a matching DBC `VAL_` entry return the enum label; other
numeric signals return the DBC-scaled physical number.

## Standard PID Keywords

Profiles may support any subset of these basic PIDs:

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

## File Structure

Vehicle definitions are grouped by folder. Each folder may contribute partial
definitions:

```text
vehicles/
  universal/
    profile.yaml
    signals.dbc

  nissan/sentra/
    profile.yaml
    signals.dbc
```

Profiles merge by applicability, with the most-specific match winning.

## YAML Root Structure

Only `version` is required.

```yaml
version: 1

applies_to: {}

dbc:
  files: []

endpoints: {}

sequences: {}

signals: {}

queries: {}

actions: {}
```

## Applicability Rules

`applies_to` describes which vehicles a YAML profile and its DBC files support.
If `applies_to` is omitted, the profile is universal and applies to all makes and
models. Standard OBD-II PID profiles are a typical universal profile.

Supported keys:

- `manufacturers`
- `models`
- `years`
- `trims`
- `engines`
- `markets`

Missing fields act as wildcards.

```yaml
applies_to:
  manufacturers: [Nissan]
  models: [Sentra, Versa]
  years:
    - 2010
    - 2011
    - range: [2012, 2015]
  trims: [S, SV]
  engines: [2.0L]
  markets: [NA]
```

Year ranges are inclusive:

```yaml
years:
  - range: [2010, 2015]
```

This matches model years 2010 through 2015.

## DBC Rules

DBC files decode received CAN payloads only.

Use DBC for:

- passive broadcast frames
- request/response diagnostic replies
- UDS positive responses
- ECU status messages
- sensor values

Do not use DBC for:

- command flows
- multi-step transactions
- security or session setup
- tester-present keepalive
- applicability logic

DBC message IDs must be real CAN response IDs, not invented logical IDs.

```dbc
VERSION ""

BU_: Tester ECU

BO_ 2024 OBD_Response: 8 ECU
 SG_ vehicle_speed : 24|8@1+ (1,0) [0|255] "km/h" Vector__XXX

BO_ 1893 Body_Response: 8 ECU
 SG_ response_service : 8|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ routine_high     : 16|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ routine_low      : 24|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ routine_status   : 32|8@1+ (1,0) [0|255] "" Vector__XXX
```

In this example, `0x7E8` is decimal `2024` and `0x765` is decimal `1893`.

## DBC File References

Profiles reference DBC files by relative path:

```yaml
dbc:
  files:
    - path: signals.dbc
```

## CAN Bus Selection

Vehicle profiles may route each diagnostic endpoint and passive monitor to a
logical CAN controller with `bus`. If `bus` is omitted, it defaults to `0` so
existing single-bus profiles remain valid.

```yaml
endpoints:
  powertrain:
    bus: 0
    request_id: 0x7E0
    response_id: 0x7E8

  body:
    bus: 1
    request_id: 0x745
    response_id: 0x765

signals:
  DOOR_OPEN:
    monitor:
      bus: 1
      message: BODY_STATUS
      signal: DRIVER_DOOR_OPEN
```

The profile layer accepts bus numbers `0..255` for transport portability. The
Can Opener SE dual-CAN firmware currently implements buses `0` and `1`; any
other bus is rejected by that firmware as `invalid_bus`.

`bus` selects a controller that is already configured by firmware. It does not
set the physical OBD pins or CAN bit rate. The current SE firmware defaults are
CAN0 at 500 kbit/s and CAN1 at 125 kbit/s; changing those rates is a firmware
configuration/build concern until a runtime bus-configuration primitive is
defined. Vehicle profiles must therefore describe which logical bus to use, not
claim ownership of electrical routing or bit timing.

For inline actions that do not reference an endpoint, `bus` may be placed in the
`send` object:

```yaml
actions:
  EXAMPLE_COMMAND:
    send:
      bus: 1
      request_id: 0x35D
      request: [0xC1, 0x03]
```

Endpoint-backed queries, actions, and sequence steps inherit the endpoint's
`bus`. Passive monitor signals use `signals.<name>.monitor.bus`.

## Endpoint Rules

An endpoint defines a reusable request/response transport target.

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

Rules:

- `request_id` is one transmit CAN ID.
- `response_id` is one accepted response CAN ID.
- `response_ids` is a list of accepted response IDs and ranges.
- Endpoints are reused by queries, actions, and sequences.

## Transaction Step Rules

A step is one BLE firmware request transaction.

```yaml
- send: [0x10, 0x81]
  expect: [0x50, 0x81]
```

This sends bytes, waits for a response, and validates the response prefix. If
`expect` is omitted, the step sends bytes only and does not wait for a response.
`send` and `expect` always belong to the same step.

## Expect Matching Rules

`expect` is a response pattern. By default, an `expect` array is a prefix match
and extra response bytes are ignored.

```yaml
expect: [0x41, 0x0D]
```

This matches `41 0D 00`, `41 0D 7F`, and any other response starting with
`41 0D`.

Use `"*"` as a wildcard byte:

```yaml
expect: [0x70, 0x30, "*"]
```

This matches `70 30 00`, `70 30 01`, and `70 30 FF`.

Use exact matching when extra response bytes should fail validation:

```yaml
expect:
  pattern: [0x70, 0x30, 0x01]
  exact: true
```

Omitted `expect` means no response wait.

## Sequences

Sequences are reusable step groups intended for shared setup logic.

```yaml
sequences:
  body_session_prep:
    steps:
      - send: [0x10, 0x81]
        expect: [0x50, 0x81]

      - send: [0x10, 0xC0]
        expect: [0x50, 0xC0]
```

Rules:

- Sequences are expanded inline.
- Sequences may be nested.
- Circular references are invalid.

## Sequence References

A step may reference another sequence:

```yaml
- ref: sequences.body_session_prep
```

Example:

```yaml
actions:
  HORN:
    endpoint: body
    steps:
      - ref: sequences.body_session_prep
      - send: [0x30, 0x30, 0x00, 0x01]
        expect: [0x70, 0x30, 0x01]
```

Rules:

- References expand in place.
- Circular references are invalid.
- A referenced sequence inherits the command endpoint unless it declares its own
  endpoint.

## Signals

Signals represent passively collected values. They are usually broadcast at a
regular cadence on the CAN bus and decoded with a DBC file.

```yaml
signals:
  STEERING_ANGLE:
    monitor:
      bus: 0
      message: STEERING
      signal: STEERING_ANGLE
```

Default value behavior:

- If the DBC signal has a matching `VAL_` entry, state is updated with that enum
  label.
- Otherwise, state is updated with the DBC-scaled physical value.
- Profile `normalize.enum` is optional and runs after DBC decode.

Use `normalize.enum` only when the DBC labels need to be translated into the
portable profile vocabulary:

```yaml
signals:
  LOW_BEAMS:
    monitor:
      message: BODY_STATUS
      signal: HEADLAMP_STATE
    normalize:
      enum:
        inactive: off
        active: on
```

Firmware mapping:

- Configure monitor CAN IDs from DBC message references.
- Receive monitor data notifications.
- Decode signals continuously from the latest frame data.

## Queries

Queries are request/response reads from the CAN bus, typically to an ECU that
responds with a CAN frame. They are used for PIDs, UDS reads, VIN, serial
numbers, ASCII strings, multi-frame identifiers, and status blobs.

DBC-backed queries use `dbc_mapping` to point a standard YAML query name to the
DBC message and signal that decode the response payload. The DBC owns units,
scaling, offsets, byte order, signedness, and enum tables.

```yaml
queries:
  SPEED:
    endpoint: obd
    send: [0x01, 0x0D]
    expect: [0x41, 0x0D]
    dbc_mapping:
      message: OBD_Response_7E8
      signal: SPEED
```

Queries follow the same value rules as monitored signals. DBC enum labels are
returned by default, numeric DBC signals return physical values by default, and
optional `normalize.enum` remaps labels after decode:

```yaml
queries:
  GEAR:
    endpoint: obd
    send: [0x22, 0x12, 0x34]
    expect: [0x62, 0x12, 0x34]
    dbc_mapping:
      message: Body_Response
      signal: TRANSMISSION_STATE
    normalize:
      enum:
        P: park
        R: reverse
        D: drive
```

Use `decoder` only for built-in non-DBC decoders:

```yaml
queries:
  VIN:
    endpoint: obd
    send: [0x09, 0x02]
    expect: [0x49, 0x02]
    decoder: ascii
    length: 17
```

Supported built-in decoder forms:

```yaml
decoder: ascii
length: 17
```

```yaml
decoder: bytes
```

```yaml
decoder:
  type: ascii
  length: 17
```

```yaml
decoder:
  type: bytes
  length: 8
```

Built-in decoders operate on the response payload after the `expect` prefix is
removed. `ascii` returns a string and trims trailing null bytes. `bytes` returns
raw bytes. `length` limits the number of bytes consumed by the decoder.

Queries always use BLE request/response.

## Actions

Actions change vehicle state. They may be request-only, verified
request/response, or multi-step flows.

### send forms

The `send` field accepts two forms:

- **Array form** `send: [0x30, 0x38, ...]`: requires `endpoint` to supply the
  transmit CAN ID and optional response bounds.
- **Object form** `send: {request_id: 0x123, request: [...]}`: embeds the
  transmit CAN ID inline. No `endpoint` is needed. This form is always
  request-only; response bounds and timeouts are not inherited from any
  endpoint.

Actions with no `send` and no `steps` are silently skipped during profile
loading.

Single request (inline `request_id`, no endpoint required):

```yaml
actions:
  LEFT_SIGNAL:
    send:
      request_id: 0x123
      request: [0x01, 0x00, 0x00, 0x00]
```

Verified request/response (array `send`, endpoint required):

```yaml
actions:
  LOCK:
    endpoint: body
    send: [0x30, 0x38, 0x00, 0x01]
    expect: [0x70, 0x38, 0x01]
```

Multi-step flow:

```yaml
actions:
  HORN:
    endpoint: body
    steps:
      - ref: sequences.body_session_prep
      - send: [0x30, 0x30, 0x00, 0x01]
        expect: [0x70, 0x30, 0x01]
```

Actions may return nothing. If `expect` validation is used, actions return
boolean success or failure.

`ECU_WAKE` is an internal, request-only action used to recover a sleeping ECU.
When a different action receives no ECU response, the runtime sends `ECU_WAKE`
and retries the full original action once. It does not wake or retry after an
unexpected response payload, and it preserves the original failure when the
active profile does not define `ECU_WAKE`.

## Firmware Execution Mapping

- Signals with `monitor` use configure monitor plus the monitor notification
  stream.
- Signals with `send` and `expect` use request/response and return a decoded
  value.
- Queries use request/response and return a decoded value.
- Actions with `expect` use request/response and return a boolean.
- Actions without `expect` use request-only.
- Actions using the `{request_id, request}` inline form use request-only
  without response bounds, regardless of whether an endpoint is also present.
- Sequences expand into multiple BLE request transactions.

## Runtime Profile Reloading

`VirtualVehicle.reloadProfiles(sources)` replaces the loaded capability set
at runtime without reconnecting. This is useful for staged loading: connect
with a minimal profile (for example, OBD-II PIDs only) to read the VIN, then
call `reloadProfiles` with the full vehicle-specific profile set after
discovery.

Profile reload rebuilds capabilities and DBC bindings from scratch. Active
monitors are not automatically restarted; the caller should re-subscribe after
reloading.

Batch `subscribe([...])` calls skip signals that cannot be resolved against the
currently loaded DBC. This makes it safe to call subscribe with a superset of
signal names before or after a reload.

## BLE Interface

The BLE transport exposes the same three primitives as before, now with an
optional logical bus selector. All multibyte integers are little-endian.

Can Opener SE uses:

- device name: `CanOpener`
- primary service: `0x0180`
- request / response characteristic: `0xFEF4`
- monitor control / acknowledgement: `0xA003`
- monitor data: `0xA004`

Omitting the bus selector preserves the original single-bus behavior and routes
to bus `0`. Dual-CAN transports should always emit the bus-aware layouts.

### Request flags

The request `flags` byte is shared by all request layouts:

- `0x01`: expect a CAN response
- `0x02`: transmit CAN ID is extended (29-bit)
- `0x04`: response CAN ID is extended (29-bit)
- `0x08`: variable-length ISO-TP payload (v3 layout)

### Legacy request-only packet — bus 0

```text
[0]      seq
[1]      flags
[2..5]   tx_can_id
[6]      dlc 0-8
[7..14]  payload[8]
```

Total length: 15 bytes. This remains valid and always targets bus 0.

### Dual-CAN request-only packet — v2

```text
[0]      seq
[1]      flags
[2]      bus
[3..6]   tx_can_id
[7]      dlc 0-8
[8..15]  payload[8]
```

Total length: 16 bytes.

### Legacy request/response packet — bus 0

```text
[0]       seq
[1]       flags (bit0 set)
[2..5]    tx_can_id
[6..9]    response_id_start
[10..13]  response_id_end
[14..15]  timeout_ms
[16]      dlc 0-8
[17..24]  payload[8]
```

Total length: 25 bytes. This remains valid and always targets bus 0.

### Dual-CAN request/response packet — v2

```text
[0]       seq
[1]       flags (bit0 set)
[2]       bus
[3..6]    tx_can_id
[7..10]   response_id_start
[11..14]  response_id_end
[15..16]  timeout_ms
[17]      dlc 0-8
[18..25]  payload[8]
```

Total length: 26 bytes. The firmware performs ISO-TP response reassembly when a
response is expected.

### Variable-length ISO-TP request — v3

Use this layout when the application payload itself is longer than a classic
CAN frame or when firmware-managed ISO-TP request segmentation is desired. Set
flag `0x08`.

```text
[0]       seq
[1]       flags
[2]       bus
[3..6]    tx_can_id
[7..10]   response_id_start
[11..14]  response_id_end
[15..16]  timeout_ms
[17]      payload_length
[18..]    application payload
```

The SE firmware handles request segmentation, ECU flow control, block size,
STmin, response segmentation/reassembly, and UDS response-pending (`7F xx 78`).

### Request notification

Every request that expects a response, and every v3 ISO-TP request, reports
status through `0xFEF4` notifications:

```text
[0]       seq
[1]       status
[2]       response_flags
[3..6]    response_can_id
[7]       payload_len
[8..]     payload
```

Response flags:

- `0x01`: response CAN ID is extended
- `0x02`: payload is a fragment of a larger response
- `0x04`: more response fragments follow

For fragmented notifications, the first two payload bytes are the little-endian
fragment offset; the remaining bytes are response data. Reassemble by offset and
sequence before decoding the profile query.

SE request status values:

- `0x00`: OK
- `0xE1`: bad packet length
- `0xE2`: bad DLC
- `0xE3`: CAN transmit failure
- `0xE4`: CAN receive timeout
- `0xE5`: invalid ISO-TP exchange
- `0xE6`: ISO-TP response overflow
- `0xE7`: invalid CAN ID
- `0xE8`: invalid / unavailable bus

## BLE Monitor Control

Monitor tables are independent per bus. The Can Opener SE firmware currently
allows up to 16 subscribed CAN IDs on each bus.

### ADD / REMOVE — legacy bus 0

```text
[0]    opcode = 0x01 ADD or 0x02 REMOVE
[1]    seq
[2]    count
[3..]  count * u32 CAN IDs
```

### ADD / REMOVE — dual-CAN

```text
[0]    opcode = 0x01 ADD or 0x02 REMOVE
[1]    seq
[2]    bus
[3]    count
[4..]  count * u32 CAN IDs
```

### CLEAR

Legacy bus 0: `[0x03, seq]`

Dual-CAN: `[0x03, seq, bus]`

### Stream all frames

Start: `[0x04, seq, bus]`

Stop: `[0x05, seq, bus]`

### Firmware-timed periodic frame

Start uses 19 bytes:

```text
[0]       opcode = 0x06
[1]       seq
[2]       bus
[3..4]    interval_ms (minimum 10 ms)
[5..8]    can_id
[9]       dlc
[10..17]  payload[8]
[18]      extended (0 or 1)
```

Stop all periodic output: `[0x07, seq]`

Stop if it belongs to a specific bus: `[0x07, seq, bus]`

### Monitor configuration acknowledgement

```text
[0]  opcode = 0x80
[1]  seq
[2]  status
[3]  current_monitor_count for this bus
[4]  bus
```

Status codes:

- `0x00`: OK
- `0x01`: invalid opcode
- `0x02`: invalid length
- `0x03`: monitor full
- `0x04`: duplicate ID
- `0x05`: invalid CAN ID
- `0x06`: internal error
- `0x07`: invalid / unavailable bus

## BLE Monitor Data

Each frame payload remains 13 bytes: `u32 can_id`, `u8 dlc`, `u8 data[8]`.

For backward compatibility, subscribed CAN0 snapshots keep the original format:

```text
[0]     opcode = 0x81
[1]     frame_count
[2..]   repeated 13-byte frames
```

Bus-aware snapshots from nonzero buses use:

```text
[0]     opcode = 0x82
[1]     bus
[2]     frame_count
[3..]   repeated 13-byte frames
```

All-frame streaming uses:

```text
[0]     opcode = 0x83
[1]     bus
[2]     frame_count
[3..]   repeated 13-byte frames
```

A transport must attach the decoded bus number to each delivered `CanFrame`.
The virtual vehicle layer keys subscriptions by `(bus, can_id)`, so the same CAN
ID may be monitored independently on both channels without collision.

## Transport Mapping Rules

A `VehicleTransport` implementation for Can Opener SE must map the generic
profile contract onto firmware as follows:

- `CanFrame.bus` -> request packet bus byte; omitted means `0`.
- `MonitorControlRequest.bus` -> monitor-control bus byte; omitted means `0`.
- endpoint `bus` -> outbound query/action frame bus.
- monitor `bus` -> monitor subscription bus and inbound frame identity.
- v2 request layouts are sufficient for classic 0-8 byte request payloads.
- v3 is required for variable-length ISO-TP request payloads.
- legacy layouts may be used only for bus 0 compatibility.

Bitrate and physical OBD/harness routing are deliberately outside this
application/profile protocol.

## Final Rule

DBC is the physical CAN payload decoder. YAML is the source of transport,
workflow, request bytes, expected replies, monitor definitions, and
applicability. Capabilities are the stable universal API. Firmware BLE stays
limited to the three primitives: configure monitor, request/response, and
request-only.
