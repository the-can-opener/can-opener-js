import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "can-opener-js/transport": fileURLToPath(new URL("../../src/transport/index.ts", import.meta.url)),
      "can-opener-js": fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
