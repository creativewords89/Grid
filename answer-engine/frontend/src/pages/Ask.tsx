import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ApiError, type ChatMessage, type Conversation, type Source } from "../api";
import { Alert, Confirm } from "../components/ui";

// Ask (SPEC section 7.1). The confidence badge, 👍/👎 and review labels arrive in steps 9-11.

type Shown = ChatMessage & { streaming?: boolean; error?: string; question?: string };

function chatFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("c");
}

function setChatInUrl(id: string | null) {
  const url = id ? `/?c=${id}` : "/";
  window.history.replaceState(null, "", url);
}

function sourceHref(source: Source): string {
  const base = `/api/files/${source.file_id}/download?inline=true`;
  return source.page ? `${base}#page=${source.page}` : base;
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
      .then((chat) => current && setMessages(chat.messages))
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
            ...m.answer,
            sources,
          },
        })),
      onDone: (done) =>
        update(replyKey, (m) => ({
          streaming: false,
          answer: {
            sources: m.answer?.sources ?? [],
            status: "auto",
            corrected: false,
            id: done.answer_id,
            outcome: (done.outcome as "no_answer" | null) ?? null,
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
              />
            ),
          )}
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

function AnswerBubble({ message, onRetry }: { message: Shown; onRetry: () => void }) {
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
  const sources = message.answer?.sources ?? [];
  return (
    <div className="bubble bubble-answer">
      {message.body ? (
        <div className={message.streaming ? "markdown typing" : "markdown"}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {message.body}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="muted">Searching the documents…</p>
      )}
      {sources.length > 0 && (
        <ul className="sources" aria-label="Sources">
          {sources.map((source) => (
            <li key={source.n}>
              <a
                href={sourceHref(source)}
                target="_blank"
                rel="noopener noreferrer"
                className="source-chip"
              >
                <span className="source-n">{source.n}</span> {source.label}
              </a>
            </li>
          ))}
        </ul>
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
        </div>
      )}
    </div>
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
