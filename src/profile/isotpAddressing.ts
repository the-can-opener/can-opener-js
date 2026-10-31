import type { IsotpAddressBytes } from "../transport/types.js";
import type { IsotpAddressing, ProfileEndpoint } from "./types.js";

/** The address byte each direction carries for an endpoint's addressing mode. */
export function isotpAddressBytes(addressing: IsotpAddressing): IsotpAddressBytes {
  switch (addressing.mode) {
    case "extended":
      return { tx: addressing.targetAddress, rx: addressing.sourceAddress };
    case "mixed":
      return { tx: addressing.addressExtension, rx: addressing.addressExtension };
    default: {
      const unhandled: never = addressing;
      throw new Error(`Unknown ISO-TP addressing mode ${String(unhandled)}`);
    }
  }
}

/** The `isotpAddressing` field of a `VehicleRequest` sent to `endpoint`, or nothing for normal addressing. */
export function isotpAddressingFields(
  endpoint: Pick<ProfileEndpoint, "addressing"> | undefined,
): { isotpAddressing?: IsotpAddressBytes } {
  return endpoint?.addressing === undefined ? {} : { isotpAddressing: isotpAddressBytes(endpoint.addressing) };
}

/** Where the ISO-TP PCI sits in a frame: after the address byte when the exchange is addressed, otherwise first. */
export function isotpPciOffset(addressing: IsotpAddressing | IsotpAddressBytes | undefined): 0 | 1 {
  return addressing === undefined ? 0 : 1;
}
