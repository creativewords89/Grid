import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import type { Lead, LeadDetail, LeadPage } from "../api";
import { AuthProvider } from "../auth";
import { BatchLeads } from "./Leads";
import { makeUser, mockApi } from "../test/mockApi";

function lead(id: string, overrides: Partial<Lead> = {}): Lead {
  return {
    lead_id: id,
    batch_id: "b1",
    batch_name: "Batch 1",
    niche: "Cleaning",
    city: "Tulsa",
    business_name: "Multi-Clean",
    level: "",
    gbp_link: "https://share.google/mc",
    emails: ["kevin@mc.com", "info@mc.com"],
    data: { phone: "(918) 523-8300", website: "https://mc.com/", address: "12 Elm St" },
    extra: {},
    results: {},
    check: [],
    ...overrides,
  };
}

function leadPage(leads: Lead[], overrides: Partial<LeadPage> = {}): LeadPage {
  return {
    leads,
    total: leads.length,
    page: 1,
    pages: 1,
    agents: {},
    extra_columns: [],
    ...overrides,
  };
}

function detail(overrides: Partial<LeadDetail> = {}): LeadDetail {
  return { ...lead("L-000001"), files: [], can_edit: true, held: false, ...overrides };
}

const as = (role: "owner" | "admin" | "viewer") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

afterEach(() => vi.unstubAllGlobals());

test("the leads show like a sheet, with the agents' scores, filters and pages", async () => {
  const calls = mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [
      200,
      leadPage(
        [
          lead("L-000001", {
            results: {
              "gbp-audit": {
                status: "OK",
                score: 61,
                summary: "Posts are rare.",
                details: {},
                benchmark_id: null,
                benchmark_version: 1,
                at: "2026-10-28T08:00:00Z",
              },
            },
          }),
          lead("L-000002", { business_name: "Top Shine", level: "Top", emails: [] }),
        ],
        { total: 230, pages: 3, agents: { "gbp-audit": "GBP" } },
      ),
    ],
    "GET /leads?batch_id=b1&page=1&q=shine": [200, leadPage([])],
    "GET /leads?batch_id=b1&page=1&q=shine&level=top": [200, leadPage([])],
    "GET /leads?batch_id=b1&page=2": [
      200,
      leadPage([lead("L-000101")], { total: 230, page: 2, pages: 3 }),
    ],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  const rows = await screen.findAllByRole("row");
  expect(screen.getByText("230 leads")).toBeVisible();
  expect(screen.getAllByText("Page 1 of 3")[0]).toBeVisible();
  expect(within(rows[0]!).getByText("GBP")).toBeVisible();
  expect(within(rows[1]!).getByText("61")).toBeVisible();
  // Every field of the lead file is a column, links open in a new tab.
  const headers = within(rows[0]!)
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual([
    "Lead ID",
    "Business name",
    "Check",
    "GBP link",
    "Address",
    "City",
    "Website",
    "Phone",
    "WhatsApp",
    "Email",
    "Facebook",
    "Instagram",
    "Reviews",
    "Rating",
    "Top",
    "Notes",
    "Batch",
    "GBP",
  ]);
  expect(within(rows[1]!).getByText("kevin@mc.com, info@mc.com")).toBeVisible();
  expect(within(rows[1]!).getByText("12 Elm St")).toBeVisible();
  expect(within(rows[1]!).getByRole("link", { name: "mc.com/" })).toHaveAttribute(
    "href",
    "https://mc.com/",
  );
  expect(within(rows[1]!).getByRole("link", { name: "Open map" })).toHaveAttribute(
    "target",
    "_blank",
  );
  expect(within(rows[2]!).getByText("Top")).toBeVisible();
  expect(screen.getByRole("link", { name: /^Download Excel/ })).toHaveAttribute(
    "href",
    "/api/leads/export?batch_id=b1",
  );

  await userEvent.click(screen.getAllByRole("button", { name: "Next" })[0]!);
  expect(await screen.findByText("L-000101")).toBeVisible();

  await userEvent.type(screen.getByLabelText("Search"), "shine");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("No leads match.")).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText("Top"), "top");
  await screen.findByText("No leads match.");
  // The filters that are on show as chips; a chip takes its filter off.
  expect(screen.getByRole("button", { name: "Top only ×" })).toBeVisible();
  expect(calls.some((c) => c.path === "/leads?batch_id=b1&page=1&q=shine&level=top")).toBe(true);
  expect(screen.getByRole("link", { name: /^Download Excel/ })).toHaveAttribute(
    "href",
    "/api/leads/export?batch_id=b1&q=shine&level=top",
  );
});

test("sorting by an agent's score", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")], { agents: { demo: "Demo" } })],
    "GET /leads?batch_id=b1&sort=score&score_of=demo&page=1": [200, leadPage([])],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  expect(await screen.findByText("Multi-Clean")).toBeVisible();
  await userEvent.selectOptions(screen.getByLabelText("Sort by"), "score:demo");
  await screen.findByText("No leads match.");
  expect(calls.some((c) => c.path.includes("sort=score&score_of=demo"))).toBe(true);
});

