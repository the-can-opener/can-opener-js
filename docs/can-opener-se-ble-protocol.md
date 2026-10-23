# Can Opener SE BLE Transport Protocol

This document defines the BLE and CAN transport protocol implemented by the
current Can Opener SE ESP32-C5 firmware.

It is intended for developers writing their own app or implementing a
`VehicleTransport` for `can-opener-js`.

Related documents:

- [Vehicle Profile and Library Specification](./vehicle-profile-spec.md)
- [Security Protocol](./can-opener-se-security-protocol.md)

All multibyte integers are little-endian.

## 1. GATT profile

The adapter advertises:

- device name: `CanOpener SE XXXX`
- primary service: `0x0180`
- request and response characteristic: `0xFEF4`
- monitor control and acknowledgement characteristic: `0xA003`
- monitor data characteristic: `0xA004`
- security control characteristic: `0xA005`
- Device Information Service: `0x180A`
- Model Number String: `0x2A24`, value `CO-SE-NEXUS`
- Firmware Revision String: `0x2A26`, value such as `v0.2.3`

`XXXX` is the last two bytes of the factory MAC in uppercase hexadecimal.

Characteristic properties:

- `0xFEF4`: Write, Write Without Response, Notify
- `0xA003`: Write, Write Without Response, Notify
- `0xA004`: Notify
- `0xA005`: Write with Response, Notify

If the GATT layout changes, firmware uses Service Changed so bonded clients
can rediscover services.

## 2. Required connection sequence

A client should:

1. Scan for service `0x0180` and parse manufacturer data.
2. Connect and discover the service and characteristics.
3. Negotiate an ATT MTU of at least 70.
4. Subscribe to `0xA005`.
5. Follow the matching security path:
   - For an unclaimed adapter, complete pairing and link encryption, then send
     `CLAIM`.
   - For a claimed adapter with an approved bond, resume encryption, then
     authenticate.
   - For a claimed adapter on a new phone, authenticate on the plaintext link,
     then complete pairing when the adapter requests it.
6. Subscribe to `0xFEF4`, `0xA003`, and `0xA004`.
7. Configure any profile bus timing.
8. Add monitor subscriptions.
9. Start normal queries and actions.

Do not treat BLE pairing as authorization. Every connection must authorize on
`0xA005`.

Before authorization, writes to `0xFEF4` and `0xA003` fail with ATT `0x08`,
Insufficient Authorization. Writes that require link encryption fail with ATT
`0x0F`, Insufficient Encryption.

## 3. Advertising

The advertising packet includes service `0x0180` and 12 bytes of
manufacturer-specific data:

```text
[0..1]   company_id = 0xFFFF
[2]      format_version = 0x01
[3]      flags
[4..11]  first eight bytes of device_id
```

Flags:

- `0x01`: pairing mode is open
- `0x02`: adapter is claimed

The device ID bytes are all zero while unclaimed.

The device name is in the scan response. The adapter uses a static random BLE
address. Factory reset changes the address and device ID.

## 4. General client rules

Sequence fields are unsigned bytes and may wrap. Do not reuse a sequence while
a request with that sequence is pending on the same characteristic.

Correlate:

- `0xFEF4` responses by request sequence
- `0xA003` acknowledgements by control sequence
- `0xA005` responses by opcode and sequence

The firmware accepts request writes up to 244 bytes on `0xFEF4` and monitor
control writes up to 244 bytes on `0xA003`.

Serialize `0xFEF4` work unless the client has a deliberate correlation and
queueing strategy. The current firmware processes request writes in arrival
order.

## 5. CAN request flags

Every `0xFEF4` request begins with:

```text
[0]   sequence
[1]   flags
```

Flags:

- `0x01`: expect a CAN response
- `0x02`: transmit CAN ID is extended, 29-bit
- `0x04`: response CAN ID is extended, 29-bit
- `0x08`: v3 variable-length ISO-TP application payload
- `0x10`: v4 batch

Bits `5` through `7` are reserved.

## 6. Classic request-only packets

Legacy bus 0 packet:

```text
[0]       sequence
[1]       flags
[2..5]    transmit_can_id:u32
[6]       dlc, 0 through 8
[7..14]   data[8]
```

