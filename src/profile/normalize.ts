import type { ProfileValueNormalization } from "./types.js";

/** Multiplies a value in the first unit into the second. */
const UNIT_FACTORS: Record<string, number> = {
  "km>m": 1000,
};

const TRUE_LABELS: ReadonlySet<unknown> = new Set([true, 1, "on", "open", "true"]);
const FALSE_LABELS: ReadonlySet<unknown> = new Set([false, 0, "off", "closed", "false"]);

/**
 * Maps a decoded value through the profile's `enum`, then converts it to the
 * property's VSS datatype where it can. Returns `undefined` for an invalid
 * observation, which callers do not publish. `sourceUnit` is the unit the value was
 * decoded in, when known.
 */
export function applyValueNormalization(
  value: unknown,
  normalize: ProfileValueNormalization | undefined,
  sourceUnit?: string,
): unknown {
  if (normalize === undefined) {
    return value;
  }

  let result = value;
  const enumValue = normalize.enum?.[String(value)];
  if (enumValue !== undefined) {
    result = enumValue;
  } else if (normalize.strict === true) {
    return undefined;
  }

  if (normalize.datatype === "boolean") {
    if (TRUE_LABELS.has(result)) return true;
    if (FALSE_LABELS.has(result)) return false;
    return result;
  }
  if (typeof result === "number" && sourceUnit !== undefined && normalize.unit !== undefined) {
    return result * (UNIT_FACTORS[`${sourceUnit}>${normalize.unit}`] ?? 1);
  }
  return result;
}
