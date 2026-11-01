# Vehicle Keywords

Profile spec version 1.1. The naming convention and value rules are defined in
[Vehicle Profile Specification](./vehicle-profile-spec.md), section 3. This
document is the registry of common keywords: the names a profile should use
when a capability has the stated meaning, so that an application written
against one vehicle works with the next.

The list is deliberately short. A profile may add vehicle-specific keywords
for anything not here; propose a new common keyword only when more than one
vehicle needs the same thing.

## 1. How to read the tables

Each keyword names an *entity*, a thing on the vehicle, never a predicate or a
verb: `TRUNK`, not `TRUNK_OPEN` or `OPEN_TRUNK`. One keyword covers every
way a profile touches that entity. `LEFT_SIGNAL` is both the monitored
indicator state and the action that drives the indicator; `SPEED` is both a
broadcast signal and an OBD-II query.

**Used as** lists the profile sections in which the keyword may be declared:

- `signal`: passive monitor under `signals`, decoded from broadcast frames.
- `query`: request and response under `queries`.
- `action`: under `actions`. An action with `values` runs one present-tense
  command per value; an action without `values` is a trigger, a momentary
  routine with nothing to set back. The table says which.

A profile declares only what its vehicle supports. A vehicle that broadcasts
the trunk state but cannot open it declares `TRUNK` under `signals` only.

Values and units:

- Signal and query values are lowercase conditions: `closed`, `locked`,
  `folded`, `on`. A profile uses `normalize.enum` to map the vehicle's own
  labels onto them.
- Action commands are the present tense of that condition when the words
  differ: `close`, `lock`, `unlock`, `fold`, `unfold`. `open`, `on`, `off`,
  and level names (`low`, `high`, `intermittent`, `auto`) are already the
  command, so the action uses the same word. The library records that
  profile-declared command unchanged after it reaches the bus; applications
  may interpret this convention, and a signal or query later replaces it
  with the reported condition.
- Numeric values use the unit in the table. A profile should map the keyword
  to a DBC signal scaled to that unit, so applications never convert.
- Apertures with a known travel also have a `<KEYWORD>_POSITION` entity in
  percent, `0` closed and `100` fully open.

Position prefixes are `FRONT_`/`REAR_` and `LEFT_`/`RIGHT_`, as seen from the
driver's seat facing forward. They are physical sides, not driver/passenger
side, because DBC signals are physical.

## 2. Body and access

| Keyword | Used as | Values | Description |
| --- | --- | --- | --- |
| `DOORS` | signal, action (values) | signal `locked`, `unlocked`; action `lock`, `unlock` | Central locking for all doors. `action("DOORS", { value: "lock" })` runs `DOORS.lock`. |
| `FRONT_LEFT_DOOR`, `FRONT_RIGHT_DOOR`, `REAR_LEFT_DOOR`, `REAR_RIGHT_DOOR` | signal | `open`, `closed` | Door ajar state. |
| `TRUNK` | signal, action (values) | signal `open`, `closed`; action `open`, `close` | Trunk lid, hatch, liftgate, or tailgate. A manual trunk may offer only `open` as a release. |
| `HOOD` | signal | `open`, `closed` | Hood or bonnet ajar state. |
| `SUNROOF` | signal, action (values) | signal `open`, `closed`; action `open`, `close` | Sunroof or moonroof. `SUNROOF_POSITION` gives the travel in percent. |
| `FRONT_LEFT_WINDOW`, `FRONT_RIGHT_WINDOW`, `REAR_LEFT_WINDOW`, `REAR_RIGHT_WINDOW` | signal, action (values) | signal `open`, `closed`; action `open`, `close` | Side window state. `<KEYWORD>_POSITION` gives the travel in percent. |
| `FUEL_DOOR` | signal, action (values) | signal `open`, `closed`; action `open`, `close` | Fuel filler door or flap. |
| `CHARGE_PORT` | signal, action (values) | signal `open`, `closed`; action `open`, `close` | Charge port door. For whether a cable is plugged in, see `CHARGER`. |
| `MIRRORS` | signal, action (values) | signal `folded`, `unfolded`; action `fold`, `unfold` | Power-folding side mirrors. |
| `FRONT_LEFT_SEATBELT`, `FRONT_RIGHT_SEATBELT` | signal | `fastened`, `unfastened` | Front seat belt buckle state. |

## 3. Lighting and signalling

