import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";

const profileDirectory = new URL(
  "../examples/slcan-web/nissan-versa-vehicle-profile-1-6/",
  import.meta.url,
);

const versaProfile = {
  name: "nissan-versa",
  content: readFileSync(new URL("profile.yaml", profileDirectory), "utf8"),
  dbcFiles: [
    {
      name: "signals.dbc",
      content: readFileSync(new URL("signals.dbc", profileDirectory), "utf8"),
    },
  ],
};

describe("Nissan Versa profile", () => {
  it("subscribes to the broadcast signals declared in the profile", async () => {
    const transport = new MockTransport();
    const car = await new VirtualVehicleManager().connect({
      id: "versa",
      transport,
      profiles: [versaProfile],
    });

    await expect(car.subscribe([
      "SPEED",
      "RPM",
      "TPS",
      "STEERING_ANGLE",
      "BRAKE_LIGHTS",
      "LOW_BEAMS",
      "HIGH_BEAMS",
      "LEFT_SIGNAL",
      "RIGHT_SIGNAL",
      "FRONT_LEFT_DOOR",
      "FRONT_RIGHT_DOOR",
      "REAR_LEFT_DOOR",
      "REAR_RIGHT_DOOR",
    ])).resolves.toBe(true);
    expect(car.subscriptionCount()).toBe(13);

    transport.emitFrame(car.dbc.encodeSignal("SPEED_KMPH", 42));
    expect(car.state.get<number>("SPEED")).toBeCloseTo(42, 0);

    // Portable door entities carry the DBC's open/closed labels.
    transport.emitFrame({
      canId: 1549,
      data: Uint8Array.of(0b0000_1000, 0, 0, 0, 0, 0, 0, 0),
    });
    expect(car.state.get<string>("FRONT_LEFT_DOOR")).toBe("open");
    expect(car.state.get<string>("FRONT_RIGHT_DOOR")).toBe("closed");

    await car.disconnect();
  });
});
