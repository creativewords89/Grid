import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { NicheStandard, Standard } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

const standard: Standard = {
  services: [{ name: "Deep cleaning", synonyms: ["deep clean"], must_have: true }],
  service_page: {
    min_words: 600,
    min_sections: 4,
    faq: true,
    price: true,
    own_photos: true,
    reviews: true,
    cta: true,
    service_area: true,
  },
  location_page: {
    min_words: 400,
    city_in_title: true,
    local_content: true,
    local_photos: true,
    all_services_linked: true,
    local_reviews: true,
    map: true,
    faq: true,
    cta: true,
    max_shared_text_pct: 60,
  },
  supporting_pages: ["FAQ", "Reviews"],
  blog: { posts_per_month: 2, topics: ["Cost guide"] },
  mobile_lcp_seconds: 2.5,
};

function niche(overrides: Partial<NicheStandard> = {}): NicheStandard {
  return {
    niche: "Cleaning",
    locked: null,
    draft: {
      version: null,
      label: null,
      standard,
      edited_by: "Sara",
      edited_at: "2026-10-27T10:00:00Z",
      locked_by: null,
      locked_at: null,
    },
    versions: [],
    can_edit: true,
    can_lock: true,
    ...overrides,
  };
}

beforeEach(() => window.history.pushState(null, "", "/benchmarks"));
afterEach(() => vi.unstubAllGlobals());

test("check a benchmark file, see its problems, then save a clean one", async () => {
  let clean = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /benchmarks": [200, []],
    "GET /website-standards": [200, []],
    "POST /benchmarks/upload": (body) => {
      const apply = (body as { apply: string }).apply === "true";
      if (!clean)
        return [
          200,
          {
            applied: false,
            rows: [{ city: "Dallas" }],
            errors: ["B row 3: rating must be between 0 and 5."],
            ignored_columns: [],
            replaces: 0,
          },
        ];
      return [
        200,
        {
          applied: apply,
          rows: [{ city: "Dallas" }],
          errors: [],
          ignored_columns: [],
          replaces: 1,
        },
      ];
    },
  });
  render(<App />);

  fireEvent.change(await screen.findByLabelText("Benchmark file"), {
    target: { files: [new File(["x"], "benchmarks.xlsx")] },
  });
  await userEvent.click(screen.getByRole("button", { name: "Check the file" }));
  expect(await screen.findByText("B row 3: rating must be between 0 and 5.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save 1 benchmarks" })).toBeDisabled();

  clean = true;
  await userEvent.click(screen.getByRole("button", { name: "Check the file" }));
  expect(await screen.findByText(/1 of them replace existing ones/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save 1 benchmarks" }));

  expect(await screen.findByText("Saved 1 benchmarks.")).toBeVisible();
  expect(calls.filter((c) => c.path === "/benchmarks/upload").map((c) => c.body)).toEqual([
    expect.objectContaining({ apply: "false" }),
    expect.objectContaining({ apply: "false" }),
    expect.objectContaining({ apply: "true" }),
  ]);
});

test("edit a Website Standard draft and lock it", async () => {
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /benchmarks": [200, []],
    "GET /website-standards": [200, [niche()]],
    "GET /website-standards/Cleaning": [200, niche()],
    "PUT /website-standards/Cleaning/draft": (body) => [
      200,
      niche({
        draft: { ...niche().draft!, standard: body as Standard, edited_at: "2026-10-27T11:00:00Z" },
      }),
    ],
    "POST /website-standards/Cleaning/lock": [
      200,
      niche({
        draft: null,
        locked: { ...niche().draft!, version: 1, label: "cleaning-v1", locked_by: "Olivia" },
        versions: [1],
      }),
    ],
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "Cleaning standard" });
  await userEvent.click(within(form).getByRole("button", { name: "+ Add a service" }));
  await userEvent.type(within(form).getByLabelText("Service 2"), "Move-out cleaning");
  await userEvent.type(
    within(form).getAllByLabelText("Also called (comma separated)")[1]!,
    "end of lease, move out",
  );
  await userEvent.click(within(form).getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Draft saved.")).toBeVisible();

  const saved = calls.find((c) => c.method === "PUT")?.body as Standard;
  expect(saved.services[1]).toEqual({
    name: "Move-out cleaning",
    synonyms: ["end of lease", "move out"],
    must_have: true,
  });
  expect(saved.blog.topics).toEqual(["Cost guide"]);

  await userEvent.click(
    within(await screen.findByRole("form", { name: "Cleaning standard" })).getByRole("button", {
      name: "Lock as the next version",
    }),
  );
  expect(await screen.findByText(/In use: cleaning-v1/)).toBeVisible();
  expect(screen.getByText(/Locked\. The Website agent uses it/)).toBeVisible();
});

test("a viewer reads but can't edit", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /benchmarks": [200, []],
    "GET /website-standards": [200, [niche({ can_edit: false, can_lock: false })]],
    "GET /website-standards/Cleaning": [200, niche({ can_edit: false, can_lock: false })],
  });
  render(<App />);

  const form = await screen.findByRole("form", { name: "Cleaning standard" });
  expect(within(form).getByLabelText("Service 1")).toBeDisabled();
  expect(within(form).queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Benchmark file")).not.toBeInTheDocument();
});
