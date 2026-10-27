import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Platform,
  type Resolved,
  type ThreadDetail,
  type ThreadList,
  type ThreadMessage,
  type ThreadStatus,
} from "../api";
import { useAuth } from "../auth";
import { Alert, Confirm } from "../components/ui";
import { ago, formatDate } from "../format";
import { THREAD_STATUSES } from "../labels";
import { navigate, useSearch } from "../router";

// Marketing (SPEC sections 6.10 and 7.3), laid out like Chat: conversations on the left;
// on the right, a new conversation (pick the platform, paste the post's code) or one
// conversation with a reply box at the bottom. The engine drafts; a person always posts.

const STATUS_NAME = Object.fromEntries(THREAD_STATUSES) as Record<ThreadStatus, string>;

function openThread(id: string, replyTo?: string | null) {
  const q = new URLSearchParams({ thread: id });
  if (replyTo) q.set("reply_to", replyTo);
  navigate(`/marketing?${q.toString()}`);
}

function startNew(platform: string, code?: string) {
  const q = new URLSearchParams({ new: platform });
  if (code) q.set("code", code);
  navigate(`/marketing?${q.toString()}`);
}

// A one-time note shown at the top of the conversation that was just opened.
let flash = "";
function setFlash(note: string) {
  flash = note;
}
function takeFlash(): string {
  const note = flash;
  flash = "";
  return note;
}

export function Marketing() {
  const query = new URLSearchParams(useSearch());
  const threadId = query.get("thread");
  const platform = query.get("new");
  // Bumped when a conversation changes, so the list on the left shows its new status.
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  let body;
  if (threadId) {
    body = (
      <ThreadView
        key={threadId}
        id={threadId}
        replyTo={query.get("reply_to")}
        onChanged={changed}
      />
    );
  } else if (platform) {
    body = (
      <NewConversation
        key={`${platform}:${query.get("code") ?? ""}`}
        platform={platform}
        code={query.get("code") ?? ""}
        onCreated={changed}
      />
    );
  } else {
    body = <PickPlatform />;
  }

  return (
    <div className={`mk ${threadId || platform ? "has-main" : ""}`}>
      <Conversations current={threadId} version={version} />
      <div className="mk-main">
        {(threadId || platform) && (
          <button className="link-button mk-back" onClick={() => navigate("/marketing")}>
            ← Conversations
          </button>
        )}
        {body}
      </div>
    </div>
  );
}

// --- the list on the left -------------------------------------------------------------------------

