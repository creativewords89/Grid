import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Community,
  type KbStatus,
  type Platform,
  type SettingsData,
} from "../api";
import { Alert, Confirm, Field } from "../components/ui";
import { plural } from "../format";
import { Connections } from "./Connections";
import { Answering, History, Limits, System, Usage } from "./SettingsCards";

// Settings (SPEC section 7.8). Each card saves its own settings.
export function Settings() {
  return (
    <section className="page">
      <h1>Settings</h1>
      <Connections />
      <Reviews />
      <Answering />
      <Platforms />
      <KnowledgeBase />
      <Limits />
      <Usage />
      <System />
      <History />
    </section>
  );
}

type Notice = { kind: "error" | "success"; text: string } | null;

// Platforms & communities (SPEC sections 6.10 and 7.8).
function Platforms() {
  const [list, setList] = useState<Platform[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api
      .platforms()
      .then(setList)
      .catch(() => setNotice({ kind: "error", text: "Platforms couldn't be loaded." }));
  }, []);
  useEffect(load, [load]);

  async function run(call: () => Promise<unknown>, done: string) {
    setNotice(null);
    try {
      await call();
      setNotice({ kind: "success", text: done });
      load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not saved." });
    }
  }

  return (
    <div className="card stack">
      <h2>Platforms &amp; communities</h2>
      <p className="muted">
        How drafts sound on each platform, the line added when a draft mentions GridRankers, and
        notes about each community (for example "no links").
      </p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {list?.map((p) => (
        <PlatformCard key={p.id} platform={p} run={run} />
      ))}
      {adding ? (
        <AddPlatform
          onDone={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div>
          <button className="button" onClick={() => setAdding(true)}>
            + Add a platform
          </button>
        </div>
      )}
    </div>
  );
}

type Run = (call: () => Promise<unknown>, done: string) => Promise<void>;

function PlatformCard({ platform, run }: { platform: Platform; run: Run }) {
  const [style, setStyle] = useState(platform.style_prompt);
  const [disclosure, setDisclosure] = useState(platform.disclosure_line ?? "");
  const [hosts, setHosts] = useState(platform.hosts.join(", "));
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  function save(event: FormEvent) {
    event.preventDefault();
    void run(
      () =>
        api.updatePlatform(platform.id, {
          style_prompt: style,
          disclosure_line: disclosure.trim() || null,
          ...(platform.parser === "generic"
            ? {
                hosts: hosts
                  .split(",")
                  .map((h) => h.trim())
                  .filter(Boolean),
              }
            : {}),
        }),
      `${platform.name} saved.`,
    );
  }

  return (
    <details className="platform-card">
      <summary>
        <strong>{platform.name}</strong>{" "}
        <span className="muted small">
          {platform.enabled ? "on" : "switched off"} · {platform.communities.length} communities
        </span>
      </summary>
      <div className="stack">
        <label className="inline">
          <input
            type="checkbox"
            checked={platform.enabled}
            onChange={(e) =>
              void run(
                () => api.updatePlatform(platform.id, { enabled: e.target.checked }),
                e.target.checked ? `${platform.name} is on.` : `${platform.name} is switched off.`,
              )
            }
          />
          Answer threads on {platform.name}
        </label>
        <form className="stack" onSubmit={save}>
          <label htmlFor={`style-${platform.id}`}>Style for drafts</label>
          <textarea
            id={`style-${platform.id}`}
            className="textarea"
            rows={3}
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          />
          <label htmlFor={`disclosure-${platform.id}`}>Disclosure line</label>
          <input
            id={`disclosure-${platform.id}`}
            className="input"
            placeholder="(I work at GridRankers.)"
            value={disclosure}
            onChange={(e) => setDisclosure(e.target.value)}
          />
          {platform.parser === "generic" && (
            <>
              <label htmlFor={`hosts-${platform.id}`}>Websites (comma-separated)</label>
              <input
                id={`hosts-${platform.id}`}
                className="input"
                value={hosts}
                onChange={(e) => setHosts(e.target.value)}
              />
            </>
          )}
          <div>
            <button className="button button-primary">Save {platform.name}</button>
          </div>
        </form>
        <h4>Communities</h4>
        {platform.communities.length === 0 && <p className="muted small">None yet.</p>}
        {platform.communities.map((c) => (
          <CommunityRow key={c.id} community={c} run={run} />
        ))}
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => api.addCommunity(platform.id, name, notes), `${name} added.`).then(
              () => {
                setName("");
                setNotes("");
              },
            );
          }}
        >
          <input
            className="input"
            aria-label={`New ${platform.name} community`}
            placeholder={platform.slug === "reddit" ? "r/localseo" : "Group name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input grow"
            aria-label="Notes"
            placeholder="Notes, e.g. no links"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button className="button" disabled={!name.trim()}>
            Add
          </button>
        </form>
      </div>
    </details>
  );
}

function CommunityRow({ community, run }: { community: Community; run: Run }) {
  const [notes, setNotes] = useState(community.notes);
  return (
    <form
      className="row"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => api.updateCommunity(community.id, notes), `${community.name} saved.`);
      }}
    >
      <strong className="community-name">{community.name}</strong>
      <input
        className="input grow"
        aria-label={`Notes for ${community.name}`}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button className="button button-small">Save</button>
      <button
        type="button"
        className="button button-small"
        onClick={() =>
          void run(() => api.deleteCommunity(community.id), `${community.name} removed.`)
        }
      >
        Remove
      </button>
    </form>
  );
}

function AddPlatform({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [hosts, setHosts] = useState("");
  const [style, setStyle] = useState("");
  const [error, setError] = useState("");
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.addPlatform({
        name,
        slug,
        hosts: hosts
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean),
        style_prompt: style,
        disclosure_line: "(I work at GridRankers.)",
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not added.");
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h3>Add a platform</h3>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <Field
        label="Website(s)"
        hint="Comma-separated, e.g. quora.com"
        value={hosts}
        onChange={(e) => setHosts(e.target.value)}
      />
      <label htmlFor="new-style">Style for drafts</label>
      <textarea
        id="new-style"
        className="textarea"
        rows={3}
        value={style}
        onChange={(e) => setStyle(e.target.value)}
      />
      <div className="row">
        <button className="button button-primary" disabled={!slug || !hosts.trim()}>
          Add platform
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

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
      verified_match: String(v.verified_match ?? ""),
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
          verified_match: Number(form.verified_match),
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
          Telegram isn't set up: reviews wait in the Review Queue only. To use a Telegram group,
          enter the bot token under Connections → Telegram and press Connect the bot.
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
            label="Verified answer match"
            type="number"
            step="0.01"
            min={0.5}
            max={1}
            hint="How close (0.5–1) a question must be to a verified answer for it to be reused."
            value={form.verified_match ?? ""}
            error={errors.verified_match}
            onChange={set("verified_match")}
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
          Pinecone isn't set up yet, so documents can't be searched. Enter the API key under
          Connections → Pinecone, press Test and create index, then press Rebuild index here.
          Changes made meanwhile are kept and sent once it's set up.
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
