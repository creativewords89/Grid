import { render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("shows the Hub's name and checks the server", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ status: "ok", version: "0.1.0", checks: { database: "ok" } }),
        ),
      ),
  );

  render(<App />);

  expect(screen.getByRole("heading", { name: "GridRankers Agent Hub" })).toBeInTheDocument();
  expect(await screen.findByText(/Server is running/)).toBeInTheDocument();
});
