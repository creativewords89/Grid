import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Voice, VoiceExample, VoicePlatform } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const me = (role: "owner" | "user") =>
  [200, { user: makeUser({ role }), csrf_token: "t" }] as [number, unknown];
const files = [200, { files: [], totals: { files: 0, pages: 0, ocr_pages_this_month: 0 } }] as [
  number,
  unknown,
];
const platforms: VoicePlatform[] = [
  { slug: "facebook", name: "Facebook", enabled: true, examples: 2, suggested: 1 },
  { slug: "reddit", name: "Reddit", enabled: true, examples: 0, suggested: 0 },
];

function voice(over: Partial<Voice> = {}): Voice {
  return {
    slug: "facebook",
    name: "Facebook",
    file: {
      name: "Facebook examples.xlsx",
      uploaded_at: "2026-10-28T10:00:00Z",
      uploaded_by: { id: "u1", name: "Olivia" },
    },
    from_file: 2,
    from_posted: 0,
    suggested: 1,
    guide: "- 2-4 short sentences.\n- Friendly.",
    guide_edited: false,
    guide_at: "2026-10-28T10:01:00Z",
    rules: {
      max_words: 80,
      emojis: "one",
      links: "when_asked",
      banned: ["game-changer"],
      disclosure_line: "(I work at GridRankers.)",
    },
    can_manage: true,
    ...over,
  };
}

function example(over: Partial<VoiceExample> = {}): VoiceExample {
  return {
    id: "e1",
    question: "Can I use a PO box for my GBP?",
    answer: "Sadly no, Google wants a real address.",
    community: "localbiz",
    notes: null,
    source: "file",
    state: "active",
    enabled: true,
    starred: false,
    corrected: false,
    used_count: 12,
    created_by: { id: "u1", name: "Olivia" },
    created_at: "2026-10-28T10:00:00Z",
    ...over,
  };
}

const list = (items: VoiceExample[]) => [200, { items, total: items.length }] as [number, unknown];

