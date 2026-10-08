import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type LinkResult, type Role, type User } from "../api";
import { useAuth } from "../auth";
import { Alert, CopyLink, Field, Modal } from "../components/ui";

const ROLE_NAMES: Record<Role, string> = {
  owner: "Owner",
  reviewer: "Reviewer",
  user: "User",
};
const ROLES: Role[] = ["user", "reviewer", "owner"];

function status(user: User): string {
  if (!user.active) return "Deactivated";
  return user.invited ? "Invited" : "Active";
}

function lastSeen(value: string | null): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
}

type Notice = { kind: "error" | "success"; text: string; link?: string };

function linkNotice(result: LinkResult, sentText: string, who: string): Notice {
  return result.email_sent
    ? { kind: "success", text: sentText }
    : {
        kind: "success",
        text: `Email isn't set up yet, so copy this link and send it to ${who} yourself. It works once.`,
        link: result.link ?? undefined,
      };
}

export function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const load = useCallback(() => {
    api
      .listUsers()
      .then(setUsers)
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(load, [load]);

  async function linkAction(user: User, action: "invite" | "reset") {
    try {
      const result =
        action === "invite" ? await api.resendInvite(user.id) : await api.sendReset(user.id);
      const sent =
        action === "invite"
          ? `A new invite was emailed to ${user.email}.`
          : `A password reset link was emailed to ${user.email}.`;
      setNotice(linkNotice(result, sent, user.name));
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not sent." });
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Users</h1>
        <button className="button button-primary" onClick={() => setInviting(true)}>
          + Invite
        </button>
      </div>
      {notice && (
        <Alert kind={notice.kind}>
          {notice.text}
          {notice.link && <CopyLink link={notice.link} />}
        </Alert>
      )}
      {loadError && <Alert kind="error">{loadError}</Alert>}
      {users && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Telegram</th>
                <th>Last sign-in</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.active ? undefined : "row-muted"}>
                  <td>
                    <div className="cell-strong">
                      {user.name}
                      {user.id === me?.id && <span className="tag">You</span>}
                    </div>
                    <div className="muted small">{user.email}</div>
                  </td>
                  <td>{ROLE_NAMES[user.role]}</td>
                  <td>
                    <span className={`pill pill-${status(user).toLowerCase()}`}>
                      {status(user)}
                    </span>
                  </td>
                  <td className="hide-narrow">{user.telegram_linked ? "✔" : "✘"}</td>
                  <td className="hide-narrow">{lastSeen(user.last_login_at)}</td>
                  <td className="actions">
                    <button className="button button-small" onClick={() => setEditing(user)}>
                      Edit
                    </button>
                    {user.active && user.invited && (
                      <button
                        className="button button-small"
                        onClick={() => void linkAction(user, "invite")}
                      >
                        Resend invite
                      </button>
                    )}
                    {user.active && !user.invited && (
                      <button
                        className="button button-small"
                        onClick={() => void linkAction(user, "reset")}
                      >
                        Reset password
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onInvited={(result, invited) => {
            setInviting(false);
            setNotice(linkNotice(result, `Invite emailed to ${invited.email}.`, invited.name));
            load();
          }}
        />
      )}
      {editing && (
        <EditDialog
          user={editing}
          isMe={editing.id === me?.id}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice({ kind: "success", text: `${saved.name} was updated.` });
            load();
          }}
        />
      )}
    </section>
  );
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <div className="field">
      <label htmlFor="role">Role</label>
      <select id="role" value={value} onChange={(e) => onChange(e.target.value as Role)}>
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {ROLE_NAMES[role]}
          </option>
        ))}
      </select>
      <p className="hint">Reviewers also handle reviews. Owners manage people and settings.</p>
    </div>
  );
}

function InviteDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (result: LinkResult, user: User) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const result = await api.invite(name, email, role);
      onInvited(result, result.user);
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
      setBusy(false);
    }
  }

  return (
    <Modal title="Invite someone" onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        {errors.form && <Alert kind="error">{errors.form}</Alert>}
        <Field
          label="Name"
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          value={email}
          error={errors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <RoleSelect value={role} onChange={setRole} />
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            Send invite
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditDialog({
  user,
  isMe,
  onClose,
  onSaved,
}: {
  user: User;
  isMe: boolean;
  onClose: () => void;
  onSaved: (user: User) => void;
}) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSaved(await api.updateUser(user.id, { name, role, active }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${user.name}`} onClose={onClose}>
      <form onSubmit={submit} className="stack" noValidate>
        {error && <Alert kind="error">{error}</Alert>}
        <p className="muted">{user.email}</p>
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <RoleSelect value={role} onChange={setRole} />
        {!isMe && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (unticking signs them out and blocks sign-in)
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
