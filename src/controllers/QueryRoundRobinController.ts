import type { QueryController } from "./QueryController.js";
import type { ProfileQuery } from "../profile/types.js";

export interface QueryRoundRobinStatus {
  hzByName: Record<string, number>;
  names: string[];
  totalHz: number;
  perQueryHz: number;
}

// Minimum spacing between the start of consecutive OBD requests.
// Keeps the BLE radio able to interleave monitor notifications without
// adding a fixed post-response delay on top of the request round trip.
const MIN_QUERY_START_INTERVAL_MS = 85;
const QUERY_FAILURE_BACKOFF_BASE_MS = 250;
const QUERY_FAILURE_BACKOFF_MAX_MS = 2000;
const HZ_WINDOW_MS = 10000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class QueryRoundRobinController {
  private queries: ProfileQuery[] = [];
  private running = false;
  private stopped = false;
  private loopGeneration = 0;
  private cursor = 0;
  private lastQueryStartMs = 0;
  private readonly failureCountByName = new Map<string, number>();
  private readonly nextRetryAtByName = new Map<string, number>();
  private readonly pollHistoryByName = new Map<string, number[]>();

  constructor(private readonly queryController: QueryController) {}

  update(queries: readonly ProfileQuery[]): void {
    this.stopped = true;
    this.loopGeneration += 1;
    const generation = this.loopGeneration;

    this.queries = uniqueQueries(queries);
    this.cursor = 0;
    this.lastQueryStartMs = 0;
    this.failureCountByName.clear();
    this.nextRetryAtByName.clear();
    this.pollHistoryByName.clear();

    if (this.queries.length === 0) {
      return;
    }

    this.stopped = false;
    void this.runLoop(generation);
  }

  clear(): void {
    this.stopped = true;
    this.loopGeneration += 1;
    this.queries = [];
    this.cursor = 0;
    this.lastQueryStartMs = 0;
    this.failureCountByName.clear();
    this.nextRetryAtByName.clear();
    this.pollHistoryByName.clear();
  }

  activeQueryNames(): string[] {
    return this.queries.map((query) => query.name);
  }

  effectiveHzFor(queryName: string): number {
    if (
      !this.activeQueryNames().includes(queryName) ||
      this.queries.length === 0
    ) {
      return 0;
    }
    // Approximate ceiling when BLE round trips are shorter than the min interval.
    return 1000 / MIN_QUERY_START_INTERVAL_MS;
  }

  status(): QueryRoundRobinStatus {
    const names = this.activeQueryNames();
    const now = Date.now();
    const hzByName = Object.fromEntries(
      names.map((name) => [
        name,
        this.recentHistory(name, now).length / (HZ_WINDOW_MS / 1000),
      ]),
    );
    const totalHz = Object.values(hzByName).reduce((sum, hz) => sum + hz, 0);

    return {
      hzByName,
      names,
      totalHz,
      perQueryHz: names.length === 0 ? 0 : totalHz / names.length,
    };
  }

  private async runLoop(generation: number): Promise<void> {
    this.running = true;

    try {
      while (
        !this.stopped &&
        generation === this.loopGeneration &&
        this.queries.length > 0
      ) {
        const query = this.nextAvailableQuery();

        if (query === undefined) {
          await this.waitForNextRetry();
          continue;
        }

        try {
          await this.waitForNextQuerySlot();
          await this.queryController.requestProfile(query);
          this.clearQueryFailure(query.name);
          this.recordPollSuccess(query.name);
        } catch {
          this.recordQueryFailure(query.name);
        }

        if (this.stopped || generation !== this.loopGeneration) {
          break;
        }
      }
    } finally {
      if (generation === this.loopGeneration) {
        this.running = false;
      }
    }
  }

  private nextAvailableQuery(): ProfileQuery | undefined {
    const now = Date.now();
    for (let attempt = 0; attempt < this.queries.length; attempt += 1) {
      const query = this.queries[this.cursor % this.queries.length];
      this.cursor += 1;
      if (query === undefined) {
        return undefined;
      }

      const nextRetryAt = this.nextRetryAtByName.get(query.name);
      if (nextRetryAt !== undefined && now < nextRetryAt) {
        continue;
      }

      return query;
    }

    return undefined;
  }

  private async waitForNextRetry(): Promise<void> {
    const now = Date.now();
    const retryTimes = Array.from(this.nextRetryAtByName.values());
    if (retryTimes.length === 0) {
      await delay(MIN_QUERY_START_INTERVAL_MS);
      return;
    }

    const waitMs = Math.max(0, Math.min(...retryTimes) - now);
    if (waitMs > 0) {
      await delay(waitMs);
    }
  }

  private clearQueryFailure(queryName: string): void {
    this.failureCountByName.delete(queryName);
    this.nextRetryAtByName.delete(queryName);
  }

  private recordQueryFailure(queryName: string): void {
    const failureCount = (this.failureCountByName.get(queryName) ?? 0) + 1;
    this.failureCountByName.set(queryName, failureCount);
    this.nextRetryAtByName.set(
      queryName,
      Date.now() + queryFailureBackoffMs(failureCount),
    );
  }

  private async waitForNextQuerySlot(): Promise<void> {
    const now = Date.now();
    const elapsedSinceLastStart = now - this.lastQueryStartMs;
    if (elapsedSinceLastStart < MIN_QUERY_START_INTERVAL_MS) {
      await delay(MIN_QUERY_START_INTERVAL_MS - elapsedSinceLastStart);
    }
    this.lastQueryStartMs = Date.now();
  }

  private recordPollSuccess(queryName: string): void {
    const now = Date.now();
    const history = this.recentHistory(queryName, now);
    history.push(now);
    this.pollHistoryByName.set(queryName, history);
  }

  private recentHistory(queryName: string, now: number): number[] {
    const history = this.pollHistoryByName.get(queryName) ?? [];
    const recentHistory = history.filter(
      (timestamp) => now - timestamp <= HZ_WINDOW_MS,
    );
    this.pollHistoryByName.set(queryName, recentHistory);
    return recentHistory;
  }
}

function queryFailureBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, failureCount - 1);
  return Math.min(
    QUERY_FAILURE_BACKOFF_MAX_MS,
    QUERY_FAILURE_BACKOFF_BASE_MS * 2 ** exponent,
  );
}

function uniqueQueries(queries: readonly ProfileQuery[]): ProfileQuery[] {
  const seen = new Set<string>();
  const unique: ProfileQuery[] = [];

  for (const query of queries) {
    if (seen.has(query.name)) {
      continue;
    }

    seen.add(query.name);
    unique.push(query);
  }

  return unique;
}
