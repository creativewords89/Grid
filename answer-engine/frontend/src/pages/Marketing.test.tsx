import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import type { ThreadDetail, ThreadMessage, ThreadRow } from "../api";
import { App } from "../App";
import { makeUser, mockApi } from "../test/mockApi";

const me = [200, { user: makeUser(), csrf_token: "t" }] as [number, unknown];
const URL = "https://www.reddit.com/r/localseo/comments/1abc2de/how_long/";
const row: ThreadRow = {
  id: "reddit:1abc2de",
  platform: "reddit",
  platform_name: "Reddit",
  community: "r/localseo",
  title: "How long does GBP verification take?",
  original_url: URL,
  person: "u/dentist_dan",
  status: "ready_to_post",
  created_by: { id: "u1", name: "Sara" },
  posted_by: [],
  last_activity_at: new Date().toISOString(),
  created_at: "2026-10-20T10:00:00Z",
};
const question: ThreadMessage = {
  id: "m1",
  parent_id: null,
  author: "them",
  author_name: "u/dentist_dan",
  body: "How long does GBP verification take?",
  external_url: URL,
  state: null,
  posted_by: null,
  posted_at: null,
  created_by: { id: "u1", name: "Sara" },
  created_at: "2026-10-20T10:00:00Z",
  draft: null,
};
const draftMsg = (state: "ready" | "in_review" | "posted"): ThreadMessage => ({
  ...question,
  id: "m2",
  parent_id: "m1",
  author: "us",
  author_name: null,
  body: "Usually 1-2 weeks.",
  external_url: null,
  state,
  posted_by: state === "posted" ? { id: "u1", name: "Sara" } : null,
  posted_at: state === "posted" ? "2026-10-20T11:00:00Z" : null,
  created_at: "2026-10-20T10:01:00Z",
  draft: {
    answer_id: "a1",
    confidence: state === "in_review" ? 55 : 90,
    outcome: state === "in_review" ? "low" : "high",
    status: state === "in_review" ? "in_review" : "auto",
    sources: [],
    needs_info: null,
    corrected_after_post: null,
  },
});
const detail = (messages: ThreadMessage[], over: Partial<ThreadDetail> = {}): ThreadDetail => ({
  ...row,
  closed_at: null,
  close_reason: null,
  messages,
  can_close: true,
  can_delete: false,
  ...over,
});
const counts = {
  waiting_for_us: 2,
  in_review: 0,
  ready_to_post: 1,
  waiting_for_them: 0,
  closed: 0,
};

beforeEach(() => window.history.pushState(null, "", "/marketing"));
afterEach(() => vi.unstubAllGlobals());

test("the list has tabs with counts and links to the post", async () => {
  mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "GET /threads?status=ready_to_post": [200, { items: [row], counts }],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("tab", { name: "Ready to post (1)" }));

  expect(await screen.findByText(row.title)).toBeVisible();
  expect(screen.getByRole("tab", { name: "Waiting for us (2)" })).toBeVisible();
  const link = screen.getByRole("link", { name: "Open on Reddit" });
  expect(link).toHaveAttribute("href", URL);
  expect(link).toHaveAttribute("target", "_blank");
});

test("a new URL: paste the question, and it drafts straight away", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "POST /threads/resolve": [
      200,
      {
        found: false,
        parsed: {
          platform: "reddit",
          platform_name: "Reddit",
          thread_id: row.id,
          community: "r/localseo",
          comment_id: null,
        },
        thread: null,
        matched_message_id: null,
        reopened: false,
        error: null,
      },
    ],
    "POST /threads": [201, detail([question], { status: "waiting_for_us" })],
    "POST /threads/reddit%3A1abc2de/draft": [200, detail([question, draftMsg("ready")])],
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("ready")])],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Paste a Reddit link or the post's code"), URL);
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(await screen.findByText(/New thread/)).toBeVisible();
  await userEvent.type(screen.getByLabelText("Their question"), question.body);
  await userEvent.type(screen.getByLabelText("Their username (optional)"), "u/dentist_dan");
  await userEvent.click(screen.getByRole("button", { name: "Draft reply" }));

  expect(await screen.findByText("Usually 1-2 weeks.")).toBeVisible();
  expect(window.location.search).toBe("?thread=reddit%3A1abc2de");
  expect(calls.find((c) => c.method === "POST" && c.path === "/threads")?.body).toEqual({
    url: URL,
    question: question.body,
    author_name: "u/dentist_dan",
  });
  expect(calls.find((c) => c.path.endsWith("/draft"))?.body).toEqual({ parent_id: "m1" });
});

