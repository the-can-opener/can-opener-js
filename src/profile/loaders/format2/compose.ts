import type {
  ComposedPackage,
  ComposedSection,
  Format2Document,
} from "./types.js";

const COMPOSED_SECTIONS: readonly ComposedSection[] = [
  "channels",
  "endpoints",
  "sources",
  "properties",
  "sequences",
  "queries",
  "actions",
];

/**
 * Merges keyed sections across the manifest and its documents in order.
 * A later document replaces the whole entry for a key; `KEY: null` deletes
 * an entry defined earlier.
 */
export function composePackage(
  documents: readonly Format2Document[],
): ComposedPackage {
  const composed: ComposedPackage = {
    channels: {},
    endpoints: {},
    sources: {},
    properties: {},
    sequences: {},
    queries: {},
    actions: {},
  };

  for (const document of documents) {
    for (const section of COMPOSED_SECTIONS) {
      mergeSection(composed[section], document[section]);
    }
  }

  return composed;
}

function mergeSection(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
) {
  for (const [key, entry] of Object.entries(source ?? {})) {
    if (entry === null) {
      delete target[key];
    } else {
      target[key] = entry;
    }
  }
}
