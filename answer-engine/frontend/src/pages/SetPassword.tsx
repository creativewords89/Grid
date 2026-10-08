import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Alert, AuthCard, Field } from "../components/ui";
import { hashToken, navigate } from "../router";

type Mode = "invite" | "reset";

const TEXT: Record<Mode, { title: string; button: string }> = {
  invite: { title: "Welcome! Set your password", button: "Set password and sign in" },
  reset: { title: "Choose a new password", button: "Save new password" },
};

/** Accept an invite (/invite#token) or finish a password reset (/reset#token). */
export function SetPassword({ mode, onReset }: { mode: Mode; onReset: (message: string) => void }) {
  const { signedIn } = useAuth();
  const [token] = useState(hashToken);
  const [person, setPerson] = useState<{ name: string; email: string } | null>(null);
  const [linkError, setLinkError] = useState(
    token ? "" : "This link is incomplete. Open it again from your email.",
  );
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ password?: string; repeat?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .checkToken(token, mode)
      .then(setPerson)
      .catch((err: unknown) =>
        setLinkError(err instanceof ApiError ? err.message : "Something went wrong."),
      );
  }, [token, mode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) {
      setErrors({ repeat: "The passwords don't match." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      if (mode === "invite") {
        signedIn(await api.acceptInvite(token, password));
        navigate("/", true);
      } else {
        onReset((await api.resetPassword(token, password)).message);
        navigate("/", true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.fields.password)
        setErrors({ password: err.fields.password });
      else setErrors({ form: err instanceof ApiError ? err.message : "Something went wrong." });
      setBusy(false);
    }
  }

  if (linkError) {
    return (
      <AuthCard title={TEXT[mode].title}>
        <Alert kind="error">{linkError}</Alert>
        <p className="auth-foot">
          <a
            href="/forgot"
            onClick={(e) => {
              e.preventDefault();
              navigate("/forgot", true);
            }}
          >
            Ask for a new link
          </a>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={TEXT[mode].title}>
      {!person ? (
        <p className="muted">Checking your link…</p>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="muted">
            {person.name} · {person.email}
          </p>
          {errors.form && <Alert kind="error">{errors.form}</Alert>}
          <input type="hidden" autoComplete="username" value={person.email} readOnly />
          <Field
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters. A few unrelated words works well."
            error={errors.password}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field
            label="Repeat password"
            type="password"
            autoComplete="new-password"
            error={errors.repeat}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
          <button className="button button-primary button-wide" disabled={busy}>
            {TEXT[mode].button}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
