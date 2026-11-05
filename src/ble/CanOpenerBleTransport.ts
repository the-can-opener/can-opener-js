import type { CanFrame, CanPayload } from "../dbc/types.js";
import { delay } from "../delay.js";
import { BatchUnsupportedError, NoEcuResponseError } from "../errors.js";
import type { AccessRole } from "../security/credentials.js";
import { openSecurityChannel, type SecurityChannel, type SecurityWritePolicy } from "../security/pairing.js";
import type { SecuritySession } from "../security/session.js";
import type {
  CanBusConfigRequest,
  CanBusConfigResponse,
  MonitorControlRequest,
  MonitorControlResponse,
  MonitorSnapshot,
  VehicleBatchRequest,
  VehicleBatchResponse,
  VehicleBatchStep,
  VehicleBatchStepResult,
  VehicleDisconnectOptions,
  VehicleRequest,
  VehicleTransport,
} from "../transport/types.js";
import {
  batchBudgetMs,
  batchStepTimeoutMs,
  buildBatchRequestPacket,
  isSingleRequestChunk,
  parseBatchResultPayload,
  planBatchChunks,
  resolveBatchBus,
  toBatchStepResult,
  toBatchStepResults,
} from "./batch.js";
import type { CanOpenerGattLink, WarningHandler } from "./gattLink.js";
import {
  buildCanBusConfigPacket,
  buildCaptureAllPacket,
  buildMonitorControlPacket,
  buildNanControlPacket,
  canBusConfigStatus,
  parseMonitorControlResponse,
  parseMonitorDataPacket,
  parseNanEnableResponse,
  type NanEnableResponse,
} from "./monitor.js";
import {
  buildRequestPackets,
  CanResponseAssembler,
  MONITOR_CONTROL_CHAR_UUID,
  MONITOR_DATA_CHAR_UUID,
  parseCanNotification,
  REQUEST_CHAR_UUID,
  type CanNotification,
  type CanResponse,
} from "./protocol.js";
import {
  describeRequestStatus,
  REQUEST_PACKET_DEFAULT_TIMEOUT_MS,
  REQUEST_STATUS_OK,
  requestStatusError,
  sendsAsCanFdPayload,
} from "./wire.js";

const REQUEST_RESPONSE_TIMEOUT_MS = 1000;
// A declared timeout is enforced by the adapter. The client waits slightly
// longer so its timer cannot win the race with the adapter's response.
const REQUEST_RESPONSE_MARGIN_MS = 250;
// Covers BLE latency and the firmware's own transmit timeouts on top of the
// CAN time a batch or CAN FD request declares.
const BATCH_RESPONSE_MARGIN_MS = 2500;
const MONITOR_CONTROL_TIMEOUT_MS = 1000;
// Firmware answers a timing command only after auto-detect finishes, which
// listens 250 ms per candidate rate (about 2.5 s on a silent bus).
const CAN_BUS_CONFIG_TIMEOUT_MS = 4000;
const DEFAULT_SEQUENCE_RANGE: SequenceRange = { min: 0x00, max: 0x7f };

/** Inclusive range of request sequence bytes this transport may use. */
export interface SequenceRange {
  min: number;
  max: number;
}

export interface CanOpenerBleTransportOptions {
  /**
   * Proves access on the 0xA005 security characteristic before vehicle
   * notifications are enabled; the firmware rejects them until then. Use
   * `credentialAuthorizer`. Omit only for firmware without access control.
   */
  authorize?: (session: SecuritySession) => Promise<void>;
  /** Retries 0xA005 writes while the OS pairing prompt is open. */
  securityWritePolicy?: SecurityWritePolicy;
  /**
   * Pause after enabling each notification. Android drops a descriptor write
   * issued while the previous one is in flight; 80 ms is enough there.
   */
  subscribeSettleMs?: number;
  /**
   * The firmware matches replies by sequence byte only, so clients sharing the
   * link and its notifications must use disjoint ranges. Defaults to 0x00-0x7F.
   */
  sequenceRange?: SequenceRange;
  /** Receives notifications that could not be parsed and callback failures. */
  onWarning?: WarningHandler;
}

interface PendingReply<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingCanResponse extends PendingReply<CanResponse> {
  assembler: CanResponseAssembler;
}

interface MonitorControlAck {
  response: MonitorControlResponse;
  raw: Uint8Array;
}

type SnapshotCallback = (snapshot: MonitorSnapshot) => void;