Total length is 15 bytes.

Bus-aware v2 packet:

```text
[0]       sequence
[1]       flags
[2]       bus
[3..6]    transmit_can_id:u32
[7]       dlc, 0 through 8
[8..15]   data[8]
```

Total length is 16 bytes.

A normal request-only packet produces no notification. This includes failures
such as an unavailable bus, invalid DLC, invalid CAN ID, and transmit failure.
Use a response request or a batch when the app needs a transport result.

New clients should use the v2 form, including for bus 0.

## 7. Classic request and response packets

Legacy bus 0 packet:

```text
[0]       sequence
[1]       flags, bit 0 set
[2..5]    transmit_can_id:u32
[6..9]    response_id_start:u32
[10..13]  response_id_end:u32
[14..15]  timeout_ms:u16
[16]      dlc, 0 through 8
[17..24]  data[8]
```

Total length is 25 bytes.

Bus-aware v2 packet:

```text
[0]       sequence
[1]       flags, bit 0 set
[2]       bus
[3..6]    transmit_can_id:u32
[7..10]   response_id_start:u32
[11..14]  response_id_end:u32
[15..16]  timeout_ms:u16
[17]      dlc, 0 through 8
[18..25]  data[8]
```

Total length is 26 bytes. Response ID bounds are inclusive.

These packets send the supplied bytes as one classic CAN frame. For an ISO-TP
diagnostic request, the data must already contain its ISO-TP PCI byte.

Example, OBD-II speed query on bus 0:

```text
sequence          2A
flags             01
bus               00
transmit ID       000007DF
response start    000007E8
response end      000007EF
timeout           01F4
dlc               08
data              02 01 0D 00 00 00 00 00
```

Serialized v2 bytes:

```text
2A 01 00
DF 07 00 00
E8 07 00 00
EF 07 00 00
F4 01
08
02 01 0D 00 00 00 00 00
```

The firmware reassembles the ISO-TP response and returns its application
payload without PCI bytes. A successful response payload begins `41 0D`.

### 7.1 ISO-TP response behavior

The firmware handles:

- single-frame responses
- first and consecutive frames
- flow-control CTS
- UDS response pending, `7F service 78`
- responses up to 512 application bytes
- BLE response fragmentation

For a multi-frame standard 11-bit response, the firmware sends flow control to
`matched_response_id - 8`. This matches standard OBD-II addressing, such as
`0x7E8` to `0x7E0`.

For an extended response, flow control uses the original transmit CAN ID.

Important compatibility restriction: a nonstandard 11-bit request and response
pair must follow the `response_id - 8` convention for multi-frame responses.
For example, request `0x745` and response `0x765` will receive flow control at
`0x75D`, not at `0x745`. Single-frame responses are unaffected.

## 8. v3 variable-length ISO-TP request

Set flag `0x08` when the BLE packet carries an ISO-TP application payload
instead of a ready-to-send classic CAN frame.

```text
[0]       sequence
[1]       flags
[2]       bus
[3..6]    transmit_can_id:u32
[7..10]   response_id_start:u32
[11..14]  response_id_end:u32
[15..16]  timeout_ms:u16
[17]      payload_length, 1 through 255
[18..]    application_payload
```

The total write length must be exactly `18 + payload_length` and no more than
244 bytes.

The firmware adds ISO-TP PCI, segments long requests, obeys ECU flow control,
supports block size and STmin, and optionally waits for a reassembled
response. Set flag `0x01` when a response is expected.

Every v3 request returns a request notification, including a request-only v3
write that reaches the request task. The notification reports its final
transport status.

Current firmware has one queue-full exception: when a v3 request has flag
`0x01` clear and the request command queue is already full, the write is
dropped without an `0xE9` notification. There is no guaranteed delivery-only
result for request-only v3 traffic under queue saturation. Set flag `0x01`
only when the transaction semantically expects an ECU response.

Current `can-opener-js` profile version 1 cannot create this packet through
`VehicleRequest`; profile `send` is limited to one classic CAN frame. A custom
application may use v3 directly.

## 9. v4 batch request

A batch executes several classic CAN steps on one logical bus. Set flag
`0x10`.

