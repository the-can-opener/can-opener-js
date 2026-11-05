import { bytesToHex, readU8, readU16 } from "./bytes.js";
import type { DeviceCredential } from "./credentials.js";

/** BLE advertisements carry this name prefix (case-insensitive). */
export const CAN_OPENER_DEVICE_NAME_PREFIX = "canopener";
export const ADVERTISED_DEVICE_ID_PREFIX_LENGTH = 8;

// Manufacturer data: `company_id:u16le, format_version, flags, device_id_prefix[8]`.
const ADV_COMPANY_ID = 0xffff;
const ADV_FORMAT_VERSION = 0x01;
const ADV_FLAG_PAIRING = 0x01;
const ADV_FLAG_CLAIMED = 0x02;
const ADV_MFG_DATA_LENGTH = 4 + ADVERTISED_DEVICE_ID_PREFIX_LENGTH;

export interface AdapterAdvertisement {
  pairingMode: boolean;
  claimed: boolean;
  /** First 8 bytes of the device ID as lowercase hex; null while unclaimed. */
  deviceIdPrefix: string | null;
}

export function isCanOpenerDeviceName(name: string): boolean {
  return name.toLowerCase().startsWith(CAN_OPENER_DEVICE_NAME_PREFIX);
}

/** Parses the adapter's manufacturer data; null for anything else. */
export function parseAdapterAdvertisement(
  manufacturerData: Uint8Array | null | undefined,
): AdapterAdvertisement | null {
  if (
    manufacturerData == null ||
    manufacturerData.length < ADV_MFG_DATA_LENGTH ||
    readU16(manufacturerData, 0) !== ADV_COMPANY_ID ||
    readU8(manufacturerData, 2) !== ADV_FORMAT_VERSION
  ) {
    return null;
  }

  const flags = readU8(manufacturerData, 3);
  const claimed = (flags & ADV_FLAG_CLAIMED) !== 0;
  return {
    pairingMode: (flags & ADV_FLAG_PAIRING) !== 0,
    claimed,
    deviceIdPrefix: claimed ? bytesToHex(manufacturerData.slice(4, ADV_MFG_DATA_LENGTH)) : null,
  };
}

/** Whether a stored credential belongs to the adapter that sent `advertisement`. */
export function credentialMatchesAdvertisement(
  credential: DeviceCredential,
  advertisement: AdapterAdvertisement | null,
): boolean {
  return advertisement?.deviceIdPrefix != null && credential.deviceId.startsWith(advertisement.deviceIdPrefix);
}
