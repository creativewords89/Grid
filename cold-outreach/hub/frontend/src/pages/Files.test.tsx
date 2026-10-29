import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../App";
import type { HandedInFile, HandedInFileDetail } from "../api";
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
    version: 1,
    businesses: 120,
    errors: 2,
    warnings: 1,
    status: "errors",
    uploaded_by: "Cal",
    mine: true,
    created_at: "2026-10-29T10:00:00Z",
    updated_at: "2026-10-29T10:00:00Z",
    batch: null,
    same_as: null,
    cities_on: 1,
    cities_topped: 0,
    progress: 100,
    error: null,
    sends_at: null,
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
};

const batch = {
  id: "b1",
  name: "Batch 01",
  niche: "Cleaning",
  benchmark: null,
  leads: 0,
  top: 0,
  files: 0,
  bots: [],
  status: "not_started",
  position: 0,
  progress_pct: null,
  created_at: "2026-10-01T10:00:00Z",
  can_edit: true,
  can_run: true,
  can_rename: true,
  can_delete: true,
};

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
  await screen.findByRole("option", { name: "Cleaning" }); // the niches are loaded
  await userEvent.selectOptions(screen.getByLabelText("Niche"), "Cleaning");
  // Choosing (or dropping) the file uploads it at once.
  await userEvent.upload(screen.getByLabelText(/Excel file/), new File(["x"], "tulsa.xlsx"));

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

  const niche = await screen.findByLabelText("Niche");
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
  expect(screen.getByText(/Upload revised version/)).toBeVisible();
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

test("a used file says where, and can't be changed", async () => {
  const used = file({
    status: "used",
    errors: 0,
    batch: { batch_id: "b1", batch_name: "Batch 01", import_id: "i1", at: null, by: "Olivia" },
  });
  mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": [200, [used]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /submissions/f1": [200, { ...detail, ...used, problems: [] }],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
  });
  render(<App />);

  expect(await screen.findByText("Batch 01")).toBeVisible();
  expect(screen.getByText(/Used in/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "tulsa.xlsx" }));
  expect(await screen.findByRole("heading", { name: "tulsa.xlsx" })).toBeVisible();
  expect(screen.queryByText(/Upload revised version/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});

test("an owner adds a ready file to a batch of its niche", async () => {
  const ready = file({ status: "ready", errors: 0, warnings: 0 });
  const calls = mockApi({
    "GET /auth/me": me(owner),
    "GET /submissions": [200, [ready]],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "GET /batches": [200, [batch, { ...batch, id: "b2", name: "Roofs 01", niche: "Roofing" }]],
    "GET /submissions/f1": [200, { ...detail, ...ready, problems: [] }],
    "GET /submissions/f1/leads?page=1&sort=row": [200, leads],
    "POST /submissions/f1/use": [200, { ...ready, status: "adding" }],
  });
  render(<App />);

  const aside = await screen.findByRole("complementary", { name: "Batches" });
  expect(await within(aside).findByText("Batch 01")).toBeVisible();
  expect(screen.getByRole("button", { name: "Niches" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "tulsa.xlsx" }));
  const select = await screen.findByLabelText("Add to batch");
  expect(within(select).queryByRole("option", { name: "Roofs 01" })).toBeNull();
  await userEvent.selectOptions(select, "b1");
  await userEvent.click(screen.getByRole("button", { name: "Add to batch" }));

  expect(calls.find((c) => c.path === "/submissions/f1/use")?.body).toEqual({ batch_id: "b1" });
  expect(window.location.search).toBe("?batch=b1&tab=files");
});

test("fixes come back from Excel: shown first, then saved", async () => {
  const preview = {
    saved: false,
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
    sends_at: new Date(Date.now() + 42 * 60_000).toISOString(),
  });
  let listed = [waiting, file({ id: "f2", file_name: "other.xlsx" })];
  const calls = mockApi({
    "GET /auth/me": me(collector),
    "GET /submissions": () => [200, listed],
    "GET /submissions/niches": [200, ["Cleaning"]],
    "POST /submissions/f1/send": () => {
      listed = [{ ...waiting, status: "needs_top", sends_at: null }, listed[1]!];
      return [200, listed[0]];
    },
  });
  render(<App />);

  const card = await screen.findByRole("listitem", { name: "tulsa.xlsx" });
  expect(within(card).getByText(/Goes to Top Review in 4[12] min/)).toBeVisible();
  // The stages count the files; one shows just the files at that stage.
  const stages = screen.getByRole("navigation", { name: "Stages" });
  await userEvent.click(within(stages).getByRole("button", { name: /Final check/ }));
  expect(screen.queryByRole("listitem", { name: "other.xlsx" })).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "Send to Top Review now" }));
  expect(calls.some((c) => c.method === "POST" && c.path === "/submissions/f1/send")).toBe(true);
  await userEvent.click(within(stages).getByRole("button", { name: /Top Review/ }));
  const sent = await screen.findByRole("listitem", { name: "tulsa.xlsx" });
  expect(within(sent).getByText(/Waiting for Top Review/)).toBeVisible();
});