/** Uploads go through XMLHttpRequest (for progress). */
function fakeUpload(body: unknown) {
  const sent: string[] = [];
  class FakeXHR {
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string) {
      sent.push(url);
    }
    setRequestHeader() {}
    send() {
      setTimeout(() => {
        this.status = 200;
        this.responseText = JSON.stringify(body);
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  return sent;
}

beforeEach(() => {
  window.history.pushState(null, "", "/documents");
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

async function openBrandVoice() {
  render(<App />);
  await userEvent.click(await screen.findByRole("tab", { name: "Brand voice" }));
}

test("the Owner sees the examples and uploads a new version", async () => {
  const sent = fakeUpload({
    added: 64,
    skipped: 2,
    duplicates: 1,
    voice: voice({
      from_file: 64,
      file: { name: "v2.xlsx", uploaded_at: null, uploaded_by: null },
    }),
  });
  mockApi({
    "GET /auth/me": me("owner"),
    "GET /files": files,
    "GET /voice": [200, platforms],
    "GET /voice/facebook": [200, voice()],
    "GET /voice/facebook/examples?state=active&offset=0&limit=50": list([
      example(),
      example({ id: "e2", question: "Do reviews help?", source: "posted", used_count: 4 }),
    ]),
  });
  await openBrandVoice();

  expect(await screen.findByText("Facebook examples.xlsx")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Facebook" })).toHaveAttribute("aria-selected", "true");
  // Clicking the tab that's already selected keeps the page.
  await userEvent.click(screen.getByRole("tab", { name: "Facebook" }));
  expect(screen.getByText("Facebook examples.xlsx")).toBeVisible();
  expect(await screen.findByText("Can I use a PO box for my GBP?")).toBeVisible();
  expect(screen.getByText("Posted reply")).toBeVisible();
  expect(screen.getByRole("button", { name: /To approve/ })).toHaveTextContent("1");

  const input = document.getElementById("bv-upload") as HTMLInputElement;
  await userEvent.upload(input, new File(["question,answer"], "v2.xlsx"));

  expect(
    await screen.findByText(/Added 64 examples\. Skipped 2 rows without a question/),
  ).toBeVisible();
  expect(sent).toEqual(["/api/voice/facebook/file"]);
  expect(await screen.findByText("v2.xlsx")).toBeVisible();
});

test("people other than the Owner see it but can't change it", async () => {
  mockApi({
    "GET /auth/me": me("user"),
    "GET /files": files,
    "GET /voice": [200, platforms],
    "GET /voice/facebook": [200, voice({ can_manage: false })],
    "GET /voice/facebook/examples?state=active&offset=0&limit=50": list([example()]),
  });
  await openBrandVoice();

  expect(await screen.findByText("Can I use a PO box for my GBP?")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Upload/ })).toBeNull();
  expect(screen.getByText(/Only the Owner can change Brand voice/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Style guide & rules" }));
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.getByLabelText("Maximum length (words)")).toBeDisabled();
});

test("editing the style guide and saving the writing rules", async () => {
  const calls = mockApi({
    "GET /auth/me": me("owner"),
    "GET /files": files,
    "GET /voice": [200, platforms],
    "GET /voice/facebook": [200, voice()],
    "GET /voice/facebook/examples?state=active&offset=0&limit=50": list([]),
    "PUT /voice/facebook/guide": [200, voice({ guide: "- Keep it short.", guide_edited: true })],
    "PUT /voice/facebook/rules": [200, voice()],
  });
  await openBrandVoice();
  await userEvent.click(await screen.findByRole("button", { name: "Style guide & rules" }));

  expect(screen.getByText(/2-4 short sentences/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const text = screen.getByLabelText("Style guide text");
  await userEvent.clear(text);
  await userEvent.type(text, "- Keep it short.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Style guide saved.")).toBeVisible();
  expect(screen.getByText(/Edited by the Owner/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "None" }));
  await userEvent.click(screen.getByRole("button", { name: "Never" }));
  await userEvent.type(screen.getByLabelText("Add a word or phrase"), "DM me");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove game-changer" }));
  const max = screen.getByLabelText("Maximum length (words)");
  await userEvent.clear(max);
  await userEvent.type(max, "60");
  await userEvent.click(screen.getByRole("button", { name: "Save rules" }));

  await waitFor(() =>
    expect(calls.find((c) => c.method === "PUT" && c.path.endsWith("/rules"))?.body).toEqual({
      max_words: 60,
      emojis: "none",
      links: "never",
      banned: ["DM me"],
      disclosure_line: "(I work at GridRankers.)",
    }),
  );
});

test("Try it shows the test draft, its checks and the examples it copied", async () => {
  const calls = mockApi({
    "GET /auth/me": me("owner"),
    "GET /files": files,
    "GET /voice": [200, platforms],
    "GET /voice/facebook": [200, voice()],
    "GET /voice/facebook/examples?state=active&offset=0&limit=50": list([]),
    "POST /voice/facebook/try": [
      200,
      {
        text: "Honestly you can do most of it yourself.",
        matched: true,
        examples: [{ id: "e1", question: "Do reviews help?", answer: "Steady ones do." }],
        sources: ["Review guide.pdf · p.3"],
        checks: { words: 8, max_words: 80, too_long: false, links: false, emojis: 0, banned: [] },
      },
    ],
  });
  await openBrandVoice();
  await userEvent.click(await screen.findByRole("button", { name: "Try it" }));
  await userEvent.type(screen.getByLabelText("Their question"), "Should I pay for reviews?");
  await userEvent.type(screen.getByLabelText("Group (optional)"), "localbiz");
  await userEvent.click(screen.getByRole("button", { name: "Write a test draft" }));

  expect(await screen.findByText("Honestly you can do most of it yourself.")).toBeVisible();
  const checks = screen.getByRole("list", { name: "Checks" });
  expect(within(checks).getByText("8 words · limit 80")).toBeVisible();
  expect(within(checks).getByText("No banned words")).toBeVisible();
  expect(screen.getByText("Examples it copied the style from")).toBeVisible();
  expect(screen.getByText("Steady ones do.")).toBeVisible();
  expect(screen.getByText(/Review guide\.pdf · p\.3/)).toBeVisible();
  expect(calls.find((c) => c.path === "/voice/facebook/try")?.body).toEqual({
    question: "Should I pay for reviews?",
    community: "localbiz",
  });
});

test("approving a posted reply, with an edit", async () => {
  const suggestion = example({
    id: "s1",
    question: "Can I change my business name?",
    answer: "Yes, to your real name.",
    source: "posted",
    state: "suggested",
    corrected: true,
    created_by: { id: "u2", name: "Sara" },
  });
  const calls = mockApi({
    "GET /auth/me": me("owner"),
    "GET /files": files,
    "GET /voice": [200, platforms],
    "GET /voice/facebook": [200, voice()],
    "GET /voice/facebook/examples?state=active&offset=0&limit=50": list([]),
    "GET /voice/facebook/examples?state=suggested&offset=0&limit=50": list([suggestion]),
    "POST /voice/examples/s1/approve": [200, { ...suggestion, state: "active" }],
  });
  await openBrandVoice();
  await userEvent.click(await screen.findByRole("button", { name: /To approve/ }));

  expect(await screen.findByText("Can I change my business name?")).toBeVisible();
  expect(screen.getByText(/Posted by Sara/)).toBeVisible();
  expect(screen.getByText("Corrected by a reviewer")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Edit, then approve" }));
  const box = screen.getByLabelText("Answer");
  await userEvent.clear(box);
  await userEvent.type(box, "Yes, but only your real name.");
  await userEvent.click(screen.getByRole("button", { name: "Save and approve" }));

  expect(await screen.findByText("Nothing waiting.")).toBeVisible();
  expect(calls.find((c) => c.path === "/voice/examples/s1/approve")?.body).toEqual({
    answer: "Yes, but only your real name.",
  });
});
