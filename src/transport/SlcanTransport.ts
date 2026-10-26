import type { CanFrame, CanPayload } from "../dbc/types.js";
import { NoEcuResponseError } from "../errors.js";
import {
  encodeSlcanDataFrame,
  IsotpReassembly,
  parseSlcanFrame,
  slcanBitrateCommand,
  slcanDataBitrateCommand,
  type SlcanFrameFormat,
} from "./slcanProtocol.js";
import type {
  CanBusConfigRequest,
  CanBusConfigResponse,
  MonitorControlRequest,
  MonitorControlResponse,
  MonitorSnapshot,
  VehicleBatchRequest,
  VehicleBatchResponse,
  VehicleBatchStepResult,
  VehicleDisconnectOptions,
  VehicleRequest,
  VehicleTransport,
} from "./types.js";

const textEncoder = new TextEncoder();
const MAX_MONITOR_IDS = 16;
const DEFAULT_BITRATE = 500_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 1000;
const CLASSIC_FRAME_LENGTH = 8;
const ISOTP_FLOW_CONTROL_CTS = 0x30;
/** A 64-byte CAN FD single frame spends two bytes on the escaped PCI. */
const CAN_FD_SINGLE_FRAME_MAX_PAYLOAD = 62;

export interface SlcanBytePort {
  write(chunk: Uint8Array): Promise<void>;
  /** Next bytes from the adapter. `null` means the port has closed. */
  read(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface SlcanTransportOptions {
  /** Nominal bitrate used when `connect()` opens the channel. Defaults to 500 kbit/s. */
  bitrate?: number;
  /**
   * The adapter runs CANable 2 firmware, which adds CAN FD frames, the `Y2`/`Y5`
   * data bitrates and `S9` (83.333 kbit/s). CANable 1 and other Lawicel
   * adapters ignore those commands without an error, so this defaults to off
   * and CAN FD requests are rejected.
   */
  canFd?: boolean;
  onTrace?: (direction: "tx" | "rx", text: string) => void;
}

type SnapshotCallback = (snapshot: MonitorSnapshot) => void;
type FrameWaiter = (frame: CanFrame | undefined) => void;

/**
 * One CAN channel over a Lawicel SLCAN serial link (CANable 1 or CANable 2
 * firmware). `sendRequest()` returns the ISO-TP application payload with PCI
 * bytes removed. Monitor filtering happens in this class; the adapter still
 * receives every frame. The firmware never acknowledges commands, so
 * `configureBus` reports the timing it sent, not timing the adapter confirmed.
 */
export class SlcanTransport implements VehicleTransport {
  private readonly callbacks = new Set<SnapshotCallback>();
  private readonly monitoredCanIds = new Set<number>();
  private readonly queuedFrames: CanFrame[] = [];
  private readonly frameWaiters: FrameWaiter[] = [];

  private connected = false;
  private channelOpen = false;
  private reading = false;
  private bitrate: number;
  /** Distinct CAN FD data-phase bitrate; when set, CAN FD frames switch bit rate. */
  private dataBitrate: number | undefined;
  private readonly canFd: boolean;
  private snapshotSequence = 0;
  private readBuffer = "";
  private readLoopPromise: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private requestTail: Promise<void> = Promise.resolve();
  private acceptingFrames = false;

  constructor(
    private readonly port: SlcanBytePort,
    private readonly options: SlcanTransportOptions = {},
  ) {
    this.bitrate = options.bitrate ?? DEFAULT_BITRATE;
    this.canFd = options.canFd === true;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (slcanBitrateCommand(this.bitrate, this.canFd) === undefined) {
      throw new Error(`SLCAN bitrate ${this.bitrate} is not a supported speed code`);
    }

    this.connected = true;
    this.reading = true;
    this.readLoopPromise = this.readLoop();
    try {
      await this.openChannel(this.bitrate, undefined);
    } catch (error: unknown) {
      await this.disconnect();
      throw error;
    }
  }

  async configureBus(req: CanBusConfigRequest): Promise<CanBusConfigResponse> {
    this.assertConnected();
    if (!isSupportedBus(req.bus)) {
      return { status: "invalid_bus", bus: req.bus };
    }
    if (req.bitrate === "auto") {
      // SLCAN has no bitrate search; the channel keeps its current timing.
      return { status: "auto_detect_failed", bus: req.bus, ...this.appliedTiming() };
    }
    if (req.dataBitrate !== undefined && !this.canFd) {
      return { status: "invalid_bitrate", bus: req.bus };
    }
    const dataBitrate = distinctDataBitrate(req.bitrate, req.dataBitrate);
    if (
      slcanBitrateCommand(req.bitrate, this.canFd) === undefined ||
      (dataBitrate !== undefined && slcanDataBitrateCommand(dataBitrate) === undefined)
    ) {
      return { status: "invalid_bitrate", bus: req.bus };
    }

    await this.openChannel(req.bitrate, dataBitrate);
    return { status: "ok", bus: req.bus, ...this.appliedTiming() };
  }

  async disconnect(_options?: VehicleDisconnectOptions): Promise<void> {
    if (!this.connected && !this.reading) {
      return;
    }

    const closeChannel = this.channelOpen;
    this.connected = false;
    this.channelOpen = false;
    this.reading = false;
    this.acceptingFrames = false;
    if (closeChannel) {
      await this.writeText("C\r").catch(() => undefined);
    }
    this.failWaiters();
    await this.port.close().catch(() => undefined);
    await this.readLoopPromise?.catch(() => undefined);
    this.readLoopPromise = undefined;
    this.monitoredCanIds.clear();
    this.queuedFrames.length = 0;
  }

  async sendRequest(req: VehicleRequest): Promise<CanPayload | undefined> {
    return this.enqueue(() => this.sendRequestNow(req));
  }

  async sendRequestBatch(req: VehicleBatchRequest): Promise<VehicleBatchResponse> {
    return this.enqueue(() => this.sendRequestBatchNow(req));
  }

  async updateMonitor(req: MonitorControlRequest): Promise<MonitorControlResponse> {
    this.assertConnected();
    const bus = req.bus ?? 0;
    if (!isSupportedBus(bus)) {
      return this.monitorResponse("invalid_bus", bus, req.bus !== undefined);
    }

    switch (req.operation) {
      case "clear":
        this.monitoredCanIds.clear();
        return this.monitorResponse("ok", bus, req.bus !== undefined);
      case "remove":
        return this.removeMonitored(req.canIds, bus, req.bus !== undefined);
      case "add":
        return this.addMonitored(req.canIds, bus, req.bus !== undefined);
      default: {
        const exhaustive: never = req;
        return exhaustive;
      }
    }
  }

  onMonitorSnapshot(cb: SnapshotCallback): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  private async sendRequestBatchNow(req: VehicleBatchRequest): Promise<VehicleBatchResponse> {
    if (req.steps.length === 0) {
      throw new Error("Batch request must contain at least one step");
    }
    const bus = req.bus ?? 0;
    if (!isSupportedBus(bus)) {
      throw new Error(`SLCAN transport only has CAN0, received CAN${bus}`);
    }
    const mismatched = req.steps.find((step) => (step.txFrame.bus ?? 0) !== bus);
    if (mismatched !== undefined) {
      throw new Error(
        `Batch step on CAN${mismatched.txFrame.bus ?? 0} does not match batch bus CAN${bus}`,
      );
    }

    const steps: VehicleBatchStepResult[] = [];
    let aborted = false;
    for (const step of req.steps) {
      if (aborted) {
        steps.push({ status: "skipped" });
        continue;
      }
      const result = await this.runBatchStep(step);
      steps.push(result);
      if (result.status !== "ok" && req.continueOnError !== true) {
        aborted = true;
      }
      if (step.delayAfterMs !== undefined && step.delayAfterMs > 0 && !aborted) {
        await delay(step.delayAfterMs);
      }
    }
    return { steps };
  }

  private async runBatchStep(step: VehicleRequest): Promise<VehicleBatchStepResult> {
    try {
      const payload = await this.sendRequestNow(step);
      return {
        status: "ok",
        ...(payload !== undefined ? { payload, responseCanId: step.responseIdStart ?? step.txFrame.canId } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof NoEcuResponseError) {
        return { status: "no_response" };
      }
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async sendRequestNow(req: VehicleRequest): Promise<CanPayload | undefined> {
    this.assertConnected();
    if (!this.channelOpen) {
      throw new Error("SLCAN channel is closed");
    }
    const bus = req.txFrame.bus ?? 0;
    if (!isSupportedBus(bus)) {
      throw new Error(`SLCAN transport only has CAN0, received CAN${bus}`);
    }
    const format = this.requestFormat(req);
    const txFrame = requestFrame(req);

    if (!req.expectCanResponse) {
      await this.writeText(encodeSlcanDataFrame(txFrame, format));
      return undefined;
    }

    const responseIdStart = req.responseIdStart ?? 0;
    const responseIdEnd = req.responseIdEnd ?? 0x1fffffff;
    const reassembly = new IsotpReassembly(
      req.txFrame.canId,
      req.txFrame.extended === true,
      responseIdStart,
      responseIdEnd,
      req.responseIdExtended === true,
    );
    const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
    this.queuedFrames.length = 0;
    this.acceptingFrames = true;
    try {
      await this.writeText(encodeSlcanDataFrame(txFrame, format));
      return await this.collectResponse(reassembly, deadline, format, req.canFd?.txDl ?? CLASSIC_FRAME_LENGTH);
    } finally {
      this.acceptingFrames = false;
      this.queuedFrames.length = 0;
    }
  }

  /** Flow control uses the request's frame shape, as Can Opener firmware does. */
  private async collectResponse(
    reassembly: IsotpReassembly,
    deadline: number,
    format: SlcanFrameFormat,
    flowControlLength: number,
  ): Promise<CanPayload> {
    for (;;) {
      const frame = await this.nextFrame(deadline);
      if (frame === undefined) {
        throw new NoEcuResponseError();
      }

      const step = reassembly.push(frame);
      if (step.type === "ignore" || step.type === "pending") {
        continue;
      }
      if (step.type === "invalid") {
        throw new Error(step.message);
      }
      if (step.type === "done") {
        return step.payload;
      }

      const flowControl = new Uint8Array(flowControlLength);
      flowControl[0] = ISOTP_FLOW_CONTROL_CTS;
      await this.writeText(encodeSlcanDataFrame({
        canId: step.canId,
        dlc: flowControlLength,
        data: flowControl,
        bus: 0,
        ...(step.extended ? { extended: true } : {}),
      }, format));
    }
  }

  private requestFormat(req: VehicleRequest): SlcanFrameFormat {
    if (req.canFd === undefined) {
      return "classic";
    }
    if (!this.canFd) {
      throw new Error("SLCAN adapter is not set up for CAN FD; pass canFd: true for CANable 2 firmware");
    }
    return this.dataBitrate !== undefined ? "fd_brs" : "fd";
  }

  /** Configuration commands only apply while the channel is closed. */
  private async openChannel(bitrate: number, dataBitrate: number | undefined): Promise<void> {
    const command = slcanBitrateCommand(bitrate, this.canFd);
    if (command === undefined) {
      throw new Error(`SLCAN bitrate ${bitrate} is not a supported speed code`);
    }
    const dataCommand = dataBitrate === undefined ? undefined : slcanDataBitrateCommand(dataBitrate);
    if (dataBitrate !== undefined && dataCommand === undefined) {
      throw new Error(`SLCAN data bitrate ${dataBitrate} is not a supported speed code`);
    }
    if (this.channelOpen) {
      await this.writeText("C\r");
      this.channelOpen = false;
    }
    await this.writeText(command);
    if (dataCommand !== undefined) {
      await this.writeText(dataCommand);
    }
    await this.writeText("O\r");
    this.channelOpen = true;
    this.bitrate = bitrate;
    this.dataBitrate = dataBitrate;
  }

  private appliedTiming(): { bitrate: number; dataBitrate?: number } {
    return {
      bitrate: this.bitrate,
      ...(this.dataBitrate !== undefined ? { dataBitrate: this.dataBitrate } : {}),
    };
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    while (this.reading) {
      const chunk = await this.port.read();
      if (chunk === null) {
        this.reading = false;
        this.failWaiters();
        return;
      }
      this.readBuffer += decoder.decode(chunk, { stream: true });
      this.drainLines();
    }
  }

  private drainLines(): void {
    for (;;) {
      const carriageReturn = this.readBuffer.indexOf("\r");
      const lineFeed = this.readBuffer.indexOf("\n");
      const cut = earliestBreak(carriageReturn, lineFeed);
      if (cut < 0) {
        return;
      }
      const line = this.readBuffer.slice(0, cut);
      this.readBuffer = this.readBuffer.slice(cut + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    this.options.onTrace?.("rx", line);
    const frame = parseSlcanFrame(line);
    if (frame === undefined) {
      return;
    }
    this.emitMonitor(frame);
    if (!this.acceptingFrames) {
      return;
    }
    const waiter = this.frameWaiters.shift();
    if (waiter !== undefined) {
      waiter(frame);
      return;
    }
    this.queuedFrames.push(frame);
  }

  private nextFrame(deadline: number): Promise<CanFrame | undefined> {
    const queued = this.queuedFrames.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0 || !this.reading) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const waiter: FrameWaiter = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        const index = this.frameWaiters.indexOf(waiter);
        if (index >= 0) {
          this.frameWaiters.splice(index, 1);
        }
        resolve(undefined);
      }, remaining);
      this.frameWaiters.push(waiter);
    });
  }

  private failWaiters(): void {
    const waiters = this.frameWaiters.splice(0);
    for (const waiter of waiters) {
      waiter(undefined);
    }
  }

  private emitMonitor(frame: CanFrame): void {
    if (!this.monitoredCanIds.has(frame.canId)) {
      return;
    }
    const snapshot: MonitorSnapshot = {
      sequence: this.snapshotSequence,
      frames: [frame],
    };
    this.snapshotSequence = (this.snapshotSequence + 1) & 0xffff;
    for (const callback of this.callbacks) {
      callback(snapshot);
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

  private writeText(text: string): Promise<void> {
    const pending = this.writeTail.then(async () => {
      this.options.onTrace?.("tx", text.replace(/\r$/, ""));
      await this.port.write(textEncoder.encode(text));
    });
    this.writeTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private addMonitored(canIds: readonly number[], bus: number, includeBus: boolean): MonitorControlResponse {
    const invalidCanId = canIds.find((canId) => !isValidCanId(canId));
    if (invalidCanId !== undefined) {
      return this.monitorResponse("invalid_can_id", bus, includeBus);
    }

    const uniqueCanIds = new Set(canIds);
    if (uniqueCanIds.size !== canIds.length || canIds.some((canId) => this.monitoredCanIds.has(canId))) {
      return this.monitorResponse("duplicate_id", bus, includeBus);
    }
    if (this.monitoredCanIds.size + uniqueCanIds.size > MAX_MONITOR_IDS) {
      return this.monitorResponse("monitor_full", bus, includeBus);
    }
    for (const canId of uniqueCanIds) {
      this.monitoredCanIds.add(canId);
    }
    return this.monitorResponse("ok", bus, includeBus);
  }

  private removeMonitored(canIds: readonly number[], bus: number, includeBus: boolean): MonitorControlResponse {
    const invalidCanId = canIds.find((canId) => !isValidCanId(canId));
    if (invalidCanId !== undefined) {
      return this.monitorResponse("invalid_can_id", bus, includeBus);
    }
    for (const canId of canIds) {
      this.monitoredCanIds.delete(canId);
    }
    return this.monitorResponse("ok", bus, includeBus);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("SlcanTransport is not connected");
    }
  }

  private monitorResponse(
    status: MonitorControlResponse["status"],
    bus: number,
    includeBus: boolean,
  ): MonitorControlResponse {
    const response: MonitorControlResponse = {
      status,
      currentMonitorCount: this.monitoredCanIds.size,
    };
    if (includeBus) {
      response.bus = bus;
    }
    return response;
  }
}

function isSupportedBus(bus: number): boolean {
  return bus === 0;
}

/** A data bitrate of zero or equal to nominal means the data phase does not switch rate. */
function distinctDataBitrate(bitrate: number, dataBitrate: number | undefined): number | undefined {
  return dataBitrate === undefined || dataBitrate === 0 || dataBitrate === bitrate ? undefined : dataBitrate;
}

/**
 * The frame a request puts on the wire. A CAN FD request with `txDl` 64 is one
 * escaped single frame (`00 len payload`) padded to 64 bytes; SLCAN does not
 * send multi-frame requests.
 */
function requestFrame(req: VehicleRequest): CanFrame {
  const { canFd, txFrame } = req;
  if (canFd === undefined) {
    return txFrame;
  }
  const data = new Uint8Array(canFd.txDl);
  switch (canFd.txDl) {
    case 8:
      data.set(txFrame.data.subarray(0, CLASSIC_FRAME_LENGTH));
      break;
    case 64:
      if (canFd.payload.length === 0 || canFd.payload.length > CAN_FD_SINGLE_FRAME_MAX_PAYLOAD) {
        throw new Error(
          `SLCAN sends a CAN FD request as one single frame of 1 to ${CAN_FD_SINGLE_FRAME_MAX_PAYLOAD} bytes, received ${canFd.payload.length}`,
        );
      }
      data[1] = canFd.payload.length;
      data.set(canFd.payload, 2);
      break;
    default: {
      const unsupported: never = canFd;
      throw new Error(`Unsupported CAN FD request ${String(unsupported)}`);
    }
  }
  return { ...txFrame, dlc: canFd.txDl, data };
}

function isValidCanId(canId: number): boolean {
  return Number.isInteger(canId) && canId >= 0 && canId <= 0x1fffffff;
}

function earliestBreak(carriageReturn: number, lineFeed: number): number {
  if (carriageReturn < 0) {
    return lineFeed;
  }
  if (lineFeed < 0) {
    return carriageReturn;
  }
  return Math.min(carriageReturn, lineFeed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
