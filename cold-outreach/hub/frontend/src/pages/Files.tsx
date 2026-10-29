import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Batch,
  type FileLead,
  type FileLeadFilters,
  type FileLeadsPage,
  type HandedInFile,
  type HandedInFileDetail,
  type NicheRow,
} from "../api";
import { useAuth } from "../auth";
import { FIELD_NAMES } from "../checkLabels";
import { Alert, Modal } from "../components/ui";
import { day } from "../format";
import { navigate } from "../router";
import { CheckBadge, Pager } from "./Leads";

/** The Files screen (step 31): the external team (Collectors) hand in lead files, see what
 * Lead Check finds and upload revised versions until it has no error; Reviewers then choose
 * each city's Top (Top Review, step 32); an Owner or Admin drags the ready file onto a batch
 * of its niche. A file is used once. */

const STATUS: Record<HandedInFile["status"], [string, string]> = {
  checking: ["badge-warning", "Checking"],
  failed: ["badge-error", "Couldn't read"],
  errors: ["badge-error", "Needs fixing"],
  needs_top: ["badge-warning", "Needs Top"],
  ready: ["badge-ok", "Ready"],
  adding: ["badge-warning", "Being added"],
  used: ["badge", "Used"],
};

type Filter = "" | HandedInFile["status"];
const FILTERS: [Filter, string][] = [
  ["", "All"],
  ["checking", "Checking"],
  ["errors", "Needs fixing"],
  ["needs_top", "Needs Top"],
  ["ready", "Ready"],
  ["adding", "Being added"],
  ["used", "Used"],
];
const DRAG_TYPE = "application/x-hub-file";
const POLL_MS = 2000; // how often a file being checked is looked at again

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function sameNiche(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function Files() {
  const { user } = useAuth();
  const [items, setItems] = useState<HandedInFile[] | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("");
  const [dragging, setDragging] = useState<HandedInFile | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const role = user?.role;
  const staff = role === "owner" || role === "admin";
  const canHandIn = staff || role === "collector";

  const load = useCallback(() => {
    api
      .files()
      .then(setItems)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, []);
  useEffect(load, [load]);
  // Files are checked on the server (step 33): look again while one is being checked.
  const checking = (items ?? []).some((f) => f.status === "checking");
  useEffect(() => {
    if (!checking || open) return;
    const timer = window.setTimeout(load, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [checking, items, open, load]);
  useEffect(() => {
    if (staff)
      api
        .batches()
        .then(setBatches)
        .catch(() => setBatches([]));
  }, [staff]);

  if (!user) return null;

  async function addToBatch(item: HandedInFile, batch: Batch) {
    setError("");
    setNotice("");
    if (!sameNiche(item.niche, batch.niche)) {
      setError(`${item.file_name} is for ${item.niche}; ${batch.name} is a ${batch.niche} batch.`);
      return;
    }
    try {
      await api.useFile(item.id, batch.id);
      // The batch shows the file's preview: confirm it there.
      navigate(`/batches?batch=${batch.id}&tab=files`);
    } catch (err) {
      setError(message(err, "Not added."));
      load();
    }
  }

  if (open) {
    return (
      <section className="page page-wide">
        {error && <Alert kind="error">{error}</Alert>}
        <FileView
          id={open}
          staff={staff}
          batches={batches}
          onClose={() => {
            setOpen(null);
            setNotice("");
            load();
          }}
          onChanged={load}
          onAdd={(item, batch) => void addToBatch(item, batch)}
        />
      </section>
    );
  }

  const shown = (items ?? []).filter((f) => !filter || f.status === filter);
  const counts = Object.fromEntries(
    FILTERS.map(([key]) => [key, (items ?? []).filter((f) => !key || f.status === key).length]),
  );

  return (
    <section className="page page-wide">
      <div className="page-head">
        <div className="stack-tight">
          <h1>Files</h1>
          <p className="muted files-intro">
            {role === "collector"
              ? "Hand in your lead files. Lead Check marks every problem: fix them and upload the revised version until the file is ready."
              : "Lead files handed in by the team. A ready file can be added to a batch of its niche, once."}
          </p>
        </div>
        {staff && <NichesButton />}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {canHandIn && (
        <HandIn
          onDone={(item) => {
            load();
            setNotice(
              `${item.file_name} is uploaded and being checked. You can leave this page: the check goes on, and its result is here when you come back.`,
            );
          }}
        />
      )}

      <div className={staff ? "files-layout" : undefined}>
        <div className="card table-card stack-tight">
          <div className="files-filters" role="group" aria-label="Show">
            {FILTERS.map(([key, label]) => (
              <button
                key={key || "all"}
                className={`chip ${filter === key ? "chip-on" : ""}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label} <span className="muted">{counts[key]}</span>
              </button>
            ))}
          </div>
          {items === null ? (
            <p className="muted">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="muted">{items.length === 0 ? "No files yet." : "No file here."}</p>
          ) : (
            <div className="table-scroll">
              <table className="table files-table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Niche</th>
                    <th className="num">Businesses</th>
                    {role !== "collector" && <th className="hide-narrow">Handed in by</th>}
                    <th className="hide-narrow">Updated</th>
                    <th>Lead Check</th>
                    <th>Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <FileRow
                      key={item.id}
                      item={item}
                      staff={staff}
                      collector={role === "collector"}
                      onOpen={() => setOpen(item.id)}
                      onDrag={setDragging}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {staff && (
          <BatchTargets
            batches={batches}
            dragging={dragging}
            onDrop={(item, batch) => void addToBatch(item, batch)}
            files={items ?? []}
          />
        )}
      </div>
    </section>
  );
}

const NEW_NICHE = "\u0000new";

function HandIn({ onDone }: { onDone: (item: HandedInFileDetail) => void }) {
  const [niches, setNiches] = useState<string[]>([]);
  const [niche, setNiche] = useState("");
  const [adding, setAdding] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const loadNiches = useCallback((choose?: string) => {
    api
      .fileNiches()
      .then((found) => {
        setNiches(found);
        if (choose) setNiche(choose);
        else if (found.length === 1) setNiche(found[0]!);
      })
      .catch(() => setNiches([]));
  }, []);
  useEffect(() => loadNiches(), [loadNiches]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!niche) return setError("Choose the niche.");
    if (!file) return setError("Choose an Excel file (.xlsx).");
    setSent(0);
    setError("");
    try {
      // Uploading is shown as it goes; the check then runs on the server (step 33).
      onDone(await api.handIn(file, niche, setSent));
      if (input.current) input.current.value = "";
    } catch (err) {
      setError(message(err, "Not uploaded."));
    } finally {
      setSent(null);
    }
  }

  return (
    <form className="card stack-tight" onSubmit={(e) => void submit(e)}>
      <h2>Hand in a lead file</h2>
      <div className="row files-hand-in">
        <label className="field">
          <span>Niche</span>
          <select
            value={niche}
            onChange={(e) => {
              if (e.target.value === NEW_NICHE) setAdding(true);
              else setNiche(e.target.value);
            }}
            required
          >
            <option value="">Choose…</option>
            {niches.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={NEW_NICHE}>+ New niche…</option>
          </select>
        </label>
        <label className="field">
          <span>Excel file (.xlsx), one tab per city</span>
          <input ref={input} type="file" accept=".xlsx" disabled={sent !== null} />
        </label>
        <button className="button button-primary" disabled={sent !== null}>
          {sent === null ? "Upload and check" : `Uploading ${sent}%`}
        </button>
      </div>
      {sent !== null && <ProgressBar percent={sent} label="Uploading" />}
      {sent !== null && (
        <p className="small muted">Keep this page open until the upload is done.</p>
      )}
      {adding && (
        <NewNiche
          onCancel={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            loadNiches(name);
          }}
        />
      )}
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}

function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Add a niche; a spelling close to a known one is asked about first. */
function NewNiche({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [similar, setSimilar] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(confirm: boolean) {
    setBusy(true);
    setError("");
    try {
      onAdded((await api.addNiche(name, confirm)).name);
    } catch (err) {
      if (err instanceof ApiError && err.code === "similar")
        setSimilar(String(err.details.similar ?? ""));
      else setError(message(err, "Not added."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="files-new-niche stack-tight" role="group" aria-label="Add a niche">
      <div className="row">
        <label className="field">
          <span>New niche</span>
          <input
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              setSimilar("");
            }}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={busy || name.trim().length < 2}
          onClick={() => void add(false)}
        >
          Add
        </button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {similar && (
        <div className="row">
          <span>Did you mean {similar}?</span>
          <button type="button" className="button button-small" onClick={() => onAdded(similar)}>
            Use {similar}
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={() => void add(true)}
          >
            Add “{name.trim()}” anyway
          </button>
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** Owners and Admins rename niches (everything of it follows) and delete unused ones. */
function NichesButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button" onClick={() => setOpen(true)}>
        Niches
      </button>
      {open && <NichesDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NichesDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<NicheRow[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .allNiches()
      .then(setRows)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, []);
  useEffect(load, [load]);

  async function act(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      setEditing(null);
      load();
    } catch (err) {
      setError(message(err, "Not saved."));
    }
  }

  return (
    <Modal title="Niches" onClose={onClose}>
      {error && <Alert kind="error">{error}</Alert>}
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="table compact-table">
          <thead>
            <tr>
              <th>Niche</th>
              <th className="num">Used by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <td>
                  {editing === n.id ? (
                    <input
                      aria-label={`New name for ${n.name}`}
                      value={name}
                      maxLength={80}
                      onChange={(e) => setName(e.target.value)}
                    />
                  ) : (
                    n.name
                  )}
                </td>
                <td className="num">{n.uses}</td>
                <td className="nowrap">
                  {editing === n.id ? (
                    <>
                      <button
                        className="button button-small"
                        onClick={() => void act(() => api.renameNiche(n.id, name))}
                      >
                        Save
                      </button>{" "}
                      <button className="link-button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="link-button"
                        onClick={() => {
                          setEditing(n.id);
                          setName(n.name);
                        }}
                      >
                        Rename
                      </button>
                      {n.uses === 0 && (
                        <>
                          {" · "}
                          <button
                            className="link-button"
                            onClick={() => void act(() => api.deleteNiche(n.id))}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted">
        Renaming a niche renames it on its files, batches, benchmarks and leads. A niche in use
        can't be deleted.
      </p>
    </Modal>
  );
}

function CheckCell({ item }: { item: HandedInFile }) {
  if (item.status === "checking")
    return (
      <span className="nowrap stack-tight">
        <span className="badge badge-warning">Checking {item.progress}%</span>
        <ProgressBar percent={item.progress} label={`Checking ${item.file_name}`} />
      </span>
    );
  return (
    <span className="nowrap">
      <span className={`badge ${STATUS[item.status][0]}`}>{STATUS[item.status][1]}</span>
      {item.errors > 0 && <span className="small">🔴 {item.errors}</span>}{" "}
      {item.warnings > 0 && <span className="small muted">🟠 {item.warnings}</span>}
    </span>
  );
}

function UsedIn({ item }: { item: HandedInFile }) {
  if (!item.batch) return <span className="muted">—</span>;
  const when = item.batch.at ? day(item.batch.at) : "";
  const verb = item.status === "used" ? "Used in" : "Waiting in";
  return (
    <span className="small">
      {verb} <strong>{item.batch.batch_name ?? "a batch"}</strong>
      {when && ` · ${when}`}
      {item.batch.by && ` · by ${item.batch.by}`}
    </span>
  );
}

function FileRow({
  item,
  staff,
  collector,
  onOpen,
  onDrag,
}: {
  item: HandedInFile;
  staff: boolean;
  collector: boolean;
  onOpen: () => void;
  onDrag: (item: HandedInFile | null) => void;
}) {
  const movable = staff && item.status === "ready";
  return (
    <tr
      className={movable ? "file-draggable" : undefined}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "copy";
        onDrag(item);
      }}
      onDragEnd={() => onDrag(null)}
      title={movable ? "Drag onto a batch" : undefined}
    >
      <td>
        {movable && (
          <span className="drag-handle" aria-hidden>
            ⠿{" "}
          </span>
        )}
        <button className="link-button cell-strong" onClick={onOpen}>
          {item.file_name}
        </button>
        <div className="small muted">
          Version {item.version}
          {item.same_as && <span className="files-same"> · ⚠ {item.same_as}</span>}
        </div>
      </td>
      <td>{item.niche}</td>
      <td className="num">{item.businesses.toLocaleString()}</td>
      {!collector && <td className="hide-narrow">{item.uploaded_by ?? "—"}</td>}
      <td className="hide-narrow small nowrap">{day(item.updated_at)}</td>
      <td>
        <CheckCell item={item} />
      </td>
      <td>
        <UsedIn item={item} />
      </td>
    </tr>
  );
}

function BatchTargets({
  batches,
  dragging,
  files,
  onDrop,
}: {
  batches: Batch[];
  dragging: HandedInFile | null;
  files: HandedInFile[];
  onDrop: (item: HandedInFile, batch: Batch) => void;
}) {
  const [over, setOver] = useState<string | null>(null);

  function drop(event: DragEvent, batch: Batch) {
    event.preventDefault();
    setOver(null);
    const id = event.dataTransfer.getData(DRAG_TYPE);
    const item = files.find((f) => f.id === id);
    if (item) onDrop(item, batch);
  }

  return (
    <aside className="card stack-tight files-batches" aria-label="Batches">
      <h2>Batches</h2>
      <p className="small muted">Drag a ready file onto a batch of its niche.</p>
      {batches.length === 0 && <p className="muted">No batch yet.</p>}
      {batches.map((batch) => {
        const fits = !dragging || sameNiche(dragging.niche, batch.niche);
        return (
          <div
            key={batch.id}
            className={`file-target ${over === batch.id ? "over" : ""} ${fits ? "" : "no-fit"}`}
            onDragOver={(e) => {
              if (!fits) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(batch.id);
            }}
            onDragLeave={() => setOver((o) => (o === batch.id ? null : o))}
            onDrop={(e) => drop(e, batch)}
          >
            <strong>{batch.name}</strong>
            <span className="small muted">
              {batch.niche} · {batch.leads.toLocaleString()} businesses · {batch.files} files
            </span>
          </div>
        );
      })}
    </aside>
  );
}

/** A file on its own page: its state, what to do next and its businesses (step 33). */
function FileView({
  id,
  staff,
  batches,
  onClose,
  onChanged,
  onAdd,
}: {
  id: string;
  staff: boolean;
  batches: Batch[];
  onClose: () => void;
  onChanged: () => void;
  onAdd: (item: HandedInFile, batch: Batch) => void;
}) {
  const [item, setItem] = useState<HandedInFileDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api
      .file(id)
      .then(setItem)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [id]);
  useEffect(load, [load]);
  // Checked on the server (step 33): look again until it is done.
  useEffect(() => {
    if (item?.status !== "checking") return;
    const timer = window.setTimeout(load, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [item, load]);

  async function revise() {
    const file = input.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setSent(0);
    setError("");
    try {
      setItem(await api.reviseFile(id, file, setSent));
      onChanged();
    } catch (err) {
      setError(message(err, "Not uploaded."));
    } finally {
      setBusy(false);
      setSent(null);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    if (!item || !window.confirm(`Delete ${item.file_name}?`)) return;
    setBusy(true);
    try {
      await api.deleteFile(id);
      onChanged();
      onClose();
    } catch (err) {
      setError(message(err, "Not deleted."));
      setBusy(false);
    }
  }

  // Once a file has no error the Collectors are done: only Owners and Admins delete it then.
  const fixing = ["checking", "failed", "errors"];
  const revisable = item && (item.mine || staff) && fixing.includes(item.status);
  const deletable =
    item &&
    (staff ? [...fixing, "needs_top", "ready"] : fixing).includes(item.status) &&
    (item.mine || staff);

  async function reopen() {
    setBusy(true);
    setError("");
    try {
      await api.reopenFile(id);
      setItem(await api.file(id));
      onChanged();
    } catch (err) {
      setError(message(err, "Not reopened."));
    } finally {
      setBusy(false);
    }
  }
  const fitting = item ? batches.filter((b) => sameNiche(b.niche, item.niche)) : [];
  const columnWarnings = item
    ? Object.entries(item.tabs).flatMap(([tab, t]) => t.columns.map((c) => ({ tab, ...c })))
    : [];

  return (
    <>
      <div className="small muted">
        <a
          href="/files"
          onClick={(e) => {
            e.preventDefault();
            onClose();
          }}
        >
          Files
        </a>{" "}
        / {item?.file_name}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!item ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
          <h1>{item.file_name}</h1>
          <div className="row">
            <CheckCell item={item} />
            <span className="small muted">
              {item.niche} · version {item.version} · {item.businesses.toLocaleString()} businesses
              {item.uploaded_by && ` · handed in by ${item.uploaded_by}`}
            </span>
          </div>
          {item.same_as && <Alert kind="info">⚠ {item.same_as}</Alert>}
          {item.batch && (
            <p>
              <UsedIn item={item} />
            </p>
          )}
          {item.status === "checking" && (
            <div className="stack-tight">
              <p>
                Lead Check is checking this file on the server: {item.progress}%. You can leave this
                page; the check goes on.
              </p>
              <ProgressBar percent={item.progress} label="Checking" />
            </div>
          )}
          {item.status === "failed" && (
            <Alert kind="error">
              This file couldn't be read: {item.error} Upload a revised version.
            </Alert>
          )}
          {sent !== null && <ProgressBar percent={sent} label="Uploading" />}
          {item.status === "errors" && (
            <p>
              🔴 {item.errors} {item.errors === 1 ? "error" : "errors"} to fix before this file can
              go into a batch. Download the file with each problem marked, fix it in Excel, then
              upload the revised version.
            </p>
          )}
          {item.status === "needs_top" && (
            <p>
              🟡 No errors. Waiting for Top Review: {item.cities_topped} of {item.cities_on}{" "}
              {item.cities_on === 1 ? "city has" : "cities have"} a Top.
            </p>
          )}
          {item.status === "ready" && (
            <p>
              ✅ No errors and every city has a Top
              {item.cities_on === 0 && " (no city has 10 businesses, so none needs one)"}: this file
              is ready to be added to a batch.
            </p>
          )}

          <div className="row">
            {!["checking", "failed"].includes(item.status) && (
              <a className="button" href={`/api/submissions/${item.id}/marked.xlsx`} download>
                <span aria-hidden>⬇</span> Download problems to fix
              </a>
            )}
            {revisable && (
              <label className={`button ${busy ? "disabled" : ""}`}>
                <span aria-hidden>⬆</span> Upload revised version
                <input
                  ref={input}
                  className="sr-only"
                  type="file"
                  accept=".xlsx"
                  disabled={busy}
                  onChange={() => void revise()}
                />
              </label>
            )}
            {staff && item.status === "ready" && (
              <button className="button" disabled={busy} onClick={() => void reopen()}>
                Reopen for Top Review
              </button>
            )}
            {deletable && (
              <button
                className="button button-danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Delete
              </button>
            )}
          </div>

          {staff && item.status === "ready" && (
            <div className="row">
              <label className="field">
                <span>Add to batch</span>
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a {item.niche} batch…</option>
                  {fitting.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-primary"
                disabled={!target}
                onClick={() => {
                  const batch = fitting.find((b) => b.id === target);
                  if (batch) onAdd(item, batch);
                }}
              >
                Add to batch
              </button>
            </div>
          )}

          {columnWarnings.length > 0 && (
            <ul className="check-list small">
              {columnWarnings.map((c, index) => (
                <li key={index}>
                  🟠 {c.tab}: {FIELD_NAMES[c.field] ?? c.field} · {c.message}
                </li>
              ))}
            </ul>
          )}
          {!["checking", "failed"].includes(item.status) && (
            <FileLeads key={`${item.id}-${item.version}`} id={item.id} />
          )}
        </div>
      )}
    </>
  );
}

const TABLE_COLUMNS = [
  "business_name",
  "gbp_link",
  "address",
  "city",
  "website",
  "phone",
  "whatsapp",
  "email",
  "facebook",
  "instagram",
  "reviews",
  "rating",
  "notes",
];
const LINKS = new Set(["gbp_link", "website", "facebook", "instagram"]);

function safeLink(value: string): string | null {
  const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The file's businesses as the Leads tab shows a batch's (step 33): only to look at. Fixes
 * are made in Excel and handed in as a revised version. */
function FileLeads({ id }: { id: string }) {
  const [filters, setFilters] = useState<FileLeadFilters>({ page: 1, sort: "row" });
  const [typed, setTyped] = useState("");
  const [data, setData] = useState<FileLeadsPage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setFilters((f) => (f.search === typed ? f : { ...f, search: typed, page: 1 })),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [typed]);
  useEffect(() => {
    api
      .fileLeads(id, filters)
      .then(setData)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [id, filters]);

  const set = (change: FileLeadFilters) => setFilters((f) => ({ ...f, ...change, page: 1 }));
  const issueOf = (lead: FileLead, field: string) => lead.issues.filter((i) => i.field === field);

  return (
    <section className="stack-tight" aria-label="Businesses in this file">
      <form className="leads-toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="toolbar-search">
          <span className="sr-only">Search</span>
          <input
            type="search"
            placeholder="🔍 Search name, email, phone, website…"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">City</span>
          <select value={filters.city ?? ""} onChange={(e) => set({ city: e.target.value })}>
            <option value="">City: all</option>
            {(data?.cities ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Problems</span>
          <select
            value={filters.problems ?? ""}
            onChange={(e) => set({ problems: e.target.value as FileLeadFilters["problems"] })}
          >
            <option value="">Problems: all ({data?.counts.all ?? 0})</option>
            <option value="errors">🔴 Errors ({data?.counts.errors ?? 0})</option>
            <option value="warnings">🟠 Warnings only ({data?.counts.warnings ?? 0})</option>
            <option value="ok">✓ OK ({data?.counts.ok ?? 0})</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Sort by</span>
          <select
            value={filters.sort ?? "row"}
            onChange={(e) => set({ sort: e.target.value as FileLeadFilters["sort"] })}
          >
            <option value="row">Sort: tab and row</option>
            <option value="problems">Sort: most problems</option>
            <option value="name">Sort: name</option>
            <option value="city">Sort: city</option>
            <option value="reviews">Sort: most reviews</option>
            <option value="rating">Sort: best rating</option>
          </select>
        </label>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <div className="leads-summary">
            <strong>{data.total.toLocaleString()} businesses</strong>
            <Pager data={data} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
          </div>
          <div className="card table-card">
            <div className="table-scroll">
              <table className="table leads-table">
                <thead>
                  <tr>
                    <th>Tab · Row</th>
                    <th>Business name</th>
                    <th>Check</th>
                    {TABLE_COLUMNS.slice(1).map((key) => (
                      <th key={key}>{FIELD_NAMES[key] ?? key}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.leads.map((lead) => (
                    <tr key={lead.rows[0]}>
                      <td className="small nowrap">
                        {lead.tab} · {lead.line}
                      </td>
                      {[TABLE_COLUMNS[0]!, "check", ...TABLE_COLUMNS.slice(1)].map((key) => {
                        if (key === "check")
                          return (
                            <td key={key}>
                              <CheckBadge issues={lead.issues} />
                            </td>
                          );
                        const value = lead.values[key] ?? "";
                        const wrong = issueOf(lead, key);
                        const link = LINKS.has(key) && value ? safeLink(value) : null;
                        return (
                          <td
                            key={key}
                            className={`${wrong.length ? "cell-problem" : ""} ${key === "address" ? "cell-clamp" : "cell-trunc"}`}
                            title={
                              wrong.length
                                ? wrong.map((i) => i.message).join("\n")
                                : value || undefined
                            }
                          >
                            {link ? (
                              <a href={link} target="_blank" rel="noopener noreferrer">
                                {value}
                              </a>
                            ) : (
                              value || <span className="muted">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="leads-summary">
            <span />
            <Pager data={data} onPage={(page) => setFilters((f) => ({ ...f, page }))} />
          </div>
        </>
      )}
    </section>
  );
}
