import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { Source } from "../api";
import { App } from "../App";
import { makeUser, mockApi, sse } from "../test/mockApi";

const signedIn = [200, { user: makeUser(), csrf_token: "tok" }] as [number, unknown];
const chat = { id: "c1", title: "Pro plan price", last_message_at: "2026-10-08T10:00:00Z" };
const source: Source = {
  n: 1,
  kind: "doc",
  ref_id: "doc_f1_0",
  file_id: "f1",
  file_name: "Pricing.pdf",
  label: "Pricing.pdf · p.2",
  page: 2,
  sheet: null,
  score: 0.91,
};

beforeEach(() => window.history.pushState(null, "", "/"));
afterEach(() => vi.unstubAllGlobals());

test("an empty Ask screen invites a question", async () => {
  mockApi({ "GET /auth/me": signedIn, "GET /conversations": [200, []] });

  render(<App />);

  expect(await screen.findByText("Ask anything about GridRankers' documents.")).toBeVisible();
  expect(screen.getByText("No chats yet.")).toBeVisible();
});

test("asking streams the answer and shows its sources", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": () =>
      sse(
        ["delta", { text: "The **Pro** plan costs " }],
        ["delta", { text: "$900 a month [1]." }],
        ["sources", { sources: [source] }],
        ["done", { answer_id: "a1", outcome: null, stop_reason: "end_turn" }],
      ),
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "What does Pro cost?{Enter}");

  const answer = await screen.findByText(/a month \[1\]\./);
  expect(answer.closest(".markdown")?.querySelector("strong")?.textContent).toBe("Pro");
  const chip = await screen.findByRole("link", { name: /Pricing\.pdf · p\.2/ });
  expect(chip).toHaveAttribute("href", "/api/files/f1/download?inline=true#page=2");
  expect(chip).toHaveAttribute("target", "_blank");
  expect(screen.getByText("What does Pro cost?")).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
  const asked = calls.find((c) => c.path === "/conversations/c1/ask");
  expect(asked?.body).toEqual({ question: "What does Pro cost?" });
  expect(asked?.csrf).toBe("tok");
  expect(window.location.search).toBe("?c=c1");
});

test("a replaced answer shows the final text", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": () =>
      sse(
        ["delta", { text: "Draft words" }],
        ["replace", { text: "I can't answer this question. Please ask the team directly." }],
        ["sources", { sources: [] }],
        ["done", { answer_id: "a1", outcome: null, stop_reason: "refusal" }],
      ),
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "Something?{Enter}");

  expect(await screen.findByText(/I can't answer this question/)).toBeVisible();
  expect(screen.queryByText("Draft words")).not.toBeInTheDocument();
});

test("a failed answer offers to try again", async () => {
  let attempts = 0;
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, [chat]],
    "GET /conversations/c1": [200, { ...chat, messages: [] }],
    "POST /conversations/c1/ask": () => {
      attempts += 1;
      return attempts === 1
        ? sse(["error", { message: "The answer service is busy, please try again." }])
        : sse(
            ["delta", { text: "Second time lucky." }],
            ["sources", { sources: [] }],
            ["done", { answer_id: "a2", outcome: null, stop_reason: "end_turn" }],
          );
    },
  });
  window.history.pushState(null, "", "/?c=c1");
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "Price?{Enter}");
  expect(await screen.findByText("The answer service is busy, please try again.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByText("Second time lucky.")).toBeVisible();
  expect(screen.getAllByText("Price?")).toHaveLength(1);
});

test("answers never render HTML from documents", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, [chat]],
    "GET /conversations/c1": [
      200,
      {
        ...chat,
        messages: [
          { id: "m1", role: "user", body: "Hi?", created_at: "", answer: null },
          {
            id: "m2",
            role: "assistant",
            body: 'Safe text <img src=x onerror="alert(1)"><script>alert(2)</script> [link](javascript:alert(3))',
            created_at: "",
            answer: {
              id: "a1",
              sources: [],
              outcome: null,
              status: "auto",
              stop_reason: "end_turn",
              corrected: false,
            },
          },
        ],
      },
    ],
  });
  window.history.pushState(null, "", "/?c=c1");
  const { container } = render(<App />);

  await screen.findByText(/Safe text/);

  expect(container.querySelector("img, script")).toBeNull();
  const link = screen.getByText("link").closest("a");
  expect(link).not.toBeNull();
  expect(link?.getAttribute("href") ?? "").not.toContain("javascript");
});

