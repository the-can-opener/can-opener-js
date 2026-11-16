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
- `0x20`: ISO-TP extended or mixed addressing (section 5.1)
- `0x40`: send the request as CAN FD (section 8.1)
- `0x80`: ISO-TP receive options (section 5.2)

### 5.1 ISO-TP addressing

ISO 15765-2 extended and mixed addressing put one address byte in front of
the PCI of every frame in an exchange: single, first, consecutive and flow
control, in both directions. BMW diagnostics are the common case: the tester
sends to `0x6F1` with the ECU address first, and the ECU answers on `0x600`
plus its address with `F1`, the tester address, first.

Flag `0x20` enables this for one request. It adds two bytes directly before
`transmit_can_id` in the v2 and v3 layouts, and directly after `step_flags`
in a v4 step. Every later field moves back by two.

```text
[n]       tx_address    first byte of every frame sent to the ECU
[n+1]     rx_address    first byte of every frame the ECU sends back
```

Extended addressing sets `tx_address` to the target address and `rx_address`
to the source address. Mixed addressing sets both to the address extension.
The firmware does not distinguish the two.

With flag `0x20`:

- The firmware puts `tx_address` in front of the PCI of every frame it builds:
  v3 single, first and consecutive frames, and every flow control frame.
- A v2 or v4 step `data[8]` is still the ready-to-send frame, so the client
  places `tx_address` in `data[0]` and the PCI in `data[1]` itself.
- Only response frames whose first byte is `rx_address` belong to the
  exchange. Other frames in the response ID range are ignored. The firmware
  strips the address byte and the PCI; the notification payload is the
  application payload, as for normal addressing.
- Flow control for a multi-frame reply goes to `transmit_can_id` with
  `tx_address` first, `tx_address 30 00 00` padded to the frame size, for
  both 11-bit and 29-bit IDs. The `response_id - 8` rule of section 7.1 does
  not apply.
- The address byte takes one byte from every frame: a classic single frame
  carries 6 application bytes, a 12-bit first frame `tx_dl - 3`, a 32-bit
  first frame `tx_dl - 7`, a consecutive frame `tx_dl - 2`, and a `tx_dl` 64
  single frame 61 bytes laid out as `tx_address 00 length payload`.

The flag is valid only on layouts with a bus byte. A legacy packet with flag
`0x20` returns `0xE1`. Firmware older than this document ignores the flag and
misreads the longer layout, usually as `0xE1`.

### 5.2 ISO-TP receive options

Flag `0x80` sets, for one request, the flow control the firmware sends for a
multi-frame reply and the longest reply it accepts. It adds four bytes
directly after `bus` in the v2 and v3 layouts, and directly after
`step_flags` in a v4 step. Every later field moves back by four. When flag
`0x20` is also set, the options come first and the address pair of section
5.1 follows them.

```text
[n]       block_size
[n+1]     st_min
[n+2..3]  max_response_len:u16, 0 for no cap
```

With flag `0x80`:

- Flow control for a multi-frame reply is `30 block_size st_min`, padded to
  the frame size, in place of `30 00 00`. With flag `0x20` it is
  `tx_address 30 block_size st_min`. It goes to the CAN ID given by the rules
  of section 7.1.
- `block_size` 0 lets the ECU send the whole reply after one flow control.
  With any other value the ECU stops after that many consecutive frames, and
  the firmware sends the same flow control again for every block until the
  reply is complete. It sends none after the last consecutive frame.
- `st_min` is sent as given, in the ISO 15765-2 encoding: `0x00` through
  `0x7F` are milliseconds, and `0xF1` through `0xF9` are 100 through 900
  microseconds. The ECU does the pacing. The firmware does not check the gap
  between received frames.
- A reply longer than `max_response_len` returns `0xE6` with an empty
  payload. For a multi-frame reply the firmware decides from the length in
  the first frame and sends no flow control, so the ECU sends nothing more. A
  UDS response-pending frame, `7F service 78`, is not the reply and is never
  refused.
- `max_response_len` 0 sets no cap for the request. The 65535-byte limit of
  section 7.1 still applies, and a longer first frame is still answered with
  an overflow flow-control frame.

A request-only packet may carry the four bytes. They have no effect.

Packet lengths with flag `0x80`: v2 request-only 20 bytes, v2 request and
response 30 bytes, v3 `23 + payload_length`, CAN FD v3
`24 + payload_length`, and a v4 step 20 or 30 bytes. Flag `0x20` adds two
bytes to each.

The flag is valid only on layouts with a bus byte. A legacy packet with flag
`0x80` returns `0xE1`. Firmware through `v0.3.3` ignores the flag and
misreads the longer layout, usually as `0xE1`.

