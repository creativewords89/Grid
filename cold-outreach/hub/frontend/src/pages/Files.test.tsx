import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import type { FileCity, HandedInFile, HandedInFileDetail } from "../api";
import { makeUser, mockApi } from "../test/mockApi";

const collector = makeUser({ id: "c1", name: "Cal", role: "collector" });
const owner = makeUser({ id: "o1", name: "Olivia", role: "owner" });
const me = (user: typeof owner) => [200, { user, csrf_token: "t" }] as [number, unknown];

function file(overrides: Partial<HandedInFile> = {}): HandedInFile {
  return {
    id: "f1",
    number: 12,
    file_name: "tulsa.xlsx",
    niche: "Cleaning",
    batch_name: "Cleaning",
    version: 1,
    businesses: 120,
    errors: 2,
    warnings: 1,
    status: "errors",
    uploaded_by: "Cal",
    mine: true,
    created_at: "2026-10-29T10:00:00Z",
    updated_at: "2026-10-29T10:00:00Z",
    same_as: null,
    cities_going: 1,
    cities_in_batch: 0,
    cities_ready: 0,
    cities_muted: 0,
    progress: 100,
    error: null,
    sends_at: null,
    sends_in: null,
    can_send_cities: false,
    has_duplicates: false,
    ...overrides,
  };
}

const detail: HandedInFileDetail = {
  ...file(),
  tabs: { Tulsa: { errors: 2, warnings: 1, columns: [] } },
  problems: [
    {
      code: "PHONE_HAS_LETTERS",
      field: "phone",
      severity: "error",
      message: "Phone holds letters",
      tab: "Tulsa",
      line: 14,
      business: "Bad Co",
      value: "call us",
    },
  ],
  cities: [],
  duplicates: { rows: 0, elsewhere: 0 },
};

function city(overrides: Partial<FileCity> = {}): FileCity {
  return {
    key: "tulsa",
    name: "Tulsa",
    businesses: 12,
    state: "needs_top",
    tops: 0,
    muted: "",
    moves_at: null,
    moves_in: null,
    moved_at: null,
    ...overrides,
  };
}

beforeEach(() => window.history.pushState(null, "", "/files"));
afterEach(() => vi.unstubAllGlobals());

const leads = {
  total: 2,
  page: 1,
  pages: 1,
  counts: { all: 2, problems: 1, errors: 1, warnings: 0, ok: 1 },
  cities: ["Tulsa"],
  leads: [
    {
      id: "F12-0001",
      tab: "Tulsa",
      line: 2,
      rows: ["Tulsa row 2"],
      values: { business_name: "Multi-Clean", city: "Tulsa", phone: "(918) 523-8300" },
      issues: [],
    },
    {
      id: "F12-0014",
      tab: "Tulsa",
      line: 14,
      rows: ["Tulsa row 14"],
      values: { business_name: "Bad Co", city: "Tulsa", phone: "call us" },
      issues: [
        {
          field: "phone",
          code: "PHONE_HAS_LETTERS",
          severity: "error",
          message: "Phone holds letters",
        },
      ],
    },
  ],
};

test("a collector lands on Files whatever the address, hands in a file and sees it checked", async () => {
  window.history.pushState(null, "", "/batches");
  const checking = file({ status: "checking", progress: 40, errors: 0, warnings: 0 });
  let listed: HandedInFile[] = [];
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": () => [200, listed],
    "GET /submissions/niches": [200, ["Cleaning", "Roofing"]],
    "POST /submissions": () => {
      listed = [checking];
      return [201, { ...detail, ...checking }];
    },
  });
  render(<App />);

  expect(await screen.findByRole("heading", { name: "Files" })).toBeVisible();
  expect(calls.some((c) => c.path.startsWith("/batches"))).toBe(false);
  // Choosing (or dropping) the file asks for its niche; no niche, no upload (step 38).
  await userEvent.upload(screen.getByLabelText(/Excel file/), new File(["x"], "tulsa.xlsx"));
  const asked = await screen.findByRole("dialog", { name: "Which niche is this file for?" });
  expect(within(asked).getByRole("button", { name: "Upload and check" })).toBeDisabled();
  await within(asked).findByRole("option", { name: "Cleaning" });
  await userEvent.selectOptions(within(asked).getByLabelText("Niche"), "Cleaning");
  await userEvent.click(within(asked).getByRole("button", { name: "Upload and check" }));

  expect(await screen.findByText(/is uploaded and being checked/)).toBeVisible();
  expect(await screen.findByText("Checking 40%")).toBeVisible();
  const sent = calls.find((c) => c.method === "POST" && c.path === "/submissions");
  expect(sent?.body).toMatchObject({ niche: "Cleaning" });
  expect(sent?.csrf).toBe("t");
});

