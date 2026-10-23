# SLCAN web tester

A Chrome or Edge page that talks to a USB SLCAN adapter through `SlcanTransport`, using the Nissan Versa 2007–2012 profile in `nissan-versa-vehicle-profile-1-6`.

Use a CANable (or compatible board) with the stock SLCAN firmware, not candleLight. Wire CANH, CANL, and ground to the bus. For an OBD port that is usually pins 6, 14, and 5. The Versa high-speed bus is 500 kbit/s.

```sh
cd examples/slcan-web
npm install
npm run dev
```

Connect, and the page subscribes to the profile's broadcast signals (speed, rpm, throttle, steering, lights, doors). Action buttons run the profile actions, including the body-controller session on `0x745`. The raw form can send one frame and, when checked, wait for a reply on `0x765`.