test("open a lead, change it and mark it Top", async () => {
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")])],
    "GET /leads/L-000001": [
      200,
      detail({
        files: [
          {
            id: "f1",
            agent_key: "gbp-audit",
            name: "gbp-report.pdf",
            content_type: "application/pdf",
            size: 20480,
            created_at: "2026-10-28T08:00:00Z",
          },
        ],
      }),
    ],
    "PATCH /leads/L-000001": [200, detail({ level: "Top", emails: ["owner@mc.com"] })],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Multi-Clean" }));
  const dialog = await screen.findByRole("dialog", { name: "Multi-Clean" });
  expect(within(dialog).getByLabelText("Address")).toHaveValue("12 Elm St");
  expect(within(dialog).getByText("No agent has checked this lead yet.")).toBeVisible();
  expect(within(dialog).getByRole("link", { name: "gbp-report.pdf" })).toHaveAttribute(
    "href",
    "/api/leads/L-000001/files/f1",
  );
  const email = within(dialog).getByLabelText("Email(s)");
  expect(email).toHaveValue("kevin@mc.com, info@mc.com");
  await userEvent.clear(email);
  await userEvent.type(email, "owner@mc.com");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

  expect(await within(dialog).findByText("Saved.")).toBeVisible();
  // Only what changed is sent.
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ email: "owner@mc.com" });
  // Top is shown, not changed, in the lead window (step 19).
  expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
  expect(within(dialog).getByText(/Never audited or contacted/)).toBeVisible();
});