/**
 * Vehicle transport for a Can Opener SE adapter over BLE. The caller connects
 * the link (scan, connect, discover services, request MTU) and passes it in;
 * `connect()` authorizes and enables notifications, and `sendRequest()` returns
 * the reassembled ISO-TP application payload.
 */
export class CanOpenerBleTransport implements VehicleTransport {
  private readonly pendingCanResponses = new Map<number, PendingCanResponse>();
  private readonly pendingMonitorResponses = new Map<number, PendingReply<MonitorControlAck>>();
  private readonly monitorCallbacks = new Set<SnapshotCallback>();
  private readonly monitorFrames = new Map<string, CanFrame>();
  private readonly unsubscribes: (() => void)[] = [];
  private readonly sequenceRange: SequenceRange;
  private securityChannel: SecurityChannel | undefined;
  private connected = false;
  private seq: number;
  private snapshotSequence = 0;
  private requestTail: Promise<void> = Promise.resolve();
  // Firmware that predates v4 parses a batch as a malformed request-only
  // packet and drops it silently, so support is learned from the first batch.
  private batchSupport: "unknown" | "supported" | "unsupported" = "unknown";

  constructor(
    private readonly link: CanOpenerGattLink,
    private readonly options: CanOpenerBleTransportOptions = {},
  ) {
    this.sequenceRange = validateSequenceRange(options.sequenceRange ?? DEFAULT_SEQUENCE_RANGE);
    this.seq = this.sequenceRange.min;
  }

  /** The role `authorize` proved on this connection. */
  get accessRole(): AccessRole | null {
    return this.securityChannel?.session.authorizedRole ?? null;
  }

  /** The authorized security session, for managing guests on this connection. */
  get accessSession(): SecuritySession | null {
    const session = this.securityChannel?.session;
    return session?.authorizedRole == null ? null : session;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    try {
      const { authorize, securityWritePolicy, onWarning } = this.options;
      if (authorize !== undefined) {
        const channel = openSecurityChannel(this.link, {
          ...(securityWritePolicy !== undefined ? { writePolicy: securityWritePolicy } : {}),
          ...(onWarning !== undefined ? { onWarning } : {}),
        });
        this.securityChannel = channel;
        await this.settleSubscription();
        await authorize(channel.session);
      }

      await this.subscribe(
        REQUEST_CHAR_UUID,
        (value) => this.handleRequestNotification(value),
        (error) => rejectAll(this.pendingCanResponses, error),
      );
      await this.subscribe(
        MONITOR_CONTROL_CHAR_UUID,
        (value) => this.handleMonitorControlNotification(value),
        (error) => rejectAll(this.pendingMonitorResponses, error),
      );
      await this.subscribe(
        MONITOR_DATA_CHAR_UUID,
        (value) => this.handleMonitorDataNotification(value),
        (error) => this.warn("Monitor data notification error", error),
      );
    } catch (error: unknown) {
      await this.disconnect();
      throw error;
    }

    this.connected = true;
    this.batchSupport = "unknown";
  }

  async disconnect(options: VehicleDisconnectOptions = {}): Promise<void> {
    this.connected = false;
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    const reason = new Error("BLE transport disconnected");
    this.securityChannel?.close(reason);
    this.securityChannel = undefined;
    this.monitorCallbacks.clear();
    this.monitorFrames.clear();
    rejectAll(this.pendingCanResponses, reason);
    rejectAll(this.pendingMonitorResponses, reason);

    if (options.cancelConnection ?? true) {
      // The link may already be gone; there is nothing left to clean up then.
      await this.link.disconnect().catch(() => undefined);
    }
  }