| Keyword | Used as | Values | Description |
| --- | --- | --- | --- |
| `LOW_BEAMS` | signal, action | `on`, `off` | Low (dipped) headlights. Action with values: switch. Action without values: flash once. |
| `HIGH_BEAMS` | signal, action | `on`, `off` | High (main) beam headlights. Action with values: switch. Action without values: flash once. |
| `RUNNING_LIGHTS` | signal, action (values) | `on`, `off` | Parking, position, or daytime running lights. |
| `FOG_LIGHTS` | signal, action (values) | `on`, `off` | Fog lights. |
| `BRAKE_LIGHTS` | signal | `on`, `off` | Brake lamps lit. |
| `REVERSE_LIGHTS` | signal | `on`, `off` | Reverse lamps lit. |
| `LEFT_SIGNAL` | signal, action | `on`, `off` | Left turn indicator. Action with values: latch on or off, for vehicles whose body module holds the indicator. Action without values: flash once. |
| `RIGHT_SIGNAL` | signal, action | `on`, `off` | Right turn indicator, as `LEFT_SIGNAL`. |
| `HAZARDS` | signal, action (values) | `on`, `off` | Hazard warning lights. |
| `INTERIOR_LIGHTS` | signal, action (values) | `on`, `off` | Dome and courtesy lights. |

## 4. Wipers and climate

| Keyword | Used as | Values | Description |
| --- | --- | --- | --- |
| `WIPERS` | signal, action | `off`, `intermittent`, `low`, `high`, `auto` | Front wipers. Action with values: select a speed. Action without values: one wipe. |
| `REAR_WIPER` | signal, action (values) | `off`, `intermittent`, `on` | Rear window wiper. |
| `WASHER` | action (trigger) | | Windshield washer, one spray. |
| `FRONT_DEFROST` | signal, action (values) | `on`, `off` | Windshield defrost. |
| `REAR_DEFROST` | signal, action (values) | `on`, `off` | Rear window defroster. |
| `CLIMATE` | signal, action (values) | `on`, `off` | HVAC master state, including remote pre-conditioning. |
| `CABIN_TEMP_SETPOINT` | signal, query, action (values) | degrees C | Requested cabin temperature. |
| `CABIN_TEMP` | signal, query | degrees C | Measured cabin temperature. |
| `AMBIENT_TEMP` | signal, query | degrees C | Outside air temperature. |
| `FRONT_LEFT_SEAT_HEATER`, `FRONT_RIGHT_SEAT_HEATER` | signal, action (values) | `off`, `low`, `medium`, `high` | Front seat heating level. |

## 5. Driver controls and vehicle state

| Keyword | Used as | Values | Description |
| --- | --- | --- | --- |
| `IGNITION` | signal, query | `off`, `accessory`, `on`, `start` | Ignition or power-mode switch position. |
| `READY` | signal, query | `on`, `off` | Vehicle is ready to drive: engine running, or an EV in READY mode. |
| `ENGINE` | signal, action (values) | `on`, `off` | Combustion engine running. As an action: remote start and stop. |
| `GEAR` | signal, query | `park`, `reverse`, `neutral`, `drive`, `low` | Shift selector position. |
| `PARKING_BRAKE` | signal, action (values) | `on`, `off` | Parking or electric park brake engaged. |
| `CRUISE_CONTROL` | signal | `on`, `off` | Cruise control engaged. |
| `STEERING_ANGLE` | signal, query | degrees | Steering wheel angle, positive to the left, `0` centred. |
| `ACCELERATOR_PEDAL` | signal, query | percent | Accelerator pedal travel. For throttle plate position see `TPS`. |
| `BRAKE_PEDAL` | signal, query | percent | Brake pedal travel or pressure as a percentage. |

## 6. Speed and distance

| Keyword | Used as | Unit | Description |
| --- | --- | --- | --- |
| `SPEED` | signal, query | km/h | Vehicle road speed (OBD-II PID 0x0D). |
| `ODOMETER` | signal, query | km | Total distance travelled, as shown on the instrument cluster (PID 0xA6 where supported). Applications convert to miles. |
| `RANGE` | signal, query | km | Estimated remaining range on the current fuel and charge. |
| `DIST_SINCE_CLEAR` | query | km | Distance since diagnostic codes were cleared (PID 0x31). |
| `RUNTIME` | query | s | Time since engine start (PID 0x1F). |

## 7. Engine

OBD-II PID names keep their customary abbreviations because they are
universal across scan tools. Any of them may also be a `signal` on a vehicle
that broadcasts the value.

