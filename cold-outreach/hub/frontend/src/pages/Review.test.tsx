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
      likely: false,
    },
    {
      key: "Tulsa row 3",
      rows: ["Tulsa row 3"],
      values: { business_name: "Shine 1", phone: "(918) 555-0001" },
      extra: {},
      top: false,
      likely: true,
    },
  ],
  benchmark: { name: "Cleaning Benchmark 1", reviews: 150, rating: 4.8 },
};

beforeEach(() => window.history.pushState(null, "", "/batches"));
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

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
    "GET /review/small?page=1": [
      200,
      {
        total: 1,
        page: 1,
        pages: 1,
        columns: city.columns,
        benchmark: null,
        cities: [
          {
            ...row({ key: "waco", name: "Waco", businesses: 3, state: "small" }),
            businesses_list: city.businesses,
          },
        ],
      },
    ],
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
  expect(await screen.findByRole("region", { name: /Waco, tulsa\.xlsx/ })).toBeVisible();
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

test("the last list shows at once on a reload, then is brought up to date", async () => {
  window.localStorage.setItem(
    "top-review:list:needs_top",
    JSON.stringify({ counts, cities: [row({ name: "Kept City", key: "kept" })] }),
  );
  let answer: (value: [number, ReviewList]) => void = () => {};
  mockApi({
    "GET /auth/me": signedIn,
    "GET /review/cities?show=needs_top": () =>
      new Promise<[number, ReviewList]>((resolve) => {
        answer = resolve;
      }),
  });
  render(<App />);

  // Shown from what the browser kept: no Loading while the server answers.
  expect(await screen.findByRole("button", { name: "Kept City" })).toBeVisible();
  expect(screen.queryByText(/Loading/)).toBeNull();
  answer(list([row({ name: "Fresh City", key: "fresh" })]));
  expect(await screen.findByRole("button", { name: "Fresh City" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Kept City" })).toBeNull();
});

test("Save & next city opens the next one, fetched ahead; ticks are kept as a draft", async () => {
  const waco = row({ key: "waco", name: "Waco", file_id: "f1" });
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /review/cities?show=needs_top": list([row(), waco]),
    "GET /review/files/f1/cities/tulsa": [200, city],
    "GET /review/files/f1/cities/waco": [200, { ...city, key: "waco", name: "Waco" }],
    "PUT /review/files/f1/cities/tulsa": [200, row({ tops: 1, state: "ready", moves_in: 3600 })],
  });
  const { unmount } = render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Tulsa" }));
  // Most reviews first, with ⭐ on the business that meets the benchmark.
  expect(await screen.findByLabelText("Likely Top")).toBeVisible();
  expect(
    screen.getByText(/meets Cleaning Benchmark 1 \(150\+ reviews, 4.8\+ rating\)/),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("checkbox", { name: "Top: Shine 1" }));
  // The next city is fetched while this one is worked on.
  expect(calls.some((c) => c.path === "/review/files/f1/cities/waco")).toBe(true);

  // A reload keeps the tick (a draft until saved).
  unmount();
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Tulsa" }));
  expect(await screen.findByRole("checkbox", { name: "Top: Shine 1" })).toBeChecked();

  await userEvent.click(screen.getByRole("button", { name: "Save & next city (Waco)" }));
  expect(await screen.findByRole("heading", { name: "Waco" })).toBeVisible();
  expect(screen.getByText(/Saved the Top of Tulsa/)).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ tops: ["Tulsa row 3"] });
  expect(window.localStorage.getItem("top-review:draft:f1:tulsa")).toBeNull();
});

test("the keyboard ticks and saves: Space, then Enter", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /review/cities?show=needs_top": list([row()]),
    "GET /review/files/f1/cities/tulsa": [200, city],
    "PUT /review/files/f1/cities/tulsa": [200, row({ tops: 1, state: "ready", moves_in: 3600 })],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Tulsa" }));
  const businesses = await screen.findByLabelText("Businesses of Tulsa");
  businesses.focus();
  await userEvent.keyboard("{ArrowDown} {Enter}");
  expect(await screen.findByText(/Saved the Top of Tulsa/)).toBeVisible();
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ tops: ["Tulsa row 3"] });
});

test("cities under 10 are ticked on one page and saved at once", async () => {
  const small = (name: string, key: string, fileId: string) => ({
    ...row({ name, key, file_id: fileId, businesses: 2, state: "small" as const }),
    businesses_list: [
      { ...city.businesses[0]!, key: `${name} row 2`, values: { business_name: `${name} A` } },
      { ...city.businesses[1]!, key: `${name} row 3`, values: { business_name: `${name} B` } },
    ],
  });
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /review/cities?show=needs_top": list([]),
    "GET /review/cities?show=small": list([]),
    "GET /review/small?page=1": [
      200,
      {
        total: 2,
        page: 1,
        pages: 1,
        columns: city.columns,
        benchmark: null,
        cities: [small("Waco", "waco", "f1"), small("Enid", "enid", "f2")],
      },
    ],
    "PUT /review/tops": [200, { saved: 2 }],
  });
  render(<App />);

  const lists = await screen.findByRole("navigation", { name: "Cities" });
  await userEvent.click(within(lists).getByRole("button", { name: /Cities under 10/ }));
  await userEvent.click(await screen.findByRole("checkbox", { name: "Top: Waco B (Waco)" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Top: Enid A (Enid)" }));
  await userEvent.click(screen.getByRole("button", { name: "Save the Tops of 2 cities" }));
  expect(await screen.findByText(/Saved the Top of 2 cities/)).toBeVisible();
  expect(calls.find((c) => c.path === "/review/tops")?.body).toEqual({
    cities: [
      { file_id: "f1", city: "waco", tops: ["Waco row 3"] },
      { file_id: "f2", city: "enid", tops: ["Enid row 2"] },
    ],
  });
});
