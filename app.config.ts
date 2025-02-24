import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  server: {
    preset: "aws_lambda",
    serveStatic: true,
    inlineDynamicImports: true,
  },
});