| Keyword | Used as | Unit | Description |
| --- | --- | --- | --- |
| `RPM` | signal, query | rpm | Engine speed (PID 0x0C). |
| `ENGINE_LOAD` | query | percent | Calculated engine load (PID 0x04). |
| `ECT` | signal, query | degrees C | Engine coolant temperature (PID 0x05). |
| `IAT` | query | degrees C | Intake air temperature (PID 0x0F). |
| `MAP` | query | kPa | Intake manifold absolute pressure (PID 0x0B). |
| `MAF` | query | g/s | Mass air flow (PID 0x10). |
| `TPS` | signal, query | percent | Throttle position (PID 0x11). |
| `BARO` | query | kPa | Barometric pressure (PID 0x33). |
| `BOOST_PRESSURE` | signal, query | kPa | Boost above atmospheric, `MAP` minus `BARO`. |
| `TIMING_ADVANCE` | query | degrees | Ignition timing advance (PID 0x0E). |
| `STFT_B1`, `STFT_B2` | query | percent | Short term fuel trim, bank 1 and 2 (PIDs 0x06, 0x08). |
| `LTFT_B1`, `LTFT_B2` | query | percent | Long term fuel trim, bank 1 and 2 (PIDs 0x07, 0x09). |
| `LAMBDA` | query | ratio | Commanded equivalence ratio (PID 0x44). |
| `O2_DATA` | query | V | Oxygen sensor voltage (PIDs 0x14 to 0x1B). |
| `FUEL_PRESSURE` | query | kPa | Fuel rail pressure (PID 0x0A or 0x23). |
| `FUEL_RATE` | signal, query | L/h | Fuel consumption rate (PID 0x5E). |
| `FUEL_LEVEL` | signal, query | percent | Fuel tank level (PID 0x2F). |
| `OIL_TEMP` | signal, query | degrees C | Engine oil temperature (PID 0x5C). |
| `OIL_PRESSURE` | signal, query | kPa | Engine oil pressure. |
| `OIL_LIFE` | query | percent | Remaining oil life from the maintenance monitor. |
| `TRANSMISSION_TEMP` | signal, query | degrees C | Transmission fluid temperature. |
| `DRIVER_TORQUE_DEMAND` | query | percent | Driver's demanded engine torque (PID 0x61). |
| `ACTUAL_TORQUE` | query | percent | Actual engine torque (PID 0x62). |
| `MODULE_VOLTAGE` | query | V | Control module supply voltage (PID 0x42). |

## 8. Batteries and charging

| Keyword | Used as | Values | Description |
| --- | --- | --- | --- |
| `AUX_BATTERY_VOLTAGE` | signal, query | V | 12 V auxiliary battery voltage. |
| `HV_BATTERY_SOC` | signal, query | percent | Traction battery state of charge. |
| `HV_BATTERY_SOH` | query | percent | Traction battery state of health. |
| `HV_BATTERY_VOLTAGE` | signal, query | V | Traction battery pack voltage. |
| `HV_BATTERY_CURRENT` | signal, query | A | Pack current, positive when discharging. |
| `HV_BATTERY_POWER` | signal, query | kW | Pack power, positive when discharging, negative when charging or regenerating. |
| `HV_BATTERY_TEMP` | signal, query | degrees C | Representative pack temperature. |
| `HV_BATTERY_CAPACITY` | query | kWh | Usable pack capacity. |
| `CHARGER` | signal, query | `connected`, `disconnected` | A charge cable is plugged in, whether or not energy is flowing. |
| `CHARGER_TYPE` | signal, query | `none`, `ac`, `dc` | Type of charger connected. |
| `CHARGING` | signal, query, action (values) | `on`, `off` | Energy is flowing into the traction battery. As an action: start and stop charging. |
| `CHARGE_LIMIT` | signal, query, action (values) | percent | Target state of charge at which charging stops. |
| `CHARGE_POWER` | signal, query | kW | Charging power delivered to the pack. |
| `CHARGE_TIME_REMAINING` | signal, query | min | Estimated time until `CHARGE_LIMIT` is reached. |

## 9. Tires

| Keyword | Used as | Unit | Description |
| --- | --- | --- | --- |
| `FRONT_LEFT_TIRE_PRESSURE`, `FRONT_RIGHT_TIRE_PRESSURE`, `REAR_LEFT_TIRE_PRESSURE`, `REAR_RIGHT_TIRE_PRESSURE` | signal, query | kPa | Tire pressure from TPMS. Applications convert to psi or bar. |

## 10. Diagnostics

| Keyword | Used as | Values | Description |
| --- | --- | --- | --- |
| `VIN` | query | 17-character string | Vehicle identification number (OBD-II mode 09 PID 02). |
| `MIL_STATUS` | query | `on`, `off` | Malfunction indicator (check engine) lamp (PID 0x01). |
| `READINESS_STATUS` | query | bitfield | OBD-II monitor readiness (PID 0x01). |
| `CLEAR_DTC` | action (trigger) | | Clear stored diagnostic trouble codes (OBD-II mode 04). Applications treat this as a maintenance action, not a shortcut. |

## 11. Triggers

Actions declared without `values`. Each runs a momentary routine.

