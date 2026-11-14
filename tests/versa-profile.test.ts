import { describe, expect, it } from "vitest";
import versaProfileContent from "../examples/slcan-web/nissan-versa-vehicle-profile-1-6/profile.yaml?raw";
import versaSignalsContent from "../examples/slcan-web/nissan-versa-vehicle-profile-1-6/signals.dbc?raw";
import { VirtualVehicleManager } from "../src/manager/VirtualVehicleManager.js";
import { MockTransport } from "../src/transport/index.js";

const versaProfile = {
  name: "nissan-versa",
  content: versaProfileContent,
  dbcFiles: [{ name: "signals.dbc", content: versaSignalsContent }],
};

const FRONT_LEFT_DOOR = "Vehicle.Cabin.Door.Row1.DriverSide.IsOpen";
const FRONT_RIGHT_DOOR = "Vehicle.Cabin.Door.Row1.PassengerSide.IsOpen";

describe("Nissan Versa profile", () => {
  it("subscribes to the broadcast signals declared in the profile", async () => {
    const transport = new MockTransport();
    const car = await new VirtualVehicleManager().connect({
      id: "versa",
      transport,
      profiles: [versaProfile],
    });

    // The format 1 profile declares keywords; the alias methods take them.
    await expect(car.alias.subscribe([
      "SPEED",
      "RPM",
      "TPS",
      "STEERING_ANGLE",
      "BRAKE_LIGHTS",
      "FRONT_LEFT_DOOR",
      "FRONT_RIGHT_DOOR",
      "REAR_LEFT_DOOR",
      "REAR_RIGHT_DOOR",
    ])).resolves.toBe(true);
    // The light keywords command a target, so their state is read by VSS path.
    await expect(car.subscribe([
      "Vehicle.Body.Lights.Beam.Low.IsOn",
      "Vehicle.Body.Lights.Beam.High.IsOn",
      "Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling",
      "Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling",
    ])).resolves.toBe(true);
    expect(car.subscriptionCount()).toBe(13);

    transport.emitFrame(car.dbc.encodeSignal("SPEED_KMPH", 42));
    expect(car.state.get<number>("Vehicle.Speed")).toBeCloseTo(42, 0);

    // The DBC's open/closed labels become the boolean the VSS path carries.
    transport.emitFrame({
      canId: 1549,
      data: Uint8Array.of(0b0000_1000, 0, 0, 0, 0, 0, 0, 0),
    });
    expect(car.state.get<boolean>(FRONT_LEFT_DOOR)).toBe(true);
    expect(car.state.get<boolean>(FRONT_RIGHT_DOOR)).toBe(false);

    await car.disconnect();
  });
});
