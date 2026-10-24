import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type ConnectionField, type Connections as Data } from "../api";
import { Alert } from "../components/ui";

// Settings → Connections (SPEC section 7.8): API keys and connection details, entered here
// instead of on the server. Keys are write-only: once saved, only their last four
// characters are shown.

const TEST_LABEL: Record<string, string> = {
  anthropic: "Test the key",
  pinecone: "Test and create index",
  telegram: "Connect the bot",
  email: "Send a test email",
};

const HELP: Record<string, string> = {
  anthropic: "From console.anthropic.com → API keys. Used to read scans and write every answer.",
  pinecone:
    "From app.pinecone.io → API keys. After saving, press Test and create index, then Rebuild index under Knowledge base.",
  telegram:
    "From @BotFather in Telegram (/newbot). After saving, press Connect the bot, then add it to your reviewers' group.",
  email:
    "From your email provider. Used for invites, password resets and notifications. Port 587 (or 465).",
};

const SOURCE: Record<string, string> = {
  portal: "saved here",
  server: "from the server's .env",
  default: "default",
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
    <div className="card stack" id="connections">
      <h2>Connections</h2>
      <p className="muted">
        The services the Answer Engine uses. Keys are stored encrypted and can't be read back: after
        saving, only their last four characters show. To change one, paste the new key.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {data?.groups.map((g) => (
        // A new key per saved state starts the form again from what was saved.
        <ConnectionGroup key={`${g.id}:${JSON.stringify(g.fields)}`} group={g} onSaved={setData} />
      ))}
    </div>
  );
}

function ConnectionGroup({
  group,
  onSaved,
}: {
  group: Data["groups"][number];
  onSaved: (data: Data) => void;
}) {
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(group.fields.map((f) => [f.name, f.secret ? "" : (f.value ?? "")])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState("");

  // Only what was typed or changed is sent: an empty secret box keeps the saved key.
  const changes = (): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    for (const f of group.fields) {
      const value = (form[f.name] ?? "").trim();
      if (f.secret ? value !== "" : value !== (f.value ?? "")) out[f.name] = value || null;
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
      setNotice({ kind: "success", text: "Saved." });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setNotice({ kind: "error", text: err.message });
      }
    } finally {
      setBusy("");
    }
  }

  async function remove(field: ConnectionField) {
    setBusy(field.name);
    setNotice(null);
    try {
      onSaved(await api.updateConnections({ [field.name]: null }));
      setNotice({ kind: "success", text: `${field.label} removed.` });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not removed." });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testConnection(group.id);
      setNotice({ kind: result.ok ? "success" : "error", text: result.message });
      onSaved(await api.connections());
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not tested." });
    } finally {
      setBusy("");
    }
  }

  // Read the value now: React resets a controlled field before a state updater runs.
  const set = (key: string) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  return (
    <form className="connection" onSubmit={save} aria-labelledby={`conn-${group.id}`}>
      <div className="connection-head">
        <h3 id={`conn-${group.id}`}>{group.name}</h3>
        <span className={`pill ${group.ready ? "pill-active" : "pill-deactivated"}`}>
          {group.ready ? "Set up" : "Not set up"}
        </span>
      </div>
      <p className="hint">{HELP[group.id]}</p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      <div className="connection-fields">
        {group.fields.map((f) => {
          const id = `conn-${f.name}`;
          return (
            <div className="field" key={f.name}>
              <label htmlFor={id}>{f.label}</label>
              <input
                id={id}
                type={f.secret ? "password" : f.number ? "number" : "text"}
                autoComplete={f.secret ? "new-password" : "off"}
                spellCheck={false}
                placeholder={
                  f.secret && f.set ? `${f.hint} · paste a new one to replace it` : f.placeholder
                }
                value={form[f.name] ?? ""}
                aria-invalid={errors[f.name] ? true : undefined}
                onChange={set(f.name)}
              />
              {errors[f.name] ? (
                <p className="field-error">{errors[f.name]}</p>
              ) : (
                f.set &&
                f.source && (
                  <p className="hint">
                    {f.secret ? `Set (${f.hint}), ` : ""}
                    {SOURCE[f.source]}
                    {f.secret && f.source === "portal" && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy !== ""}
                          onClick={() => void remove(f)}
                        >
                          Remove
                        </button>
                      </>
                    )}
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
