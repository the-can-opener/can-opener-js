/**
 * Loose TypeScript views of the format 2 grammar, ported from can-opener-cloud.
 * The canonical grammar is https://github.com/the-can-opener/vehicle-profile-spec.
 * Packages are validated when they are published; these types only describe
 * the fields the loader reads.
 */

export type YearRange = { range: [number, number] };

export type AppliesTo = {
  manufacturers?: string[] | null;
  models?: string[] | null;
  years?: (number | YearRange)[] | null;
  trims?: string[] | null;
  engines?: string[] | null;
  markets?: string[] | null;
};

export type FdFrames = { tx_dl: 8 | 64 };

/** Request frame format. `true` is CAN FD with 8-byte ISO-TP frames. */
export type FrameFormat = boolean | FdFrames;

export type ExtendedAddressing = {
  mode: "extended";
  target_address: string;
  source_address: string;
};

export type MixedAddressing = {
  mode: "mixed";
  address_extension: string;
};

export type IdRange = { range: [string, string] };

/** One receive ID, or an inclusive range. */
export type RxId = string | IdRange;

export type Channel = {
  protocol: "can" | "canfd";
  bitrate?: number | "auto" | null;
  data_bitrate?: number | null;
  configuration?: "runtime" | null;
  /** Default format of frames sent on this channel. `canfd` only; omitted means classic. */
  fd?: FrameFormat | null;
};

export type Endpoint = {
  /** Omitted names `can0`. */
  channel?: string;
  protocol: "can" | "isotp";
  tx: string;
  rx?: RxId[];
  id_format: "standard" | "extended";
  timeout_ms?: number | null;
  responder?: string | null;
  fd?: FrameFormat | null;
  addressing?: ExtendedAddressing | MixedAddressing | null;
};

export type ActionRelease = { action: string };

export type Repeat = {
  interval_ms: number;
  release: "silence" | ActionRelease;
  frame: { base: "last-rx"; mask: string; patch: string };
};

export type Step =
  | { request: unknown; expect?: unknown }
  | { call: string }
  | { wait_ms: number };

export type WriteBody = {
  endpoint: string;
  request?: unknown;
  expect?: unknown;
  steps?: Step[] | null;
  repeat?: Repeat | null;
  deadline_ms?: number | null;
  duration?: number | "latched" | null;
  release?: ActionRelease | null;
  constraints?: unknown;
};

export type CasesWrite = {
  cases: Record<string, WriteBody>;
  constraints?: unknown;
};

export type Write = WriteBody | CasesWrite;

export type DbcSignalBinding = {
  dbc: string;
  message: string;
  signal: string;
  decode_as?: "boolean" | null;
  enum?: Record<string, unknown> | null;
};

export type SourceRefBinding = {
  source: string;
  output: string;
  decode_as?: "boolean" | null;
  enum?: Record<string, unknown> | null;
};

export type InlineSignalBinding = {
  /** Omitted names `can0`. */
  channel?: string;
  id: string;
  id_format: "standard" | "extended";
  length: number;
  decode: unknown;
};

export type InlineQueryBinding = {
  endpoint: string;
  request: unknown;
  response: unknown;
  decode: unknown;
  interval_ms?: number | null;
};

export type Read = {
  signal?: DbcSignalBinding | InlineSignalBinding | SourceRefBinding | null;
  query?: InlineQueryBinding | SourceRefBinding | null;
  policy?: unknown;
};

export type Property = {
  aliases?: string[];
  read?: Read | null;
  write?: Write | null;
  value?: unknown;
};

export type Source =
  | { kind: "signal"; dbc: string; message: string }
  | {
      kind: "signal";
      /** Omitted names `can0`. */
      channel?: string;
      id: string;
      id_format: string;
      length: number;
      outputs: Record<string, unknown>;
    }
  | {
      kind: "query";
      endpoint: string;
      request: unknown;
      response: unknown;
      outputs: Record<string, unknown>;
      interval_ms?: number | null;
    };

export type Sequence = { steps: Step[] };

export type NamedQuery = {
  description: string;
  endpoint: string;
  request: unknown;
  response: unknown;
  decode?: unknown;
  datatype?: string | null;
  unit?: string | null;
  outputs?: Record<string, unknown> | null;
  interval_ms?: number | null;
  input_schema?: unknown;
};

export type NamedAction = WriteBody & {
  description: string;
  input_schema?: unknown;
  retry?: "never" | "idempotent";
};

export type ComposedPackage = {
  channels: Record<string, Channel>;
  endpoints: Record<string, Endpoint>;
  sources: Record<string, Source>;
  properties: Record<string, Property>;
  sequences: Record<string, Sequence>;
  queries: Record<string, NamedQuery>;
  actions: Record<string, NamedAction>;
};

export type ComposedSection = keyof ComposedPackage;

/** Sections a document may declare; `null` entries delete earlier ones. */
export type DocumentSections = {
  [Section in ComposedSection]?: Record<
    string,
    ComposedPackage[Section][string] | null
  >;
};

export type Format2Document = DocumentSections & {
  applies_to?: AppliesTo;
  requires?: Record<string, string>;
  extensions?: Record<string, unknown>;
};

export type DbcRef = {
  path: string;
  /** Omitted names `can0`. */
  channel?: string;
  sha256?: string | null;
};

export type DocumentRef = {
  path: string;
  applies_to?: AppliesTo;
  override?: boolean;
  sha256?: string | null;
};

export type Format2Manifest = Format2Document & {
  manifest: 1;
  format: 2;
  id: string;
  version: string;
  name: string;
  vss: string;
  applies_to?: AppliesTo;
  dbc?: Record<string, DbcRef>;
  documents?: DocumentRef[] | null;
  fixtures?: unknown[];
  depends?: { id: string; version: string }[];
  unmapped?: Record<string, unknown>[];
};
