import type { QueryController } from "./QueryController.js";
import type { ProfileQuery } from "../profile/types.js";

export interface QueryRoundRobinStatus {
  hzByName: Record<string, number>;
  names: string[];
  totalHz: number;
  perQueryHz: number;
}

// Minimum idle gap between the end of one query and the start of the next.
// Gives the BLE radio time to drain monitor notifications between OBD requests.
const INTER_QUERY_GAP_MS = 2000;
const QUERY_FAILURE_BACKOFF_MS = 20000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class QueryRoundRobinController {
  private queries: ProfileQuery[] = [];
  private running = false;
  private stopped = false;
  private cursor = 0;
  private readonly failedAtByName = new Map<string, number>();
  private readonly pollHistoryByName = new Map<string, number[]>();

  constructor(
    private readonly queryController: QueryController,
  ) {}

  update(queries: readonly ProfileQuery[]): void {
    this.clear();
    this.queries = uniqueQueries(queries);

    if (this.queries.length === 0) {
      return;
    }

    this.stopped = false;
    void this.runLoop();
  }

  clear(): void {
    this.stopped = true;
    this.queries = [];
    this.cursor = 0;
    this.failedAtByName.clear();
    this.pollHistoryByName.clear();
  }

  activeQueryNames(): string[] {
    return this.queries.map((query) => query.name);
  }

  effectiveHzFor(queryName: string): number {
    if (!this.activeQueryNames().includes(queryName) || this.queries.length === 0) {
      return 0;
    }
    // Approximate: one query every (n * INTER_QUERY_GAP_MS + typical_round_trip)
    return 1000 / (this.queries.length * INTER_QUERY_GAP_MS);
  }

  status(): QueryRoundRobinStatus {
    const names = this.activeQueryNames();
    const now = Date.now();
    const hzByName = Object.fromEntries(
      names.map((name) => [name, this.recentHistory(name, now).length]),
    );
    const totalHz = Object.values(hzByName).reduce((sum, hz) => sum + hz, 0);

    return {
      hzByName,
      names,
      totalHz,
      perQueryHz: names.length === 0 ? 0 : totalHz / names.length,
    };
  }

  private async runLoop(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      while (!this.stopped && this.queries.length > 0) {
        const query = this.nextAvailableQuery();

        if (query !== undefined) {
          try {
            await this.queryController.requestProfile(query);
            this.failedAtByName.delete(query.name);
            this.recordPollSuccess(query.name);
          } catch {
            this.failedAtByName.set(query.name, Date.now());
          }
        }

        if (this.stopped) {
          break;
        }

        await delay(INTER_QUERY_GAP_MS);
      }
    } finally {
      this.running = false;
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

      const failedAt = this.failedAtByName.get(query.name);
      if (failedAt !== undefined && now - failedAt < QUERY_FAILURE_BACKOFF_MS) {
        continue;
      }

      if (failedAt !== undefined) {
        this.failedAtByName.delete(query.name);
      }

      return query;
    }

    return undefined;
  }

  private recordPollSuccess(queryName: string): void {
    const now = Date.now();
    const history = this.recentHistory(queryName, now);
    history.push(now);
    this.pollHistoryByName.set(queryName, history);
  }

  private recentHistory(queryName: string, now: number): number[] {
    const history = this.pollHistoryByName.get(queryName) ?? [];
    const recentHistory = history.filter((timestamp) => now - timestamp <= 1000);
    this.pollHistoryByName.set(queryName, recentHistory);
    return recentHistory;
  }
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