```text
[0]       sequence
[1]       flags = 0x10
[2]       bus
[3]       batch_flags
[4]       step_count, 1 through 14
[5..]     encoded steps
```

Batch flag `0x01` continues after a step transport failure. Without it, the
firmware stops after the first failed step.

Each step begins with:

```text
[0]       step_flags
[1..4]    transmit_can_id:u32
[5]       dlc, 0 through 8
[6..13]   data[8]
[14..15]  post_delay_ms:u16
```

Step flags:

- `0x01`: expect response
- `0x02`: transmit ID is extended
- `0x04`: response ID is extended

If the step expects a response, append:

```text
[16..19]  response_id_start:u32
[20..23]  response_id_end:u32
[24..25]  timeout_ms:u16
```

A zero response timeout selects the firmware default of 1000 ms.

Batch limits:

- at most 14 steps
- at most 244 total BLE bytes
- one logical bus
- at most 30,000 ms total of response timeouts and post-step delays
- at most 512 bytes in the combined result

The firmware validates the entire packet before transmitting a step. DLC,
length, ID, bus, step count, and budget errors reject the whole batch.

The firmware checks transport success only. It does not evaluate application
payload patterns. A later step may run even when an earlier response is valid
at the transport level but wrong for the application.

### 9.1 Batch result

Every batch produces one logical request response with response flag `0x08`.
It may be split across BLE fragments.

Batch payload:

```text
[0]       requested_step_count
[1]       executed_step_count
[2..]     entries
```

Each executed entry:

```text
[0]       step_index
[1]       step_status
[2]       response_flags
[3..6]    response_can_id:u32
[7..8]    payload_length:u16
[9..]     application_payload
```

Steps after `executed_step_count` were skipped.

Firmware versions without v4 may reject the shape as an older request or may
remain silent. A transport can probe with its first batch, then fall back to
sequential v2 writes after an unsupported response or a short capability
timeout. Do not retry a batch after an ambiguous link timeout unless repeating
its actions is safe.

## 10. Request notifications

Requests that expect a response, all v3 requests, and all v4 batches report on
`0xFEF4`.

```text
[0]       sequence
[1]       status
[2]       response_flags
[3..6]    response_can_id:u32
[7]       payload_length
[8..]     payload
```

Response flags:

- `0x01`: response CAN ID is extended
- `0x02`: payload is one fragment
- `0x04`: more fragments follow
- `0x08`: payload is a v4 batch result

Request statuses:

- `0x00`: OK
- `0xE1`: invalid packet length
- `0xE2`: invalid DLC
- `0xE3`: CAN transmit failed
- `0xE4`: CAN response timeout
- `0xE5`: invalid ISO-TP exchange
- `0xE6`: ISO-TP payload overflow
- `0xE7`: invalid CAN ID or range
- `0xE8`: invalid or unavailable bus
- `0xE9`: request queue busy
- `0xEA`: batch rejected because step count or time budget is invalid

### 10.1 Fragment reassembly

When response flag `0x02` is set, payload begins with:

```text
[0..1]   fragment_offset:u16
[2..]    response bytes at that offset
```

Reassemble fragments by sequence and offset. Complete the response when a
fragment arrives without flag `0x04`. Validate overlaps, gaps, and the
512-byte maximum before returning the payload.

The `payload_length` field describes bytes in that BLE notification, including
the two-byte offset when fragmented.

### 10.2 Timeouts

Start an application request timeout after the BLE write is acknowledged.

The application timeout should include:

- requested CAN response timeout
- batch delays and per-step timeouts
- BLE scheduling margin

For a batch, 2.5 seconds above its declared CAN budget is a reasonable mobile
client margin.

## 11. Monitor control

Monitor state is independent per logical bus. Current firmware supports up to
16 subscribed CAN IDs per bus.

Control requests are written to `0xA003`. Every valid control operation
returns an acknowledgement notification on `0xA003`.

### 11.1 Add and remove IDs

Legacy bus 0:

```text
[0]       opcode, 0x01 add or 0x02 remove
[1]       sequence
[2]       count
[3..]     count times can_id:u32
```

Bus-aware:

```text
[0]       opcode, 0x01 add or 0x02 remove
[1]       sequence
[2]       bus
[3]       count
[4..]     count times can_id:u32
```