test("opening a chat loads its messages; deleting asks first", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, [chat]],
    "GET /conversations/c1": [
      200,
      {
        ...chat,
        messages: [
          { id: "m1", role: "user", body: "What does Pro cost?", created_at: "", answer: null },
          {
            id: "m2",
            role: "assistant",
            body: "$900 a month [1].",
            created_at: "",
            answer: {
              id: "a1",
              sources: [source],
              outcome: null,
              status: "auto",
              stop_reason: "end_turn",
              corrected: false,
            },
          },
        ],
      },
    ],
    "DELETE /conversations/c1": [204],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Pro plan price" }));
  expect(await screen.findByText("$900 a month [1].")).toBeVisible();
  expect(within(screen.getByLabelText("Sources")).getByText(/Pricing\.pdf/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Delete Pro plan price" }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

  expect(calls.some((c) => c.method === "DELETE" && c.path === "/conversations/c1")).toBe(true);
  expect(await screen.findByText("Ask anything about GridRankers' documents.")).toBeVisible();
});

test("the setup message shows when answering isn't configured", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": [
      503,
      {
        error: {
          code: "not_configured",
          message:
            "Answering isn't set up yet: the Owner needs to add the Claude and Pinecone API keys.",
        },
      },
    ],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "Hello?{Enter}");

  expect(await screen.findByText(/Answering isn't set up yet/)).toBeVisible();
});

test("a low-confidence answer says the team is checking it", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": () =>
      sse(
        ["delta", { text: "It takes 3–5 days [1]." }],
        ["sources", { sources: [source] }],
        ["confidence", { confidence: 62, outcome: "low", status: "in_review" }],
        ["done", { answer_id: "a1", outcome: "low", stop_reason: "end_turn" }],
      ),
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "How long?{Enter}");

  expect(await screen.findByText("🟠 Being checked by our team")).toBeVisible();
});

test("a high-confidence answer looks normal", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": () =>
      sse(
        ["delta", { text: "Pro costs $900 [1]." }],
        ["sources", { sources: [source] }],
        ["confidence", { confidence: 92, outcome: "high", status: "auto" }],
        ["done", { answer_id: "a1", outcome: "high", stop_reason: "end_turn" }],
      ),
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "Pro price?{Enter}");

  await screen.findByRole("button", { name: "Copy" });
  expect(screen.queryByText(/Being checked/)).toBeNull();
  expect(screen.queryByText(/92/)).toBeNull();
});

test("thumbs down asks what was wrong and sends the note", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, [chat]],
    "GET /conversations/c1": [
      200,
      {
        ...chat,
        messages: [
          { id: "m1", role: "user", body: "Pro price?", created_at: "", answer: null },
          {
            id: "m2",
            role: "assistant",
            body: "Pro costs $900 [1].",
            created_at: "",
            answer: {
              id: "a1",
              sources: [source],
              outcome: "high",
              status: "auto",
              stop_reason: "end_turn",
              corrected: false,
              confidence: 90,
              feedback: null,
            },
          },
        ],
      },
    ],
    "POST /answers/a1/feedback": (body) => [
      200,
      { feedback: (body as { value: string }).value, flagged: true },
    ],
  });
  window.history.pushState(null, "", "/?c=c1");
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Not helpful" }));
  await userEvent.type(await screen.findByLabelText("What was wrong? (optional)"), "Old price");
  await userEvent.click(screen.getByRole("button", { name: "Send" }));

  const sent = calls.filter((c) => c.path === "/answers/a1/feedback").map((c) => c.body);
  expect(sent).toEqual([{ value: "down" }, { value: "down", note: "Old price" }]);
  expect(screen.getByRole("button", { name: "Not helpful" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByLabelText("What was wrong? (optional)")).toBeNull();
});

