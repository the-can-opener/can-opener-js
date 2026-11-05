export function assertLength(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) {
    throw new Error(`${what} must be ${length} bytes, got ${bytes.length}`);
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function writeU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
}

export function readU8(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return readU8(bytes, offset) | (readU8(bytes, offset + 1) << 8);
}

export function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = (value >>> 24) & 0xff;
}

export function readU32(bytes: Uint8Array, offset: number): number {
  return (readU16(bytes, offset) | (readU16(bytes, offset + 2) << 16)) >>> 0;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
