import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type KbStatus, type SettingsData } from "../api";
import { Alert, Confirm, Field } from "../components/ui";
import { plural } from "../format";

// Settings (SPEC section 7.8). Each card saves its own settings.
export function Settings() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <Reviews />
      <KnowledgeBase />
    </section>
  );
}

type Notice = { kind: "error" | "success"; text: string } | null;

function Reviews() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);

  const fill = useCallback((next: SettingsData) => {
    setData(next);
    const v = next.values;
    setForm({
      confidence_threshold: String(v.confidence_threshold ?? ""),
      review_reminder_hours: String(v.review_reminder_hours ?? ""),
      review_escalation_hours: String(v.review_escalation_hours ?? ""),
      telegram_group_chat_id:
        v.telegram_group_chat_id == null ? "" : String(v.telegram_group_chat_id),
    });
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then(fill)
      .catch(() => setNotice({ kind: "error", text: "Settings couldn't be loaded." }));
  }, [fill]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setNotice(null);
    try {
      fill(
        await api.updateSettings({
          confidence_threshold: Number(form.confidence_threshold),
          review_reminder_hours: Number(form.review_reminder_hours),
          review_escalation_hours: Number(form.review_escalation_hours),
          telegram_group_chat_id: form.telegram_group_chat_id || null,
        }),
      );
      setNotice({ kind: "success", text: "Saved." });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setNotice({ kind: "error", text: err.message });
      }
    }
  }

  async function test() {
    setNotice(null);
    try {
      setNotice({ kind: "success", text: (await api.telegramTest()).message });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not sent." });
    }
  }

  // Read the value now: React resets a controlled field before a state updater runs.
  const set = (key: string) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <div className="card stack">
      <h2>Reviews</h2>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {data && !data.telegram.configured && (
        <Alert kind="info">
          Telegram isn't set up: reviews wait in the Review Queue only. To use a Telegram group, add
          TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET to the server's .env and run{" "}
          <code>python -m app.cli setup-telegram</code>.
        </Alert>
      )}
      {data && (
        <form className="stack" onSubmit={save}>
          <Field
            label="Confidence threshold"
            type="number"
            min={0}
            max={100}
            hint="Answers scoring below this go to review."
            value={form.confidence_threshold ?? ""}
            error={errors.confidence_threshold}
            onChange={set("confidence_threshold")}
          />
          <Field
            label="Remind the group after (hours)"
            type="number"
            step="0.5"
            value={form.review_reminder_hours ?? ""}
            error={errors.review_reminder_hours}
            onChange={set("review_reminder_hours")}
          />
          <Field
            label="Tell the Owners after (hours)"
            type="number"
            value={form.review_escalation_hours ?? ""}
            error={errors.review_escalation_hours}
            onChange={set("review_escalation_hours")}
          />
          {data.telegram.configured && (
            <div className="field">
              <label htmlFor="tg-group">Telegram review group</label>
              <select
                id="tg-group"
                value={form.telegram_group_chat_id ?? ""}
                onChange={set("telegram_group_chat_id")}
              >
                <option value="">— Not chosen —</option>
                {data.telegram.seen_chats.map((chat) => (
                  <option key={chat.id} value={String(chat.id)}>
                    {chat.title}
                  </option>
                ))}
                {form.telegram_group_chat_id &&
                  !data.telegram.seen_chats.some(
                    (c) => String(c.id) === form.telegram_group_chat_id,
                  ) && (
                    <option value={form.telegram_group_chat_id}>
                      {form.telegram_group_chat_id}
                    </option>
                  )}
              </select>
              <p className="hint">
                Add {data.telegram.bot_username ? `@${data.telegram.bot_username}` : "the bot"} to
                your private reviewers' group; the group then appears here.
              </p>
              {errors.telegram_group_chat_id && (
                <p className="field-error">{errors.telegram_group_chat_id}</p>
              )}
            </div>
          )}
          <div className="row">
            <button className="button button-primary">Save</button>
            {data.telegram.configured && (
              <button type="button" className="button" onClick={() => void test()}>
                Send a test message
              </button>
            )}
          </div>
        </form>
      )}
    </div>
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
