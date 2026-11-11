import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type ApiKeyRow } from "../api";
import { Alert, Confirm } from "../components/ui";
import { formatDate } from "../format";

// Settings → API keys (SPEC sections 4 and 7.8, step 28): keys for scripts and assistants.
// A key is shown once; it acts as the Owner who made it, only within its scopes.

const EXPIRY: [string, string][] = [
  ["30", "30 days"],
  ["90", "90 days"],
  ["365", "1 year"],
  ["never", "Never"],
];

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>(["facebook"]);
  const [expiry, setExpiry] = useState("90");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(() => {
    api
      .apiKeys()
      .then((data) => (setKeys(data.items), setScopes(data.scopes)))
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
  }, []);
  useEffect(load, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    setCopied(false);
    try {
      const made = await api.createApiKey({
        name,
        scopes: chosen,
        expires_days: expiry === "never" ? null : Number(expiry),
      });
      setToken(made.token);
      setName("");
      load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not created." });
    }
  }

  async function revoke(key: ApiKeyRow) {
    setRevoking(null);
    try {
      await api.revokeApiKey(key.id);
      setNotice({ kind: "success", text: `“${key.name}” is revoked. It stops working now.` });
      load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not revoked." });
    }
  }

  return (
    <div className="card stack">
      <h2>API keys</h2>
      <p className="muted">
        For scripts and assistants that load or save Facebook answers without signing in. A key acts
        as the Owner who made it, but only for what you tick. Treat it like a password.
      </p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {token && (
        <Alert kind="success">
          <strong>Copy this key now. You won&apos;t see it again.</strong>
          <code className="api-key">{token}</code>
          <button
            className="button button-small"
            onClick={() =>
              void navigator.clipboard
                .writeText(token)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>{" "}
          <button className="link-button" onClick={() => setToken("")}>
            I&apos;ve saved it
          </button>
        </Alert>
      )}
      <form className="stack" onSubmit={(e) => void create(e)}>
        <label htmlFor="key-name">Name</label>
        <input
          id="key-name"
          className="input"
          placeholder="e.g. Claude data sync"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="stack-tight">
          <legend>What it may do</legend>
          {Object.entries(scopes).map(([scope, label]) => (
            <label key={scope} className="inline">
              <input
                type="checkbox"
                checked={chosen.includes(scope)}
                onChange={(e) =>
                  setChosen(
                    e.target.checked ? [...chosen, scope] : chosen.filter((s) => s !== scope),
                  )
                }
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>
        <label htmlFor="key-expiry">Expires after</label>
        <select
          id="key-expiry"
          className="input"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
        >
          {EXPIRY.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <div className="row">
          <button className="button button-primary" disabled={!name.trim() || !chosen.length}>
            Create a key
          </button>
        </div>
      </form>
      {keys && keys.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Can</th>
              <th>Made by</th>
              <th>Expires</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>
                  <code>{k.prefix}…</code>
                </td>
                <td>{k.scopes.join(", ")}</td>
                <td>{k.made_by.name}</td>
                <td>{k.expires_at ? formatDate(k.expires_at) : "Never"}</td>
                <td>{k.last_used_at ? formatDate(k.last_used_at) : "Not yet"}</td>
                <td>
                  {k.revoked_at ? (
                    <span className="muted">Revoked</span>
                  ) : (
                    <button className="button button-small" onClick={() => setRevoking(k)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revoking && (
        <Confirm
          title={`Revoke “${revoking.name}”?`}
          message="Anything using it stops working straight away. This can't be undone."
          confirmLabel="Revoke"
          danger
          onConfirm={() => void revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
