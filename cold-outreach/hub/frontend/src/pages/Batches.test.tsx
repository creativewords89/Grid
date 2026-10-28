import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Batch, Benchmark, ImportSheet, LeadImport } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function preview(overrides: Partial<LeadImport> = {}): LeadImport {
  return {
    id: "i1",
    file_name: "GBP_Data_2.xlsx",
    niche: "Cleaning",
    batch_id: "b1",
    batch_name: "Batch 1",
    status: "preview",
    uploaded_by: "Sara",
    created_at: "2026-10-27T10:00:00Z",
    confirmed_at: null,
    counts: {
      tabs: 248,
      leads: 3995,
      new: 3990,
      updated: 0,
      other_batch: 5,
      merged: 0,
      top: 0,
      no_gbp_link: 2,
      no_website: 877,
      skipped_rows: 1,
      invalid_emails: 14,
      cities: 236,
      new_lists: 236,
    },
    preview: {
      has_level_column: false,
      empty_tabs: ["Jackson"],
      unknown_columns: { "Operation Hour": ["Henderson"] },
      skipped_rows: ["Enterprise row 4"],
      invalid_emails: ["Columbus row 16: http:"],
      merged_rows: [],
      updated: [],
      other_batch: ["Sparkle (L-000004, in Spring batch)"],
      no_gbp_link: ["MOLLY MAID (San Jose row 9)"],
      top: [],
      new_lists: ["Tulsa"],
    },
    ...overrides,
  };
}

function batch(overrides: Partial<Batch> = {}): Batch {
  return {
    id: "b1",
    name: "Batch 1",
    niche: "Cleaning",
    benchmark: { id: "m1", name: "Cleaning Benchmark 1", version: 2 },
    leads: 0,
    top: 0,
    files: 0,
    bots: [],
    status: "not_started",
    position: 0,
    progress_pct: null,
    created_at: "2026-10-27T10:00:00Z",
    can_edit: true,
    can_run: true,
    can_rename: true,
    can_delete: true,
    ...overrides,
  };
}

function benchmark(id: string, name: string, niche = "Cleaning"): Benchmark {
  return {
    id,
    name,
    niche,
    version: 1,
    gbp: {},
    website: {},
    batches: [],
    updated_by: null,
    updated_at: "2026-10-27T10:00:00Z",
    can_edit: true,
  };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/batches"));
afterEach(() => vi.unstubAllGlobals());

test("make a batch: a name, its niche and a benchmark of that niche", async () => {
  let made = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": () => [200, made ? [batch({ name: "Texas November" })] : []],
    "GET /lists": [200, []],
    "GET /benchmarks": [
      200,
      [
        benchmark("m1", "Cleaning Benchmark 1"),
        benchmark("m2", "Cleaning Benchmark 2"),
        benchmark("m3", "Roofing Benchmark 1", "Roofing"),
      ],
    ],
    "GET /imports?batch_id=b1": [200, []],
    "POST /batches": () => {
      made = true;
      return [201, batch({ name: "Texas November" })];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ New batch" }));
  const form = screen.getByRole("form", { name: "New batch" });
  await userEvent.type(within(form).getByLabelText("Batch name"), "Texas November");
  await userEvent.type(within(form).getByLabelText("Niche (one per batch)"), "cleaning");
  const select = within(form).getByLabelText("Benchmark");
  // Only this niche's benchmarks are offered.
  expect(
    within(select)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Choose…", "Cleaning Benchmark 1", "Cleaning Benchmark 2"]);
  await userEvent.selectOptions(select, "m2");
  await userEvent.click(within(form).getByRole("button", { name: "Make the batch" }));

  expect(await screen.findByRole("heading", { name: "Texas November" })).toBeVisible();
  expect(screen.getByRole("form", { name: "Add a lead file" })).toBeVisible();
  expect(calls.find((c) => c.path === "/batches" && c.method === "POST")?.body).toEqual({
    name: "Texas November",
    niche: "cleaning",
    benchmark_id: "m2",
  });
});

test("a niche without a benchmark points to the Benchmarks screen", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, []],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, [benchmark("m1", "Cleaning Benchmark 1")]],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "+ New batch" }));
  await userEvent.type(screen.getByLabelText("Niche (one per batch)"), "Plumbing");

  expect(screen.getByText(/No benchmark for this niche yet/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Make one on Benchmarks" })).toBeVisible();
  expect(screen.getByLabelText("Benchmark")).toBeDisabled();
});