test("a new niche, with a close spelling asked about", async () => {
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, []],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "POST /niches": [
      409,
      {
        error: {
          code: "similar",
          message: "Did you mean Cleaning?",
          details: { similar: "Cleaning" },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.upload(await screen.findByLabelText(/Excel file/), new File(["x"], "tulsa.xlsx"));
  const niche = await screen.findByLabelText("Niche");
  await screen.findByRole("option", { name: "Cleaning" });
  await userEvent.selectOptions(niche, "+ New niche…");
  await userEvent.type(screen.getByLabelText("New niche"), "Cleanning");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(await screen.findByText("Did you mean Cleaning?")).toBeVisible();
  expect(screen.getByRole("button", { name: "Add “Cleanning” anyway" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Use Cleaning" }));
  expect(niche).toHaveValue("Cleaning");
  expect(calls.find((c) => c.path === "/niches")?.body).toEqual({
    name: "Cleanning",
    confirm: false,
  });
});

test("a file opens to its businesses, the wrong cells marked", async () => {
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [file()]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, detail],
    "GET /submissions/f1/marked.xlsx": [
      404,
      { error: { code: "not_found", message: "That file doesn't exist." } },
    ],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "GET /submissions/f1/leads?page=1&sort=row&problems=errors": [
      200,
      { ...leads, total: 1, leads: [leads.leads[1]] },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "tulsa.xlsx" }));
  expect(await screen.findByRole("heading", { name: "tulsa.xlsx" })).toBeVisible();
  expect(screen.getByText(/2 errors to fix/)).toBeVisible();
  // A download that fails says why.
  await userEvent.click(screen.getByRole("button", { name: /Download problems to fix/ }));
  expect(
    await screen.findByText("The file wasn't downloaded: That file doesn't exist."),
  ).toBeVisible();
  // Two buttons: the problems out, the fixes (or a whole new file) back in.
  expect(screen.queryByText(/Upload revised version/)).toBeNull();
  expect(screen.getByRole("button", { name: /Upload fixes/ })).toBeVisible();
  const table = await screen.findByRole("region", { name: "Businesses in this file" });
  const wrong = await within(table).findByText("call us");
  expect(wrong.closest("td")).toHaveClass("cell-problem");
  expect(wrong.closest("td")).toHaveAttribute("title", "Phone holds letters");
  expect(within(table).getByText("F12-0014")).toHaveAttribute("title", "Tulsa, row 14");
  // Only to look at: no editing in the table.
  expect(within(table).queryByRole("textbox", { name: /Phone/ })).toBeNull();
  const problems = within(table).getByLabelText("Problems");
  expect(
    within(problems)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual([
    "All (2)",
    "Problems: errors and warnings (1)",
    "🔴 Errors (1)",
    "🟠 Warnings (0)",
    "✓ OK (1)",
  ]);
  await userEvent.selectOptions(problems, "errors");
  expect(await within(table).findByText("1 businesses")).toBeVisible();
  expect(
    calls.some((c) => c.path === "/submissions/f1/leads?page=1&sort=row&problems=errors"),
  ).toBe(true);
});

test("a file in the batch shows its cities, and can't be changed", async () => {
  const done = file({ status: "in_batch", errors: 0, warnings: 0, cities_in_batch: 1 });
  mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [done]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [
      200,
      {
        ...detail,
        ...done,
        problems: [],
        cities: [
          city({ state: "in_batch", tops: 2, moved_at: "2026-10-29T12:00:00Z" }),
          city({ key: "waco", name: "Waco", businesses: 3, state: "small" }),
        ],
      },
    ],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
  });
  render(<App />);

  const row = await screen.findByRole("row", { name: /tulsa\.xlsx/ });
  expect(within(row).getByText("Cleaning")).toBeVisible();
  expect(within(row).getByText(/1 of 1/)).toBeVisible();
  expect(within(row).getByText(/city in the batch/)).toBeVisible();
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
    "Batch name",
    "File",
    "Stage",
    "Status",
    "In a batch",
    "Next step",
  ]); // a Collector's own files: no Handed in by
  await userEvent.click(screen.getByRole("button", { name: "tulsa.xlsx" }));
  expect(await screen.findByRole("heading", { name: "tulsa.xlsx" })).toBeVisible();
  // No table of cities on a file's page: Top Review has them.
  expect(screen.queryByRole("table", { name: /Cities/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Upload fixes/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});

test("a file in Top Review: no Ready cities here; a muted city is a warning an owner unmutes", async () => {
  const reviewing = file({
    status: "top_review",
    errors: 0,
    warnings: 0,
    cities_going: 2,
    cities_ready: 1,
    cities_muted: 1,
    can_send_cities: true,
  });
  const cities = [
    city({ state: "ready", tops: 1 }),
    city({
      key: "dallas",
      name: "Dallas",
      state: "muted",
      muted: "Dallas is already in file F3 (dallas.xlsx), handed in earlier",
    }),
  ];
  const full = {
    ...detail,
    ...reviewing,
    problems: [],
    cities,
    tabs: {
      Irvine: {
        errors: 0,
        warnings: 0,
        columns: [{ field: "city", message: "City differs from the tab's name" }],
      },
    },
  };
  const calls = mockApi({
    "GET /auth/me": me(owner),
    "GET /submissions": [200, [reviewing]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, full],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "POST /submissions/f1/cities/dallas/unmute": [200, { ...full, status: "checking" }],
  });
  render(<App />);

  const row = await screen.findByRole("row", { name: /tulsa\.xlsx/ });
  expect(within(row).getByText("Cal")).toBeVisible(); // who handed it in
  expect(within(row).getByText("In Top Review")).toBeVisible();
  expect(within(row).getByText("Waiting for Top Review")).toBeVisible();
  expect(within(row).queryByText(/ready/i)).toBeNull();
  expect(within(row).queryByRole("button", { name: /Send/ })).toBeNull();

  await userEvent.click(within(row).getByRole("button", { name: "Open" }));
  const muted = await screen.findByRole("list", { name: "Muted cities" });
  expect(muted).toHaveTextContent("Dallas is muted: Dallas is already in file F3");
  expect(screen.queryByRole("table", { name: /Cities/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Send/ })).toBeNull();
  // A tab's column problems aren't listed on the file's page.
  expect(screen.queryByText(/City differs from the tab's name/)).toBeNull();
  await userEvent.click(within(muted).getByRole("button", { name: "Unmute" }));
  expect(calls.some((c) => c.path === "/submissions/f1/cities/dallas/unmute")).toBe(true);
});

test("fixes come back from Excel: shown first, then saved", async () => {
  const preview = {
    saved: false,
    whole_file: false,
    version_after: 1,
    rows: 3,
    changed: [
      {
        tab: "Tulsa",
        line: 2,
        file_id: "F12-0014",
        business_name: "Bad Co",
        changes: [
          { field: "Phone", from: "call us", to: "(918) 555-2222" },
          { field: "Website", from: "https://facebook.com/bc", to: "https://badco.com" },
        ],
      },
    ],
    removed: [{ tab: "Tulsa", line: 3, file_id: "F12-0015", business_name: "Ghost Co" }],
    skipped: [],
    businesses_after: 1,
  };
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [file()]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, detail],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "POST /submissions/f1/fixes": (body) =>
      (body as { confirm: string }).confirm === "true"
        ? [200, { ...preview, saved: true }]
        : [200, preview],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "tulsa.xlsx" }));
  await userEvent.click(await screen.findByRole("button", { name: /Upload fixes/ }));
  const dialog = screen.getByRole("dialog", { name: "Upload fixes" });
  await userEvent.upload(within(dialog).getByLabelText(/Fixed file/), new File(["x"], "fix.xlsx"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));

  expect(await within(dialog).findByText(/Taken out of the file: Ghost Co/)).toBeVisible();
  expect(within(dialog).getByRole("cell", { name: "(918) 555-2222" })).toBeVisible();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Save 2 changes and take out 1" }),
  );
  expect(screen.queryByRole("dialog", { name: "Upload fixes" })).toBeNull();
  const sent = calls.filter((c) => c.path === "/submissions/f1/fixes").map((c) => c.body);
  expect(sent.map((b) => (b as { confirm: string }).confirm)).toEqual(["false", "true"]);
});

