import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type DuplicateDetails,
  type ReviewAction,
  type ReviewDetail,
  type ReviewRow,
} from "../api";
import { DuplicatePrompt } from "../components/DuplicatePrompt";
import { Markdown } from "../components/Markdown";
import { Alert } from "../components/ui";
import { ago, formatDate } from "../format";
import { REVIEW_STATES } from "../labels";
import { navigate } from "../router";

// Review Queue (SPEC section 7.6): the same reviews and actions as the Telegram group.

function reviewFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("id");
}

export function ReviewQueue({ onChange }: { onChange?: () => void }) {
  const [openId, setOpenId] = useState<string | null>(reviewFromUrl);

  const open = (id: string | null) => {
    setOpenId(id);
    navigate(id ? `/reviews?id=${id}` : "/reviews", true);
  };

  return (
    <section className="page">
      {openId ? (
        <Review id={openId} onBack={() => open(null)} onChange={() => onChange?.()} />
      ) : (
        <Queue onOpen={open} />
      )}
    </section>
  );
}

function Queue({ onOpen }: { onOpen: (id: string) => void }) {
  const [show, setShow] = useState<"waiting" | "mine" | "decided">("waiting");
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    api
      .listReviews(show)
      .then((list) => current && setRows(list))
      .catch(
        (err: unknown) =>
          current && setError(err instanceof ApiError ? err.message : "Not loaded."),
      );
    return () => {
      current = false;
    };
  }, [show]);

  return (
    <>
      <div className="page-head">
        <h1>Review Queue</h1>
      </div>
      <div className="tabs" role="tablist">
        {(["waiting", "mine", "decided"] as const).map((tab) => (
          <button key={tab} role="tab" aria-selected={show === tab} onClick={() => setShow(tab)}>
            {{ waiting: "Waiting", mine: "Mine", decided: "Decided" }[tab]}
          </button>
        ))}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {rows && rows.length === 0 && (
        <p className="muted">
          {show === "decided" ? "Nothing decided yet." : "Nothing to review. 🎉"}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="review-list">
          {rows.map((row) => (
            <li key={row.id} className="card">
              <button className="review-row" onClick={() => onOpen(row.id)}>
                <span className="review-num">#R-{row.number}</span>
                <span className="review-main">
                  <strong>{row.question}</strong>
                  <span className="muted small">
                    {row.reason_label} · {row.asked_by?.name ?? "Someone"} ·{" "}
                    {row.kind === "chat" ? "Chat" : "Marketing"} · {ago(row.created_at)}
                  </span>
                </span>
                <span className={`pill pill-${row.state}`}>
                  {row.claimed_by && row.state === "claimed"
                    ? `${row.claimed_by.name} has it`
                    : REVIEW_STATES[row.state]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Review({
  id,
  onBack,
  onChange,
}: {
  id: string;
  onBack: () => void;
  onChange: () => void;
}) {
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"edit" | "reject" | "needs_info" | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<{
    details: DuplicateDetails;
    retry: (choice: string) => void;
  } | null>(null);

  const load = useCallback(() => {
    api
      .getReview(id)
      .then(setReview)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [id]);
  useEffect(load, [load]);

  async function run(call: () => Promise<ReviewDetail>, retry?: (choice: string) => void) {
    setBusy(true);
    setError("");
    try {
      setReview(await call());
      setMode(null);
      onChange();
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate" && retry && err.details) {
        setDuplicate({ details: err.details as DuplicateDetails, retry });
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong.");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  const decide = (action: ReviewAction, withText?: string, choice?: string): Promise<void> =>
    run(
      () => api.decideReview(id, action, withText, note.trim() || undefined, choice),
      (picked) => void decide(action, withText, picked),
    );

  function choose(next: "edit" | "reject" | "needs_info") {
    setMode(next);
    setText(next === "edit" && review ? review.current_text : "");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode) void decide(mode, text);
  }

  const undecided = review && ["open", "claimed", "needs_info"].includes(review.state);
  const othersHaveIt = review && review.claimed_by && !review.mine && undecided;

  return (
    <>
      <button className="link-button" onClick={onBack}>
        ← Review Queue
      </button>
      {error && <Alert kind="error">{error}</Alert>}
      {review && (
        <div className="stack review-detail">
          <div>
            <h1>
              #R-{review.number} · {review.reason_label}
            </h1>
            <p className="muted">
              {review.asked_by?.name ?? "Someone"} · {review.kind === "chat" ? "Chat" : "Marketing"}{" "}
              · {ago(review.created_at)} ·{" "}
              <span className={`pill pill-${review.state}`}>{REVIEW_STATES[review.state]}</span>
            </p>
          </div>
          <div className="card stack">
            <h2>{review.question}</h2>
            <div className="bubble bubble-answer">
              <Markdown text={review.current_text} />
            </div>
            {review.current_text !== review.original_text && (
              <details>
                <summary>Original answer</summary>
                <Markdown text={review.original_text} />
              </details>
            )}
            {review.explanation && <p className="muted small">{review.explanation}</p>}
            {review.unsupported_claims.length > 0 && (
              <div>
                <h4>Not supported by the documents</h4>
                <ul>
                  {review.unsupported_claims.map((claim) => (
                    <li key={claim}>{claim}</li>
                  ))}
                </ul>
              </div>
            )}
            {review.sources.length > 0 && (
              <ul className="sources" aria-label="Sources">
                {review.sources.map((source) => (
                  <li key={source.n}>
                    <a
                      className="source-chip"
                      href={
                        api.fileUrl(source.file_id, true) +
                        (source.page ? `#page=${source.page}` : "")
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className="source-n">{source.n}</span> {source.label}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {review.notes.length > 0 && (
            <div className="card stack">
              <h3>Questions and replies</h3>
              {review.notes.map((n) => (
                <div key={n.created_at + n.body} className={`note note-${n.kind}`}>
                  <div className="muted small">
                    {n.author?.name ?? "Someone"} · {ago(n.created_at)}
                  </div>
                  <div>{n.body}</div>
                </div>
              ))}
            </div>
          )}
          {!undecided && (
            <Alert kind="info">
              {REVIEW_STATES[review.state]} by {review.decided_by?.name ?? "someone"}
              {review.decided_at && <> on {formatDate(review.decided_at)}</>}
              {review.note && <> · “{review.note}”</>}
            </Alert>
          )}
          {othersHaveIt && <Alert kind="info">{review.claimed_by?.name} is handling this.</Alert>}
          {undecided && !othersHaveIt && (
            <div className="card stack">
              <div className="row">
                {!review.no_answer && (
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void decide("approve")}
                  >
                    ✅ Approve
                  </button>
                )}
                <button className="button" disabled={busy} onClick={() => choose("edit")}>
                  ✏️ {review.no_answer ? "Answer" : "Edit"}
                </button>
                {review.no_answer ? (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void decide("no_answer")}
                  >
                    🚫 No answer known
                  </button>
                ) : (
                  <button className="button" disabled={busy} onClick={() => choose("reject")}>
                    ❌ Reject
                  </button>
                )}
                <button className="button" disabled={busy} onClick={() => choose("needs_info")}>
                  ❓ Needs info
                </button>
                {review.state === "open" && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void run(() => api.claimReview(id))}
                  >
                    Claim
                  </button>
                )}
                {review.mine && review.state === "claimed" && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void run(() => api.releaseReview(id))}
                  >
                    Release
                  </button>
                )}
              </div>
              {mode && (
                <form className="stack" onSubmit={submit}>
                  <label htmlFor="review-text">
                    {mode === "edit"
                      ? "Corrected answer"
                      : mode === "reject"
                        ? "The correct answer"
                        : `Your question for ${review.asked_by?.name ?? "the asker"}`}
                  </label>
                  <textarea
                    id="review-text"
                    className="textarea"
                    rows={mode === "needs_info" ? 3 : 8}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                  {mode !== "needs_info" && (
                    <>
                      <label htmlFor="review-note">Note for the log (optional)</label>
                      <input
                        id="review-note"
                        className="input"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </>
                  )}
                  <div className="row">
                    <button className="button button-primary" disabled={busy || !text.trim()}>
                      {mode === "needs_info" ? "Send question" : "Save"}
                    </button>
                    {mode === "reject" && (
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => void decide("no_answer")}
                      >
                        🚫 No answer known
                      </button>
                    )}
                    <button type="button" className="button" onClick={() => setMode(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}
      {duplicate && (
        <DuplicatePrompt
          details={duplicate.details}
          onClose={() => setDuplicate(null)}
          onChoose={(choice) => {
            const retry = duplicate.retry;
            setDuplicate(null);
            retry(choice);
          }}
        />
      )}
    </>
  );
}
