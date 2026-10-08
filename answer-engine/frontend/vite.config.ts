import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` talks to a backend started with `uv run uvicorn app.main:app`.
    proxy: { "/api": "http://localhost:8000" },
  },
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
