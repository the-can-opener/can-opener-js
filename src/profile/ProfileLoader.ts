import {
  isSupportedProfileFormatVersion,
  loadFormat1,
  readProfileFormatVersion,
} from "./loaders/format1.js";
import { loadFormat2, readManifestVersion } from "./loaders/format2.js";
import { mapUpFormat1 } from "./loaders/mapUp.js";
import type { LoadedVehicleProfile, ProfileProperty, ProfileWrite, VehicleProfileSource } from "./types.js";

export {
  ACTION_VALUE_SEPARATOR,
  SUPPORTED_PROFILE_VERSIONS,
  actionName,
  isSupportedProfileFormatVersion,
  mergeProfileCanBusConfigs,
  normalizeProfileFormatVersion,
  readProfileFormatVersion,
} from "./loaders/format1.js";

/**
 * Picks the loader for each source by the format its YAML declares. A
 * `manifest: 1` package is format 2, the default. A `version: 1` or `1.1`
 * profile is format 1 and is mapped onto VSS paths with the spec vocabulary.
 */
/**
 * Parses one source and applies its allow-list. Unlike {@link ProfileLoader.load},
 * this still returns a package whose `depends` entry is not loaded yet, so a
 * caller can read the actions and queries an add-on declares.
 */
export function readProfileSource(source: VehicleProfileSource): LoadedVehicleProfile | undefined {
  const profile = loadSource(source);
  if (profile === undefined) return undefined;
  return applyAllowedKeys(profile, source.allowedKeys);
}

export class ProfileLoader {
  load(sources: readonly VehicleProfileSource[]): LoadedVehicleProfile[] {
    const loaded: LoadedVehicleProfile[] = [];
    for (const source of sources) {
      const profile = loadSource(source);
      if (profile === undefined) {
        continue;
      }
      const missing = profile.depends?.find((id) => !loaded.some((earlier) => earlier.id === id));
      if (missing !== undefined) {
        console.warn(
          `Skipping vehicle profile ${source.name}: it depends on ${missing}, which is not loaded before it.`,
        );
        continue;
      }
      loaded.push(applyAllowedKeys(profile, source.allowedKeys));
    }
    return loaded;
  }
}

function loadSource(source: VehicleProfileSource): LoadedVehicleProfile | undefined {
  const manifest = readManifestVersion(source.content);
  if (manifest === 1) {
    return loadFormat2(source);
  }
  // Leave every other format untouched. One future profile must not
  // stop the profiles this loader does understand from loading.
  if (manifest !== undefined) {
    console.warn(`Skipping vehicle profile ${source.name}: manifest ${String(manifest)} is not loaded.`);
    return undefined;
  }
  const version = readProfileFormatVersion(source.content);
  if (version !== null && !isSupportedProfileFormatVersion(version)) {
    console.warn(
      `Skipping vehicle profile ${source.name}: version ${version} is not loaded. Supported versions are 1 and 1.1.`,
    );
    return undefined;
  }
  return mapUpFormat1(loadFormat1(source));
}

function applyAllowedKeys(
  profile: LoadedVehicleProfile,
  allowed: VehicleProfileSource["allowedKeys"],
): LoadedVehicleProfile {
  if (allowed === undefined) {
    return profile;
  }
  const keeps = (list: string[] | undefined, key: string): boolean => list === undefined || list.includes(key);
  const properties: ProfileProperty[] = [];
  for (const { signal, query, write, ...property } of profile.properties) {
    const kept: ProfileProperty = {
      ...property,
      ...(signal !== undefined && keeps(allowed.signals, property.path) ? { signal } : {}),
      ...(query !== undefined && keeps(allowed.queries, property.path) ? { query } : {}),
    };
    const keptWrite = write === undefined ? undefined : allowedWrite(write, property.path, allowed.actions);
    if (keptWrite !== undefined) {
      kept.write = keptWrite;
    }
    if (kept.signal !== undefined || kept.query !== undefined || kept.write !== undefined) {
      properties.push(kept);
    }
  }
  return {
    ...profile,
    properties,
    queries: profile.queries.filter((query) => keeps(allowed.queries, query.name)),
    actions: profile.actions.filter((action) => keeps(allowed.actions, action.name)),
  };
}

/** The whole write when its path is listed, else the cases listed by name (`path=target`). */
function allowedWrite(write: ProfileWrite, path: string, list: string[] | undefined): ProfileWrite | undefined {
  if (list === undefined || list.includes(path)) {
    return write;
  }
  const cases = Object.entries(write.cases ?? {}).filter(([, action]) => list.includes(action.name));
  if (cases.length === 0) {
    return undefined;
  }
  return {
    cases: Object.fromEntries(cases),
    ...(write.constraints !== undefined ? { constraints: write.constraints } : {}),
  };
}
