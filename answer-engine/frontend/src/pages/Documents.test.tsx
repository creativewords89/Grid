import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { StoredFile, UploadResult } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

function makeFile(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    id: "f1",
    name: "Pricing.pdf",
    type: "PDF",
    mime: "application/pdf",
    size: 2048,
    status: "ready",
    error: null,
    warning: null,
    page_count: 3,
    sheet_count: null,
    chunk_count: 0,
    version: 1,
    previous_file_id: null,
    uploaded_by: { id: "u1", name: "Sara" },
    created_at: "2026-10-08T10:00:00Z",
    can_delete: true,
    ...overrides,
  };
}

const listing = (files: StoredFile[]) => ({
  files,
  totals: { files: files.length, pages: 3, ocr_pages_this_month: 0 },
});

/** Uploads go through XMLHttpRequest (for progress); answer them from `respond`. */
function fakeUploads(respond: (fileName: string) => [number, unknown]) {
  const sent: string[] = [];
  class FakeXHR {
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    headers: Record<string, string> = {};
    open() {}
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(form: FormData) {
      const file = form.get("files") as File;
      sent.push(file.name);
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
        const [status, body] = respond(file.name);
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return sent;
}

const me = (role: "owner" | "user") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];

beforeEach(() => window.history.pushState(null, "", "/documents"));
afterEach(() => vi.unstubAllGlobals());

test("lists documents with their status and only the actions allowed", async () => {
  mockApi({
    "GET /auth/me": me("user"),
    "GET /files": [
      200,
      listing([
        makeFile(),
        makeFile({
          id: "f2",
          name: "Scan.png",
          type: "Image",
          mime: "image/png",
          status: "failed",
          error: "The uploaded file is missing from storage.",
          can_delete: false,
          version: 2,
        }),
      ]),
    ],
  });

  render(<App />);

  const rows = (await screen.findAllByRole("row")).slice(1);
  expect(within(rows[0]!).getByText("Ready")).toBeVisible();
  expect(within(rows[0]!).getByRole("button", { name: "Delete" })).toBeVisible();
  expect(within(rows[0]!).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  expect(within(rows[0]!).getByRole("link", { name: "Open" })).toHaveAttribute(
    "href",
    "/api/files/f1/download?inline=true",
  );
  expect(within(rows[1]!).getByText("Failed")).toBeVisible();
  expect(within(rows[1]!).getByText("The uploaded file is missing from storage.")).toBeVisible();
  expect(within(rows[1]!).getByRole("button", { name: "Retry" })).toBeVisible();
  expect(within(rows[1]!).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  expect(within(rows[1]!).getByText("v2")).toBeVisible();
  expect(screen.getByText(/2 files · 3 pages/)).toBeVisible();
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
});

test("workbooks show their sheets instead of pages", async () => {
  mockApi({
    "GET /auth/me": me("user"),
    "GET /files": [
      200,
      listing([makeFile({ name: "Fees.xlsx", type: "Excel", page_count: null, sheet_count: 2 })]),
    ],
  });

  render(<App />);

  const row = (await screen.findAllByRole("row"))[1]!;
  expect(within(row).getByText("2 sheets")).toBeVisible();
});

test("a file that was only partly read says why", async () => {
  mockApi({
    "GET /auth/me": me("user"),
    "GET /files": [
      200,
      listing([
        makeFile({
          warning:
            "2 pages look scanned and will be read once scanned-page reading is switched on.",
        }),
      ]),
    ],
  });

  render(<App />);

  expect(await screen.findByText(/2 pages look scanned/)).toBeVisible();
});

test("each uploaded file gets its own result", async () => {
  mockApi({ "GET /auth/me": me("user"), "GET /files": [200, listing([])] });
  const sent = fakeUploads((name): [number, unknown] => {
    const result: UploadResult =
      name === "notes.txt"
        ? {
            name,
            file: null,
            error: { code: "unsupported", message: "This file type isn't supported." },
          }
        : { name, file: makeFile({ name, status: "queued" }), error: null };
    return [200, { results: [result] }];
  });
  render(<App />);
  await screen.findByText("No documents yet. Upload some above.");

  await userEvent.upload(
    screen.getByTestId("upload-input"),
    [new File(["%PDF-"], "Pricing.pdf"), new File(["hi"], "notes.txt")],
    { applyAccept: false },
  );

  const uploads = screen.getByLabelText("Uploads");
  expect(await within(uploads).findByText("✔ Added")).toBeVisible();
  expect(await within(uploads).findByText("✘ This file type isn't supported.")).toBeVisible();
  expect(sent).toEqual(["Pricing.pdf", "notes.txt"]);
});

test("deleting asks first, then moves the file to the trash", async () => {
  const calls = mockApi({
    "GET /auth/me": me("user"),
    "GET /files": [200, listing([makeFile()])],
    "DELETE /files/f1": [204],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog", { name: "Delete this file?" });
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

  expect(await screen.findByText("Pricing.pdf was moved to the trash.")).toBeVisible();
  expect(calls.find((c) => c.method === "DELETE")?.csrf).toBe("t");
});

test("search and type filters are sent to the server", async () => {
  const calls = mockApi({
    "GET /auth/me": me("user"),
    "GET /files": [200, listing([])],
    "GET /files?type=excel": [200, listing([])],
    "GET /files?q=fees&type=excel": [200, listing([])],
  });
  render(<App />);
  await screen.findByText("No documents yet. Upload some above.");

  await userEvent.selectOptions(screen.getByLabelText("Type"), "excel");
  await userEvent.type(screen.getByLabelText("Search documents"), "fees");

  await waitFor(() => expect(calls.at(-1)?.path).toBe("/files?q=fees&type=excel"));
  expect(await screen.findByText("No documents match.")).toBeVisible();
});

test("the owner restores from the trash", async () => {
  const calls = mockApi({
    "GET /auth/me": me("owner"),
    "GET /files": [200, listing([])],
    "GET /trash": [
      200,
      [
        {
          id: "t1",
          kind: "file",
          ref_id: "f1",
          title: "Old pricing.pdf",
          deleted_by: "Sara",
          deleted_at: "2026-10-08T10:00:00Z",
          purge_at: "2026-11-07T10:00:00Z",
          reason: "replaced",
        },
      ],
    ],
    "POST /trash/t1/restore": [204],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("tab", { name: "Trash" }));
  expect(await screen.findByText("File · replaced by a new version")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));

  expect(await screen.findByText("Old pricing.pdf was restored.")).toBeVisible();
  expect(calls.some((c) => c.path === "/trash/t1/restore")).toBe(true);
});
