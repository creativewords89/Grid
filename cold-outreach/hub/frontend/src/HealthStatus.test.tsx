import { render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { HealthStatus } from "./HealthStatus";

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("shows the server as running when health is ok", async () => {
  mockFetch(200, { status: "ok", version: "0.1.0", checks: { database: "ok" } });

  render(<HealthStatus />);

  expect(await screen.findByText(/Server is running · version 0\.1\.0/)).toBeInTheDocument();
});

test("names the failing check when health returns 503", async () => {
  mockFetch(503, { status: "error", version: "0.1.0", checks: { database: "error" } });

  render(<HealthStatus />);

  expect(await screen.findByText(/Server has a problem/)).toHaveTextContent("failing: database");
});

test("shows an alert when the server can't be reached", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));

  render(<HealthStatus />);

  expect(await screen.findByRole("alert")).toHaveTextContent("The server can't be reached.");
});
