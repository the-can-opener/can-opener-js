import type { VehicleBatchRequest, VehicleBatchStep, VehicleBatchStepResult } from "./types.js";
import {
  BLE_MAX_REQUEST_WRITE_BYTES,
  describeRequestStatus,
  ISOTP_ADDRESSING_FIELD_SIZE,
  isTxCanIdExtended,
  REQUEST_FLAG_BATCH,
  REQUEST_FLAG_CAN_FD,
  REQUEST_FLAG_EXPECT_CAN_RESPONSE,
  REQUEST_FLAG_ISOTP_ADDRESSING,
  REQUEST_FLAG_RESPONSE_ID_EXTENDED,
  REQUEST_FLAG_TX_CAN_ID_EXTENDED,
  REQUEST_PACKET_DEFAULT_TIMEOUT_MS,
  REQUEST_STATUS_CAN_RX_TIMEOUT,
  REQUEST_STATUS_CAN_TX_FAIL,
  REQUEST_STATUS_OK,
  RESPONSE_FLAG_CAN_ID_EXTENDED,
  resolveResponseIds,
  sendsAsCanFdPayload,
  validateBus,
} from "./bleWire.js";

// v4 batch layout. Must stay in sync with the firmware.
const BATCH_FLAG_CONTINUE_ON_ERROR = 0x01;
const BATCH_HEADER_SIZE = 5;
const BATCH_STEP_BASE_SIZE = 16;
const BATCH_STEP_RESPONSE_FIELDS_SIZE = 10;
const BATCH_MAX_STEPS = 14;
const BATCH_MAX_TOTAL_BUDGET_MS = 30_000;
const BATCH_RESULT_HEADER_SIZE = 2;
const BATCH_RESULT_ENTRY_HEADER_SIZE = 9;

export interface BatchResultEntry {
  stepIndex: number;
  status: number;
  responseCanIdExtended: boolean;
  responseCanId: number;
  payload: Uint8Array;
}

export interface BatchResult {
  /** Number of steps the device was asked to run. */
  stepCount: number;
  /** Results for the steps the device actually executed, in order. */
  entries: BatchResultEntry[];
}

export function batchStepTimeoutMs(step: VehicleBatchStep): number {
  return step.timeoutMs ?? REQUEST_PACKET_DEFAULT_TIMEOUT_MS;
}

/** Wall-clock CAN time the device may legitimately spend on these steps. */
export function batchBudgetMs(steps: readonly VehicleBatchStep[]): number {
  return steps.reduce(
    (total, step) => total + (step.expectCanResponse ? batchStepTimeoutMs(step) : 0) + (step.delayAfterMs ?? 0),
    0,
  );
}

/** The one bus every step targets; steps that omit a bus inherit it. */
export function resolveBatchBus(req: VehicleBatchRequest): number {
  const bus = validateBus(req.bus ?? req.steps[0]?.txFrame.bus ?? 0);
  req.steps.forEach((step, index) => {
    const stepBus = step.txFrame.bus ?? bus;
    if (stepBus !== bus) {
      throw new Error(`Batch step ${index} targets CAN${stepBus} but the batch targets CAN${bus}`);
    }
  });
  return bus;
}

/**
 * Splits steps into runs that each fit one BLE write and the firmware's
 * per-batch step and time limits. Every chunk keeps request order. A CAN FD
 * step with tx_dl 64 does not fit the batch layout and gets a chunk of its own
 * (see `isSingleRequestChunk`).
 */
