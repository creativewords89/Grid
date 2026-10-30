import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Benchmark } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function benchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: "m1",
    name: "Cleaning Benchmark 1",
    niche: "Cleaning",
    version: 2,
    gbp: { photos: 120, posts_90_days: 9 },
    website: {
      services: [{ name: "Deep cleaning", synonyms: ["deep clean"], must_have: true }],
      blog: { posts_per_month: 2, topics: ["Cost guide"] },
    },
    batches: ["Batch 1"],
    updated_by: "Olivia",
    updated_at: "2026-10-27T10:00:00Z",
    can_edit: true,
    ...overrides,
  };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/benchmarks"));
afterEach(() => vi.unstubAllGlobals());

test("make a new benchmark: GBP numbers and the website part", async () => {
  let made = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /benchmarks": () => [200, made ? [benchmark({ version: 1, batches: [] })] : []],
    "GET /niches": [200, ["Cleaning"]],
    "POST /benchmarks": () => {
      made = true;
      return [201, benchmark({ version: 1, batches: [] })];
    },
  });
  render(<App />);

  expect(await screen.findByText(/No benchmarks yet/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "+ New benchmark" }));
  const form = screen.getByRole("form", { name: "Benchmark" });
  await userEvent.type(within(form).getByLabelText("Name"), "Cleaning Benchmark 1");
  await userEvent.type(within(form).getByLabelText("Niche"), "Cleaning");
  await userEvent.type(within(form).getByLabelText("Photos"), "120");
  await userEvent.type(within(form).getByLabelText("Posts in 90 days"), "9");
  await userEvent.type(
    within(form).getByLabelText("Right primary categories"),
    "House cleaning service{enter}Maid service",
  );
  await userEvent.click(within(form).getByRole("button", { name: "+ Add a service" }));
  await userEvent.type(within(form).getByLabelText("Service 1"), "Deep cleaning");
  await userEvent.type(within(form).getByLabelText("Also called (comma separated)"), "deep clean");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved Cleaning Benchmark 1.")).toBeVisible();
  expect(screen.getByRole("cell", { name: "Cleaning Benchmark 1" })).toBeVisible();
  const sent = calls.find((c) => c.method === "POST")?.body as {
    name: string;
    niche: string;
    gbp: Record<string, unknown>;
    website: { services: unknown[]; location_page: { min_words: number } };
  };
  expect(sent.name).toBe("Cleaning Benchmark 1");
  expect(sent.niche).toBe("Cleaning");
  // Empty boxes aren't compared.
  expect(sent.gbp).toEqual({
    photos: 120,
    posts_90_days: 9,
    primary_categories: ["House cleaning service", "Maid service"],
  });
  expect(sent.website.services).toEqual([
    { name: "Deep cleaning", synonyms: ["deep clean"], must_have: true },
  ]);
  expect(sent.website.location_page.min_words).toBe(400);
});

test("editing one in use warns that its batches are checked again", async () => {
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /benchmarks": [200, [benchmark()]],
    "GET /niches": [200, ["Cleaning"]],
    "PUT /benchmarks/m1": [200, benchmark({ version: 3, gbp: { photos: 200, posts_90_days: 9 } })],
  });
  render(<App />);

  const row = await screen.findByRole("row", { name: /Cleaning Benchmark 1/ });
  expect(within(row).getByText("v2")).toBeVisible();
  expect(within(row).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "Edit Cleaning Benchmark 1" }));
  const form = screen.getByRole("form", { name: "Benchmark" });
  expect(within(form).getByText(/Used by Batch 1/)).toBeVisible();
  expect(within(form).getByLabelText("Niche")).toBeDisabled();
  const photos = within(form).getByLabelText("Photos");
  expect(photos).toHaveValue(120);
  await userEvent.clear(photos);
  await userEvent.type(photos, "200");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Saved Cleaning Benchmark 1 (version 3).")).toBeVisible();
  const sent = calls.find((c) => c.method === "PUT")?.body as { gbp: object; niche?: string };
  expect(sent.gbp).toEqual({ photos: 200, posts_90_days: 9 });
  expect(sent.niche).toBeUndefined();
});

test("copy a benchmark into a new one, and a server error shows on its field", async () => {
  mockApi({
    "GET /auth/me": as("admin"),
    "GET /benchmarks": [200, [benchmark()]],
    "GET /niches": [200, ["Cleaning"]],
    "POST /benchmarks": [
      422,
      {
        error: {
          code: "invalid",
          message: "Input should be less than or equal to 5.",
          fields: { "gbp.rating": "Input should be less than or equal to 5." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Copy Cleaning Benchmark 1" }));
  const form = screen.getByRole("form", { name: "Benchmark" });
  expect(within(form).getByLabelText("Name")).toHaveValue("Cleaning Benchmark 1 (copy)");
  expect(within(form).getByLabelText("Service 1")).toHaveValue("Deep cleaning");
  await userEvent.type(within(form).getByLabelText("Rating (0–5)"), "9");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));

  expect(await within(form).findAllByText("Input should be less than or equal to 5.")).toHaveLength(
    2,
  );
});

test("an unused benchmark can be deleted", async () => {
  let deleted = false;
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /benchmarks": () => [200, deleted ? [] : [benchmark({ batches: [] })]],
    "DELETE /benchmarks/m1": () => {
      deleted = true;
      return [204];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Delete Cleaning Benchmark 1" }));
  expect(await screen.findByText("Deleted Cleaning Benchmark 1.")).toBeVisible();
});

test("a viewer sees the benchmarks but can't change them", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /benchmarks": [200, [benchmark({ can_edit: false })]],
  });
  render(<App />);

  expect(await screen.findByRole("cell", { name: "Cleaning Benchmark 1" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "+ New benchmark" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
});
