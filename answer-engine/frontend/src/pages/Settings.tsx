import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type KbStatus } from "../api";
import { Alert, Confirm } from "../components/ui";
import { plural } from "../format";

// Settings (SPEC section 7.8). Only the knowledge base section exists so far; the rest
// arrives in build step 14.
export function Settings() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <KnowledgeBase />
    </section>
  );
}

function when(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function KnowledgeBase() {
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    api
      .kbStatus()
      .then(setStatus)
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!status?.pending_ops) return;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [status?.pending_ops, load]);

  async function rebuild() {
    setConfirming(false);
    try {
      setNotice({ kind: "success", text: (await api.kbRebuild()).message });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not started." });
    }
    load();
  }

  if (!status) return notice ? <Alert kind={notice.kind}>{notice.text}</Alert> : null;
  const check = status.last_check;

  return (
    <div className="card stack">
      <div className="page-head">
        <h2>Knowledge base</h2>
        <button
          className="button"
          onClick={() => setConfirming(true)}
          disabled={!status.configured}
        >
          Rebuild index
        </button>
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {!status.configured && (
        <Alert kind="error">
          Pinecone isn't set up yet, so documents can't be searched. Add PINECONE_API_KEY to the
          server's .env, run <code>python -m app.cli setup-pinecone</code>, then press Rebuild
          index. Changes made meanwhile are kept and sent once it's set up.
        </Alert>
      )}
      <dl className="facts">
        <div>
          <dt>Pinecone index</dt>
          <dd>{status.index}</dd>
        </div>
        <div>
          <dt>Searchable documents</dt>
          <dd>
            {plural(status.files_ready, "file")} · {plural(status.chunks, "chunk")}
          </dd>
        </div>
        <div>
          <dt>Waiting to sync</dt>
          <dd>
            {status.pending_ops === 0
              ? "Nothing — Pinecone is up to date"
              : `${plural(status.pending_records, "record")} in ${plural(status.pending_ops, "change")}` +
                (status.oldest_pending_at ? ` (since ${when(status.oldest_pending_at)})` : "")}
          </dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>
            {!check
              ? "Not run yet (runs nightly at 03:00 UTC)"
              : check.error
                ? `${when(check.at)}: ${check.error}`
                : `${when(check.at)}${check.rebuild ? " (rebuild)" : ""}: ${check.expected} expected, ` +
                  `${check.in_pinecone} in Pinecone, ${check.missing} missing, ${check.extra} extra — fixes queued`}
          </dd>
        </div>
      </dl>
      {status.retrying && status.last_error && (
        <Alert kind="error">
          Pinecone isn't accepting changes right now; they will be retried automatically. Last
          error: {status.last_error}
        </Alert>
      )}
      {confirming && (
        <Confirm
          title="Rebuild the index?"
          message="Every document is sent to Pinecone again and anything that shouldn't be there is removed. Answers keep working while it runs."
          confirmLabel="Rebuild"
          onClose={() => setConfirming(false)}
          onConfirm={() => void rebuild()}
        />
      )}
    </div>
  );
}