| Keyword | Description |
| --- | --- |
| `HORN` | Sound the horn once. |
| `FLASH_LIGHTS` | Flash the exterior lights once, as a locate or confirm signal. |
| `PANIC` | Sound the alarm and flash the lights until cancelled or timed out. |
| `LEFT_SIGNAL`, `RIGHT_SIGNAL` | Flash the indicator once. The same keywords are signals and, with `values`, latching actions (section 3). |
| `HIGH_BEAMS`, `LOW_BEAMS` | Flash the headlights once. The same keywords are signals and, with `values`, switches (section 3). |
| `WIPERS`, `WASHER` | One wipe or spray. |
| `CLEAR_DTC` | Clear diagnostic trouble codes. |
| `ECU_WAKE` | Reserved. The library runs it to wake a sleeping bus before retrying another action. Applications do not offer it as a control. |

## 12. Deprecated keywords

Earlier profiles used predicate and verb names. The library does not alias
them; applications that must read old profiles map them at the edge.

| Deprecated | Use |
| --- | --- |
| `FRONT_LEFT_DOOR_OPEN`, `FRONT_RIGHT_DOOR_OPEN`, `REAR_LEFT_DOOR_OPEN`, `REAR_RIGHT_DOOR_OPEN` | `FRONT_LEFT_DOOR`, `FRONT_RIGHT_DOOR`, `REAR_LEFT_DOOR`, `REAR_RIGHT_DOOR` |
| `TRUNK_OPEN` | `TRUNK` |
| `DOORS_LOCKED`, `DOORS_UNLOCKED` | `DOORS` |
| `LOCK`, `UNLOCK` | `DOORS` with commands `lock`, `unlock` |
| `OPEN_TRUNK`, `CLOSE_TRUNK` | `TRUNK` with commands `open`, `close` |
| `HIGH_BEAM`, `LOW_BEAM` | `HIGH_BEAMS`, `LOW_BEAMS` |
| `VEHICLE_SPEED` | `SPEED` |

## 13. Porting from WiCAN

[WiCAN](https://meatpihq.github.io/wican-fw/config/automate/supported_parameters/)
profiles cover many of the same vehicles. Its names are abbreviated; this
table maps the common ones. WiCAN reports tire pressure in psi and odometer
in either km or miles; convert to the unit in this document.

| WiCAN | Keyword |
| --- | --- |
| `SPEED` | `SPEED` |
| `ODOMETER`, `ODOMETER_MI` | `ODOMETER` (km) |
| `RANGE` | `RANGE` |
| `ENGINE_RPM` | `RPM` |
| `COOLANT_TMP` | `ECT` |
| `INTAKE_AIR_TMP` | `IAT` |
| `MAF` | `MAF` |
| `THROTTLE` | `TPS` |
| `STFT` | `STFT_B1` |
| `FUEL` | `FUEL_LEVEL` |
| `FUEL_RATE` | `FUEL_RATE` |
| `FUEL_PRESSURE` | `FUEL_PRESSURE` |
| `ENGINE_OIL_TEMP`, `ENGINE_OIL_PRES` | `OIL_TEMP`, `OIL_PRESSURE` |
| `OIL_LIFE` | `OIL_LIFE` |
| `TRAN_F_TEMP` | `TRANSMISSION_TEMP` |
| `GEAR` | `GEAR` |
| `IGNITION` | `IGNITION` |
| `READY` | `READY` |
| `PARK_BRAKE` | `PARKING_BRAKE` |
| `STEER_ANGLE` | `STEERING_ANGLE` |
| `LV_V` | `AUX_BATTERY_VOLTAGE` |
| `SOC` | `HV_BATTERY_SOC` |
| `SOH` | `HV_BATTERY_SOH` |
| `HV_V`, `HV_A`, `HV_W` | `HV_BATTERY_VOLTAGE`, `HV_BATTERY_CURRENT`, `HV_BATTERY_POWER` (W to kW) |
| `HV_T_A` | `HV_BATTERY_TEMP` |
| `HV_CAPACITY_KWH` | `HV_BATTERY_CAPACITY` |
| `CHARGER_CONNECTED`, `AC_PLUG` | `CHARGER` |
| `CHARGING_DC` | `CHARGER_TYPE` = `dc` |
| `CHARGING` | `CHARGING` |
| `CHARGER_DC_PWR` | `CHARGE_POWER` |
| `CABIN_TEMPERATURE`, `T_CAB` | `CABIN_TEMP` |
| `OUTSIDE_TEMPERATURE`, `TMP_A` | `AMBIENT_TEMP` |
| `TYRE_P_FL`, `TYRE_P_FR`, `TYRE_P_RL`, `TYRE_P_RR` | `FRONT_LEFT_TIRE_PRESSURE`, ... (psi to kPa) |
