import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import type { ReviewCity, ReviewList, ReviewRow } from "../api";
import { makeUser, mockApi } from "../test/mockApi";

const reviewer = makeUser({ id: "r1", name: "Rita", role: "reviewer" });
const signedIn = [200, { user: reviewer, csrf_token: "t" }] as [number, unknown];

function row(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    file_id: "f1",
    file_name: "tulsa.xlsx",
    number: 12,
    niche: "Cleaning",
    key: "tulsa",
    name: "Tulsa",
    businesses: 12,
    tops: 0,
    state: "needs_top",
    moves_at: null,
    moves_in: null,
    ...overrides,
  };
}

const counts = { needs_top: 1, ready: 1, small: 1 };
const list = (cities: ReviewRow[]): [number, ReviewList] => [200, { counts, cities }];

const city: ReviewCity = {
  key: "tulsa",
  name: "Tulsa",
  state: "needs_top",
  moves_at: null,
  moves_in: null,
  file_id: "f1",
  file_name: "tulsa.xlsx",
  columns: [
    { key: "business_name", label: "Business name" },
    { key: "phone", label: "Phone" },
  ],
  businesses: [
    {
      key: "Tulsa row 2",
      rows: ["Tulsa row 2"],
      values: { business_name: "Shine 0", phone: "(918) 555-0000" },
      extra: {},
      top: false,
    },
    {
      key: "Tulsa row 3",
      rows: ["Tulsa row 3"],
      values: { business_name: "Shine 1", phone: "(918) 555-0001" },
      extra: {},
      top: false,
    },
  ],
};

beforeEach(() => window.history.pushState(null, "", "/batches"));
afterEach(() => vi.unstubAllGlobals());

test("a reviewer chooses a city's Top: it is ready, and goes to its batch now if sent", async () => {
  const soon = new Date(Date.now() + 60 * 60_000).toISOString();
  const ready = row({ key: "austin", name: "Austin", file_id: "f2", tops: 2, state: "ready" });
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /review/cities?show=needs_top": list([row()]),
    "GET /review/cities?show=ready": list([{ ...ready, moves_at: soon, moves_in: 3600 }]),
    "GET /review/cities?show=small": list([
      row({ key: "waco", name: "Waco", businesses: 3, state: "small" }),
    ]),
    "GET /review/files/f1/cities/tulsa": [200, city],
    "PUT /review/files/f1/cities/tulsa": [
      200,
      row({ tops: 1, state: "ready", moves_at: soon, moves_in: 3590 }),
    ],
    "POST /submissions/f2/to-batch": [200, {}],
  });
  render(<App />);

  // Whatever the address, a Reviewer is on Top Review: three lists of cities.
  expect(await screen.findByRole("heading", { name: "Top Review" })).toBeVisible();
  expect(calls.some((c) => c.path.startsWith("/batches"))).toBe(false);
  const lists = screen.getByRole("navigation", { name: "Cities" });
  expect(within(lists).getByRole("button", { name: /Not ready/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await userEvent.click(within(lists).getByRole("button", { name: /Cities under 10/ }));
  expect(await screen.findByRole("button", { name: "Waco" })).toBeVisible();
  await userEvent.click(within(lists).getByRole("button", { name: /Not ready/ }));

  await userEvent.click(await screen.findByRole("button", { name: "Tulsa" }));
  const table = await screen.findByRole("table");
  expect(within(table).getByText("(918) 555-0000")).toBeVisible();
  await userEvent.click(screen.getByRole("checkbox", { name: "Top: Shine 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Save the Top of Tulsa" }));
  expect(
    await screen.findByText(/Saved the Top of Tulsa: it goes on to its batch in (59|60) min/),
  ).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ tops: ["Tulsa row 3"] });

  // A ready city goes to its batch now when sent.
  const again = screen.getByRole("navigation", { name: "Cities" }); // shown anew
  await userEvent.click(within(again).getByRole("button", { name: /Ready/ }));
  const austin = await screen.findByRole("row", { name: /Austin/ });
  await userEvent.click(within(austin).getByRole("button", { name: "Send to batch now" }));
  expect(await screen.findByText("Austin is in its batch.")).toBeVisible();
  expect(calls.find((c) => c.path === "/submissions/f2/to-batch")?.body).toEqual({
    city: "austin",
  });
});
