# Can Opener SE Security Protocol

This document defines authorization on the Can Opener SE security
characteristic, `0xA005`.

Link encryption and authorization are separate:

- BLE LE Secure Connections protects the radio link.
- The protocol in this document decides which phone may use the adapter.

Every connection must authorize before using CAN request or monitor
characteristics. Private keys remain on phones. The adapter stores public
keys.

All multibyte integers are little-endian. Context strings are ASCII bytes
without a null terminator.

## 1. Keys and roles

The Admin is the first phone to claim an adapter. Its Ed25519 public key is
stored as user `0`.

A guest has:

- its own Ed25519 key
- a positive user ID
- a label of at most 16 UTF-8 bytes

Guests may use CAN requests and monitors. They cannot list guests, issue
invites, cancel invites, or remove other guests.

The adapter also creates an X25519 box key when claimed. An Admin seals guest
invites to this box key.

## 2. BLE connection rules

`0xA005` supports Write with Response and Notify.

Clients must:

1. Negotiate an ATT MTU of at least 70.
2. Subscribe to `0xA005` notifications.
3. Send one security request at a time, or correlate responses by opcode and
   sequence.
4. Pair before claim when the adapter is unclaimed.
5. Authenticate before pairing only when a claimed adapter does not yet
   approve this phone.
6. Use the CAN characteristics only after authorization and any required
   pairing succeed.

Guest redemption writes are about 330 bytes. The BLE stack must support ATT
prepare and execute long writes. Security requests may be up to 512 bytes.

An unencrypted `0xA005` write normally fails with ATT `0x0F`, Insufficient
Encryption, causing the operating system to pair. A new phone connecting to a
claimed adapter is allowed to send `AUTH_BEGIN` and `AUTH_PROVE` before
pairing so that the adapter can decide whether to request pairing.

An unauthorized connection is closed after 60 seconds. A phone that must
prove before pairing has 15 seconds. Three failed proofs also close the
connection.

## 3. Packet envelope

Request:

```text
[0]     opcode
[1]     sequence
[2..]   request payload
```

Response notification:

```text
[0]     opcode | 0x80
[1]     sequence
[2]     status
[3..]   response payload
```

Opcodes:

- `0x01` `CLAIM`
- `0x02` `AUTH_BEGIN`
- `0x03` `AUTH_PROVE`
- `0x20` `LIST_GUESTS`
- `0x21` `REMOVE_GUEST`
- `0x22` `CANCEL_INVITE`

Statuses:

- `0x00` `ok`
- `0x01` `bad_length`
- `0x02` `unknown_opcode`
- `0x03` `not_in_pairing_mode`
- `0x04` `already_claimed`
- `0x05` `not_authorized`
- `0x06` `bad_proof`
- `0x07` `guest_list_full`
- `0x08` `unknown_key`
- `0x09` `internal_error`
- `0x0A` `provisioning_required`
- `0x0B` `invite_used`

Roles:

- `0x01` Admin
- `0x02` guest

## 4. Claiming an adapter

Claim request:

```text
opcode  = 0x01
payload = admin_public_key[32]
          optional provisioning_verification[32]
```

Successful response payload:

```text
device_id[16]
box_public_key[32]
```

Claim is accepted only while the adapter is unclaimed and its pairing window
is open. It stores the Admin key, creates a random device ID, creates the box
key, authorizes the connection, and closes the pairing window.

The client generates a random 32-byte Ed25519 seed and stores it securely.
Only its 32-byte public key is sent to the adapter.

### 4.1 Provisioning key

An adapter may be built with `CONFIG_CO_PROVISIONING_KEY`. It stores the
SHA-256 hash of that UTF-8 key.

For a provisioned adapter:

```text
provisioning_hash = SHA-256(UTF8(provisioning_key))
verification      = HMAC-SHA256(
  provisioning_hash,
  ASCII("CO-CLAIM-v1") || admin_public_key
)
```

Send the 32-byte verification after the Admin public key. Omitting it returns
`0x0A`. A wrong value returns `0x06`.

Test vector:

