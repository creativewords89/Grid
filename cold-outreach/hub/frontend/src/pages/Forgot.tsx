import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { Alert, AuthCard, Field } from "../components/ui";
import { navigate } from "../router";

export function Forgot() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      setDone((await api.forgot(email)).message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Reset your password">
      {done ? (
        <Alert kind="success">{done}</Alert>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="muted">Enter your email and we'll send you a link to set a new password.</p>
          {error && <Alert kind="error">{error}</Alert>}
          <Field
            label="Email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="button button-primary button-wide" disabled={busy}>
            Send link
          </button>
        </form>
      )}
      <p className="auth-foot">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Back to sign in
        </a>
      </p>
    </AuthCard>
  );
}