  async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    const response = await this.sendRequestWithResponseDetails(req);
    return response?.payload;
  }

  /** Like `sendRequest`, but keeps the responding CAN ID and status. */
  sendRequestWithResponseDetails(req: VehicleRequest): Promise<CanResponse | undefined> {
    return this.enqueue(() => this.sendRequestNow(req));
  }

  /**
   * Sends several CAN frames as one device transaction. Steps that do not fit
   * a single BLE write (or the firmware's step and time limits) are split into
   * consecutive device batches; requests from this transport never interleave
   * with them.
   */
  sendRequestBatch(req: VehicleBatchRequest): Promise<VehicleBatchResponse> {
    return this.enqueue(() => this.sendRequestBatchNow(req));
  }

  async updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse> {
    const response = await this.sendMonitorControl(buildMonitorControlPacket(this.nextSeq(), req));
    if (req.operation === "clear" && response.status === "ok") {
      this.clearMonitorFrames(req.bus);
    }
    return response;
  }

  async configureBus(req: CanBusConfigRequest): Promise<CanBusConfigResponse> {
    const response = await this.sendMonitorControl(
      buildCanBusConfigPacket(this.nextSeq(), req),
      CAN_BUS_CONFIG_TIMEOUT_MS,
    );
    return {
      status: canBusConfigStatus(response.status),
      bus: response.bus ?? req.bus,
      ...(response.bitrate !== undefined ? { bitrate: response.bitrate } : {}),
      ...(response.dataBitrate !== undefined ? { dataBitrate: response.dataBitrate } : {}),
    };
  }

  /**
   * Streams every received frame instead of only monitored IDs. `busMask`
   * (bit 0 = CAN0, bit 1 = CAN1) limits capture where the firmware supports it
   * and falls back to all buses where it does not.
   */
  async setCaptureAll(enabled: boolean, busMask?: number): Promise<MonitorControlResponse> {
    let response = await this.sendMonitorControl(buildCaptureAllPacket(this.nextSeq(), enabled, busMask));
    if (enabled && busMask !== undefined && response.status === "invalid_length") {
      response = await this.sendMonitorControl(buildCaptureAllPacket(this.nextSeq(), true));
    }
    if (response.status === "ok") {
      this.monitorFrames.clear();
    }
    return response;
  }

  /** Enables the Wi-Fi Aware CAN stream; enabling returns its stream key. */
  async setNanEnabled(enabled: boolean): Promise<NanEnableResponse> {
    const { raw } = await this.sendMonitorControlAck(buildNanControlPacket(this.nextSeq(), enabled));
    return parseNanEnableResponse(raw);
  }

  onMonitorSnapshot(cb: SnapshotCallback): () => void {
    this.monitorCallbacks.add(cb);
    return () => {
      this.monitorCallbacks.delete(cb);
    };
  }

  private async sendRequestNow(req: VehicleRequest): Promise<CanResponse | undefined> {
    this.assertConnected();
    const seq = this.nextSeq();
    const packets = buildRequestPackets(seq, req);
    let pendingResponse: Promise<CanResponse> | undefined;
    if (req.expectCanResponse) {
      pendingResponse = this.awaitCanResponse(
        seq,
        req.timeoutMs === undefined ? REQUEST_RESPONSE_TIMEOUT_MS : req.timeoutMs + REQUEST_RESPONSE_MARGIN_MS,
        () => new NoEcuResponseError(`Timed out waiting for CAN response seq ${seq}`),
      );
    } else if (sendsAsCanFdPayload(req)) {
      // A full device command queue drops request-only v3 writes silently,
      // so wait for the confirmation v3 always sends.
      pendingResponse = this.awaitCanResponse(
        seq,
        (req.timeoutMs ?? REQUEST_PACKET_DEFAULT_TIMEOUT_MS) + BATCH_RESPONSE_MARGIN_MS,
        () => new Error(`Device did not confirm CAN FD request seq ${seq}; it may have been dropped`),
      );
    }

    await this.writeRequestPackets(seq, packets);
    if (pendingResponse === undefined) {
      return undefined;
    }

    const response = await pendingResponse;
    if (response.status !== REQUEST_STATUS_OK) {
      throw requestStatusError(response.status);
    }
    return req.expectCanResponse ? response : undefined;
  }

  private async sendRequestBatchNow(req: VehicleBatchRequest): Promise<VehicleBatchResponse> {
    this.assertConnected();
    if (this.batchSupport === "unsupported") {
      throw new BatchUnsupportedError();
    }
    const bus = resolveBatchBus(req);
    const results: VehicleBatchStepResult[] = [];
    let aborted = false;
    for (const chunk of planBatchChunks(req.steps)) {
      if (aborted) {
        results.push(...chunk.map((): VehicleBatchStepResult => ({ status: "skipped" })));
        continue;
      }
      const chunkResults = isSingleRequestChunk(chunk)
        ? [await this.sendBatchStepAsRequest(chunk[0], bus)]
        : await this.sendBatchChunk({ ...req, bus, steps: chunk });
      results.push(...chunkResults);
      if (req.continueOnError !== true && chunkResults.some((result) => result.status !== "ok")) {
        aborted = true;
      }
    }
    return { steps: results };
  }

  private async sendBatchChunk(req: VehicleBatchRequest): Promise<VehicleBatchStepResult[]> {
    const seq = this.nextSeq();
    const packet = buildBatchRequestPacket(seq, req);
    // v4 firmware always answers a batch, with results or a rejection. A device
    // that has never answered one and stays silent is taken to be pre-v4
    // firmware; once a device has answered, silence is a link fault.
    const pendingResponse = this.awaitCanResponse(seq, batchBudgetMs(req.steps) + BATCH_RESPONSE_MARGIN_MS, () =>
      this.batchSupport === "unknown"
        ? new BatchUnsupportedError(`Device did not answer batch seq ${seq}; assuming firmware without batch support`)
        : new Error(`Timed out waiting for batch result seq ${seq} (${req.steps.length} steps)`),
    );
    await this.writeRequestPackets(seq, [packet]);

    let response: CanResponse;
    try {
      response = await pendingResponse;
    } catch (error: unknown) {
      if (error instanceof BatchUnsupportedError) {
        this.batchSupport = "unsupported";
      }
      throw error;
    }
    this.batchSupport = "supported";

    if (!response.batchResult) {
      // Batch-level rejection: nothing was transmitted.
      throw new Error(
        response.status === REQUEST_STATUS_OK
          ? `Batch seq ${seq} returned no result list`
          : `Batch request rejected with status ${describeRequestStatus(response.status)}`,
      );
    }
    return toBatchStepResults(parseBatchResultPayload(response.payload), req.steps);
  }

  /** A CAN FD tx_dl 64 step cannot be batched; it goes out as its own v3 request. */
  private async sendBatchStepAsRequest(step: VehicleBatchStep, bus: number): Promise<VehicleBatchStepResult> {
    const seq = this.nextSeq();
    const packets = buildRequestPackets(seq, { ...step, txFrame: { ...step.txFrame, bus } });
    const pendingResponse = this.awaitCanResponse(
      seq,
      batchStepTimeoutMs(step) + BATCH_RESPONSE_MARGIN_MS,
      () => new Error(`Timed out waiting for CAN FD batch step seq ${seq}`),
    );
    await this.writeRequestPackets(seq, packets);

    const response = await pendingResponse;
    if (step.delayAfterMs !== undefined && step.delayAfterMs > 0) {
      await delay(step.delayAfterMs);
    }
    return toBatchStepResult(step, response);
  }

  private awaitCanResponse(seq: number, timeoutMs: number, timeoutError: () => Error): Promise<CanResponse> {
    return handledLater(
      new Promise<CanResponse>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingCanResponses.delete(seq);
          reject(timeoutError());
        }, timeoutMs);
        this.pendingCanResponses.set(seq, { resolve, reject, timeoutId, assembler: new CanResponseAssembler() });
      }),
    );
  }

  private async writeRequestPackets(seq: number, packets: readonly Uint8Array[]): Promise<void> {
    try {
      for (const packet of packets) {
        await this.link.write(REQUEST_CHAR_UUID, packet);
      }
    } catch (error: unknown) {
      clearPending(this.pendingCanResponses, seq);
      throw error;
    }
  }

  private async sendMonitorControl(
    packet: Uint8Array,
    timeoutMs = MONITOR_CONTROL_TIMEOUT_MS,
  ): Promise<MonitorControlResponse> {
    return (await this.sendMonitorControlAck(packet, timeoutMs)).response;
  }

  /** Monitor control packets carry their sequence byte at offset 1. */
  private async sendMonitorControlAck(
    packet: Uint8Array,
    timeoutMs = MONITOR_CONTROL_TIMEOUT_MS,
  ): Promise<MonitorControlAck> {
    this.assertConnected();
    const seq = packet[1];
    if (seq === undefined) {
      throw new Error("Monitor control packet is missing a sequence byte");
    }

    const responsePromise = handledLater(
      new Promise<MonitorControlAck>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingMonitorResponses.delete(seq);
          reject(new Error(`Timed out waiting for monitor config response seq ${seq}`));
        }, timeoutMs);
        this.pendingMonitorResponses.set(seq, { resolve, reject, timeoutId });
      }),
    );

    try {
      await this.link.write(MONITOR_CONTROL_CHAR_UUID, packet);
    } catch (error: unknown) {
      clearPending(this.pendingMonitorResponses, seq);
      throw error;
    }
    return responsePromise;
  }

  private handleRequestNotification(data: Uint8Array): void {
    let notification: CanNotification;
    try {
      notification = parseCanNotification(data);
    } catch (error: unknown) {
      this.warn("Failed to parse CAN response", error);
      return;
    }

    const pending = this.pendingCanResponses.get(notification.seq);
    if (pending === undefined) {
      return;
    }

    let response: CanResponse | undefined;
    try {
      response = pending.assembler.push(notification);
    } catch (error: unknown) {
      clearPending(this.pendingCanResponses, notification.seq);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (response === undefined) {
      // More fragments to come; the request timeout keeps guarding the wait.
      return;
    }
    clearPending(this.pendingCanResponses, notification.seq);
    pending.resolve(response);
  }

  private handleMonitorControlNotification(data: Uint8Array): void {
    let ack: ReturnType<typeof parseMonitorControlResponse>;
    try {
      ack = parseMonitorControlResponse(data);
    } catch (error: unknown) {
      this.warn("Failed to parse monitor config response", error);
      return;
    }
    const pending = this.pendingMonitorResponses.get(ack.seq);
    if (pending === undefined) {
      return;
    }
    clearPending(this.pendingMonitorResponses, ack.seq);
    pending.resolve({ response: ack.response, raw: data });
  }

  /** Each notification updates the latest frame per bus and CAN ID; snapshots carry the whole set. */
  private handleMonitorDataNotification(data: Uint8Array): void {
    let frames: CanFrame[];
    try {
      frames = parseMonitorDataPacket(data);
    } catch (error: unknown) {
      this.warn("Failed to parse monitor data", error);
      return;
    }
    for (const frame of frames) {
      this.monitorFrames.set(monitorKey(frame), frame);
    }

    const snapshot: MonitorSnapshot = {
      sequence: this.snapshotSequence,
      frames: Array.from(this.monitorFrames.values(), cloneFrame),
    };
    this.snapshotSequence = (this.snapshotSequence + 1) & 0xffff;
    for (const callback of this.monitorCallbacks) {
      try {
        callback(snapshot);
      } catch (error: unknown) {
        this.warn("Monitor snapshot callback failed", error);
      }
    }
  }

  private clearMonitorFrames(bus: number | undefined): void {
    if (bus === undefined) {
      this.monitorFrames.clear();
      return;
    }
    for (const [key, frame] of this.monitorFrames) {
      if ((frame.bus ?? 0) === bus) {
        this.monitorFrames.delete(key);
      }
    }
  }

  private async subscribe(
    characteristicUuid: string,
    onValue: (value: Uint8Array) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    this.unsubscribes.push(this.link.subscribe(characteristicUuid, onValue, onError));
    await this.settleSubscription();
  }

  private async settleSubscription(): Promise<void> {
    const settleMs = this.options.subscribeSettleMs ?? 0;
    if (settleMs > 0) {
      await delay(settleMs);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.requestTail.then(operation);
    this.requestTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq = seq >= this.sequenceRange.max ? this.sequenceRange.min : seq + 1;
    return seq;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("BLE transport is not connected");
    }
  }

  private warn(message: string, detail: unknown): void {
    this.options.onWarning?.(message, detail);
  }
}