```text
provisioning_key  CANOPENER-TEST
SHA-256           4499bf24388ac4eac510b62068c4cdd1bf66e702c5796959156c1aa9cbc5e92e
admin_public_key  03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8
verification      7c0d6dc9747c40c45dff8cf3ace95912fc585648293796347efbe37bd63e7025
```

## 5. Authenticating on every connection

Authentication has two requests.

### 5.1 AUTH_BEGIN

Request:

```text
[0] 0x02
[1] sequence
```

Successful response payload:

```text
nonce[16]
device_id[16]
box_public_key[32]
```

The client must compare `device_id` with its stored credential before signing.

### 5.2 AUTH_PROVE

Create the authentication message:

```text
message = ASCII("CO-AUTH-v2")
          || nonce
          || device_id
          || phone_public_key

signature = Ed25519(phone_seed, message)
```

Request payload:

```text
[0..31]    phone_public_key[32]
[32..95]   signature[64]
[96..97]   credential_length:u16
[98..]     credential[credential_length]
```

A known Admin or guest key sends `credential_length = 0`.

A new guest sends the redemption credential described in section 7.

Successful response:

```text
[0]      role
[1..4]   user_id:u32
```

The challenge is single-use. Start again with `AUTH_BEGIN` after any failed or
lost `AUTH_PROVE` result.

Authentication signature vector:

```text
seed       000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
public_key 03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8
nonce      404142434445464748494a4b4c4d4e4f
device_id  808182838485868788898a8b8c8d8e8f
signature  719865296dc5a09915db68740e1f84ab8b15abae441d6752b570f22585ddbe12
           8aa668b1c5409afe592617358cadfd9a223c23f1be87f26131853de9b37f1104
```

## 6. Creating a guest invite

The Admin creates invites offline. It needs:

- its Ed25519 seed
- the adapter device ID
- the adapter box public key
- an unused positive user ID
- a label

Generate a fresh 32-byte Ed25519 invite seed and its public key.

Invite body:

```text
[0]          version = 0x01
[1..4]       user_id:u32
[5..36]      invite_public_key[32]
[37]         label_length, 0 through 16
[38..]       UTF-8 label
[..+64]      admin_signature[64]
```

The Admin signs:

```text
admin_message   = ASCII("CO-INVITE-v1")
                  || device_id
                  || body_before_admin_signature

admin_signature = Ed25519(admin_seed, admin_message)
```

### 6.1 Sealing

Generate a fresh X25519 ephemeral secret for every invite.

```text
ephemeral_public_key = X25519-Base(ephemeral_secret)
shared               = X25519(ephemeral_secret, box_public_key)
seal_key              = HMAC-SHA256(
  shared,
  ASCII("CO-SEAL-v1") || ephemeral_public_key || box_public_key
)
```

Seal with ChaCha20-Poly1305-IETF:

```text
nonce         = 12 zero bytes
aad           = device_id
plaintext     = invite_body
sealed_invite = ephemeral_public_key[32] || ciphertext || tag[16]
```

A fresh ephemeral key makes the fixed nonce safe. Reject an all-zero X25519
shared secret.

The sealed invite is 154 through 166 bytes.

### 6.2 Invite link

The Can Opener link format is:

```text
canopenerapp://invite?t=<token>
```

The token is unpadded base64url of:

```text
0x01 || device_id[16] || invite_seed[32] || sealed_invite
```

The token contains a single-use secret. Treat it like a key until redeemed or
cancelled.

## 7. Redeeming an invite

The guest reads the invite token, generates a fresh Ed25519 phone seed, and
starts normal authentication.

For the nonce returned by `AUTH_BEGIN`:

```text
redeem_message = ASCII("CO-REDEEM-v1")
                 || nonce
                 || device_id
                 || guest_public_key

redeem_signature = Ed25519(invite_seed, redeem_message)
```

AUTH_PROVE credential:

```text
[0]       version = 0x01
[1..64]   redeem_signature[64]
[65..]    sealed_invite
```

Set `credential_length` to the exact credential byte length.

The adapter:

