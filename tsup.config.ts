import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/transport/index.ts",
    "src/ble/index.ts",
    "src/security/index.ts",
    "src/react-native-ble/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