function validateSequenceRange(range: SequenceRange): SequenceRange {
  const { min, max } = range;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 0xff || min > max) {
    throw new Error(`Invalid sequence range ${min}-${max}; expected 0 <= min <= max <= 255`);
  }
  return { min, max };
}

function rejectAll<T>(pending: Map<number, PendingReply<T>>, error: Error): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timeoutId);
    entry.reject(error);
  }
  pending.clear();
}

function clearPending<T>(pending: Map<number, PendingReply<T>>, seq: number): void {
  const entry = pending.get(seq);
  if (entry !== undefined) {
    clearTimeout(entry.timeoutId);
    pending.delete(seq);
  }
}

/**
 * The caller awaits `promise` only after its BLE writes finish; this keeps a
 * rejection in the meantime (timeout, disconnect) from being reported as unhandled.
 */
function handledLater<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function monitorKey(frame: CanFrame): string {
  return `${frame.bus ?? 0}:${frame.canId}`;
}

function cloneFrame(frame: CanFrame): CanFrame {
  return {
    canId: frame.canId,
    ...(frame.dlc !== undefined ? { dlc: frame.dlc } : {}),
    data: frame.data.slice(),
    ...(frame.extended !== undefined ? { extended: frame.extended } : {}),
    ...(frame.bus !== undefined ? { bus: frame.bus } : {}),
  };
}
