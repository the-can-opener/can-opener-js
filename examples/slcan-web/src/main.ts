import { VirtualVehicleManager, type VirtualVehicle } from "can-opener-js";
import {
  SlcanTransport,
  openWebSerialSlcanPort,
  requestWebSerialPort,
  webSerialAvailable,
} from "can-opener-js/transport";
import profileYaml from "../nissan-versa-vehicle-profile-1-6/profile.yaml?raw";
import signalsDbc from "../nissan-versa-vehicle-profile-1-6/signals.dbc?raw";

const SIGNALS = [
  "SPEED",
  "RPM",
  "TPS",
  "STEERING_ANGLE",
  "BRAKE_LIGHTS",
  "LOW_BEAMS",
  "HIGH_BEAMS",
  "LEFT_SIGNAL",
  "RIGHT_SIGNAL",
  "FRONT_LEFT_DOOR_OPEN",
  "FRONT_RIGHT_DOOR_OPEN",
  "REAR_LEFT_DOOR_OPEN",
  "REAR_RIGHT_DOOR_OPEN",
] as const;

const ACTIONS = [
  "ECU_WAKE",
  "HORN",
  "HIGH_BEAM",
  "RUNNING_LIGHTS",
  "LOW_BEAM",
  "LEFT_SIGNAL",
  "RIGHT_SIGNAL",
  "SIGNAL_OFF",
  "LOCK",
  "UNLOCK",
  "WIPERS",
] as const;

const connectButton = element<HTMLButtonElement>("connect");
const disconnectButton = element<HTMLButtonElement>("disconnect");
const bitrateSelect = element<HTMLSelectElement>("bitrate");
const status = element<HTMLSpanElement>("status");
const signals = element<HTMLDListElement>("signals");
const actions = element<HTMLDivElement>("actions");
const log = element<HTMLPreElement>("log");
const sendButton = element<HTMLButtonElement>("send");
const watchButton = element<HTMLButtonElement>("watch-button");

const manager = new VirtualVehicleManager();
let vehicle: VirtualVehicle | undefined;
let transport: SlcanTransport | undefined;
let actionBusy = false;
const lines: string[] = [];
const actionButtons = new Map<string, HTMLButtonElement>();

for (const name of SIGNALS) {
  const term = document.createElement("dt");
  term.textContent = name;
  const value = document.createElement("dd");
  value.dataset.signal = name;
  value.textContent = "—";
  signals.append(term, value);
}

for (const name of ACTIONS) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = name;
  button.disabled = true;
  button.addEventListener("click", () => {
    void runAction(name);
  });
  actionButtons.set(name, button);
  actions.append(button);
}

if (!webSerialAvailable()) {
  status.textContent = "Web Serial is unavailable. Open this page in Chrome or Edge.";
  connectButton.disabled = true;
}

connectButton.addEventListener("click", () => {
  void connect();
});

disconnectButton.addEventListener("click", () => {
  void disconnect();
});

bitrateSelect.addEventListener("change", () => {
  if (transport === undefined) {
    return;
  }
  void transport.configureBus({ bus: 0, bitrate: selectedBitrate() }).then((response) => {
    trace("bus", `${response.status} ${response.bitrate ?? ""}`.trim());
  }).catch((error: unknown) => {
    trace("bus", errorText(error));
  });
});

element<HTMLFormElement>("raw").addEventListener("submit", (event) => {
  event.preventDefault();
  void sendRaw();
});

element<HTMLFormElement>("watch").addEventListener("submit", (event) => {
  event.preventDefault();
  void watchId();
});