test("a file without errors waits in its Final check, and can be sent on now", async () => {
  const waiting = file({
    status: "final_check",
    errors: 0,
    warnings: 0,
    // The viewer's clock is two hours off: the time left comes from the server.
    sends_at: new Date(Date.now() + 162 * 60_000).toISOString(),
    sends_in: 42 * 60,
  });
  let listed = [waiting, file({ id: "f2", file_name: "other.xlsx" })];
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": () => [200, listed],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "POST /submissions/f1/send": () => {
      listed = [{ ...waiting, status: "top_review", sends_at: null, sends_in: null }, listed[1]!];
      return [200, listed[0]];
    },
  });
  render(<App />);

  const card = await screen.findByRole("row", { name: /tulsa\.xlsx/ });
  expect(within(card).getByText("Cleaning")).toBeVisible();
  expect(within(card).getByText("No errors · 42 min left")).toBeVisible();
  // The stages count the files; one shows just the files at that stage.
  const stages = screen.getByRole("navigation", { name: "Stages" });
  await userEvent.click(within(stages).getByRole("button", { name: /Final check/ }));
  expect(screen.queryByRole("row", { name: /other\.xlsx/ })).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "Send to Top Review now" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/submissions/f1/send")).toBe(true);
  await userEvent.click(within(stages).getByRole("button", { name: /Top Review/ }));
  const sent = await screen.findByRole("row", { name: /tulsa\.xlsx/ });
  expect(within(sent).getByText(/Waiting for Top Review/)).toBeVisible();
});