test("a URL someone else started opens their thread and says so", async () => {
  mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "POST /threads/resolve": [
      200,
      {
        found: true,
        parsed: null,
        thread: { ...row, created_by: { id: "u9", name: "Ali" } },
        matched_message_id: null,
        reopened: false,
        error: null,
      },
    ],
    "GET /threads/reddit%3A1abc2de": [200, detail([question])],
  });
  render(<App />);

  await userEvent.type(await screen.findByLabelText("Paste a Reddit link or the post's code"), URL);
  await userEvent.click(screen.getByRole("button", { name: "Go" }));

  expect(await screen.findByText(/Ali started this thread on/)).toBeVisible();
});

test("a share link explains what to paste instead", async () => {
  mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "POST /threads/resolve": [
      200,
      {
        found: false,
        parsed: null,
        thread: null,
        matched_message_id: null,
        reopened: false,
        error: "This is a share link. Open it and copy the full address from the browser bar.",
      },
    ],
  });
  render(<App />);

  await userEvent.type(
    await screen.findByLabelText("Paste a Reddit link or the post's code"),
    "https://www.reddit.com/r/x/s/abc",
  );
  await userEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(await screen.findByText(/This is a share link/)).toBeVisible();
});

test("a draft being checked can't be copied", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  mockApi({
    "GET /auth/me": me,
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("in_review")])],
  });
  render(<App />);

  const copy = await screen.findByRole("button", { name: "Waiting for review – don't post yet" });
  expect(copy).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Mark as posted" })).toBeNull();
});

test("mark as posted, then add their reply under ours", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  const posted = draftMsg("posted");
  const calls = mockApi({
    "GET /auth/me": me,
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("ready")])],
    "POST /thread-messages/m2/posted": [
      200,
      detail([question, posted], { status: "waiting_for_them" }),
    ],
    "POST /threads/reddit%3A1abc2de/replies": [
      200,
      detail([question, posted, { ...question, id: "m3", parent_id: "m2", body: "And video?" }]),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("button", { name: "Mark as posted" }));
  await userEvent.type(
    screen.getByLabelText("Link to our posted comment (optional)"),
    `${URL}kx9z0p1/`,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save as posted" }));
  expect(await screen.findByText(/Posted by Sara/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "+ Add their reply" }));
  expect(screen.getByLabelText("Replying to")).toHaveValue("m2"); // our latest posted reply
  await userEvent.type(screen.getByLabelText("Their reply"), "And video?");
  await userEvent.click(screen.getByRole("button", { name: "Add reply" }));

  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith("/replies"))?.body).toEqual({
      body: "And video?",
      parent_id: "m2",
    }),
  );
  expect(calls.find((c) => c.path === "/thread-messages/m2/posted")?.body).toEqual({
    url: `${URL}kx9z0p1/`,
  });
  const tree = document.querySelector(".thread-tree") as HTMLElement;
  expect(within(tree).getByText("And video?")).toBeVisible();
});

test("a reply corrected after posting offers the new text", async () => {
  window.history.pushState(null, "", "/marketing?thread=reddit%3A1abc2de");
  const posted = draftMsg("posted");
  mockApi({
    "GET /auth/me": me,
    "GET /threads/reddit%3A1abc2de": [
      200,
      detail([
        question,
        { ...posted, draft: { ...posted.draft!, corrected_after_post: "2-3 weeks now." } },
      ]),
    ],
  });
  render(<App />);

  expect(await screen.findByText(/corrected after posting/)).toBeVisible();
  expect(screen.getByText("2-3 weeks now.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Copy the corrected reply" })).toBeVisible();
});

const fbRow: ThreadRow = {
  ...row,
  id: "facebook:0193abc",
  platform: "facebook",
  platform_name: "Facebook",
  community: null,
  title: "Can I use a PO box for my GBP?",
  original_url: "",
  person: "Dan Miller",
  status: "waiting_for_them",
};

