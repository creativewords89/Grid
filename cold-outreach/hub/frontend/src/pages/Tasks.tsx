import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Task } from "../api";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";

// Tasks (SPEC sections 6.7 and 7): the jobs a batch can have done and what each needs first.
// Every agent says which task it does; in a batch you choose one or more agents for each.

export function Tasks() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .tasks()
      .then(setTasks)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(load, [load]);

  if (!user) return null;
  const staff = user.role === "owner" || user.role === "admin";

  async function remove(task: Task) {
    setError("");
    try {
      await api.deleteTask(task.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not deleted.");
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Tasks</h1>
          <p className="muted small">
            The jobs a batch can have done, and what each one needs first. Every agent says which
            task it does; in a batch you choose the agents for each task.
          </p>
        </div>
        {staff && editing === null && (
          <button className="button button-primary" onClick={() => setEditing("new")}>
            + New task
          </button>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {editing !== null && tasks && (
        <TaskForm
          task={editing === "new" ? null : editing}
          all={tasks}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {tasks?.length === 0 && (
        <p className="muted">No tasks yet. An agent&apos;s task appears when it first connects.</p>
      )}
      {tasks && tasks.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Needs first</th>
                <th>Agents that do it</th>
                <th className="hide-narrow">Used by</th>
                {staff && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <div className="cell-strong">{task.name}</div>
                    <div className="muted small">{task.about}</div>
                  </td>
                  <td>{task.needs.map((n) => n.name).join(", ") || "Lead file"}</td>
                  <td className="small">
                    {task.bots.map((b) => b.name).join(", ") || (
                      <span className="field-error">No agent yet</span>
                    )}
                  </td>
                  <td className="hide-narrow small">{task.batches.join(", ") || "—"}</td>
                  {staff && (
                    <td className="nowrap">
                      <button
                        className="link-button"
                        aria-label={`Edit ${task.name}`}
                        onClick={() => setEditing(task)}
                      >
                        Edit
                      </button>
                      {task.can_delete && (
                        <>
                          {" · "}
                          <button
                            className="link-button"
                            aria-label={`Delete ${task.name}`}
                            onClick={() => void remove(task)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TaskForm({
  task,
  all,
  onCancel,
  onSaved,
}: {
  task: Task | null;
  all: Task[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(task?.key ?? "");
  const [name, setName] = useState(task?.name ?? "");
  const [about, setAbout] = useState(task?.about ?? "");
  const [needs, setNeeds] = useState<string[]>(task?.needs.map((n) => n.key) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setErrors({});
    try {
      if (task) await api.updateTask(task.id, { name, about, needs });
      else await api.createTask({ key, name, about, needs });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.message);
      }
      setBusy(false);
    }
  }

  return (
    <form
      className="card stack"
      onSubmit={submit}
      aria-label={task ? `Edit ${task.name}` : "New task"}
      noValidate
    >
      <h2>{task ? `Edit ${task.name}` : "New task"}</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="connection-fields">
        <Field
          label="Name"
          placeholder="Review Check"
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        {!task && (
          <Field
            label="Key"
            placeholder="review-check"
            hint="Agents name their task with this key in their manifest."
            value={key}
            error={errors.key}
            onChange={(e) => setKey(e.target.value)}
          />
        )}
        <Field
          label="What it does"
          value={about}
          error={errors.about}
          onChange={(e) => setAbout(e.target.value)}
        />
      </div>
      <fieldset className="plain stack-tight">
        <legend className="small">Needs first (the lead file is always needed)</legend>
        <div className="row">
          {all
            .filter((t) => t.id !== task?.id)
            .map((t) => (
              <label key={t.id} className="row small">
                <input
                  type="checkbox"
                  checked={needs.includes(t.key)}
                  onChange={(e) =>
                    setNeeds(
                      e.target.checked ? [...needs, t.key] : needs.filter((n) => n !== t.key),
                    )
                  }
                />
                {t.name}
              </label>
            ))}
        </div>
        {errors.needs && <p className="field-error">{errors.needs}</p>}
      </fieldset>
      <div className="row">
        <button className="button button-primary" disabled={busy}>
          Save task
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
