import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  api,
  ApiError,
  type AnswerStatus,
  type ChatMessage,
  type Conversation,
  type Feedback,
  type Outcome,
  type Source,
} from "../api";
import { Markdown } from "../components/Markdown";
import { reviewsChanged } from "../events";
import { formatDate } from "../format";
import { Alert, Confirm } from "../components/ui";

// Ask (SPEC section 7.1). Labels for reviewed answers follow SPEC section 6.8.

type Shown = ChatMessage & { streaming?: boolean; error?: string; question?: string };

function chatFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("c");
}

function setChatInUrl(id: string | null) {
  const url = id ? `/?c=${id}` : "/";
  window.history.replaceState(null, "", url);
}

function sourceHref(source: Source): string {
  if (source.kind === "verified") return `/verified?id=${source.ref_id.replace(/^va_/, "")}`;
  const base = `/api/files/${source.file_id}/download?inline=true`;
  return source.page ? `${base}#page=${source.page}` : base;
}

function SourceChips({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <ul className="sources" aria-label="Sources">
      {sources.map((source) => (
        <li key={source.n}>
          <a
            href={sourceHref(source)}
            target="_blank"
            rel="noopener noreferrer"
            className={`source-chip ${source.kind === "verified" ? "source-verified" : ""}`}
          >
            <span className="source-n">{source.n}</span> {source.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Ask() {
  const [chats, setChats] = useState<Conversation[]>([]);
  const [chatId, setChatId] = useState<string | null>(chatFromUrl);
  const [messages, setMessages] = useState<Shown[]>([]);
  const [filter, setFilter] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [updatedIds, setUpdatedIds] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const counter = useRef(0);
  const skipLoad = useRef<string | null>(null);

  const loadChats = useCallback(() => {
    api
      .listConversations()
      .then(setChats)
      .catch(() => setLoadError("Your chats couldn't be loaded."));
  }, []);
  useEffect(loadChats, [loadChats]);

  useEffect(() => {
    setChatInUrl(chatId);
    if (!chatId || skipLoad.current === chatId) return;
    let current = true;
    api
      .getConversation(chatId)
      .then((chat) => {
        if (!current) return;
        setMessages(chat.messages);
        setUpdatedIds(chat.updated_answer_ids ?? []);
        // Opening the chat counts as seeing the update: drop its dot.
        setChats((list) => list.map((c) => (c.id === chat.id ? { ...c, updated: false } : c)));
      })
      .catch(() => {
        if (current) {
          setChatId(null);
          setMessages([]);
          setLoadError("That chat couldn't be opened.");
        }
      });
    return () => {
      current = false;
    };
  }, [chatId]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages]);

  const update = (key: string, patch: Partial<Shown> | ((m: Shown) => Partial<Shown>)) =>
    setMessages((list) =>
      list.map((m) =>
        m.id === key ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m,
      ),
    );

  async function send(question: string, retryOf?: string) {
    setBusy(true);
    setLoadError("");
    let id = chatId;
    try {
      if (!id) {
        id = (await api.createConversation()).id;
        skipLoad.current = id; // nothing to load: the messages are being added right here
        setChatId(id);
        const created = { id, title: question, last_message_at: new Date().toISOString() };
        setChats((list) => [created, ...list]); // shown at once; the server's copy replaces it
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Something went wrong.");
      setBusy(false);
      return;
    }
    const stamp = ++counter.current;
    const userKey = `u-${stamp}`;
    const replyKey = `a-${stamp}`;
    const now = "";
    setMessages((list) => [
      ...list.filter((m) => m.id !== retryOf),
      { id: userKey, role: "user", body: question, created_at: now, answer: null },
      {
        id: replyKey,
        role: "assistant",
        body: "",
        created_at: now,
        answer: null,
        streaming: true,
        question,
      },
    ]);
    await api.ask(id, question, {
      onDelta: (text) => update(replyKey, (m) => ({ body: m.body + text })),
      onReplace: (text) => update(replyKey, { body: text }),
      onSources: (sources) =>
        update(replyKey, (m) => ({
          answer: {
            id: "",
            outcome: null,
            status: "auto",
            stop_reason: null,
            corrected: false,
            confidence: null,
            feedback: null,
            ...m.answer,
            sources,
          },
        })),
      onConfidence: (scored) =>
        update(replyKey, (m) => ({
          answer: m.answer && {
            ...m.answer,
            confidence: scored.confidence,
            outcome: scored.outcome,
            status: scored.status,
          },
        })),
      onDone: (done) =>
        update(replyKey, (m) => ({
          streaming: false,
          answer: {
            sources: m.answer?.sources ?? [],
            status: done.status ?? m.answer?.status ?? "auto",
            corrected: false,
            confidence: m.answer?.confidence ?? null,
            feedback: null,
            id: done.answer_id,
            outcome: (done.outcome as Outcome | null) ?? m.answer?.outcome ?? null,
            stop_reason: done.stop_reason,
          },
        })),
      onError: (message) => {
        // The question was withdrawn on the server: show it with a way to send it again.
        setMessages((list) => list.filter((m) => m.id !== userKey));
        update(replyKey, { streaming: false, error: message, body: "" });
      },
    });
    setBusy(false);
    loadChats();
    reviewsChanged(); // a low or unanswered question opens a review
  }

  async function remove(chat: Conversation) {
    setDeleting(null);
    try {
      await api.deleteConversation(chat.id);
      if (chat.id === chatId) {
        setChatId(null);
        setMessages([]);
      }
      loadChats();
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Not deleted.");
    }
  }

  const shown = chats.filter((c) => c.title.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="ask">
      <aside className={`chats ${listOpen ? "open" : ""}`} aria-label="Chats">
        <button
          className="button button-primary button-wide new-chat"
          onClick={() => {
            setChatId(null);
            setMessages([]);
            setListOpen(false);
          }}
        >
          + New chat
        </button>
        <input
          type="search"
          className="input"
          placeholder="Search chats"
          aria-label="Search chats"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul>
          {shown.map((chat) => (
            <li key={chat.id} className={chat.id === chatId ? "current" : undefined}>
              <button
                className="chat-link"
                aria-current={chat.id === chatId ? "page" : undefined}
                onClick={() => {
                  setChatId(chat.id);
                  setListOpen(false);
                }}
              >
                {chat.title}
                {chat.updated && <span className="dot" aria-label="An answer was updated" />}
              </button>
              <button
                className="icon-button chat-delete"
                aria-label={`Delete ${chat.title}`}
                onClick={() => setDeleting(chat)}
              >
                ×
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="muted small">{filter ? "No chats match." : "No chats yet."}</li>
          )}
        </ul>
      </aside>
      <section className="chat">
        <button className="button button-small chats-toggle" onClick={() => setListOpen(!listOpen)}>
          Chats
        </button>
        {loadError && <Alert kind="error">{loadError}</Alert>}
        <div className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-empty">
              <h1>Ask</h1>
              <p className="muted">Ask anything about GridRankers' documents.</p>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="bubble bubble-user">
                {m.body}
              </div>
            ) : (
              <AnswerBubble
                key={m.id}
                message={m}
                onRetry={() => m.question && void send(m.question, m.id)}
                onReplied={() =>
                  update(m.id, (old) => ({
                    answer: old.answer && { ...old.answer, status: "in_review", needs_info: null },
                  }))
                }
              />
            ),
          )}
          <UpdateNotice messages={messages} updatedIds={updatedIds} />
          <div ref={bottom} />
        </div>
        <Composer disabled={busy} onSend={(q) => void send(q)} />
      </section>
      {deleting && (
        <Confirm
          title="Delete this chat?"
          message={
            <>
              <strong>{deleting.title}</strong> will be removed from your chats. The answers stay in
              the Answer Log.
            </>
          }
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </div>
  );
}

function AnswerBubble({
  message,
  onRetry,
  onReplied,
}: {
  message: Shown;
  onRetry: () => void;
  onReplied: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (message.error) {
    return (
      <div className="bubble bubble-answer">
        <Alert kind="error">{message.error}</Alert>
        <button className="button button-small" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  const answer = message.answer;
  const changed = Boolean(answer?.original_text);
  // A changed answer's chips belonged to the original; they show under "Show original".
  const sources = changed ? [] : (answer?.sources ?? []);
  return (
    <div className="bubble bubble-answer" id={answer?.id ? `answer-${answer.id}` : undefined}>
      {message.body ? (
        <Markdown text={message.body} typing={message.streaming} />
      ) : (
        <p className="muted">Searching the documents…</p>
      )}
      <SourceChips sources={sources} />
      {!message.streaming && message.answer && (
        <StatusLabel
          status={message.answer.status}
          noAnswer={message.answer.outcome === "no_answer"}
          reviewedAt={message.answer.reviewed_at ?? null}
        />
      )}
      {changed && answer && (
        <details className="original">
          <summary>Show original</summary>
          <Markdown text={answer.original_text ?? ""} />
          <SourceChips sources={answer.sources} />
        </details>
      )}
      {!message.streaming &&
        message.answer?.status === "needs_info" &&
        message.answer.needs_info && (
          <NeedsInfoCard
            answerId={message.answer.id}
            question={message.answer.needs_info.question}
            from={message.answer.needs_info.asked_by}
            onSent={onReplied}
          />
        )}
      {!message.streaming && message.body && (
        <div className="answer-actions">
          <button
            className="button button-small"
            onClick={() => {
              void navigator.clipboard?.writeText(message.body);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {message.answer?.id && (
            <FeedbackButtons answerId={message.answer.id} initial={message.answer.feedback} />
          )}
        </div>
      )}
    </div>
  );
}

const LABELS: Partial<Record<AnswerStatus, [string, string]>> = {
  in_review: ["🟠 Being checked by our team", "label-pending"],
  needs_info: ["🟠 Our team needs more information", "label-pending"],
  verified: ["✔ Verified by our team", "label-ok"],
  corrected: ["✔ Corrected by our team", "label-ok"],
  wrong_no_answer: [
    "⚠ This answer was not correct and we don't have a confirmed answer yet. Please don't rely on it.",
    "label-warn",
  ],
};

const NO_ANSWER_LABEL: [string, string] = [
  "🟠 Sent to our team. We'll notify you when there's an answer.",
  "label-pending",
];

function StatusLabel({
  status,
  noAnswer,
  reviewedAt,
}: {
  status: AnswerStatus;
  noAnswer: boolean;
  reviewedAt: string | null;
}) {
  const label = noAnswer && status === "in_review" ? NO_ANSWER_LABEL : LABELS[status];
  if (!label) return null;
  const when = status === "corrected" && reviewedAt ? ` · ${formatDate(reviewedAt)}` : "";
  return (
    <p className={`answer-label ${label[1]}`}>
      {label[0]}
      {when}
    </p>
  );
}

/** SPEC 6.8: when an earlier answer was reviewed, say so at the end of the chat. */
function UpdateNotice({ messages, updatedIds }: { messages: Shown[]; updatedIds: string[] }) {
  const answers = messages.filter((m) => m.role === "assistant" && m.answer);
  const last = answers.at(-1)?.answer?.id;
  const earlier = answers.filter(
    (m) => m.answer && updatedIds.includes(m.answer.id) && m.answer.id !== last,
  );
  const target = earlier[0]?.answer;
  if (!target) return null;
  const what = target.status === "verified" ? "checked by our team" : "corrected";
  return (
    <p className="update-notice">
      🔔 An answer above was {what} —{" "}
      <button
        className="link-button"
        onClick={() =>
          document
            .getElementById(`answer-${target.id}`)
            ?.scrollIntoView?.({ behavior: "smooth", block: "center" })
        }
      >
        Jump to it
      </button>
    </p>
  );
}

function NeedsInfoCard({
  answerId,
  question,
  from,
  onSent,
}: {
  answerId: string;
  question: string;
  from: string;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.needsInfoReply(answerId, text.trim());
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="needs-info" onSubmit={send}>
      <p>
        <strong>❓ {from} from our team asks:</strong> {question}
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <label className="sr-only" htmlFor={`reply-${answerId}`}>
        Your reply
      </label>
      <textarea
        id={`reply-${answerId}`}
        rows={2}
        maxLength={4000}
        placeholder="Your reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div>
        <button className="button button-small button-primary" disabled={busy || !text.trim()}>
          Send reply
        </button>
      </div>
    </form>
  );
}

function FeedbackButtons({ answerId, initial }: { answerId: string; initial: Feedback | null }) {
  const [value, setValue] = useState<Feedback | null>(initial);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function send(next: Feedback | "none", withNote?: string) {
    setError("");
    try {
      const result = await api.feedback(answerId, next, withNote);
      setValue(result.feedback);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
      return false;
    }
  }

  return (
    <>
      <button
        className="icon-button feedback"
        aria-label="Helpful"
        aria-pressed={value === "up"}
        onClick={() => void send(value === "up" ? "none" : "up")}
      >
        👍
      </button>
      <button
        className="icon-button feedback"
        aria-label="Not helpful"
        aria-pressed={value === "down"}
        onClick={() => {
          if (value === "down") void send("none");
          else void send("down").then((ok) => ok && setAsking(true));
        }}
      >
        👎
      </button>
      {error && <span className="field-error small">{error}</span>}
      {asking && (
        <form
          className="feedback-note"
          onSubmit={(event) => {
            event.preventDefault();
            void send("down", note.trim() || undefined).then((ok) => ok && setAsking(false));
          }}
        >
          <label className="small" htmlFor={`note-${answerId}`}>
            What was wrong? (optional)
          </label>
          <textarea
            id={`note-${answerId}`}
            rows={2}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row">
            <button className="button button-small button-primary">Send</button>
            <button type="button" className="button button-small" onClick={() => setAsking(false)}>
              Skip
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (question: string) => void }) {
  const [text, setText] = useState("");

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = text.trim();
    if (!question || disabled) return;
    setText("");
    onSend(question);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        aria-label="Your question"
        placeholder="Ask a question… (Shift+Enter for a new line)"
        rows={2}
        maxLength={4000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keyDown}
      />
      <button className="button button-primary" disabled={disabled || !text.trim()}>
        {disabled ? "Answering…" : "Ask"}
      </button>
    </form>
  );
}