function Conversations({ current, version }: { current: string | null; version: number }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<ThreadStatus | "">("");
  const [data, setData] = useState<ThreadList | null>(null);
  const [error, setError] = useState("");
  const [find, setFind] = useState("");
  const [findError, setFindError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .listThreads({ status: status || undefined })
      .then((list) => live && (setData(list), setError("")))
      .catch(
        (err: unknown) => live && setError(err instanceof ApiError ? err.message : "Not loaded."),
      );
    return () => {
      live = false;
    };
  }, [status, version, current]);

  // A code or link pasted here opens its conversation, or starts a new one for it.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = find.trim();
    if (!text) return;
    setBusy(true);
    setFindError("");
    try {
      const found = await api.resolveThread(text);
      if (found.error) setFindError(found.error);
      else if (found.found && found.thread) {
        const by = found.thread.created_by;
        if (by && by.id !== user?.id) {
          setFlash(
            `${by.name} started this conversation on ${formatDate(found.thread.created_at)}.`,
          );
        } else if (found.reopened) setFlash("This conversation was closed; it's open again.");
        setFind("");
        openThread(found.thread.id, found.matched_message_id);
      } else if (found.parsed) {
        setFind("");
        startNew(found.parsed.platform, text);
      }
    } catch (err) {
      setFindError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="mk-side" aria-label="Conversations">
      <button className="button button-primary mk-new" onClick={() => navigate("/marketing")}>
        + New conversation
      </button>
      <form className="mk-find" onSubmit={submit}>
        <label className="sr-only" htmlFor="mk-find">
          Find by post code or link
        </label>
        <input
          id="mk-find"
          className="input"
          placeholder="Find by post code or link"
          value={find}
          disabled={busy}
          onChange={(e) => setFind(e.target.value)}
        />
      </form>
      {findError && <Alert kind="error">{findError}</Alert>}
      <div className="mk-chips" role="group" aria-label="Show">
        <button className="mk-chip" aria-pressed={status === ""} onClick={() => setStatus("")}>
          All
        </button>
        {THREAD_STATUSES.map(([key, label]) => (
          <button
            key={key}
            className="mk-chip"
            aria-pressed={status === key}
            onClick={() => setStatus(key)}
          >
            {label}
            {data && key !== "closed" ? ` · ${data.counts[key] ?? 0}` : ""}
          </button>
        ))}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {data && data.items.length === 0 && <p className="muted small">No conversations here.</p>}
      <ul className="mk-list">
        {data?.items.map((t) => (
          <li key={t.id}>
            <button
              className="mk-item"
              aria-current={t.id === current ? "true" : undefined}
              onClick={() => openThread(t.id)}
            >
              <span className="mk-item-top">
                <span className={`platform-badge platform-${t.platform}`}>{t.platform_name}</span>
                <span className="muted small">{ago(t.last_activity_at)}</span>
              </span>
              <strong className="mk-item-title">{t.title}</strong>
              <span className="mk-item-top">
                <span className="muted small mk-item-who">
                  {[t.person, t.community].filter(Boolean).join(" · ")}
                </span>
                <span className={`pill pill-thread-${t.status}`}>{STATUS_NAME[t.status]}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

// --- a new conversation: the platform, then the post's code ------------------------------------------

function usePlatforms(): Platform[] | null {
  const [platforms, setPlatforms] = useState<Platform[] | null>(null);
  useEffect(() => {
    api
      .platforms()
      .then((all) => setPlatforms(all.filter((p) => p.enabled)))
      .catch(() => setPlatforms([]));
  }, []);
  return platforms;
}

const CODE_HINT: Record<Platform["parser"], string> = {
  reddit: "The code in the post's link, like 1xd8w7u, or the whole link.",
  facebook:
    "On Facebook, click the post's date to open its permalink. Paste the whole address, or only the number at its end.",
  generic: "The page's full address.",
};

function PickPlatform() {
  const platforms = usePlatforms();
  return (
    <section className="card stack mk-panel" aria-labelledby="mk-pick">
      <div className="stack-tight">
        <span className="muted small">New conversation · step 1 of 2</span>
        <h1 id="mk-pick">Where is the post?</h1>
        <p className="muted">
          Pick the platform. Next you paste the post's code, and the conversation starts.
        </p>
      </div>
      {platforms && platforms.length === 0 && (
        <Alert kind="info">No platform is switched on. The Owner can do it in Settings.</Alert>
      )}
      <div className="mk-platforms">
        {platforms?.map((p) => (
          <button key={p.id} className="mk-platform" onClick={() => startNew(p.slug)}>
            <span className={`mk-platform-mark platform-${p.slug}`} aria-hidden="true">
              {p.name.slice(0, 1)}
            </span>
            <strong>{p.name}</strong>
            <span className="muted small">{CODE_HINT[p.parser]}</span>
          </button>
        ))}
      </div>
      <p className="muted small">
        Tip: you can also paste a link or code into “Find by post code or link” on the left.
      </p>
    </section>
  );
}

/** Create a thread and draft straight away: that's what the person came for. */
async function createAndDraft(body: Parameters<typeof api.createThread>[0]): Promise<string> {
  const thread = await api.createThread(body);
  try {
    await api.draftReply(thread.id, thread.messages[0]!.id);
  } catch (err) {
    setFlash(
      err instanceof ApiError ? `The draft didn't work: ${err.message}` : "The draft didn't work.",
    );
  }
  return thread.id;
}

function NewConversation({
  platform: slug,
  code: initialCode,
  onCreated,
}: {
  platform: string;
  code: string;
  onCreated: () => void;
}) {
  const { user } = useAuth();
  const platforms = usePlatforms();
  const platform = platforms?.find((p) => p.slug === slug);
  const [code, setCode] = useState(initialCode);
  const [found, setFound] = useState<Resolved | null>(null);
  const [checked, setChecked] = useState("");
  const [question, setQuestion] = useState("");
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = platform?.name ?? slug;
  const facebook = platform?.parser === "facebook";

  const check = useCallback(
    async (text: string) => {
      if (!text) return;
      setBusy(true);
      setError("");
      setFound(null);
      try {
        const result = await api.resolveThread(text);
        if (result.error) setError(result.error);
        else if (result.parsed && result.parsed.platform !== slug) {
          setError(
            `That isn't a ${name} post: it looks like ${result.parsed.platform_name}. Check the code, or paste the whole link.`,
          );
        } else if (result.found && result.thread) {
          const by = result.thread.created_by;
          if (by && by.id !== user?.id) {
            setFlash(
              `${by.name} started this conversation on ${formatDate(result.thread.created_at)}.`,
            );
          } else setFlash("We already have this post: its conversation is below.");
          openThread(result.thread.id, result.matched_message_id);
        } else {
          setFound(result);
          setChecked(text);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [slug, name, user],
  );

  // A code pasted into the finder on the left is checked straight away.
  const started = useRef(false);
  useEffect(() => {
    if (initialCode && platforms && !started.current) {
      started.current = true;
      void check(initialCode);
    }
  }, [initialCode, platforms, check]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const id = await createAndDraft({
        url: checked,
        question,
        author_name: author.trim() || undefined,
      });
      onCreated();
      openThread(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not created.");
      setBusy(false);
    }
  }

  const fresh = found?.parsed && checked === code.trim();
  return (
    <section className="card stack mk-panel" aria-labelledby="mk-code">
      <div className="stack-tight">
        <span className="muted small">
          <button className="link-button" onClick={() => navigate("/marketing")}>
            ← Back
          </button>{" "}
          New conversation · step 2 of 2
        </span>
        <h1 id="mk-code" className="mk-title">
          <span className={`platform-badge platform-${slug}`}>{name}</span> Paste the post's code
        </h1>
      </div>
      <form
        className="stack-tight"
        onSubmit={(event) => {
          event.preventDefault();
          void check(code.trim());
        }}
      >
        <label htmlFor="mk-post-code">Post code or link</label>
        <div className="row mk-code-row">
          <input
            id="mk-post-code"
            className="input grow mono"
            value={code}
            autoFocus={!initialCode}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="button" disabled={busy || !code.trim()}>
            {busy && !fresh ? "Checking…" : "Check"}
          </button>
        </div>
        {platform && <p className="hint">{CODE_HINT[platform.parser]}</p>}
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {fresh && found.parsed && (
        <form className="stack" onSubmit={create}>
          <Alert kind="success">
            <strong>New post</strong>
            {found.parsed.community && ` · ${found.parsed.community}`} · we haven't answered it
            before.
          </Alert>
          <label htmlFor="mk-question">Their question</label>
          <textarea
            id="mk-question"
            className="textarea"
            rows={5}
            required
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <label htmlFor="mk-author">
            {facebook ? "Their name (optional)" : "Their username (optional)"}
          </label>
          <input
            id="mk-author"
            className="input"
            placeholder={facebook ? "Dan Miller" : "u/john_smb"}
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
          <div className="row">
            <button className="button button-primary" disabled={busy || !question.trim()}>
              {busy ? "Drafting…" : "Start and draft reply"}
            </button>
            <button type="button" className="button" onClick={() => navigate("/marketing")}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// --- one conversation -----------------------------------------------------------------------------

function postCode(thread: ThreadDetail): string | null {
  if (!thread.original_url || !["reddit", "facebook"].includes(thread.platform)) return null;
  return thread.id.slice(thread.id.indexOf(":") + 1);
}

function ThreadView({
  id,
  replyTo,
  onChanged,
}: {
  id: string;
  replyTo: string | null;
  onChanged: () => void;
}) {
  const [thread, setThreadState] = useState<ThreadDetail | null>(null);
  const [note] = useState(takeFlash);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const setThread = useCallback(
    (next: ThreadDetail) => {
      setThreadState(next);
      onChanged();
    },
    [onChanged],
  );
  const load = useCallback(() => {
    api
      .getThread(id)
      .then(setThreadState)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [id]);
  useEffect(load, [load]);

  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);

  async function run(key: string, call: () => Promise<ThreadDetail | void>) {
    setBusy(key);
    setError("");
    try {
      const next = await call();
      if (next) setThread(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (!thread) return error ? <Alert kind="error">{error}</Alert> : null;
  const closed = thread.status === "closed";
  const code = postCode(thread);
  const ordered = [...thread.messages].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  );
  const byId = new Map(thread.messages.map((m) => [m.id, m]));

  return (
    <section className="mk-thread" aria-labelledby="mk-thread-title">
      <header className="mk-thread-head">
        <div className="mk-thread-info">
          <h1 id="mk-thread-title" className="mk-title">
            <span className={`platform-badge platform-${thread.platform}`}>
              {thread.platform_name}
            </span>{" "}
            {thread.title}
          </h1>
          <p className="muted small">
            {[
              thread.community,
              code && `post ${code}`,
              thread.created_by && `started by ${thread.created_by.name} ${ago(thread.created_at)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            {thread.original_url && (
              <>
                {" · "}
                <a href={thread.original_url} target="_blank" rel="noopener noreferrer">
                  Open on {thread.platform_name}
                </a>
              </>
            )}
          </p>
        </div>
        <div className="row mk-thread-actions">
          <span className={`pill pill-thread-${thread.status}`}>{STATUS_NAME[thread.status]}</span>
          {thread.can_close &&
            (closed ? (
              <button
                className="button button-small"
                onClick={() => void run("reopen", () => api.reopenThread(id))}
              >
                Reopen
              </button>
            ) : (
              <button
                className="button button-small"
                onClick={() => void run("close", () => api.closeThread(id))}
              >
                Close
              </button>
            ))}
          {thread.can_delete && (
            <button className="button button-small button-danger" onClick={() => setDeleting(true)}>
              Delete
            </button>
          )}
        </div>
      </header>
      <div className="mk-messages">
        {note && <Alert kind="info">{note}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        {ordered.map((m, i) => {
          const parent = m.parent_id ? byId.get(m.parent_id) : undefined;
          // Say what they answered when it isn't simply the message above.
          const answered =
            m.author === "them" && parent && ordered[i - 1]?.id !== parent.id ? parent : undefined;
          return (
            <Message
              key={m.id}
              message={m}
              answered={answered}
              thread={thread}
              busy={busy}
              closed={closed}
              onRun={run}
              onChanged={load}
            />
          );
        })}
        <div ref={end} />
      </div>
      {closed ? (
        <p className="mk-closed muted">This conversation is closed. Reopen it to continue.</p>
      ) : (
        <Composer
          thread={thread}
          replyTo={replyTo}
          onAdded={setThread}
          onError={(text) => setError(text)}
        />
      )}
      {deleting && (
        <Confirm
          title="Delete this conversation?"
          message="It goes to the trash for 30 days. Drafts waiting for review are withdrawn."
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void api.deleteThread(id).then(() => {
              onChanged();
              navigate("/marketing");
            });
          }}
        />
      )}
    </section>
  );
}

function snippet(m: ThreadMessage): string {
  const who = m.author === "us" ? "our reply" : (m.author_name ?? "their message");
  const text = m.body.length > 50 ? `${m.body.slice(0, 50)}…` : m.body;
  return `${who}: “${text}”`;
}

type Run = (key: string, call: () => Promise<ThreadDetail | void>) => Promise<void>;

function Message({
  message,
  answered,
  thread,
  busy,
  closed,
  onRun,
  onChanged,
}: {
  message: ThreadMessage;
  answered?: ThreadMessage;
  thread: ThreadDetail;
  busy: string | null;
  closed: boolean;
  onRun: Run;
  onChanged: () => void;
}) {
  const [instruction, setInstruction] = useState("");

  if (message.author === "them") {
    // Not answered yet (the draft didn't work, or it was rejected): offer to draft.
    const hasDraft = thread.messages.some((m) => m.parent_id === message.id && m.author === "us");
    return (
      <div className="mk-msg mk-msg-them">
        <div className="muted small">
          <strong className="mk-who">{message.author_name ?? "Them"}</strong>
          {answered && ` · replied to ${snippet(answered)}`} · {formatDate(message.created_at)}
        </div>
        <div className="bubble bubble-them pre">{message.body}</div>
        {!closed && !hasDraft && (
          <div className="row draft-ask">
            <input
              className="input grow"
              aria-label="Instruction for the draft (optional)"
              placeholder="Optional: e.g. shorter, mention the free audit"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <button
              className="button button-small button-primary"
              disabled={busy !== null}
              onClick={() =>
                void onRun(`draft-${message.id}`, () =>
                  api.draftReply(thread.id, message.id, instruction.trim() || undefined),
                )
              }
            >
              {busy === `draft-${message.id}` ? "Drafting…" : "Draft reply"}
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <OurReply
      message={message}
      thread={thread}
      busy={busy}
      closed={closed}
      onRun={onRun}
      onChanged={onChanged}
    />
  );
}

function OurReply({
  message,
  thread,
  busy,
  closed,
  onRun,
  onChanged,
}: {
  message: ThreadMessage;
  thread: ThreadDetail;
  busy: string | null;
  closed: boolean;
  onRun: Run;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.body);
  const [posting, setPosting] = useState(false);
  const [postUrl, setPostUrl] = useState("");
  const [redraft, setRedraft] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState("");
  const draft = message.draft;
  const inReview = message.state === "in_review";

  function copy(value: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (message.state === "posted") {
    return (
      <div className="mk-msg mk-msg-us">
        <div className="muted small">
          Our reply ·{" "}
          <strong className="mk-who">Posted by {message.posted_by?.name ?? "us"}</strong> ·{" "}
          {formatDate(message.posted_at ?? message.created_at)}
          {message.external_url && (
            <>
              {" · "}
              <a href={message.external_url} target="_blank" rel="noopener noreferrer">
                our comment
              </a>
            </>
          )}
        </div>
        <div className="bubble bubble-us pre">{message.body}</div>
        {draft?.corrected_after_post && (
          <Alert kind="info">
            This reply was corrected after posting — consider editing your comment on{" "}
            {thread.platform_name}:<div className="pre corrected">{draft.corrected_after_post}</div>
            <button
              className="button button-small"
              onClick={() => copy(draft.corrected_after_post!)}
            >
              {copied ? "Copied" : "Copy the corrected reply"}
            </button>
          </Alert>
        )}
      </div>
    );
  }

  const sure = draft?.confidence != null ? ` · ${draft.confidence}% sure` : "";
  return (
    <div className="mk-msg mk-msg-us">
      <div className="muted small">
        Draft reply · {message.created_by?.name ?? "us"} · {ago(message.created_at)}{" "}
        {inReview && <span className="pill pill-thread-in_review">Being checked by our team</span>}
        {message.state === "ready" && (
          <span className="pill pill-thread-ready_to_post">Ready to post{sure}</span>
        )}
      </div>
      <div className="bubble bubble-us draft">
        {editing ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void onRun(`edit-${message.id}`, () => api.editDraft(message.id, text)).then(() =>
                setEditing(false),
              );
            }}
          >
            <textarea
              className="textarea"
              aria-label="Draft"
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="row">
              <button className="button button-small button-primary">Save</button>
              <button
                type="button"
                className="button button-small"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="pre">{message.body}</div>
        )}
        {draft && draft.sources.length > 0 && (
          <p className="muted small mk-sources">
            Sources: {[...new Set(draft.sources.map((s) => s.file_name))].join(" · ")}
          </p>
        )}
      </div>
      {draft?.needs_info && (
        <form
          className="needs-info"
          onSubmit={(event) => {
            event.preventDefault();
            void api.needsInfoReply(draft.answer_id, reply.trim()).then(onChanged);
          }}
        >
          <p>
            <strong>❓ {draft.needs_info.asked_by} from our team asks:</strong>{" "}
            {draft.needs_info.question}
          </p>
          <textarea
            aria-label="Your reply"
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <div>
            <button className="button button-small button-primary" disabled={!reply.trim()}>
              Send reply
            </button>
          </div>
        </form>
      )}
      {!editing && !closed && (
        <div className="row draft-tools">
          <button
            className="button button-small button-primary"
            disabled={inReview}
            title={inReview ? "Waiting for review – don't post yet" : undefined}
            onClick={() => copy(message.body)}
          >
            {inReview ? "Waiting for review – don't post yet" : copied ? "Copied" : "Copy"}
          </button>
          {!inReview && (
            <button className="button button-small" onClick={() => setPosting(!posting)}>
              Mark as posted
            </button>
          )}
          <button className="button button-small" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="button button-small"
            aria-expanded={redraft}
            onClick={() => setRedraft(!redraft)}
          >
            Redraft…
          </button>
        </div>
      )}
      {redraft && !closed && (
        <form
          className="row draft-tools"
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(`draft-${message.parent_id}`, () =>
              api.draftReply(thread.id, message.parent_id!, instruction.trim() || undefined),
            );
          }}
        >
          <input
            className="input grow"
            aria-label="Instruction for a new draft"
            placeholder="e.g. shorter, mention the free audit"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button className="button button-small" disabled={busy !== null || !message.parent_id}>
            {busy === `draft-${message.parent_id}` ? "Drafting…" : "Redraft"}
          </button>
        </form>
      )}
      {posting && (
        <form
          className="row draft-tools"
          onSubmit={(event) => {
            event.preventDefault();
            void onRun(`post-${message.id}`, () =>
              api.markPosted(message.id, postUrl.trim() || undefined),
            ).then(() => setPosting(false));
          }}
        >
          <input
            className="input grow"
            aria-label="Link to our posted comment (optional)"
            placeholder="Link to our posted comment (helps match their replies)"
            value={postUrl}
            onChange={(e) => setPostUrl(e.target.value)}
          />
          <button className="button button-small button-primary">Save as posted</button>
        </form>
      )}
    </div>
  );
}

// --- the reply box at the bottom --------------------------------------------------------------------

function Composer({
  thread,
  replyTo,
  onAdded,
  onError,
}: {
  thread: ThreadDetail;
  replyTo: string | null;
  onAdded: (thread: ThreadDetail) => void;
  onError: (text: string) => void;
}) {
  const latestPosted = [...thread.messages]
    .filter((m) => m.state === "posted")
    .sort((a, b) => (a.posted_at ?? "").localeCompare(b.posted_at ?? ""))
    .pop();
  const fallback = latestPosted?.id ?? thread.messages[0]?.id ?? "";
  const [parent, setParent] = useState(replyTo ?? "");
  const [body, setBody] = useState("");
  const [author, setAuthor] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  // Opened from a link to their reply: the box is ready for it.
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const before = new Set(thread.messages.map((m) => m.id));
    try {
      const added = await api.addReply(thread.id, {
        body,
        parent_id: parent || fallback || undefined,
        author_name: author.trim() || undefined,
        url: url.trim() || undefined,
      });
      onAdded(added);
      setBody("");
      setUrl("");
      setParent("");
      const theirs = added.messages.find((m) => !before.has(m.id) && m.author === "them");
      if (theirs) {
        try {
          onAdded(await api.draftReply(thread.id, theirs.id));
        } catch (err) {
          onError(
            err instanceof ApiError
              ? `Their reply was added, but the draft didn't work: ${err.message}`
              : "Their reply was added, but the draft didn't work.",
          );
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not added.");
    } finally {
      setBusy(false);
    }
  }

  const options = thread.messages.filter((m) => m.author === "them" || m.state === "posted");
  return (
    <form className="mk-composer" onSubmit={submit}>
      {error && <Alert kind="error">{error}</Alert>}
      <label htmlFor="mk-reply">Paste their new reply</label>
      <textarea
        id="mk-reply"
        ref={input}
        className="textarea"
        rows={3}
        placeholder={`Paste what they wrote on ${thread.platform_name}…`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mk-composer-row">
        <div className="mk-field">
          <label htmlFor="mk-parent" className="small muted">
            Replying to
          </label>
          <select id="mk-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">
              {latestPosted ? "Our latest posted reply" : "Their first message"}
            </option>
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {snippet(m)}
              </option>
            ))}
          </select>
        </div>
        <div className="mk-field">
          <label htmlFor="mk-reply-author" className="small muted">
            {thread.platform === "facebook" ? "Their name (optional)" : "Their username (optional)"}
          </label>
          <input
            id="mk-reply-author"
            className="input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div className="mk-field">
          <label htmlFor="mk-reply-url" className="small muted">
            Link to their comment (optional)
          </label>
          <input
            id="mk-reply-url"
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <button className="button button-primary" disabled={busy || !body.trim()}>
          {busy ? "Drafting…" : "Send and draft"}
        </button>
      </div>
    </form>
  );
}
