import type { VssValue } from "../types.js";
import vocabularyJson from "./vocabulary.json";
import vssLeavesJson from "./vssLeaves.json";

/**
 * One keyword of the vehicle-profile-spec vocabulary (`docs/vocabulary.yaml`).
 * A keyword names a VSS path, optionally with the target it commands, or a
 * named action or query, or carries the `reason` it has no VSS mapping.
 */
export interface VocabularyEntry {
  path?: string;
  /** The value this keyword writes: `LOCK` writes `true`. Absent on keywords that only name the path. */
  target?: VssValue;
  /** Format 1 state labels and the VSS value each one means. */
  enum?: Record<string, VssValue>;
  action?: string;
  query?: string;
  reason?: string;
  unit?: string;
  legacy?: boolean;
}

/** Datatype, unit, and allowed values of one VSS 6.1 leaf. */
export interface VssLeaf {
  datatype: string;
  unit?: string;
  allowed?: string[];
}

const VOCABULARY = vocabularyJson as Record<string, VocabularyEntry>;
const VSS_LEAVES = vssLeavesJson as Record<string, VssLeaf>;

const KEYWORDS_BY_PATH = new Map<string, string[]>();
for (const [keyword, entry] of Object.entries(VOCABULARY)) {
  if (entry.path !== undefined) {
    KEYWORDS_BY_PATH.set(entry.path, [...(KEYWORDS_BY_PATH.get(entry.path) ?? []), keyword]);
  }
}

export function vocabularyEntry(keyword: string): VocabularyEntry | undefined {
  return Object.hasOwn(VOCABULARY, keyword) ? VOCABULARY[keyword] : undefined;
}

export function vssLeaf(path: string): VssLeaf | undefined {
  return Object.hasOwn(VSS_LEAVES, path) ? VSS_LEAVES[path] : undefined;
}

/** Every vocabulary keyword that names `path`, current keywords before legacy ones. */
export function keywordsForPath(path: string): string[] {
  const keywords = KEYWORDS_BY_PATH.get(path) ?? [];
  return [...keywords].sort(
    (left, right) => Number(VOCABULARY[left]?.legacy === true) - Number(VOCABULARY[right]?.legacy === true),
  );
}

/**
 * Reverse lookup: the keyword for a path, or for a path and the target it
 * commands. `keywordFor("Vehicle.Cabin.IsCentralLockEngaged", true)` is `LOCK`.
 */
export function keywordFor(path: string, target?: VssValue): string | undefined {
  return keywordsForPath(path).find((keyword) => VOCABULARY[keyword]?.target === target);
}

/** State labels of every keyword naming `path`, e.g. `locked` and `unlocked` for the central lock. */
export function stateLabelsForPath(path: string): Record<string, VssValue> {
  const labels: Record<string, VssValue> = {};
  for (const keyword of keywordsForPath(path)) {
    Object.assign(labels, VOCABULARY[keyword]?.enum);
  }
  return labels;
}

/** A write case key: `"true"`, `"false"`, an allowed value, or a decimal number. */
export function canonicalTarget(value: VssValue): string {
  return String(value);
}
