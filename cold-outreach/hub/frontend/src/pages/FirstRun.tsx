import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, AuthCard, Field } from "../components/ui";
import { navigate } from "../router";

// Shown instead of Sign in while nobody has an account yet (SPEC section 4).
export function FirstRun() {
  const { signedIn } = useAuth();
  const [form, setForm] = useState({ code: "", name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Read the value now: React resets a controlled field before a state updater runs.
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setErrors({});
    try {
      signedIn(await api.setupOwner(form));
      navigate("/users", true);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.message);
      } else setError("Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Create the Owner account">
      <p className="muted">
        Welcome to the Agent Hub. This page appears only until the first account exists. The Owner
        invites the team and enters the API keys the agents use.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={submit} noValidate>
        <Field
          label="Setup code"
          hint="On the server, run: docker compose exec api python -m app.cli setup-code"
          autoComplete="off"
          required
          value={form.code}
          error={errors.code}
          onChange={set("code")}
        />
        <Field
          label="Your name"
          autoComplete="name"
          required
          value={form.name}
          error={errors.name}
          onChange={set("name")}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={form.email}
          error={errors.email}
          onChange={set("email")}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          required
          value={form.password}
          error={errors.password}
          onChange={set("password")}
        />
        <button className="button button-primary button-wide" disabled={busy}>
          {busy ? "Creating…" : "Create the Owner account"}
        </button>
      </form>
    </AuthCard>
  );
}