test("deleting a lead asks once more", async () => {
  let deleted = false;
  mockApi({
    "GET /auth/me": as("owner"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": () => [200, leadPage(deleted ? [] : [lead("L-000001")])],
    "GET /leads/L-000001": [200, detail()],
    "DELETE /leads/L-000001": () => {
      deleted = true;
      return [204];
    },
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Multi-Clean" }));
  const dialog = await screen.findByRole("dialog", { name: "Multi-Clean" });
  await userEvent.click(await within(dialog).findByRole("button", { name: "Delete this lead" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete L-000001 for good" }));

  expect(await screen.findByText("No leads match.")).toBeVisible();
});

test("a viewer sees a lead but can't change it", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")])],
    "GET /leads/L-000001": [200, detail({ can_edit: false })],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  await userEvent.click(await screen.findByRole("button", { name: "Multi-Clean" }));
  const dialog = await screen.findByRole("dialog", { name: "Multi-Clean" });

  expect(await within(dialog).findByLabelText("Email(s)")).toBeDisabled();
  expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
});

test("only web addresses become links", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /batches": [200, []],
    "GET /leads?batch_id=b1": [
      200,
      leadPage([
        lead("L-000001", {
          gbp_link: "",
          data: { website: "javascript:alert(1)", facebook: "sparkle.cleaning" },
        }),
      ]),
    ],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  const row = (await screen.findAllByRole("row"))[1]!;
  expect(within(row).getByText("javascript:alert(1)").closest("a")).toBeNull();
  expect(within(row).getByRole("link", { name: "sparkle.cleaning" })).toHaveAttribute(
    "href",
    "https://sparkle.cleaning",
  );
});

test("the batch's Leads tab shows Top but has no boxes to choose it", async () => {
  mockApi({
    "GET /auth/me": as("admin"),
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001", { level: "Top" })])],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  expect(await screen.findByLabelText(/Top is chosen in a city/)).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Multi-Clean/ })).toHaveTextContent("Top");
});

test("in a city an Admin ticks leads and marks them Top; sorting by rating", async () => {
  let marked = false;
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /leads?batch_id=b1&city=Tulsa": () => [
      200,
      leadPage([
        lead("L-000001", { level: marked ? "Top" : "" }),
        lead("L-000002", { business_name: "Shine", level: marked ? "Top" : "" }),
        lead("L-000003", { business_name: "Dusty" }),
      ]),
    ],
    "POST /leads/top": () => {
      marked = true;
      return [200, { changed: 2 }];
    },
    "GET /leads?batch_id=b1&city=Tulsa&sort=rating&page=1": [200, leadPage([])],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" city="Tulsa" />
    </AuthProvider>,
  );

  await userEvent.click(await screen.findByRole("checkbox", { name: "Choose Multi-Clean" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Choose Shine" }));
  const bar = screen.getByRole("region", { name: "Chosen leads" });
  expect(bar).toHaveTextContent("2 chosen");
  await userEvent.click(within(bar).getByRole("button", { name: "Mark as Top" }));

  expect(await screen.findByText("2 leads marked as Top: agents leave them alone.")).toBeVisible();
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    batch_id: "b1",
    city: "Tulsa",
    lead_ids: ["L-000001", "L-000002"],
    top: true,
  });
  expect(screen.queryByRole("region", { name: "Chosen leads" })).not.toBeInTheDocument();
  // The whole page at once.
  await userEvent.click(screen.getByRole("checkbox", { name: "Choose every lead on this page" }));
  expect(screen.getByRole("region", { name: "Chosen leads" })).toHaveTextContent("3 chosen");

  await userEvent.selectOptions(screen.getByLabelText("Sort by"), "rating");
  await screen.findByText("No leads match.");
  expect(calls.some((c) => c.path === "/leads?batch_id=b1&city=Tulsa&sort=rating&page=1")).toBe(
    true,
  );
});

test("viewers can't choose Top, even in a city", async () => {
  mockApi({
    "GET /auth/me": as("viewer"),
    "GET /leads?batch_id=b1&city=Tulsa": [200, leadPage([lead("L-000001")])],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" city="Tulsa" />
    </AuthProvider>,
  );

  expect(await screen.findByText("Multi-Clean")).toBeVisible();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

test("Lead Check: problems, the filter, a held lead and a one-click fix (steps 26–27)", async () => {
  const wrong = lead("L-000002", {
    business_name: "Sparkle",
    data: { website: "https://fb.com/sp", address: "9 Elm St (918) 555-0300" },
    check: [
      {
        code: "WEBSITE_IS_FACEBOOK",
        field: "website",
        severity: "error",
        message: "Website is a Facebook link",
      },
    ],
  });
  const calls = mockApi({
    "GET /auth/me": as("admin"),
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001"), wrong])],
    "GET /leads?batch_id=b1&problems=errors&page=1": [200, leadPage([wrong])],
    "GET /leads/L-000002": [
      200,
      {
        ...wrong,
        files: [],
        can_edit: true,
        held: true,
        check: [
          {
            ...wrong.check[0],
            fix: {
              label: "Move it to Facebook",
              changes: { website: "", facebook: "https://fb.com/sp" },
            },
          },
        ],
      },
    ],
    "PATCH /leads/L-000002": [200, detail({ lead_id: "L-000002", business_name: "Sparkle" })],
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  const row = (await screen.findByRole("button", { name: "Sparkle" })).closest("tr")!;
  expect(row).toHaveTextContent("🔴 1");
  expect(row.querySelector(".cell-problem")).toHaveAttribute("title", "Website is a Facebook link");
  await userEvent.selectOptions(screen.getByLabelText("Problems"), "errors");
  expect(calls.some((c) => c.path === "/leads?batch_id=b1&problems=errors&page=1")).toBe(true);

  await userEvent.click(screen.getByRole("button", { name: "Sparkle" }));
  const dialog = await screen.findByRole("dialog", { name: "Sparkle" });
  expect(within(dialog).getByText(/Lead Check holds this lead/)).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Move it to Facebook" }));
  expect(await within(dialog).findByText("Fixed.")).toBeVisible();
  expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
    website: "",
    facebook: "https://fb.com/sp",
  });
});

test("a fix file: download, upload, see what changes, then save (step 28)", async () => {
  let posts = 0;
  const result = {
    saved: false,
    rows: 2,
    changed: [
      {
        tab: "Tulsa",
        line: 3,
        lead_id: "L-000002",
        business_name: "Sparkle",
        city: "Tulsa",
        changes: [{ field: "Address", from: "9 Elm St (918) 555-0300", to: "9 Elm St, Tulsa" }],
        errors: 0,
        warnings: 0,
      },
    ],
    unchanged: 1,
    skipped: [{ tab: "Tulsa", line: 9, lead_id: "L-999999", reason: "Not a lead of Batch 1." }],
    refused: [],
    errors_before: 1,
    errors_after: 0,
    warnings_after: 0,
    held_files_after: 0,
  };
  mockApi({
    "GET /auth/me": as("admin"),
    "GET /leads?batch_id=b1": [200, leadPage([lead("L-000001")])],
    "POST /batches/b1/fixes": () => {
      posts += 1;
      return [200, { ...result, saved: posts > 1 }];
    },
  });
  render(
    <AuthProvider>
      <BatchLeads batchId="b1" />
    </AuthProvider>,
  );

  expect(await screen.findByRole("link", { name: /^Download problems to fix/ })).toHaveAttribute(
    "href",
    "/api/batches/b1/fixes.xlsx",
  );
  await userEvent.click(screen.getByRole("button", { name: "Upload fixes" }));
  const dialog = screen.getByRole("dialog", { name: "Upload fixes" });
  await userEvent.upload(
    within(dialog).getByLabelText("Fix file (.xlsx)"),
    new File(["xlsx"], "fixed.xlsx"),
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Check the file" }));

  const changes = await within(dialog).findByRole("region", { name: "What changes" });
  expect(changes).toHaveTextContent("If you save: 1 leads change");
  expect(changes).toHaveTextContent("Errors 🔴 1 → 0");
  expect(changes).toHaveTextContent("Address: 9 Elm St (918) 555-0300 → 9 Elm St, Tulsa");
  expect(changes).toHaveTextContent("L-999999");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save 1 changes" }));

  expect(await within(dialog).findByText(/Saved:/)).toBeVisible();
  expect(posts).toBe(2);
});