Use the bus-aware form in new clients.

### 11.2 Clear one bus

Legacy bus 0:

```text
03 sequence
```

Bus-aware:

```text
03 sequence bus
```

### 11.3 Capture all BLE frames

```text
[0]   0x04
[1]   sequence
[2]   enabled, 0 or 1
[3]   optional bus mask
```

Bus mask bit `0` selects CAN0 and bit `1` selects CAN1. Omitted mask means
both. A zero mask is invalid while enabling.

Capture frames arrive on `0xA004` in the normal bus-tagged monitor envelope.
Disconnect disables capture.

### 11.4 Wi-Fi Aware stream

```text
[0]   0x05
[1]   sequence
[2]   enabled, 0 or 1
```

This enables the Wi-Fi Aware radio stream. It does not move CAN frames over
BLE. See section 15.

### 11.5 Start periodic CAN output

```text
[0]       0x06
[1]       sequence
[2]       bus
[3..4]    interval_ms:u16
[5..8]    can_id:u32
[9]       dlc
[10..17]  data[8]
[18]      extended, 0 or 1
```

Minimum interval is 10 ms. Current firmware has one global periodic slot, so a
new start replaces the previous periodic message, even on another bus.

Stop all periodic output:

```text
07 sequence
```

Stop only if the current periodic output belongs to a bus:

```text
07 sequence bus
```

Disconnect also stops periodic output.

### 11.6 Configure CAN timing

```text
[0]       0x08
[1]       sequence
[2]       bus
[3..6]    nominal_bitrate:u32
[7..10]   data_bitrate:u32
```

Nominal bitrate `0` requests listen-only auto-detection. Data bitrate `0`
means the CAN FD data phase follows nominal timing. It does not disable CAN
FD capability.

Auto-detection requires three valid frames at a candidate rate. If the bus is
asleep or no candidate matches, firmware restores the previous timing.

Runtime timing returns to compiled defaults after BLE disconnect.

## 12. Monitor acknowledgements

The normal acknowledgement is:

```text
[0]   0x80
[1]   sequence
[2]   status
[3]   current_monitor_count
[4]   bus
```

Statuses:

- `0x00`: OK
- `0x01`: invalid opcode
- `0x02`: invalid length
- `0x03`: monitor table full
- `0x04`: duplicate ID
- `0x05`: invalid CAN ID
- `0x06`: internal error
- `0x07`: invalid or unavailable bus
- `0x08`: invalid or unsupported bitrate
- `0x09`: auto-detection found no valid traffic

Timing configuration returns 13 bytes:

```text
[0..4]    normal acknowledgement
[5..8]    applied_nominal_bitrate:u32
[9..12]   applied_data_bitrate:u32
```

The extended fields are present on both success and error. They report the
timing active after the operation, including the rate selected by successful
auto-detection or the restored rate after failure.

Enabling Wi-Fi Aware returns 37 bytes:

```text
[0..4]    normal acknowledgement
[5..36]   stream_key[32]
```

Disable and error responses use the normal five-byte form.

## 13. Monitor data

Notifications arrive on `0xA004`:

```text
[0]       0x81
[1]       frame_count
[2..]     frames
```

Each current frame is 14 bytes:

```text
[0..3]    can_id:u32
[4]       dlc
[5..12]   data[8]
[13]      bus
```

Firmware batches up to 16 frames in one notification.

The envelope is used for subscribed snapshots and capture-all data. A
subscribed snapshot contains the latest value observed for each subscribed
ID, not every frame occurrence. Capture-all contains received frames.

Older clients may encounter historical 13-byte frames without a bus byte.
Treat them as bus 0. Historical `0x82` and `0x83` envelopes are parser
compatibility formats only; current firmware emits `0x81`.

Monitor data does not carry an explicit extended-ID flag. IDs above `0x7FF`
are necessarily extended. Avoid depending on an extended frame whose numeric
ID is `0x7FF` or less.

## 14. Bus and CAN limitations

Current firmware implements:

- logical bus `0`
- logical bus `1`
- classic CAN request payloads up to eight bytes
- ISO-TP application responses up to 512 bytes
- v3 ISO-TP request payloads constrained by the 244-byte BLE write