1. Verifies the guest authentication signature.
2. Opens the sealed invite with its box key.
3. Verifies the Admin signature.
4. Verifies the redemption signature.
5. Rejects an already used or cancelled ID with `0x0B`.
6. Returns `0x07` if all guest slots are full, without consuming the invite.
7. Marks the ID used and stores the guest.

If the response is lost after the guest was stored, repeating authentication
with the same guest key and credential succeeds because the key is now known.

## 8. Invite ID window

The adapter tracks:

```text
low:u32
next:u32
bits:u64
```

Every ID below `low` is used. Bit `i` marks `low + i` used.

An invite can still be redeemed only when:

```text
user_id >= low
user_id < low + 64
bit(user_id - low) is clear
```

Using a far-ahead ID slides the window and retires older unused IDs. An Admin
should choose the greater of:

- `next_invite_id` from `LIST_GUESTS`
- one more than the highest invite ID that this Admin installation issued

## 9. Managing guests

### 9.1 LIST_GUESTS

Admin request:

```text
[0]      0x20
[1]      sequence
[2..3]   start:u16
```

Successful response payload:

```text
[0..1]    total:u16
[2..3]    capacity:u16
[4..7]    next_invite_id:u32
[8..11]   used_low:u32
[12..19]  used_bits:u64
[20]      count

repeat count times:
  [0..3]  user_id:u32
  [4]     flags
  [5]     label_length
  [6..]   UTF-8 label
```

Guest flags:

- `0x01`: a phone is bonded for this key
- `0x02`: that phone is currently connected

Request pages with `start + count` until the next start is at least `total`.

### 9.2 REMOVE_GUEST

Request:

```text
[0]      0x21
[1]      sequence
[2..5]   user_id:u32
```

An Admin may remove any guest. A guest may remove itself. Removing a missing
guest returns success to the Admin, which makes retries safe. The user ID
stays used.

### 9.3 CANCEL_INVITE

Admin request:

```text
[0]      0x22
[1]      sequence
[2..5]   user_id:u32
```

The adapter marks the ID used. Cancelling an already used ID succeeds. User
`0` is invalid.

## 10. Advertising identity

The BLE advertisement includes an eight-byte prefix of `device_id` for a
claimed adapter. Apps use this prefix to choose a stored credential before
connecting.

The complete manufacturer data format is specified in
[Can Opener SE BLE Protocol](./can-opener-se-ble-protocol.md).

Do not use the BLE address as the permanent application identity. Factory
reset changes it.

## 11. Phone storage

A phone stores at least:

```text
device_id[16]
role
Ed25519 seed[32]
```

It should also retain:

- user ID learned from `AUTH_PROVE`
- adapter box public key
- Admin-issued invite links that may need to be shared again
- the highest invite ID issued by that installation

Store private seeds in the platform keystore. A backup that contains a seed
grants that key's access to its holder.

## 12. Can Opener backup code

The Can Opener app represents one credential as a `CO2` backup code.

Build 50 bytes:

```text
[0..15]   device_id[16]
[16]      role, 0x01 Admin or 0x02 guest
[17..48]  Ed25519 seed[32]
[49]      first byte of SHA-256(bytes 0 through 48)
```

Encode all 50 bytes with this Crockford base32 alphabet:

```text
0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

Prefix `CO2` and split the 80 encoded characters into groups of five:

```text
CO2-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
```

Decoders should:

- ignore ASCII whitespace and hyphens
- accept either letter case
- treat `O` as `0`
- treat `I` and `L` as `1`
- require exactly 50 decoded bytes
- verify the checksum byte
- reject unknown roles

The backup intentionally omits user ID, box public key, and pending invite.
The client learns user ID and box public key during its next authentication.

Legacy `CO1` codes used a different security model and do not work with this
protocol.

## 13. Reset and key migration

One key slot is associated with at most one bonded phone. A new phone that
proves a restored key takes over that slot. The adapter deletes the previous
phone's bond.

Holding BOOT for five seconds erases:

- Admin and guest keys
- invite state
- bonds
- device ID
- static BLE address

The provisioning key survives. After reset, clients must treat the adapter as
a new device.