async function connect(): Promise<void> {
  connectButton.disabled = true;
  status.textContent = "Choose a serial port…";
  try {
    const port = await requestWebSerialPort();
    const bytePort = await openWebSerialSlcanPort(port);
    const nextTransport = new SlcanTransport(bytePort, {
      bitrate: selectedBitrate(),
      onTrace: (direction, text) => {
        trace(direction, text);
      },
    });
    const nextVehicle = await manager.connect({
      id: "versa",
      transport: nextTransport,
      profiles: [
        {
          name: "nissan-versa",
          content: profileYaml,
          dbcFiles: [{ name: "signals.dbc", content: signalsDbc }],
        },
      ],
    });
    const subscribed = await nextVehicle.subscribe(SIGNALS);
    if (!subscribed) {
      throw new Error("Versa profile signals did not match the DBC");
    }
    nextVehicle.state.subscribe(() => {
      renderSignals(nextVehicle.state.snapshot());
    });
    nextTransport.onMonitorSnapshot((snapshot) => {
      for (const frame of snapshot.frames) {
        trace("can", `${frame.canId.toString(16).toUpperCase()} ${hex(frame.data)}`);
      }
    });
    vehicle = nextVehicle;
    transport = nextTransport;
    status.textContent = `Connected · ${nextVehicle.subscriptionCount()} signals`;
    disconnectButton.disabled = false;
    setControlsEnabled(true);
  } catch (error: unknown) {
    status.textContent = errorText(error);
    connectButton.disabled = false;
    await manager.disconnectAll().catch(() => undefined);
    vehicle = undefined;
    transport = undefined;
  }
}

async function disconnect(): Promise<void> {
  await manager.disconnectAll();
  vehicle = undefined;
  transport = undefined;
  actionBusy = false;
  status.textContent = "Not connected";
  connectButton.disabled = false;
  disconnectButton.disabled = true;
  setControlsEnabled(false);
  renderSignals({});
}

async function runAction(name: string): Promise<void> {
  if (vehicle === undefined || actionBusy) {
    return;
  }
  actionBusy = true;
  setControlsEnabled(false);
  try {
    const result = await vehicle.action(name);
    trace("action", `${name} ${result === undefined ? "sent" : String(result)}`);
  } catch (error: unknown) {
    trace("action", `${name} ${errorText(error)}`);
  } finally {
    actionBusy = false;
    if (vehicle !== undefined) {
      setControlsEnabled(true);
    }
  }
}

async function sendRaw(): Promise<void> {
  if (transport === undefined) {
    return;
  }
  const expectCanResponse = element<HTMLInputElement>("expect-response").checked;
  try {
    const canId = Number.parseInt(element<HTMLInputElement>("can-id").value, 16);
    const data = parseHex(element<HTMLInputElement>("can-data").value);
    const payload = await transport.sendRequest({
      txFrame: { canId, dlc: data.length, data },
      expectCanResponse,
      ...(expectCanResponse ? { responseIdStart: 0x765, responseIdEnd: 0x765, timeoutMs: 1000 } : {}),
    });
    trace("payload", payload === undefined ? "sent" : hex(payload));
  } catch (error: unknown) {
    trace("payload", errorText(error));
  }
}

async function watchId(): Promise<void> {
  if (transport === undefined) {
    return;
  }
  const canId = Number.parseInt(element<HTMLInputElement>("watch-id").value, 16);
  const response = await transport.updateMonitor({ operation: "add", canIds: [canId] });
  trace("watch", `${canId.toString(16).toUpperCase()} ${response.status}`);
}

function selectedBitrate(): number {
  return Number(bitrateSelect.value);
}

function renderSignals(snapshot: Record<string, unknown>): void {
  for (const name of SIGNALS) {
    const value = signals.querySelector(`dd[data-signal="${name}"]`);
    if (value instanceof HTMLElement) {
      value.textContent = formatValue(snapshot[name]);
    }
  }
}

function setControlsEnabled(enabled: boolean): void {
  for (const button of actionButtons.values()) {
    button.disabled = !enabled;
  }
  sendButton.disabled = !enabled;
  watchButton.disabled = !enabled;
}

function trace(label: string, text: string): void {
  lines.push(`${label.padEnd(7)} ${text}`);
  if (lines.length > 200) {
    lines.shift();
  }
  log.textContent = lines.join("\n");
  log.scrollTop = log.scrollHeight;
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "—";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

function parseHex(text: string): Uint8Array {
  const bytes = text
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 16));
  if (bytes.length === 0 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
    throw new Error("Data must be hex bytes, for example 02 10 81");
  }
  return Uint8Array.from(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Missing #${id}`);
  }
  return found as T;
}
