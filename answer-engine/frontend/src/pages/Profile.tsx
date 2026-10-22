import { useState, type FormEvent } from "react";
import { api, ApiError, type NotifyChannel, type TelegramCode } from "../api";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";

const ROLE_NAMES = { owner: "Owner", reviewer: "Reviewer", user: "User" } as const;

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
      <Channel />
      <TelegramLink />
    </section>
  );
}

const CHANNELS: { value: NotifyChannel; label: string; hint: string }[] = [
  { value: "in_app", label: "In the app only", hint: "The 🔔 at the top shows them." },
  { value: "email", label: "Email", hint: "Also sent to your email address." },
  { value: "telegram", label: "Telegram", hint: "Also sent to you by the bot." },
];

function Channel() {
  const { user, updated } = useAuth();
  const [error, setError] = useState("");
  if (!user) return null;

  async function choose(value: NotifyChannel) {
    setError("");
    try {
      updated(await api.setChannel(value));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
    }
  }

  return (
    <div className="card stack">
      <h2>Notifications</h2>
      <p className="muted">
        You're told when our team checks an answer you got, or needs more information from you.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <fieldset className="choices">
        <legend className="sr-only">How to tell you</legend>
        {CHANNELS.map((c) => {
          const off = c.value === "telegram" && !user.telegram_linked;
          return (
            <label key={c.value} className={off ? "choice muted" : "choice"}>
              <input
                type="radio"
                name="channel"
                value={c.value}
                checked={user.notify_channel === c.value}
                disabled={off}
                onChange={() => void choose(c.value)}
              />
              <span>
                <strong>{c.label}</strong>
                <span className="muted small">
                  {" "}
                  — {off ? "link Telegram below first." : c.hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

function TelegramLink() {
  const { user, updated, signedIn } = useAuth();
  const [code, setCode] = useState<TelegramCode | null>(null);
  const [message, setMessage] = useState<{
    kind: "error" | "success" | "info";
    text: string;
  } | null>(null);
  if (!user) return null;

  async function getCode() {
    setMessage(null);
    try {
      setCode(await api.telegramCode());
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Not available." });
    }
  }

  async function check() {
    const me = await api.me();
    signedIn(me);
    if (me.user.telegram_linked) {
      setCode(null);
      setMessage({ kind: "success", text: "Your Telegram is linked." });
    } else {
      setMessage({
        kind: "info",
        text: "Not linked yet. Send the code to the bot, then check again.",
      });
    }
  }

  async function unlink() {
    await api.telegramUnlink();
    const channel = user!.notify_channel === "telegram" ? "email" : user!.notify_channel;
    updated({ ...user!, telegram_linked: false, notify_channel: channel });
    setMessage({ kind: "success", text: "Your Telegram is unlinked." });
  }

  return (
    <div className="card stack">
      <h2>Telegram</h2>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {user.telegram_linked ? (
        <div className="row">
          <span>✔ Linked</span>
          <button className="button button-small" onClick={() => void unlink()}>
            Unlink
          </button>
        </div>
      ) : code ? (
        <div className="stack">
          <p>
            Send this to {code.bot_username ? <strong>@{code.bot_username}</strong> : "the bot"} in
            a private chat. The code works for 10 minutes.
          </p>
          <code className="link-code">/link {code.code}</code>
          {code.bot_username && (
            <a
              href={`https://t.me/${code.bot_username}?start=${code.code}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open the bot in Telegram
            </a>
          )}
          <div>
            <button className="button" onClick={() => void check()}>
              I've sent it
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted">
            {user.role === "user"
              ? "Link Telegram to get your notifications there."
              : "Link Telegram to review answers in the reviewers' group."}
          </p>
          <div>
            <button className="button button-primary" onClick={() => void getCode()}>
              Link Telegram
            </button>
          </div>
        </>
      )}
    </div>
  );
}