test("a reviewer's question appears with a reply box", async () => {
  const calls = mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, [chat]],
    "GET /conversations/c1": [
      200,
      {
        ...chat,
        messages: [
          { id: "m1", role: "user", body: "Pro price?", created_at: "", answer: null },
          {
            id: "m2",
            role: "assistant",
            body: "Pro costs $900 [1].",
            created_at: "",
            answer: {
              id: "a1",
              sources: [source],
              outcome: "low",
              status: "needs_info",
              stop_reason: "end_turn",
              corrected: false,
              confidence: 55,
              feedback: null,
              needs_info: { question: "Which client is this for?", asked_by: "Ali" },
            },
          },
        ],
      },
    ],
    "POST /answers/a1/needs-info-reply": [200, { status: "in_review" }],
  });
  window.history.pushState(null, "", "/?c=c1");
  render(<App />);

  expect(await screen.findByText("Which client is this for?")).toBeVisible();
  expect(screen.getByText("🟠 Our team needs more information")).toBeVisible();
  await userEvent.type(screen.getByPlaceholderText("Your reply"), "A dentist in Leeds");
  await userEvent.click(screen.getByRole("button", { name: "Send reply" }));

  expect(await screen.findByText("🟠 Being checked by our team")).toBeVisible();
  expect(screen.queryByText("Which client is this for?")).toBeNull();
  const sent = calls.find((c) => c.path === "/answers/a1/needs-info-reply");
  expect(sent?.body).toEqual({ text: "A dentist in Leeds" });
});

test("a question with no answer says the team will answer it", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": () =>
      sse(
        ["delta", { text: "I couldn't find this in the knowledge base." }],
        ["sources", { sources: [] }],
        ["done", { answer_id: "a1", outcome: "no_answer", status: "in_review", stop_reason: null }],
      ),
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "Office dog?{Enter}");

  expect(
    await screen.findByText("🟠 Sent to our team. We'll notify you when there's an answer."),
  ).toBeVisible();
});

test("a corrected answer shows the date, hides old sources and keeps the original", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, [{ ...chat, updated: true }]],
    "GET /conversations/c1": [
      200,
      {
        ...chat,
        updated_answer_ids: ["a1"],
        messages: [
          { id: "m1", role: "user", body: "Pro price?", created_at: "", answer: null },
          {
            id: "m2",
            role: "assistant",
            body: "Pro is $950 a month.",
            created_at: "",
            answer: {
              id: "a1",
              sources: [source],
              outcome: "low",
              status: "corrected",
              stop_reason: "end_turn",
              corrected: true,
              confidence: 55,
              feedback: null,
              original_text: "Pro costs $900 [1].",
              reviewed_at: "2026-10-09T10:00:00Z",
            },
          },
          { id: "m3", role: "user", body: "And setup?", created_at: "", answer: null },
          {
            id: "m4",
            role: "assistant",
            body: "Setup is free.",
            created_at: "",
            answer: {
              id: "a2",
              sources: [],
              outcome: "high",
              status: "auto",
              stop_reason: "end_turn",
              corrected: false,
              confidence: 90,
              feedback: null,
            },
          },
        ],
      },
    ],
  });
  render(<App />);

  expect(await screen.findByLabelText("An answer was updated")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /^Pro plan price/ }));

  expect(await screen.findByText(/✔ Corrected by our team · /)).toBeVisible();
  // The only chips are the original's, inside "Show original".
  const lists = screen.queryAllByRole("list", { name: "Sources" });
  expect(lists.map((l) => l.closest("details.original") !== null)).toEqual([true]);
  await userEvent.click(screen.getByText("Show original"));
  expect(screen.getByText(/Pro costs \$900/)).toBeVisible();
  expect(screen.getByText(/An answer above was corrected/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Jump to it" })).toBeVisible();
  expect(screen.queryByLabelText("An answer was updated")).toBeNull();
});

test("a verified source links to the verified answer", async () => {
  mockApi({
    "GET /auth/me": signedIn,
    "GET /conversations": [200, []],
    "POST /conversations": [201, chat],
    "POST /conversations/c1/ask": () =>
      sse(
        ["delta", { text: "Pro is $900 [1]." }],
        [
          "sources",
          {
            sources: [
              {
                ...source,
                kind: "verified",
                ref_id: "va_v1",
                file_id: "",
                file_name: "",
                label: "✔ Verified answer",
                page: null,
              },
            ],
          },
        ],
        ["done", { answer_id: "a1", outcome: "high", status: "auto", stop_reason: "end_turn" }],
      ),
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Your question"), "Pro?{Enter}");

  const chip = await screen.findByRole("link", { name: /Verified answer/ });
  expect(chip).toHaveAttribute("href", "/verified?id=v1");
});