## 6. Classic request-only packets

The v2 packet explicitly selects a logical CAN bus:

```text
[0]       sequence
[1]       flags
[2]       bus
[3..6]    transmit_can_id:u32
[7]       dlc, 0 through 8
[8..15]   data[8]
```

Total length is 16 bytes. With flag `0x20` the two address bytes of section
5.1 follow `bus`, every later field moves back by two, and the total length is
18 bytes. The frame is sent unchanged, so the addresses only have to be
present.

With flag `0x80` the four option bytes of section 5.2 follow `bus`, ahead of
any address pair, and the total length is 20 bytes, or 22 with flag `0x20`.
The options have no effect on a request-only packet.

A normal request-only packet produces no notification. This includes failures
such as an unavailable bus, invalid DLC, invalid CAN ID, and transmit failure.
Use a response request or a batch when the app needs a transport result.

## 7. Classic request and response packets

The v2 packet explicitly selects a logical CAN bus:

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

With flag `0x20` (section 5.1):

```text
[0]       sequence
[1]       flags, bits 0 and 5 set
[2]       bus
[3]       tx_address
[4]       rx_address
[5..8]    transmit_can_id:u32
[9..12]   response_id_start:u32
[13..16]  response_id_end:u32
[17..18]  timeout_ms:u16
[19]      dlc, 0 through 8
[20..27]  data[8]
```

Total length is 28 bytes. `data[0]` must be `tx_address` and `data[1]` the
PCI. Example, BMW VIN request to the engine ECU at address `0x12`:

```text
2B 21 00
12 F1
F1 06 00 00
12 06 00 00
12 06 00 00
F4 01
08
12 03 22 F1 90 00 00 00
```

The ECU answers `612: F1 10 14 62 F1 90 ...`, the firmware sends
`6F1: 12 30 00 00 00 00 00 00`, and the notification payload begins
`62 F1 90`.

With flag `0x80` (section 5.2):

```text
[0]       sequence
[1]       flags, bits 0 and 7 set
[2]       bus
[3]       block_size
[4]       st_min
[5..6]    max_response_len:u16
[7..10]   transmit_can_id:u32
[11..14]  response_id_start:u32
[15..18]  response_id_end:u32
[19..20]  timeout_ms:u16
[21]      dlc, 0 through 8
[22..29]  data[8]
```

Total length is 30 bytes. With flags `0x20` and `0x80` together,
`tx_address` and `rx_address` sit at `[7..8]`, every later field moves back
by two more, and the total length is 32 bytes.

Example, UDS `19 02 FF` to `0x18DA80F1` with block size 8, STmin 2 ms, and
replies above 1024 bytes refused. Flags are `0x87`: expect a reply `0x01`,
29-bit transmit ID `0x02`, 29-bit response ID `0x04`, and receive options
`0x80`.

```text
2B 87 00
08 02 00 04
F1 80 DA 18
80 F1 DA 18
80 F1 DA 18
DC 05
08
03 19 02 FF 00 00 00 00
```

The firmware answers the first frame with
`18DA80F1: 30 08 02 00 00 00 00 00` and repeats it after every eighth
consecutive frame. A first frame that declares more than 1024 bytes gets no
flow control, and the notification is `0xE6` with an empty payload.

With flag `0x40`, the same 8 bytes go out unchanged as one CAN FD frame, and
flow control for a multi-frame reply is an 8-byte FD frame. `dlc` must be `8`;
any other value returns `0xE2`. This is the `tx_dl` 8 shortcut of section 8.1.
It cannot send a frame longer than 8 bytes.

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
- flow-control CTS and overflow
- UDS response pending, `7F service 78`
- responses through 65535 application bytes, including the 32-bit length above 4095
- BLE response fragmentation

A 12-bit first-frame length carries up to 4095 bytes. A longer message uses a
zero 12-bit length and a 32-bit length. The firmware reassembles 4096 through
65535 bytes, which is the largest length a 16-bit BLE fragment offset can
address. A 32-bit length above 65535 returns `0xE6` with an empty payload,
after an overflow flow-control frame (`0x32`, block size 0, STmin 0) so the
sender stops. A zero 12-bit length that does not encode a length above 4095
returns `0xE5` with an empty payload, after the same overflow flow-control
frame.

A consecutive frame still on the bus before a single frame or first frame of
this exchange is ignored; the firmware keeps waiting. Once a first frame has
been accepted, a frame that is not the next consecutive frame returns `0xE5`
immediately, also with an empty payload. The firmware does not skip that
frame and continue.

