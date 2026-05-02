import type { ProfileValueNormalization } from "./types.js";

export function applyValueNormalization(
  value: unknown,
  normalize: ProfileValueNormalization | undefined,
): unknown {
  if (normalize === undefined) {
    return value;
  }

  const enumValue = normalize.enum?.[String(value)];
  if (enumValue !== undefined) {
    return enumValue;
  }

  return value;
}