test("Facebook: find their conversations by name and pick the closest", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "GET /threads/by-name?name=Dan+Miller&text=Is+a+virtual+office+ok%3F": [
      200,
      [
        {
          thread: { ...fbRow, id: "facebook:new", title: "How long does verification take?" },
          first_question: "How long does verification take?",
          our_last_reply: null,
          closest: false,
        },
        {
          thread: fbRow,
          first_question: "Can I use a PO box for my GBP?",
          our_last_reply: "No, Google needs a real address.",
          closest: true,
        },
      ],
    ],
    "GET /threads/facebook%3A0193abc": [
      200,
      detail([{ ...question, body: "Can I use a PO box for my GBP?", author_name: "Dan Miller" }], {
        ...fbRow,
      }),
    ],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("tab", { name: "Facebook" }));
  await userEvent.type(screen.getByLabelText("Their name on Facebook"), "Dan Miller");
  await userEvent.type(screen.getByLabelText(/Their new message/), "Is a virtual office ok?");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));

  const closest = (await screen.findByText("Closest match")).closest("li") as HTMLElement;
  expect(within(closest).getByText("Can I use a PO box for my GBP?")).toBeVisible();
  expect(within(closest).getByText("No, Google needs a real address.")).toBeVisible();
  await userEvent.click(within(closest).getByRole("button", { name: "This one" }));

  // The thread opens with their new message ready to add, under their name.
  expect(await screen.findByLabelText("Their reply")).toHaveValue("Is a virtual office ok?");
  expect(screen.getByLabelText("Their name (optional)")).toHaveValue("Dan Miller");
  expect(screen.queryByLabelText("Link to their comment (optional)")).toBeNull();
  expect(screen.queryByRole("link", { name: /Open on/ })).toBeNull();
  expect(calls.some((c) => c.path.startsWith("/threads/by-name"))).toBe(true);
});

test("Facebook: nobody found, start a new conversation and draft", async () => {
  const calls = mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "GET /threads/by-name?name=Anonymous+member": [200, []],
    "POST /threads": [201, detail([question], { ...fbRow, person: "Anonymous member" })],
    "POST /threads/facebook%3A0193abc/draft": [200, detail([question, draftMsg("ready")], fbRow)],
    "GET /threads/facebook%3A0193abc": [200, detail([question, draftMsg("ready")], fbRow)],
  });
  render(<App />);

  await userEvent.click(await screen.findByRole("tab", { name: "Facebook" }));
  await userEvent.type(screen.getByLabelText("Their name on Facebook"), "Anonymous member");
  await userEvent.click(screen.getByRole("button", { name: "Find" }));
  expect(await screen.findByText("No earlier conversations with Anonymous member.")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "+ New conversation with Anonymous member" }),
  );
  await userEvent.type(screen.getByLabelText("Their question"), "My listing got suspended?");
  await userEvent.click(screen.getByRole("button", { name: "Draft reply" }));

  expect(await screen.findByText("Usually 1-2 weeks.")).toBeVisible();
  expect(calls.find((c) => c.method === "POST" && c.path === "/threads")?.body).toEqual({
    platform: "facebook",
    author_name: "Anonymous member",
    question: "My listing got suspended?",
  });
});

test("Reddit: a known post's code opens it ready for their reply", async () => {
  mockApi({
    "GET /auth/me": me,
    "GET /threads?status=waiting_for_us": [200, { items: [], counts }],
    "POST /threads/resolve": [
      200,
      {
        found: true,
        parsed: null,
        thread: row,
        matched_message_id: null,
        reopened: false,
        error: null,
      },
    ],
    "GET /threads/reddit%3A1abc2de": [200, detail([question, draftMsg("posted")])],
  });
  render(<App />);

  await userEvent.type(
    await screen.findByLabelText("Paste a Reddit link or the post's code"),
    "1abc2de",
  );
  await userEvent.click(screen.getByRole("button", { name: "Go" }));

  expect(await screen.findByLabelText("Their reply")).toHaveValue("");
  expect(screen.getByLabelText("Replying to")).toHaveValue("m2"); // our posted reply
});
