import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";
import { ROLE_NAMES } from "../labels";

export function Profile() {
  const { user, updated } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [nameMsg, setNameMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({});
  const [pwMsg, setPwMsg] = useState("");

  if (!user) return null;

  async function saveName(event: FormEvent) {
    event.preventDefault();
    try {
      updated(await api.updateProfile(name));
      setNameMsg({ kind: "success", text: "Saved." });
    } catch (err) {
      setNameMsg({ kind: "error", text: err instanceof ApiError ? err.message : "Not saved." });
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    setPwErrors({});
    setPwMsg("");
    try {
      setPwMsg((await api.changePassword(current, next)).message);
      setCurrent("");
      setNext("");
    } catch (err) {
      if (err instanceof ApiError) setPwErrors({ form: err.message, ...err.fields });
    }
  }

  return (
    <section className="page">
      <h1>Profile</h1>
      <div className="card stack">
        <p className="muted">
          {user.email} · {ROLE_NAMES[user.role]}
        </p>
        <form onSubmit={saveName} className="stack">
          {nameMsg && <Alert kind={nameMsg.kind}>{nameMsg.text}</Alert>}
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div>
            <button className="button button-primary">Save name</button>
          </div>
        </form>
      </div>
      <div className="card stack">
        <h2>Change password</h2>
        <p className="muted">Your other devices will be signed out.</p>
        <form onSubmit={savePassword} className="stack">
          {pwMsg && <Alert kind="success">{pwMsg}</Alert>}
          {pwErrors.form && !pwErrors.current_password && !pwErrors.new_password && (
            <Alert kind="error">{pwErrors.form}</Alert>
          )}
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            error={pwErrors.current_password}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
            value={next}
            error={pwErrors.new_password}
            onChange={(e) => setNext(e.target.value)}
          />
          <div>
            <button className="button button-primary">Change password</button>
          </div>
        </form>
      </div>
      <AlertEmail />
    </section>
  );
}

function AlertEmail() {
  const { user, updated } = useAuth();
  const [error, setError] = useState("");
  if (!user) return null;
  return (
    <div className="card stack">
      <h2>Alerts</h2>
      <p className="muted">
        Owners and Admins are emailed when a run fails, an agent stops answering or a budget is used
        up. Owners also hear about low DataForSEO balance and broken connections. The Telegram group
        gets them too, as the Owner set on the Overview.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <label className="check">
        <input
          type="checkbox"
          checked={user.alert_email}
          onChange={async (e) => {
            setError("");
            try {
              updated(await api.setAlertEmail(e.target.checked));
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Not saved.");
            }
          }}
        />
        Email me alerts
      </label>
    </div>
  );
}
