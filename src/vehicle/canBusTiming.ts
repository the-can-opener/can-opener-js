import { VehicleConnectionError } from "../errors.js";
import type { ProfileCanBusConfig } from "../profile/types.js";
import type {
  CanBusConfigResponse,
  CanBusConfigStatus,
  VehicleTransport,
} from "../transport/types.js";

/** What the transport reported after applying one bus's profile timing. */
export interface CanBusTimingReport extends CanBusConfigResponse {
  /** Timing the profiles asked for; `bitrate: "auto"` means the adapter searched for it. */
  requested: ProfileCanBusConfig;
}

/**
 * Applies `configs` in bus order and returns one report per bus whose timing
 * was sent. A bus already reported with the same requested timing is skipped,
 * so repeated profile reloads do not repeat a listen-only auto-detect.
 */
export async function configureCanBuses(
  transport: VehicleTransport,
  configs: readonly ProfileCanBusConfig[],
  previous: readonly CanBusTimingReport[] = [],
): Promise<CanBusTimingReport[]> {
  const pending = configs.filter(
    (config) => !previous.some((report) => sameRequestedTiming(report, config)),
  );
  if (pending.length === 0) {
    return [];
  }
  if (transport.configureBus === undefined) {
    throw new VehicleConnectionError(
      "Vehicle profile declares CAN bus timing but transport cannot configure it",
    );
  }

  const reports: CanBusTimingReport[] = [];
  for (const config of pending) {
    const response = await transport.configureBus({
      bus: config.bus,
      bitrate: config.bitrate,
      ...(config.dataBitrate !== undefined ? { dataBitrate: config.dataBitrate } : {}),
    });
    if (!isUsableBusTiming(config, response.status)) {
      throw new VehicleConnectionError(
        `Failed to configure CAN bus ${config.bus}: ${response.status}`,
      );
    }
    reports.push({ ...response, requested: { ...config } });
  }
  return reports;
}

/** Replaces reports for re-applied buses and keeps the rest, in bus order. */
export function mergeCanBusTimingReports(
  previous: readonly CanBusTimingReport[],
  next: readonly CanBusTimingReport[],
): CanBusTimingReport[] {
  const byBus = new Map(previous.map((report) => [report.bus, report]));
  for (const report of next) {
    byBus.set(report.bus, report);
  }
  return Array.from(byBus.values()).sort((a, b) => a.bus - b.bus);
}

function sameRequestedTiming(
  report: CanBusTimingReport,
  config: ProfileCanBusConfig,
): boolean {
  return (
    report.requested.bus === config.bus &&
    report.requested.bitrate === config.bitrate &&
    report.requested.dataBitrate === config.dataBitrate
  );
}

// A failed auto-detect leaves the adapter on its previous timing (500 kbit/s
// by default), which is still usable; the report says detection failed.
function isUsableBusTiming(
  config: ProfileCanBusConfig,
  status: CanBusConfigStatus,
): boolean {
  switch (status) {
    case "ok":
      return true;
    case "auto_detect_failed":
      return config.bitrate === "auto";
    case "invalid_bus":
    case "invalid_bitrate":
    case "internal_error":
      return false;
    default: {
      const unhandled: never = status;
      throw new Error(`Unhandled CAN bus config status: ${String(unhandled)}`);
    }
  }
}
