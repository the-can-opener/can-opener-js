import { proxy, snapshot, subscribe } from "valtio/vanilla";

export class VehicleState {
  [signal: string]: unknown;

  readonly data = proxy<Record<string, unknown>>({});
  private readonly accessProxy = new Proxy(this, {
    get: (target, property) => {
      if (typeof property !== "string") {
        return Reflect.get(target, property);
      }

      if (property in target) {
        return Reflect.get(target, property);
      }

      return target.get(property) ?? target.get(toUpperSnakeCase(property));
    },
  }) as Record<string, unknown>;

  constructor() {
    return this.accessProxy as VehicleState;
  }

  update(signal: string, value: unknown): void {
    this.data[signal] = value;
  }

  get<T>(signal: string): T | undefined {
    return this.data[signal] as T | undefined;
  }

  clear(): void {
    for (const key of Object.keys(this.data)) {
      delete this.data[key];
    }
  }

  subscribe(cb: () => void): () => void {
    return subscribe(this.data, cb);
  }

  snapshot(): Record<string, unknown> {
    return snapshot(this.data);
  }

}

function toUpperSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toUpperCase();
}