export function planBatchChunks(steps: readonly VehicleBatchStep[]): VehicleBatchStep[][] {
  if (steps.length === 0) {
    throw new Error("Batch request must contain at least one step");
  }
  steps.forEach(validateBatchStep);

  const chunks: VehicleBatchStep[][] = [];
  let current: VehicleBatchStep[] = [];
  for (const step of steps) {
    if (sendsAsCanFdPayload(step)) {
      if (current.length > 0) {
        chunks.push(current);
      }
      chunks.push([step]);
      current = [];
      continue;
    }
    const candidate = [...current, step];
    if (fitsOneBatch(candidate)) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error(
        `Batch step exceeds the device limits on its own (${batchStepTimeoutMs(step)} ms timeout, ${step.delayAfterMs ?? 0} ms delay)`,
      );
    }
    chunks.push(current);
    current = [step];
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** True when a planned chunk must go out as one v3 request instead of a batch. */
export function isSingleRequestChunk(chunk: readonly VehicleBatchStep[]): chunk is readonly [VehicleBatchStep] {
  return chunk.length === 1 && chunk[0] !== undefined && sendsAsCanFdPayload(chunk[0]);
}

/**
 * Encodes one batch that already fits the device limits (see `planBatchChunks`):
 * `seq, 0x10, bus, batch_flags, step_count`, then per step `flags,
 * [tx_address, rx_address], tx_can_id:u32, dlc, data[8], delay_after_ms:u16,
 * [response_id_start:u32, response_id_end:u32, timeout_ms:u16]`.
 */
export function buildBatchRequestPacket(seq: number, req: VehicleBatchRequest): Uint8Array {
  const { steps } = req;
  if (steps.length === 0 || steps.length > BATCH_MAX_STEPS) {
    throw new Error(`Batch request must contain 1 to ${BATCH_MAX_STEPS} steps, got ${steps.length}`);
  }
  steps.forEach(validateBatchStep);
  const singleRequestIndex = steps.findIndex(sendsAsCanFdPayload);
  if (singleRequestIndex !== -1) {
    throw new Error(`Batch step ${singleRequestIndex} uses CAN FD tx_dl 64, which the device cannot batch`);
  }
  const bus = resolveBatchBus(req);
  const size = batchPacketSize(steps);
  if (size > BLE_MAX_REQUEST_WRITE_BYTES) {
    throw new Error(`Batch request is ${size} bytes; the device accepts at most ${BLE_MAX_REQUEST_WRITE_BYTES}`);
  }
  const budgetMs = batchBudgetMs(steps);
  if (budgetMs > BATCH_MAX_TOTAL_BUDGET_MS) {
    throw new Error(`Batch request needs ${budgetMs} ms; the device allows at most ${BATCH_MAX_TOTAL_BUDGET_MS} ms`);
  }

  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  view.setUint8(0, seq);
  view.setUint8(1, REQUEST_FLAG_BATCH);
  view.setUint8(2, bus);
  view.setUint8(3, req.continueOnError === true ? BATCH_FLAG_CONTINUE_ON_ERROR : 0);
  view.setUint8(4, steps.length);

  let offset = BATCH_HEADER_SIZE;
  for (const step of steps) {
    const { txFrame, isotpAddressing } = step;
    const addressOffset = isotpAddressing === undefined ? 0 : ISOTP_ADDRESSING_FIELD_SIZE;
    const canFd = step.canFd !== undefined;
    // The firmware requires DLC 8 for an 8-byte CAN FD step.
    const dlc = canFd ? 8 : (txFrame.dlc ?? txFrame.data.length);
    const { responseIdStart, responseIdEnd, responseIdExtended } = resolveResponseIds(step);

    view.setUint8(
      offset,
      (step.expectCanResponse ? REQUEST_FLAG_EXPECT_CAN_RESPONSE : 0) |
        (isTxCanIdExtended(step) ? REQUEST_FLAG_TX_CAN_ID_EXTENDED : 0) |
        (step.expectCanResponse && responseIdExtended ? REQUEST_FLAG_RESPONSE_ID_EXTENDED : 0) |
        (isotpAddressing !== undefined ? REQUEST_FLAG_ISOTP_ADDRESSING : 0) |
        (canFd ? REQUEST_FLAG_CAN_FD : 0),
    );
    if (isotpAddressing !== undefined) {
      view.setUint8(offset + 1, isotpAddressing.tx & 0xff);
      view.setUint8(offset + 2, isotpAddressing.rx & 0xff);
    }
    view.setUint32(offset + 1 + addressOffset, txFrame.canId, true);
    view.setUint8(offset + 5 + addressOffset, dlc);
    buf.set(txFrame.data.subarray(0, dlc), offset + 6 + addressOffset);
    view.setUint16(offset + 14 + addressOffset, step.delayAfterMs ?? 0, true);
    offset += BATCH_STEP_BASE_SIZE + addressOffset;

    if (step.expectCanResponse) {
      view.setUint32(offset, responseIdStart, true);
      view.setUint32(offset + 4, responseIdEnd, true);
      view.setUint16(offset + 8, batchStepTimeoutMs(step), true);
      offset += BATCH_STEP_RESPONSE_FIELDS_SIZE;
    }
  }

  return buf;
}

/**
 * Parses a batch result list: `step_count, executed_count`, then per executed
 * step `step_index, status, flags, response_can_id:u32, payload_len:u16, payload`.
 */
export function parseBatchResultPayload(payload: Uint8Array): BatchResult {
  if (payload.length < BATCH_RESULT_HEADER_SIZE) {
    throw new Error(`Invalid batch result length ${payload.length}`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const stepCount = view.getUint8(0);
  const executedCount = view.getUint8(1);
  if (executedCount > stepCount) {
    throw new Error(`Batch result executed ${executedCount} of ${stepCount} steps`);
  }

  const entries: BatchResultEntry[] = [];
  let offset = BATCH_RESULT_HEADER_SIZE;
  for (let i = 0; i < executedCount; i++) {
    if (offset + BATCH_RESULT_ENTRY_HEADER_SIZE > payload.length) {
      throw new Error(`Batch result entry ${i} is truncated`);
    }
    const stepIndex = view.getUint8(offset);
    const status = view.getUint8(offset + 1);
    const flags = view.getUint8(offset + 2);
    const responseCanId = view.getUint32(offset + 3, true);
    const payloadLength = view.getUint16(offset + 7, true);
    offset += BATCH_RESULT_ENTRY_HEADER_SIZE;
    if (offset + payloadLength > payload.length) {
      throw new Error(`Batch result entry ${i} payload is truncated`);
    }
    if (stepIndex !== i) {
      throw new Error(`Batch result entry ${i} reports step index ${stepIndex}`);
    }
    entries.push({
      stepIndex,
      status,
      responseCanIdExtended: (flags & RESPONSE_FLAG_CAN_ID_EXTENDED) !== 0,
      responseCanId,
      payload: payload.slice(offset, offset + payloadLength),
    });
    offset += payloadLength;
  }
  if (offset !== payload.length) {
    throw new Error(`Batch result has ${payload.length - offset} trailing byte(s)`);
  }

  return { stepCount, entries };
}

/** Maps a device batch result onto per-step outcomes; steps the device never ran are `skipped`. */
export function toBatchStepResults(
  result: BatchResult,
  steps: readonly VehicleBatchStep[],
): VehicleBatchStepResult[] {
  if (result.stepCount !== steps.length) {
    throw new Error(`Batch result covers ${result.stepCount} steps, expected ${steps.length}`);
  }
  return steps.map((step, index): VehicleBatchStepResult => {
    const entry = result.entries[index];
    return entry === undefined ? { status: "skipped" } : toBatchStepResult(step, entry);
  });
}

/** Maps one device status (batch entry or single request reply) onto a step outcome. */
export function toBatchStepResult(
  step: VehicleBatchStep,
  outcome: { status: number; responseCanId: number; payload: Uint8Array },
): VehicleBatchStepResult {
  switch (outcome.status) {
    case REQUEST_STATUS_OK:
      return step.expectCanResponse
        ? { status: "ok", payload: outcome.payload, responseCanId: outcome.responseCanId }
        : { status: "ok" };
    case REQUEST_STATUS_CAN_RX_TIMEOUT:
      return { status: "no_response" };
    case REQUEST_STATUS_CAN_TX_FAIL:
      return { status: "tx_failed" };
    default:
      return { status: "error", error: `CAN request failed with status ${describeRequestStatus(outcome.status)}` };
  }
}

function validateBatchStep(step: VehicleBatchStep, index: number): void {
  const dlc = step.txFrame.dlc ?? step.txFrame.data.length;
  if (!Number.isInteger(dlc) || dlc < 0 || dlc > 8) {
    throw new Error(`Batch step ${index} has invalid CAN DLC ${dlc}`);
  }
  const delayMs = step.delayAfterMs ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 0xffff) {
    throw new Error(`Batch step ${index} has invalid delay ${delayMs} ms`);
  }
  if (step.expectCanResponse) {
    const timeoutMs = batchStepTimeoutMs(step);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0xffff) {
      throw new Error(`Batch step ${index} has invalid timeout ${timeoutMs} ms`);
    }
  }
}

function batchStepPacketSize(step: VehicleBatchStep): number {
  return (
    BATCH_STEP_BASE_SIZE +
    (step.isotpAddressing !== undefined ? ISOTP_ADDRESSING_FIELD_SIZE : 0) +
    (step.expectCanResponse ? BATCH_STEP_RESPONSE_FIELDS_SIZE : 0)
  );
}

function batchPacketSize(steps: readonly VehicleBatchStep[]): number {
  return steps.reduce((total, step) => total + batchStepPacketSize(step), BATCH_HEADER_SIZE);
}

function fitsOneBatch(steps: readonly VehicleBatchStep[]): boolean {
  return (
    steps.length <= BATCH_MAX_STEPS &&
    batchPacketSize(steps) <= BLE_MAX_REQUEST_WRITE_BYTES &&
    batchBudgetMs(steps) <= BATCH_MAX_TOTAL_BUDGET_MS
  );
}