test("add a file to a batch, read the preview, save it", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch({ leads: 12, files: 1, can_rename: false, can_delete: false })]],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, [benchmark("m1", "Cleaning Benchmark 1")]],
    "GET /imports?batch_id=b1": [200, []],
    "POST /imports": [201, preview()],
    "POST /imports/i1/confirm": [
      200,
      preview({
        status: "confirmed",
        counts: { ...preview().counts, saved_new: 3990, saved_updated: 5 },
      }),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  await userEvent.click(screen.getByRole("tab", { name: "Lead files" }));
  await userEvent.click(screen.getByRole("tab", { name: "Files" }));
  const form = await screen.findByRole("form", { name: "Add a lead file" });
  fireEvent.change(within(form).getByLabelText("Excel file"), {
    target: { files: [new File(["xlsx"], "GBP_Data_2.xlsx")] },
  });
  await userEvent.click(within(form).getByRole("button", { name: "Read the file" }));

  const card = await screen.findByRole("article", { name: "Preview" });
  expect(within(card).getByText("3,995", { selector: ".count-value" })).toBeVisible();
  expect(within(card).getByText("already in another batch").previousSibling).toHaveTextContent("5");
  await userEvent.click(within(card).getByText(/Already in another batch/));
  expect(within(card).getByText("Sparkle (L-000004, in Spring batch)")).toBeVisible();
  expect(within(card).getByText("without a GBP link").previousSibling).toHaveTextContent("2");
  expect(within(card).getByText(/Top is chosen in the Hub/)).toBeVisible();
  await userEvent.click(within(card).getByText("Other columns (kept with the leads)"));
  expect(within(card).getByText("Operation Hour (in 1 tab)")).toBeVisible();
  await userEvent.click(within(card).getByRole("button", { name: "Save 3,995 businesses" }));

  expect(await screen.findByText(/Saved: 3990 new and 5 updated/)).toBeVisible();
  const posted = calls.find((c) => c.path === "/imports" && c.method === "POST");
  expect(posted?.csrf).toBe("t");
  expect((posted?.body as { batch_id: string }).batch_id).toBe("b1");
  // A batch with leads keeps its name and can't be deleted.
  expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
});

test("an unreadable file shows why", async () => {
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, [batch()]],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, []],
    "GET /imports?batch_id=b1": [200, []],
    "POST /imports": [
      422,
      {
        error: {
          code: "unreadable",
          message: "This isn't an Excel file (.xlsx).",
          fields: { file: "This isn't an Excel file (.xlsx)." },
        },
      },
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const form = await screen.findByRole("form", { name: "Add a lead file" });
  fireEvent.change(within(form).getByLabelText("Excel file"), {
    target: { files: [new File(["a,b"], "leads.csv")] },
  });
  await userEvent.click(within(form).getByRole("button", { name: "Read the file" }));

  expect(await within(form).findAllByText("This isn't an Excel file (.xlsx).")).toHaveLength(2);
});

test("change a batch's benchmark, and delete an empty batch", async () => {
  let deleted = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": () => [200, deleted ? [] : [batch()]],
    "GET /lists": [200, []],
    "GET /benchmarks": [
      200,
      [benchmark("m1", "Cleaning Benchmark 1"), benchmark("m2", "Cleaning Benchmark 2")],
    ],
    "GET /imports?batch_id=b1": [200, []],
    "PATCH /batches/b1": [
      200,
      batch({ benchmark: { id: "m2", name: "Cleaning Benchmark 2", version: 1 } }),
    ],
    "DELETE /batches/b1": () => {
      deleted = true;
      return [204];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
  const settings = await screen.findByRole("generic", { name: "Batch settings" });
  await userEvent.selectOptions(
    await within(settings).findByLabelText("Benchmark"),
    await within(settings).findByRole("option", { name: "Cleaning Benchmark 2 (v1)" }),
  );
  await userEvent.click(within(settings).getByRole("button", { name: "Use this benchmark" }));
  expect(await within(settings).findByText(/Benchmark changed/)).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ benchmark_id: "m2" });

  await userEvent.click(within(settings).getByRole("button", { name: "Delete this empty batch" }));
  expect(await screen.findByText(/No batches yet/)).toBeVisible();
});

