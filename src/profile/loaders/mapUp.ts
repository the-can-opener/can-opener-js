import type {
  LoadedVehicleProfile,
  ProfileAction,
  ProfileProperty,
  ProfileQuery,
  ProfileValueNormalization,
  VssValue,
} from "../types.js";
import { ACTION_VALUE_SEPARATOR, type Format1Profile } from "./format1.js";
import {
  canonicalTarget,
  stateLabelsForPath,
  vocabularyEntry,
  vssLeaf,
  type VocabularyEntry,
  type VssLeaf,
} from "./vocabulary.js";

/** Format 1.1 commands and the state label each one reaches. */
const COMMAND_STATES: Record<string, string> = {
  lock: "locked",
  unlock: "unlocked",
  close: "closed",
  fold: "folded",
  unfold: "unfolded",
};

/**
 * Maps a format 1 profile onto the VSS model with the spec vocabulary, the
 * way the spec's migration rules do. A keyword the vocabulary gives no path
 * keeps its original name, so nothing the profile declares is dropped.
 */
export function mapUpFormat1(profile: Format1Profile): LoadedVehicleProfile {
  const properties = new Map<string, ProfileProperty>();
  const queries: ProfileQuery[] = [];
  const actions: ProfileAction[] = [];

  const property = (key: string, alias?: string): ProfileProperty => {
    let entry = properties.get(key);
    if (entry === undefined) {
      entry = { path: key, ...vssLeaf(key) };
      properties.set(key, entry);
    }
    if (alias !== undefined && entry.aliases?.includes(alias) !== true) {
      entry.aliases = [...(entry.aliases ?? []), alias];
    }
    return entry;
  };

  for (const signal of profile.signals) {
    const path = keywordPath(signal.name);
    if (path === undefined) {
      property(signal.name).signal = signal;
      continue;
    }
    property(path, signal.name).signal = {
      ...signal,
      name: path,
      normalize: typedNormalization(path, signal.normalize),
    };
  }

  for (const query of profile.queries) {
    const path = keywordPath(query.name);
    if (path === undefined) {
      queries.push(query);
      continue;
    }
    property(path, query.name).query = {
      ...query,
      name: path,
      normalize: typedNormalization(path, query.normalize),
    };
  }

  const writeCase = (path: string, alias: string, target: VssValue, action: ProfileAction): void => {
    const key = canonicalTarget(target);
    const entry = property(path, alias);
    entry.write = {
      ...entry.write,
      cases: { ...entry.write?.cases, [key]: { ...action, name: `${path}=${key}` } },
    };
  };

  for (const { entity, value, ...action } of profile.actions) {
    if (entity !== undefined && value !== undefined) {
      const write = writeTarget(entity, value);
      if (write !== undefined) {
        writeCase(write.path, entity, write.target, action);
      } else {
        actions.push({ ...action, name: commandActionName(entity, value) });
      }
    } else if (action.input !== undefined) {
      const path = keywordPath(entity ?? action.name);
      const leaf = path === undefined ? undefined : vssLeaf(path);
      if (path !== undefined && leaf !== undefined && isNumericDatatype(leaf.datatype)) {
        const { input, ...direct } = action;
        property(path, action.name).write = { direct: { ...direct, name: path }, constraints: input };
      } else {
        actions.push(action);
      }
    } else {
      const write = writeTarget(entity ?? action.name);
      if (write !== undefined) {
        writeCase(write.path, action.name, write.target, action);
      } else {
        actions.push(action);
      }
    }
  }

  return {
    name: profile.name,
    dbcFiles: profile.dbcFiles,
    canBuses: profile.canBuses,
    endpoints: profile.endpoints,
    properties: Array.from(properties.values()),
    queries,
    actions,
  };
}

/**
 * The name a format 1 action has once it is mapped up, for stored names that
 * predate the VSS model: `LOCK` and `DOORS.lock` are
 * `Vehicle.Cabin.IsCentralLockEngaged=true`, and `MIRRORS.fold` is
 * `MIRRORS_FOLD`. A name the vocabulary gives no target, and a name that is
 * already a write case (`path=target`), is returned as is.
 */
export function mappedActionName(name: string): string {
  if (name.includes("=")) {
    return name;
  }
  const separator = name.indexOf(ACTION_VALUE_SEPARATOR);
  const entity = separator < 0 ? name : name.slice(0, separator);
  const command = separator < 0 ? undefined : name.slice(separator + 1);
  const write = writeTarget(entity, command);
  if (write !== undefined) {
    return `${write.path}=${canonicalTarget(write.target)}`;
  }
  return command === undefined ? name : commandActionName(entity, command);
}

/** The path and target a keyword writes: its own target, or the one its 1.1 `command` reaches. */
function writeTarget(keyword: string, command?: string): { path: string; target: VssValue } | undefined {
  const mapping = vocabularyEntry(keyword);
  const path = keywordPath(keyword);
  if (mapping === undefined || path === undefined) {
    return undefined;
  }
  const target = command === undefined ? mapping.target : commandTarget(command, mapping, vssLeaf(path));
  return target === undefined ? undefined : { path, target };
}

/** The VSS path a format 1 signal or query keyword reads, when the vocabulary maps it. */
function keywordPath(keyword: string): string | undefined {
  const entry = vocabularyEntry(keyword);
  return entry?.reason === undefined ? entry?.path : undefined;
}

/**
 * The profile's own label mapping, continued through the vocabulary's state
 * labels, then the VSS datatype: a DBC label `active` the profile maps to
 * `on` becomes `true` on a boolean path.
 */
function typedNormalization(
  path: string,
  normalize: ProfileValueNormalization | undefined,
): ProfileValueNormalization {
  const labels = stateLabelsForPath(path);
  const mapped: Record<string, VssValue> = { ...labels };
  for (const [label, value] of Object.entries(normalize?.enum ?? {})) {
    mapped[label] = labels[String(value)] ?? value;
  }
  const leaf = vssLeaf(path);
  return {
    ...(Object.keys(mapped).length > 0 ? { enum: mapped } : {}),
    ...(leaf?.datatype !== undefined ? { datatype: leaf.datatype } : {}),
    ...(leaf?.unit !== undefined ? { unit: leaf.unit } : {}),
  };
}

/** The VSS target of a 1.1 command: its state in the vocabulary enum, a boolean, or an allowed value. */
function commandTarget(command: string, mapping: VocabularyEntry, leaf: VssLeaf | undefined): VssValue | undefined {
  const state = COMMAND_STATES[command] ?? command;
  const fromEnum = mapping.enum?.[state];
  if (fromEnum !== undefined) {
    return fromEnum;
  }
  if (leaf?.datatype === "boolean") {
    if (state === "on" || state === "open") return true;
    if (state === "off" || state === "closed") return false;
    return undefined;
  }
  const allowed = state.toUpperCase();
  return leaf?.allowed?.includes(allowed) === true ? allowed : undefined;
}

/** A command with no VSS target becomes its own named action: `MIRRORS.fold` is `MIRRORS_FOLD`. */
function commandActionName(entity: string, command: string): string {
  return `${entity}_${command.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")}`;
}

function isNumericDatatype(datatype: string): boolean {
  return /^(u?int\d+|float|double)$/u.test(datatype);
}
