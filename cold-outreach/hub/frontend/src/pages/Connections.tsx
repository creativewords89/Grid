import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type ConnectionField,
  type ConnectionGroup,
  type Connections as Data,
} from "../api";
import { Alert } from "../components/ui";
import { ago } from "../format";

// Connections (SPEC section 6.1): every key and account the agents use, entered here and
// never on the server. Keys are write-only: once saved, only their last four characters show.

const TEST_LABEL: Record<string, string> = {
  dataforseo: "Test and show balance",
  google: "Test the Sheet and folder",
  pagespeed: "Test the key",
  email: "Send a test email",
  telegram: "Test and find the group",
};

const HELP: Record<string, string> = {
  dataforseo:
    "From app.dataforseo.com → API Access: the API login and API password (not your website password). Used by the GBP audit agent.",
  google:
    "In Google Cloud, create a service account and download its JSON key. Share the Master Sheet and the Drive folder with the service account's email as Editor. The folder should be in a Shared Drive.",
  pagespeed:
    "From Google Cloud → APIs & Services → Credentials, with the PageSpeed Insights API turned on. Used by the Website audit agent.",
  email:
    "From your email provider. Used for invites, password resets and alerts. Port 587 (or 465).",
  telegram:
    "Create a bot with @BotFather (/newbot) and paste its token. Add the bot to your alerts group and send any message there, then press Test: the group is found and saved.",
};

type Notice = { kind: "error" | "success"; text: string } | null;

export function Connections() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .connections()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="page">
      <h1>Connections</h1>
      <p className="muted">
        The services the agents use. Keys are stored encrypted and can't be read back: after saving,
        only their last four characters show. To change one, paste the new key.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {data?.groups.map((g) => (
        // A new key per saved state starts the form again from what was saved.
        <Group key={`${g.id}:${JSON.stringify(g.fields)}`} group={g} onSaved={setData} />
      ))}
    </section>
  );
}

function Group({ group, onSaved }: { group: ConnectionGroup; onSaved: (data: Data) => void }) {
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(group.fields.map((f) => [f.name, secret(f) ? "" : (f.value ?? "")])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState("");

  // Only what was typed or changed is sent: an empty secret box keeps the saved key.
  const changes = (): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    for (const f of group.fields) {
      const value = (form[f.name] ?? "").trim();
      if (secret(f) ? value !== "" : value !== (f.value ?? "")) out[f.name] = value || null;
    }
    return out;
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    const values = changes();
    if (Object.keys(values).length === 0) {
      setNotice({ kind: "error", text: "Nothing to save: type a new value first." });
      return;
    }
    setBusy("save");
    setNotice(null);
    setErrors({});
    try {
      onSaved(await api.updateConnections(values));
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setNotice({ kind: "error", text: err.message });
      }
      setBusy("");
    }
  }

  async function remove(field: ConnectionField) {
    setBusy(field.name);
    setNotice(null);
    try {
      onSaved(await api.updateConnections({ [field.name]: null }));
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not removed." });
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    try {
      await api.testConnection(group.id);
      onSaved(await api.connections());
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not tested." });
      setBusy("");
    }
  }

  // Read the value now: React resets a controlled field before a state updater runs.
  const set = (key: string) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function readFile(key: string, file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setForm((f) => ({ ...f, [key]: text }));
  }

  const last = group.last_test;
  return (
    <form className="card stack connection" onSubmit={save} aria-labelledby={`conn-${group.id}`}>
      <div className="connection-head">
        <h2 id={`conn-${group.id}`}>{group.name}</h2>
        <span className={`pill ${group.ready ? "pill-active" : "pill-deactivated"}`}>
          {group.ready ? "Set up" : "Not set up"}
        </span>
      </div>
      <p className="hint">{HELP[group.id]}</p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {last && (
        <Alert kind={last.ok ? "success" : "error"}>
          {last.message} <span className="muted small">(tested {ago(last.at)})</span>
        </Alert>
      )}
      <div className="connection-fields">
        {group.fields.map((f) => {
          const id = `conn-${f.name}`;
          const typed = form[f.name] ?? "";
          return (
            <div className="field" key={f.name}>
              <label htmlFor={id}>
                {f.label}
                {!f.required && <span className="muted small"> (optional)</span>}
              </label>
              {f.kind === "json" ? (
                <>
                  <input
                    id={id}
                    type="file"
                    accept=".json,application/json"
                    aria-invalid={errors[f.name] ? true : undefined}
                    onChange={(e) => void readFile(f.name, e.target.files?.[0])}
                  />
                  {typed && <p className="hint">Key file ready to save.</p>}
                </>
              ) : (
                <input
                  id={id}
                  type={f.kind === "secret" ? "password" : f.kind === "number" ? "number" : "text"}
                  autoComplete={f.kind === "secret" ? "new-password" : "off"}
                  spellCheck={false}
                  placeholder={
                    f.kind === "secret" && f.set
                      ? `${f.hint} · paste a new one to replace it`
                      : f.placeholder
                  }
                  value={typed}
                  aria-invalid={errors[f.name] ? true : undefined}
                  onChange={set(f.name)}
                />
              )}
              {errors[f.name] ? (
                <p className="field-error">{errors[f.name]}</p>
              ) : f.unreadable ? (
                <p className="field-error">
                  Saved before the server's secret key changed: enter it again.
                </p>
              ) : (
                secret(f) &&
                f.set && (
                  <p className="hint">
                    Saved{f.hint ? ` (${f.hint})` : ""} ·{" "}
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy !== ""}
                      onClick={() => void remove(f)}
                    >
                      Remove
                    </button>
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>
      <div className="row">
        <button className="button button-primary" disabled={busy !== ""}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy !== "" || !group.ready}
          onClick={() => void test()}
        >
          {busy === "test" ? "Checking…" : TEST_LABEL[group.id]}
        </button>
      </div>
    </form>
  );
}

function secret(field: ConnectionField): boolean {
  return field.kind === "secret" || field.kind === "json";
}