test("a whole new file through Upload fixes replaces the file once confirmed", async () => {
  const asked = {
    saved: false,
    whole_file: true,
    version_after: 2,
    rows: 0,
    changed: [],
    removed: [],
    skipped: [],
    businesses_after: null,
  };
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [file()]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, detail],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "POST /submissions/f1/fixes": (body) =>
      (body as { confirm: string }).confirm === "true"
        ? [200, { ...asked, saved: true }]
        : [200, asked],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "tulsa.xlsx" }));
  await userEvent.click(await screen.findByRole("button", { name: /Upload fixes/ }));
  const dialog = screen.getByRole("dialog", { name: "Upload fixes" });
  await userEvent.upload(
    within(dialog).getByLabelText(/whole new file/),
    new File(["x"], "v2.xlsx"),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));
  expect(await within(dialog).findByText(/replace the whole file, as version 2/)).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Replace the file" }));
  expect(screen.queryByRole("dialog", { name: "Upload fixes" })).toBeNull();
  const sent = calls.filter((c) => c.path === "/submissions/f1/fixes").map((c) => c.body);
  expect(sent.map((b) => (b as { confirm: string }).confirm)).toEqual(["false", "true"]);
});

test("Remove duplicates keeps one row of each business, after asking", async () => {
  const twice = { ...detail, duplicates: { rows: 3, elsewhere: 1 } };
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [file({ has_duplicates: true })]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, twice],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "POST /submissions/f1/remove-duplicates": [
      200,
      { ...detail, status: "checking", progress: 0, version: 2 },
    ],
  });
  render(<App />);

  // The problems don't download while there are duplicates: they go first, on the Hub.
  const row = await screen.findByRole("row", { name: /tulsa\.xlsx/ });
  expect(within(row).getByRole("button", { name: "Download problems" })).toBeDisabled();
  expect(within(row).getByText("Remove duplicates first")).toBeVisible();
  await userEvent.click(within(row).getByRole("button", { name: "tulsa.xlsx" }));
  expect(await screen.findByRole("button", { name: /Download problems to fix/ })).toBeDisabled();
  expect(screen.getByText(/This file has duplicates/)).toBeVisible();
  await userEvent.click(await screen.findByRole("button", { name: "Remove duplicates" }));
  expect(confirm).toHaveBeenCalledWith(
    expect.stringMatching(/3 duplicate rows will be removed.*1 business already handed in/),
  );
  expect(calls.some((c) => c.path === "/submissions/f1/remove-duplicates")).toBe(true);
  expect(await screen.findByText(/Lead Check is checking this file/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Remove duplicates" })).toBeNull();
});

test("an owner moves a file in Top Review to another niche", async () => {
  const reviewing = { ...detail, status: "top_review" as const, errors: 0, problems: [] };
  const calls = mockApi({
    "GET /auth/me": me(owner),
    "GET /submissions": [200, [file({ status: "top_review", errors: 0 })]],
    "GET /submissions/niches": [200, ["Cleaning", "Roofing"]],
    "GET /submissions/f1": [200, reviewing],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "PATCH /submissions/f1/niche": [200, { ...reviewing, niche: "Roofing", batch_name: "Roofing" }],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "tulsa.xlsx" }));
  await userEvent.click(await screen.findByRole("button", { name: "Change niche" }));
  const dialog = screen.getByRole("dialog", { name: "Change the niche" });
  expect(dialog).toHaveTextContent(/its cities go to the new niche's batch/);
  const select = within(dialog).getByLabelText("New niche");
  await within(select).findByRole("option", { name: "Roofing" });
  expect(within(select).queryByRole("option", { name: "Cleaning" })).toBeNull();
  await userEvent.selectOptions(select, "Roofing");
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to Roofing" }));
  expect(calls.find((c) => c.path === "/submissions/f1/niche")?.body).toEqual({ niche: "Roofing" });
  expect(await screen.findByText(/Roofing · version/)).toBeVisible();
});

test("a collector can't change a file's niche", async () => {
  mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [file()]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, detail],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "tulsa.xlsx" }));
  expect(await screen.findByRole("heading", { name: "tulsa.xlsx" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Change niche" })).toBeNull();
});