For a multi-frame standard 11-bit response, the firmware sends flow control to
`matched_response_id - 8`. This matches standard OBD-II addressing, such as
`0x7E8` to `0x7E0`.

For an extended response, flow control uses the original transmit CAN ID.

Important compatibility restriction: a nonstandard 11-bit request and response
pair must follow the `response_id - 8` convention for multi-frame responses.
For example, request `0x745` and response `0x765` will receive flow control at
`0x75D`, not at `0x745`. Single-frame responses are unaffected.

With flag `0x20`, flow control always uses the original transmit CAN ID with
`tx_address` first, and only frames starting with `rx_address` are read
(section 5.1).

Without flag `0x80`, the flow control for a reply the firmware accepts is
`30 00 00`: block size 0 and STmin 0, so the ECU sends the whole reply
without pausing. Flag `0x80` sets the block size and STmin for one request,
and can refuse a reply above a chosen length (section 5.2).

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
[17..18]  payload_length:u16, 1 through 65535
[19..]    application_payload
```

When `19 + payload_length` fits in one 244-byte BLE write, the write carries
the entire payload and the firmware runs the ISO-TP exchange immediately.

When `19 + payload_length` exceeds one 244-byte BLE write (`payload_length` up
to 65535 bytes), the first write carries the header plus the first slice of
`application_payload`, and the remaining bytes follow in consecutive writes
for the same `sequence`:

```text
[0]       sequence
[1]       flags (0x08, or the initial request flags)
[2..3]    fragment_offset:u16
[4..]     application_payload[fragment_offset..]
```

As soon as `fragment_offset + chunk_length == payload_length`, the firmware
transmits the full ISO-TP request on CAN and returns the request notification
for `sequence`. A zero length or an out-of-order `fragment_offset` aborts the
transfer and returns `0xE1`. The length field is 16 bits, so 65535 is the
largest request the packet can name, and that length fits the staging buffer.

The firmware adds the ISO-TP PCI and segments the payload. A payload that fits
in one single frame is sent as one frame. Up to 4095 bytes, a longer payload
is a first frame with a 12-bit length, carrying 6 application bytes on classic
CAN. From 4096 through 65535 bytes the first frame uses a zero 12-bit length
and a 32-bit length, carrying 2 application bytes on classic CAN. Consecutive
frames follow. Flag `0x20` shortens every frame by the address byte (section
5.1). The firmware obeys ECU flow control, including block size and STmin, and
optionally waits for a reassembled response. An ECU flow-control overflow
returns `0xE6`. Set flag `0x01` when a response is expected.

With flag `0x20` the two address bytes of section 5.1 follow `bus`, every
later field moves back by two, and a single-write packet has length
`21 + payload_length`. The payload stays application bytes; the firmware puts
`tx_address` in front of the PCI of every frame it sends and reads flow
control and reply frames only when they start with `rx_address`.

```text
[0]       sequence
[1]       flags, bits 3 and 5 set
[2]       bus
[3]       tx_address
[4]       rx_address
[5..8]    transmit_can_id:u32
[9..12]   response_id_start:u32
[13..16]  response_id_end:u32
[17..18]  timeout_ms:u16
[19..20]  payload_length:u16, 1 through 65535
[21..]    application_payload
```

With flags `0x08 | 0x20 | 0x40`, `tx_dl` sits at `[19]`, `payload_length` at
`[20..21]`, and the payload starts at `[22]` (`22 + payload_length` when sent
in one write).

With flag `0x80` the four option bytes of section 5.2 sit at `[3..6]`, ahead
of any address pair, and every later field moves back by four more:
`transmit_can_id` at `[7..10]`, `payload_length` at `[21..22]`, and a
single-write packet of length `23 + payload_length`. Continuation writes keep
their 4-byte header and do not repeat the options.

Every completed v3 request returns a request notification, including a
request-only v3 request. The notification reports its final transport status.

Profile `send` is one classic CAN frame, so a classic `VehicleRequest` maps to
v2. A `VehicleRequest` with `canFd.txDl` 64 maps to v3 with flag `0x40`
(section 8.1). A custom application may use v3 directly.

### 8.1 CAN FD v3 request

Set flags `0x08 | 0x40`. One byte is inserted after the timeout:

```text
[0]       sequence
[1]       flags
[2]       bus
[3..6]    transmit_can_id:u32
[7..10]   response_id_start:u32
[11..14]  response_id_end:u32
[15..16]  timeout_ms:u16
[17]      tx_dl, 8 or 64
[18..19]  payload_length:u16, 1 through 65535
[20..]    application_payload, without PCI
```

A single-write packet has length `20 + payload_length`; payloads larger than
one 244-byte BLE write stream their remaining bytes with the 4-byte
continuation header of section 8. Any other
`tx_dl` returns `0xE2`. Without flag `0x40`, v3 is the classic layout above.

The firmware pads every frame it sends, including flow control, with `0x00` to
`tx_dl`:

- `tx_dl` 8 uses the classic PCI in an 8-byte FD frame. `02 01 0D` is sent as
  `02 01 0D 00 00 00 00 00`.
- `tx_dl` 64 uses ISO 15765-2:2016. A payload of up to 62 bytes is one frame
  `00 LL` followed by the payload. A longer payload up to 4095 bytes is a
  first frame with 62 data bytes. A payload of 4096 through 65535 bytes is a
  first frame with a zero 12-bit length and a 32-bit length, carrying 58 data
  bytes. Consecutive frames carry 63 data bytes.

The firmware sets the bit-rate switch bit only when the bus data bitrate is
non-zero and differs from the nominal bitrate. Configure the bus first with
monitor opcode `0x08` (section 11.6). With data bitrate `0`, the request is
FD format at the nominal rate, and an ECU that expects bit-rate switch may not
decode it.

Replies are parsed by their decoded frame length, with the length and sequence
rules in section 7.1. A frame of 8 bytes or less uses the classic PCI, FD or
not. A longer frame uses the 2016 layout: a single frame is `00 LL` followed
by the payload, a first frame keeps the 12-bit length and carries `length - 2`
data bytes (`length - 6` when the 12-bit length is zero and the 32-bit length
follows), and a consecutive frame carries `length - 1` data bytes. The
notification payload is the reassembled application payload without PCI.

Example, OBD-II speed on bus 0 with `tx_dl` 64:

Flags are `0x49`: expect a reply `0x01`, v3 payload `0x08`, and CAN FD `0x40`.

```text
2A 49 00
DF 07 00 00
E8 07 00 00
EF 07 00 00
F4 01
40
02 00
01 0D
```

The CAN frame is `00 02 01 0D` followed by 60 bytes of `00`.

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
- `0x20`: ISO-TP extended or mixed addressing (section 5.1)
- `0x40`: send the 8 bytes as one CAN FD frame; `dlc` must be `8`
- `0x80`: ISO-TP receive options (section 5.2)

If the step expects a response, append:

```text
[16..19]  response_id_start:u32
[20..23]  response_id_end:u32
[24..25]  timeout_ms:u16
```

With step flag `0x20`, `tx_address` and `rx_address` follow `step_flags` and
every later field moves back by two: `transmit_can_id` at `[3..6]`, `dlc` at
`[7]`, `data` at `[8..15]`, `post_delay_ms` at `[16..17]`, and the response
fields, when present, at `[18..27]`. `data[0]` must be `tx_address`. Each
step chooses its own addressing, so a batch may mix addressed and normal
steps.

With step flag `0x80`, `block_size`, `st_min` and `max_response_len` follow
`step_flags` at `[1..4]` and every later field moves back by four:
`transmit_can_id` at `[5..8]`, `dlc` at `[9]`, `data` at `[10..17]`,
`post_delay_ms` at `[18..19]`, and the response fields, when present, at
`[20..29]`. With step flags `0x20` and `0x80` together, the address pair
follows the options at `[5..6]` and later fields move back by two more. Each
step carries its own options, and they apply to that step's reply only.

A zero response timeout selects the firmware default of 1000 ms.

Batch limits:

- at most 14 steps
- at most 244 total BLE bytes
- one logical bus
- at most 30,000 ms total of response timeouts and post-step delays
- at most 65535 bytes in the combined result; a step whose response would
  not fit is reported as `0xE6` with an empty payload

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

A transport can probe with its first batch, then fall back to sequential v2
writes after an unsupported response or a short capability timeout. Do not
retry a batch after an ambiguous link timeout unless repeating its actions is
safe.

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
- `0xE5`: invalid ISO-TP exchange. This includes a zero 12-bit first-frame
  length that does not encode a length above 4095, and a consecutive frame
  whose sequence number is not the next expected value. The payload is empty.
- `0xE6`: ISO-TP payload overflow. This includes a 32-bit response length
  above 65535, a v4 step whose response would push the combined result past
  65535 bytes, an ECU flow-control overflow, and a reply longer than the
  `max_response_len` of flag `0x80`. The payload is empty. A response longer
  than 65535 is answered with an overflow flow-control frame before this
  status. A reply refused by `max_response_len` gets no flow control.
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
65535-byte maximum before returning the payload.

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

```text
[0]       opcode, 0x01 add or 0x02 remove
[1]       sequence
[2]       bus
[3]       count
[4..]     count times can_id:u32
```

### 11.2 Clear one bus

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

Firmware replies only when auto-detection finishes. It listens for 250 ms per
candidate rate, so on a silent bus the reply arrives after about 2.5 s. A
client must wait at least that long before treating the command as timed out.

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

Monitor data does not carry an explicit extended-ID flag. IDs above `0x7FF`
are necessarily extended. Avoid depending on an extended frame whose numeric
ID is `0x7FF` or less.

## 14. Bus and CAN limitations

Current firmware implements:

- logical bus `0`
- logical bus `1`
- classic CAN request payloads up to eight bytes
- CAN FD diagnostic requests and replies with `tx_dl` 8 or 64 (section 8.1)
- ISO-TP application requests and responses up to 65535 bytes, including
  messages that use the 32-bit ISO-TP length
- multi-write v3 ISO-TP requests across 244-byte BLE writes (section 8)

Monitor and capture records carry at most 8 data bytes. A longer FD frame on
the live stream shows its first 8 bytes and reports a DLC of 8.

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

- v2 packets select a bus explicitly
- v3 carries an ISO-TP application payload
- request flag `0x40` sends CAN FD; older firmware ignores the flag, sends v2
  as classic frames, and misreads the longer v3 layout (usually `0xE1`)
- request flag `0x20` adds ISO-TP extended or mixed addressing; older
  firmware ignores the flag and misreads the two-byte-longer layouts
  (usually `0xE1`)
- request flag `0x80` adds ISO-TP receive options: flow-control block size
  and STmin, and a reply length cap. Firmware through `v0.3.3` ignores the
  flag and misreads the four-byte-longer layouts (usually `0xE1`)
- ISO-TP messages longer than 4095 bytes use a zero 12-bit first-frame length
  and a 32-bit length. Older firmware returns `0xE5` for that first frame and
  `0xE6` for a v3 `payload_length` above 4095. A consecutive-frame sequence
  error returns `0xE5` immediately; older firmware skipped the unexpected
  frame and kept waiting.
- v4 carries classic CAN batches
- monitor opcode `0x04` enables BLE capture-all
- monitor opcode `0x05` enables Wi-Fi Aware
- monitor opcode `0x08` configures timing
- security authorization uses `0xA005`

Clients should implement:

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

`CanOpenerBleTransport` from `can-opener-js/ble` implements this mapping over a
`CanOpenerGattLink`, the small write/subscribe/disconnect interface a BLE stack
adapter provides (`can-opener-js/react-native-ble` ships one for
react-native-ble-plx). It maps:

- `VehicleRequest.txFrame.bus` to the v2 bus byte
- `VehicleRequest.txFrame.canId` to transmit CAN ID
- `VehicleRequest.txFrame.data` and `dlc` to the raw classic CAN frame
- response bounds and timeout to the v2 response fields
- `VehicleRequest.canFd` `{ txDl: 8 }` to the v2 packet with flag `0x40`;
  profiles produce it for endpoints with `tx_dl` 8 and for inline actions on an
  FD bus
- `VehicleRequest.canFd` `{ txDl: 64, payload }` to a v3 packet with flags
  `0x08 | 0x40`, `tx_dl` 64, and `payload` as the application payload
- `VehicleBatchRequest` to one or more v4 writes; a `txDl` 8 step sets step
  flag `0x40`, and a `txDl` 64 step cannot be batched
- `VehicleRequest.isotpAddressing` `{ tx, rx }` to flag `0x20` with
  `tx_address = tx` and `rx_address = rx` in the v2, v3 or v4 step layout;
  `txFrame.data` already starts with `tx`, so a v2 frame is sent as given
- `MonitorControlRequest` to add, remove, or clear on `0xA003`
- monitor `0x81` frames to `CanFrame`
- `configureBus` to monitor opcode `0x08`

`CanOpenerBleTransport` does not set request flag `0x80`. Its requests get
flow control `30 00 00` and no reply length cap.

The transport must return the reassembled application payload, not the
`0xFEF4` envelope and not ISO-TP PCI bytes.

Authorization on `0xA005` must finish before the transport enables the vehicle
notifications. Pass `authorize: credentialAuthorizer(store)` from
`can-opener-js/security`: it proves one of the keys in the app's
`CredentialStore`, saves what the adapter reported, and waits for the OS
pairing to finish. The app still owns credential storage; a
`SecurityWritePolicy` (for example `bleplxSecurityWritePolicy`) covers the
platform-specific pairing errors. Claiming a new adapter and managing guests
use `SecuritySession` through `withSecuritySession` or the transport's
`accessSession`.
