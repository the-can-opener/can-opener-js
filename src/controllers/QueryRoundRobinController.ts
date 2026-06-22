import type { QueryController } from "./QueryController.js";
import type { ProfileQuery } from "../profile/types.js";

type Timer = ReturnType<typeof setInterval>;

export interface QueryRoundRobinStatus {
  hzByName: Record<string, number>;
  names: string[];
  totalHz: number;
  perQueryHz: number;
}

const DEFAULT_TOTAL_FREQUENCY_HZ = 10;

export class QueryRoundRobinController {
  private queries: ProfileQuery[] = [];
  private interval: Timer | undefined;
  private cursor = 0;
  private inFlight: Promise<unknown> | undefined;
  private readonly pollHistoryByName = new Map<string, number[]>();

  constructor(
    private readonly queryController: QueryController,
    private readonly totalFrequencyHz = DEFAULT_TOTAL_FREQUENCY_HZ,
  ) {}

  update(queries: readonly ProfileQuery[]): void {
    this.clear();
    this.queries = uniqueQueries(queries);

    if (this.queries.length === 0) {
      return;
    }

    const intervalMs = 1000 / this.totalFrequencyHz;
    this.interval = setInterval(() => {
      this.pollNext();
    }, intervalMs);
    this.pollNext();
  }

  clear(): void {
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.queries = [];
    this.cursor = 0;
    this.inFlight = undefined;
    this.pollHistoryByName.clear();
  }

  activeQueryNames(): string[] {
    return this.queries.map((query) => query.name);
  }

  effectiveHzFor(queryName: string): number {
    if (!this.activeQueryNames().includes(queryName) || this.queries.length === 0) {
      return 0;
    }

    return this.totalFrequencyHz / this.queries.length;
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

  private pollNext(): void {
    if (this.queries.length === 0 || this.inFlight !== undefined) {
      return;
    }

    const query = this.queries[this.cursor % this.queries.length];
    if (query === undefined) {
      return;
    }

    this.cursor += 1;
    this.inFlight = this.queryController.requestProfile(query)
      .then((value) => {
        this.recordPollSuccess(query.name);
        return value;
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = undefined;
      });
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
