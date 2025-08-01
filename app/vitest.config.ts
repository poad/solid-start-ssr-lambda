import solid from "vite-plugin-solid";
// eslint-disable-next-line import/no-unresolved
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    conditions: ["development", "browser"],
  },
});