test("a viewer sees batches and files but can't add; the lists are on Leads", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, [batch({ leads: 27, can_edit: false, can_rename: false })]],
    "GET /imports?batch_id=b1": [200, [preview({ status: "confirmed" })]],
    "GET /lists": [
      200,
      [
        {
          id: "l1",
          city: "Tulsa",
          niche: "Cleaning",
          active: true,
          daily_limit: null,
          leads: 27,
          top: 2,
        },
      ],
    ],
  });
  render(<App />);

  expect(await screen.findByText("Cleaning Benchmark 1 (v2)")).toBeVisible();
  expect(screen.queryByRole("button", { name: "+ New batch" })).not.toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "Tulsa · Cleaning on or off" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Batch 1" }));
  await userEvent.click(screen.getByRole("tab", { name: "Lead files" }));
  await userEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await screen.findByText("Saved")).toBeVisible();
  expect(screen.queryByRole("form", { name: "Add a lead file" })).not.toBeInTheDocument();
});

test("a waiting preview opens again and can be discarded", async () => {
  let discarded = false;
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, [batch({ can_delete: false })]],
    "GET /lists": [200, []],
    "GET /benchmarks": [200, []],
    "GET /imports?batch_id=b1": () => [200, [preview(discarded ? { status: "discarded" } : {})]],
    "POST /imports/i1/discard": () => {
      discarded = true;
      return [200, preview({ status: "discarded" })];
    },
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const card = await screen.findByRole("article", { name: "Preview" });
  await userEvent.click(within(card).getByRole("button", { name: "Discard" }));

  expect(await screen.findByRole("form", { name: "Add a lead file" })).toBeVisible();
  expect(calls.some((c) => c.path === "/imports/i1/discard")).toBe(true);
});

function sheet(overrides: Partial<ImportSheet> = {}): ImportSheet {
  return {
    kept: true,
    tabs: [
      { name: "Tulsa", rows: 2 },
      { name: "Jackson", rows: 0 },
      { name: "Dallas", rows: 1 },
    ],
    columns: [
      { key: "business_name", label: "Business name" },
      { key: "gbp_link", label: "MAP" },
      { key: "email", label: "Email" },
      { key: "extra:Operation Hour", label: "Operation Hour" },
    ],
    statuses: { new: 2, updated: 0, other_batch: 1, merged: 0, top: 0, skipped: 0 },
    rows: [
      {
        tab: "Tulsa",
        line: 2,
        status: "new",
        merged: false,
        top: false,
        values: { business_name: "Multi-Clean", email: "kevin@mc.com" },
        extra: { "Operation Hour": "9-5" },
        raw: { email: "Kevin@MC.com" },
        bad_emails: ["http:"],
      },
      {
        tab: "Tulsa",
        line: 3,
        status: "other_batch",
        merged: false,
        top: false,
        values: { business_name: "Sparkle" },
        extra: {},
        raw: {},
        bad_emails: [],
      },
    ],
    total: 2,
    page: 1,
    pages: 1,
    ...overrides,
  };
}

