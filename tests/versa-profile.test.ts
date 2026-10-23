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
      "FRONT_LEFT_DOOR_OPEN",
      "FRONT_RIGHT_DOOR_OPEN",
      "REAR_LEFT_DOOR_OPEN",
      "REAR_RIGHT_DOOR_OPEN",
    ])).resolves.toBe(true);
    expect(car.subscriptionCount()).toBe(13);

    transport.emitFrame(car.dbc.encodeSignal("SPEED_KMPH", 42));
    expect(car.state.get<number>("SPEED")).toBeCloseTo(42, 0);

    await car.disconnect();
  });
});