CAN controllers remain CAN FD capable for timing compatibility, but this BLE
protocol does not currently carry CAN FD frames or payloads longer than eight
bytes as raw frames.

Physical pins and connector routing are hardware-specific and are not part of
the BLE protocol.

## 15. Wi-Fi Aware CAN stream

After monitor opcode `0x05` succeeds, firmware publishes:

- service name: `CanOpener`
- service-specific information: `CAN/UDP/42424/v3`
- UDP port: `42424`
- protocol version: `3`

Every datagram is sealed with AES-256-GCM using the 32-byte key returned in the
enable acknowledgement.

Datagram:

```text
[0]       version = 0x03
[1..4]    counter:u32
[5..]     ciphertext
[last 16] GCM tag
```

Additional authenticated data is bytes `0` through `4`.

The 12-byte nonce is:

```text
[0]       direction
[1..7]    zero
[8..11]   counter:u32
```

Direction:

- `0x01`: adapter to client
- `0x02`: client to adapter

Each direction starts at counter `0` after every enable. A receiver accepts
only a counter strictly greater than the last accepted counter.

The client should send `START` as its first authenticated datagram. The
adapter adopts a stream peer only after an authenticated client command.

Client command plaintext is one byte:

- `0x10`: START
- `0x11`: STOP
- `0x12`: CLEAR queued frames

### 15.1 HELLO

Server plaintext:

```text
[0]       0x90
[1]       protocol_version
[2..3]    queue_depth:u16
[4..5]    interval_ms:u16
[6]       flags
[7]       reserved
```

HELLO flags:

- `0x01`: every-frame capture
- `0x02`: frames include extended-ID flag
- `0x04`: frames include logical bus

### 15.2 FRAMES

Server plaintext:

```text
[0]       0x91
[1..2]    sequence:u16
[3..4]    frame_count:u16
[5..8]    twai_drops:u32
[9..12]   stream_drops:u32
[13..]    frames
```

Each frame is 15 bytes:

```text
[0..3]    can_id:u32
[4]       flags, bit 0 means extended ID
[5]       dlc
[6..13]   data[8]
[14]      bus
```

### 15.3 AES-GCM test vector

Stream key is bytes `0xA0` through `0xBF`.

```text
adapter HELLO, counter 7
nonce      010000000000000007000000
plaintext  9003000200000700
datagram   0307000000fdacfe29945a2ada47854b5e1044151301f9be53bdb1899e

client START, counter 0
datagram   0300000000179213249bbdcb3e957d4687f4e12cfe67
```

Disconnect or a new enable invalidates the prior stream key and peer.

## 16. Version compatibility

There is no protocol negotiation request. Clients infer support from packet
shapes and outcomes:

- legacy packets support single-bus firmware
- v2 packets select a bus explicitly
- v3 carries an ISO-TP application payload
- v4 carries classic CAN batches
- monitor opcode `0x04` enables BLE capture-all
- monitor opcode `0x05` enables Wi-Fi Aware
- monitor opcode `0x08` configures timing
- firmware `v0.2.0` and later requires `0xA005` authorization

New clients should implement:

- security authorization
- v2 request packets
- v2 monitor controls
- fragmented response reassembly
- all request status values through `0xEA`
- 5-byte and 13-byte monitor acknowledgements
- 14-byte bus-tagged monitor frames

Implement v3, v4, periodic output, capture-all, and Wi-Fi Aware only when the
application needs them.

## 17. Mapping to can-opener-js

A Can Opener SE `VehicleTransport` maps:

- `VehicleRequest.txFrame.bus` to the v2 bus byte
- `VehicleRequest.txFrame.canId` to transmit CAN ID
- `VehicleRequest.txFrame.data` and `dlc` to the raw classic CAN frame
- response bounds and timeout to the v2 response fields
- `VehicleBatchRequest` to one or more v4 writes
- `MonitorControlRequest` to add, remove, or clear on `0xA003`
- monitor `0x81` frames to `CanFrame`
- `configureBus` to monitor opcode `0x08`

The transport must return the reassembled application payload, not the
`0xFEF4` envelope and not ISO-TP PCI bytes.

The transport is also responsible for security credentials and authorization,
because the generic library does not define credential storage or BLE pairing.