test("the preview shows the file tab by tab with every column", async () => {
  const calls = mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, [batch({ can_delete: false })]],
    "GET /benchmarks": [200, []],
    "GET /imports?batch_id=b1": [200, [preview()]],
    "GET /imports/i1/sheet?page=1": [200, sheet()],
    "GET /imports/i1/sheet?tab=Dallas&page=1": [200, sheet({ rows: [], total: 0 })],
    "GET /imports/i1/sheet?tab=Dallas&status=other_batch&page=1": [
      200,
      sheet({ rows: [], total: 0 }),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Batch 1" }));
  const file = await screen.findByRole("region", { name: "The file, tab by tab" });
  const tabs = within(file).getByRole("tablist", { name: "Tabs of the file" });
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((t) => t.textContent),
  ).toEqual(["All tabs (3)", "Tulsa (2)", "Jackson (0)", "Dallas (1)"]);
  const rows = within(file).getAllByRole("row");
  expect(rows[0]).toHaveTextContent("Business nameMAPEmailOperation Hour");
  expect(within(rows[1]!).getByText("9-5")).toBeVisible();
  expect(within(rows[1]!).getByText("kevin@mc.com").closest("td")).toHaveAttribute(
    "title",
    "In the file: Kevin@MC.com",
  );
  expect(within(rows[1]!).getByText(/Not an email: http:/)).toBeVisible();
  expect(within(rows[2]!).getByText("In another batch")).toBeVisible();

  await userEvent.click(within(tabs).getByRole("tab", { name: /Dallas/ }));
  await userEvent.selectOptions(within(file).getByLabelText("Show"), "other_batch");
  expect(await within(file).findByText("No rows here.")).toBeVisible();
  expect(
    calls.some((c) => c.path === "/imports/i1/sheet?tab=Dallas&status=other_batch&page=1"),
  ).toBe(true);
});

// --- step 15: leads and cities in the batch, deleting files, finding a business --------------

const OCTOBER = { id: "i1", file_name: "october.xlsx", confirmed_at: "2026-10-01T10:00:00Z" };
const NOVEMBER = { id: "i2", file_name: "november.xlsx", confirmed_at: "2026-11-01T10:00:00Z" };

function city(
  id: string,
  name: string,
  active = true,
  leads = 27,
  top = 1,
  from: typeof OCTOBER = OCTOBER,
) {
  return {
    id,
    batch_id: "b1",
    city: name,
    niche: "Cleaning",
    active,
    set_by_hand: false,
    small: leads < 10,
    daily_limit: null,
    leads,
    top,
    ready: top > 0,
    added_from: from,
    new: from === NOVEMBER,
  };
}

const emptyPipeline = {
  batch: batch({ leads: 12 }),
  steps: [],
  can_start: false,
  start_problem: "Add a task with at least one agent first.",
};

