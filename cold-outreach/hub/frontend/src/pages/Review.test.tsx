import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import type { ReviewCity, ReviewFile, ReviewFileDetail } from "../api";
import { makeUser, mockApi } from "../test/mockApi";

const reviewer = makeUser({ id: "r1", name: "Rita", role: "reviewer" });
const signedIn = [200, { user: reviewer, csrf_token: "t" }] as [number, unknown];

const waiting: ReviewFile = {
  id: "f1",
  file_name: "tulsa.xlsx",
  niche: "Cleaning",
  businesses: 14,
  created_at: "2026-10-29T10:00:00Z",
  state: "needs_top",
  cities_on: 1,
  cities_topped: 0,
};

const detail: ReviewFileDetail = {
  ...waiting,
  cities: [
    { key: "tulsa", name: "Tulsa", businesses: 12, tops: 0, state: "needs_top" },
    { key: "dallas", name: "Dallas", businesses: 2, tops: 0, state: "off" },
  ],
};

const city: ReviewCity = {
  key: "tulsa",
  name: "Tulsa",
  state: "needs_top",
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

test("a reviewer chooses a city's Top and the file is done", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /review/files": [
      200,
      [waiting, { ...waiting, id: "f2", file_name: "old.xlsx", state: "done" }],
    ],
    "GET /review/files/f1": [200, detail],
    "GET /review/files/f1/cities/tulsa": [200, city],
    "PUT /review/files/f1/cities/tulsa": [200, { ...detail, state: "done", cities_topped: 1 }],
  });
  render(<App />);

  // Whatever the address, a Reviewer is on Top Review; done files can't be opened.
  expect(await screen.findByRole("heading", { name: "Top Review" })).toBeVisible();
  expect(calls.some((c) => c.path.startsWith("/batches"))).toBe(false);
  expect(screen.queryByRole("button", { name: "old.xlsx" })).toBeNull();
  expect(await screen.findByText("Done ✓")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "tulsa.xlsx" }));
  expect(await screen.findByText("Off · under 10")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Dallas" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Tulsa" }));

  const table = await screen.findByRole("table");
  expect(within(table).getByText("(918) 555-0000")).toBeVisible();
  await userEvent.click(screen.getByRole("checkbox", { name: "Top: Shine 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Save the Top of Tulsa" }));

  expect(
    await screen.findByText("Every city has a Top: tulsa.xlsx is ready and locked."),
  ).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ tops: ["Tulsa row 3"] });
});
