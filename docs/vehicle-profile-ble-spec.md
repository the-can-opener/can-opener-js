# Can Opener Specifications

The former combined vehicle profile and BLE document has been separated by
responsibility.

## Library and profile standard

[can-opener-js Vehicle Profile and Library Specification](./vehicle-profile-spec.md)

Use this document for:

- `can-opener-js` concepts and API boundaries
- YAML vehicle profiles
- DBC responsibilities
- standard capability names
- queries, actions, sequences, and signals
- the `VehicleTransport` contract

## Can Opener SE BLE transport

[Can Opener SE BLE Transport Protocol](./can-opener-se-ble-protocol.md)

Use this document for:

- GATT service and characteristics
- advertising
- CAN request and response packets
- batches and fragmentation
- monitor control and monitor data
- CAN timing
- Wi-Fi Aware streaming
- mapping the firmware protocol to `VehicleTransport`

## Access control

[Can Opener SE Security Protocol](./can-opener-se-security-protocol.md)

Use this document for:

- adapter claim and provisioning
- per-connection authentication
- Ed25519 and X25519 constructions
- guest invites and redemption
- guest management
- credential storage and reset behavior

An app for current Can Opener SE firmware needs both BLE protocol documents.
An app that also uses `can-opener-js` needs the library and profile
specification.
