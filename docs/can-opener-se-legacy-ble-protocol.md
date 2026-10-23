# Can Opener SE Legacy BLE Formats

This document records the original single-bus BLE packet layouts for
compatibility with old clients and old firmware.

New transports should use the bus-aware formats in
[Can Opener SE BLE Transport Protocol](./can-opener-se-ble-protocol.md).

The bus-aware protocol was added on July 29, 2026 in firmware commit
`e0b3bc7`. Current firmware still accepts the original request and monitor
control layouts and routes them to CAN0.

All multibyte integers are little-endian.

## 1. Request-only packet

Write this 15-byte packet to `0xFEF4`:

```text
[0]       sequence
[1]       flags
[2..5]    transmit_can_id:u32
[6]       dlc, 0 through 8
[7..14]   data[8]
```

The packet has no bus byte and always targets CAN0.

As with the current request-only format, no notification reports success or
failure.

## 2. Request and response packet

Write this 25-byte packet to `0xFEF4`:

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

The packet has no bus byte and always targets CAN0. Responses use the same
`0xFEF4` notification envelope as current requests.

## 3. Monitor add and remove

Write to `0xA003`:

```text
[0]       opcode, 0x01 add or 0x02 remove
[1]       sequence
[2]       count
[3..]     count times can_id:u32
```

The command has no bus byte and modifies the CAN0 monitor table.

## 4. Clear monitors

Write to `0xA003`:

```text
03 sequence
```

This clears the CAN0 monitor table.

## 5. Original monitor frames

Old monitor notifications used opcode `0x81` with 13-byte frames:

```text
[0]       0x81
[1]       frame_count
[2..]     frames
```

Each frame:

```text
[0..3]    can_id:u32
[4]       dlc
[5..12]   data[8]
```

The frame has no bus byte and represents CAN0.

Current firmware emits 14-byte bus-tagged frames. A client only needs this
13-byte parser when it must connect to firmware from before the dual-CAN
protocol.

## 6. Compatibility guidance

- Do not emit these layouts from a new transport.
- Use the bus-aware packet even when selecting bus 0.
- Keep decoding support only when compatibility with old firmware is a product
  requirement.
- Do not infer support from the device name. Use the firmware revision or a
  controlled capability probe.