test("the old leads address opens the batch's Leads tab", async () => {
  window.history.pushState(null, "", "/leads?batch=b1");
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, [batch({ leads: 12 })]],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, emptyPipeline],
    "GET /leads?batch_id=b1": [
      200,
      { leads: [], total: 0, page: 1, pages: 1, agents: {}, extra_columns: [] },
    ],
  });
  render(<App />);

  expect(await screen.findByRole("tab", { name: "Leads" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tab", { name: "Lead files" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByText("No leads match.")).toBeVisible();
  expect(window.location.pathname + window.location.search).toBe("/batches?batch=b1&tab=leads");
  expect(
    within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Batches" }),
  ).toHaveAttribute("aria-current", "page");
});

test("a batch's cities: Ready, Not ready and small ones; switch one, all off, open a city", async () => {
  window.history.pushState(null, "", "/batches?batch=b1&tab=cities");
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, [batch({ leads: 54 })]],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, emptyPipeline],
    "GET /batches/b1/cities": [
      200,
      [
        city("c1", "Akron", false, 4, 0),
        city("c2", "Tulsa"),
        city("c3", "Dallas", true, 30, 0, NOVEMBER),
      ],
    ],
    "PATCH /lists/c1": [200, city("c1", "Akron", true, 4)],
    "PATCH /lists/c2": [200, city("c2", "Tulsa", false)],
    "PUT /batches/b1/cities": [200, [city("c2", "Tulsa", false), city("c3", "Dallas", false)]],
    "GET /leads?batch_id=b1&city=Tulsa": [
      200,
      { leads: [], total: 0, page: 1, pages: 1, agents: {}, extra_columns: [] },
    ],
  });
  render(<App />);

  // Ready: a Top is chosen in it.
  expect(await screen.findByRole("tab", { name: /^Ready \(1\)/ })).toBeVisible();
  expect(screen.getByText(/1 cities · 1 on · 0 off/)).toBeVisible();
  expect(screen.queryByText("Akron")).not.toBeInTheDocument();
  expect(screen.queryByText("Dallas")).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Find a city"), "xyz");
  expect(screen.queryByText("Tulsa")).not.toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("Find a city"));
  await userEvent.click(screen.getByRole("switch", { name: "Tulsa on or off" }));
  await userEvent.click(screen.getByRole("button", { name: "All off" }));
  expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
    active: false,
    small: false,
    ready: true,
  });

  // Each city says the file it first came with; the latest file's are New (step 22).
  expect(screen.getByRole("row", { name: /Tulsa/ })).toHaveTextContent("october.xlsx");
  expect(screen.getByRole("row", { name: /Tulsa/ })).not.toHaveTextContent("New");
  await userEvent.selectOptions(screen.getByLabelText("From file"), "i2");
  expect(screen.getByRole("tab", { name: /^Ready \(0\)/ })).toBeVisible();
  expect(screen.getByRole("tab", { name: /^Not ready \(1\)/ })).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: /^Not ready/ }));
  expect(screen.getByRole("row", { name: /Dallas/ })).toHaveTextContent("New");
  expect(screen.getByRole("row", { name: /Dallas/ })).toHaveTextContent("november.xlsx");
  await userEvent.selectOptions(screen.getByLabelText("From file"), "");

  // Not ready: no Top chosen yet, agents leave it alone.
  await userEvent.click(screen.getByRole("tab", { name: /^Not ready \(1\)/ }));
  expect(screen.getByText("Dallas")).toBeVisible();
  expect(screen.getByText(/No Top chosen yet/)).toBeVisible();
  // No switch here: it waits for a Top (step 21).
  expect(screen.getByRole("row", { name: /Dallas/ })).toHaveTextContent("Needs a Top");
  expect(screen.queryByRole("switch", { name: "Dallas on or off" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "All on" })).not.toBeInTheDocument();

  // The small cities, muted by the Hub: unmute one by hand; it still needs a Top.
  await userEvent.click(screen.getByRole("tab", { name: /Small cities \(under 10\) \(1\)/ }));
  expect(screen.getByText(/1 cities · 0 on · 1 off/)).toBeVisible();
  expect(screen.getByRole("row", { name: /Akron/ })).toHaveTextContent("Not ready");
  await userEvent.click(screen.getByRole("switch", { name: "Akron on or off" }));
  expect(calls.find((c) => c.path === "/lists/c1")?.body).toEqual({ active: true });

  await userEvent.click(screen.getByRole("tab", { name: /^Ready/ }));
  await userEvent.click(screen.getByRole("button", { name: "Tulsa" }));
  // A city's leads belong to Cities: that tab stays chosen, without Lead files' views.
  expect(await screen.findByRole("region", { name: "Leads of one city" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Cities" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("tablist", { name: "Lead files" })).not.toBeInTheDocument();
  expect(calls.some((c) => c.path === "/leads?batch_id=b1&city=Tulsa")).toBe(true);

  // Back to Cities returns to the same tab of cities; Show all leads drops the city.
  const bar = screen.getByRole("region", { name: "Leads of one city" });
  expect(bar).toHaveTextContent("Leads in Tulsa");
  const loads = calls.filter((c) => c.path === "/batches/b1/cities").length;
  await userEvent.click(within(bar).getByRole("button", { name: "← Back to Cities" }));
  expect(screen.getByRole("tab", { name: "Cities" })).toHaveAttribute("aria-selected", "true");
  // Loaded again: a Top marked in the city moves it to Ready.
  expect(calls.filter((c) => c.path === "/batches/b1/cities").length).toBe(loads + 1);
  expect(screen.getByRole("switch", { name: "Tulsa on or off" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Tulsa" }));
  await userEvent.click(
    within(screen.getByRole("region", { name: "Leads of one city" })).getByRole("button", {
      name: "Show all leads",
    }),
  );
  expect(screen.queryByRole("region", { name: "Leads of one city" })).not.toBeInTheDocument();
});

test("a saved file is deleted with its leads, but not while the batch runs", async () => {
  window.history.pushState(null, "", "/batches?batch=b1&tab=files");
  let running = true;
  let deleted = false;
  const saved = preview({ status: "confirmed" });
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": () => [200, [batch({ leads: 12, status: running ? "running" : "paused" })]],
    "GET /benchmarks": [200, []],
    "GET /imports?batch_id=b1": () => [200, deleted ? [] : [saved]],
    "GET /batches/b1/pipeline": () => [
      200,
      { ...emptyPipeline, batch: batch({ status: running ? "running" : "paused" }) },
    ],
    "GET /imports/i1/deletion": [
      200,
      { leads_going: 3990, leads_staying: 5, batch_running: false },
    ],
    "DELETE /imports/i1": () => {
      deleted = true;
      return [204];
    },
  });
  const { unmount } = render(<App />);

  const remove = await screen.findByRole("button", { name: "Delete GBP_Data_2.xlsx" });
  expect(remove).toBeDisabled();
  expect(screen.getByText(/pause the batch first/)).toBeVisible();
  unmount();

  running = false;
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Delete GBP_Data_2.xlsx" }));
  const dialog = screen.getByRole("dialog", { name: "Delete GBP_Data_2.xlsx?" });
  expect(dialog).toHaveTextContent("3,990 businesses this file brought in go");
  expect(dialog).toHaveTextContent("5 businesses that came from earlier files stay");
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete the file" }));

  await screen.findByRole("form", { name: "Add a lead file" });
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/imports/i1")).toBe(true);
  expect(screen.queryByText("Past imports")).not.toBeInTheDocument();
});

test("find a business in every batch", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, [batch(), batch({ id: "b2", name: "Batch 2" })]],
    "GET /leads?q=sparkle": [
      200,
      {
        leads: [
          {
            lead_id: "L-000004",
            batch_id: "b2",
            batch_name: "Batch 2",
            niche: "Cleaning",
            city: "Dallas",
            business_name: "Sparkle",
            level: "",
            gbp_link: "",
            emails: [],
            data: {},
            extra: {},
            results: {},
          },
        ],
        total: 1,
        page: 1,
        pages: 1,
        agents: {},
        extra_columns: [],
      },
    ],
    "GET /imports?batch_id=b2": [200, []],
    "GET /batches/b2/pipeline": [200, emptyPipeline],
  });
  render(<App />);

  const find = await screen.findByRole("form", { name: "Find a business" });
  await userEvent.type(within(find).getByLabelText("Find a business in every batch"), "sparkle");
  await userEvent.click(within(find).getByRole("button", { name: "Find" }));
  const results = (await screen.findByText("1 found")).closest("table")!;
  await userEvent.click(within(results).getByRole("button", { name: "Batch 2" }));

  expect(await screen.findByRole("heading", { name: "Batch 2" })).toBeVisible();
  expect(window.location.search).toBe("?batch=b2&tab=files");
});

test("the cities show 20 a page", async () => {
  window.history.pushState(null, "", "/batches?batch=b1&tab=cities");
  const many = Array.from({ length: 45 }, (_, n) =>
    city(`c${n}`, `City ${String(n + 1).padStart(2, "0")}`),
  );
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, [batch({ leads: 900 })]],
    "GET /imports?batch_id=b1": [200, []],
    "GET /batches/b1/pipeline": [200, emptyPipeline],
    "GET /batches/b1/cities": [200, many],
  });
  render(<App />);

  expect(await screen.findByText("Page 1 of 3 · 45 cities")).toBeVisible();
  expect(screen.getAllByRole("switch")).toHaveLength(20);
  expect(screen.getByText("City 01")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Page 3 of 3 · 45 cities")).toBeVisible();
  expect(screen.getAllByRole("switch")).toHaveLength(5);
  expect(screen.getByText("City 45")).toBeVisible();
  await userEvent.type(screen.getByLabelText("Find a city"), "City 0");
  expect(screen.queryByText(/Page \d of/)).not.toBeInTheDocument(); // 9 match: one page
});
