import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    // `npm run dev` talks to a backend started with `uv run uvicorn app.main:app`
    // (API_URL changes where; the end-to-end tests use their own port).
    proxy: { "/api": loadEnv(mode, ".", "").API_URL || "http://localhost:8000" },
  },
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
}));
