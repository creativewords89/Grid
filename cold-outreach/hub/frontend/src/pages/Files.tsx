import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api, ApiError, type Batch, type HandedInFile, type HandedInFileDetail } from "../api";
import { useAuth } from "../auth";
import { FIELD_NAMES } from "../checkLabels";
import { Alert, Modal } from "../components/ui";
import { day } from "../format";
import { navigate } from "../router";

/** The Files screen (step 31): the external team (Collectors) hand in lead files, see what
 * Lead Check finds and upload revised versions until it has no error; Reviewers then choose
 * each city's Top (Top Review, step 32); an Owner or Admin drags the ready file onto a batch
 * of its niche. A file is used once. */

const STATUS: Record<HandedInFile["status"], [string, string]> = {
  errors: ["badge-error", "Needs fixing"],
  needs_top: ["badge-warning", "Needs Top"],
  ready: ["badge-ok", "Ready"],
  adding: ["badge-warning", "Being added"],
  used: ["badge", "Used"],
};

type Filter = "" | HandedInFile["status"];
const FILTERS: [Filter, string][] = [
  ["", "All"],
  ["errors", "Needs fixing"],
  ["needs_top", "Needs Top"],
  ["ready", "Ready"],
  ["adding", "Being added"],
  ["used", "Used"],
];
const DRAG_TYPE = "application/x-hub-file";

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

  const shown = (items ?? []).filter((f) => !filter || f.status === filter);
  const counts = Object.fromEntries(
    FILTERS.map(([key]) => [key, (items ?? []).filter((f) => !key || f.status === key).length]),
  );

  return (
    <section className="page page-wide">
      <div className="page-head">
        <div className="stack-tight">
          <h1>Files</h1>
          <p className="muted">
            {role === "collector"
              ? "Hand in your lead files. Lead Check marks every problem: fix them and upload the revised version until the file is ready."
              : "Lead files handed in by the team. A ready file can be added to a batch of its niche, once."}
          </p>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}

      {canHandIn && (
        <HandIn
          onDone={(item) => {
            load();
            setNotice(
              item.errors
                ? `${item.file_name}: ${item.errors} to fix. Open it to see where.`
                : `${item.file_name} has no errors: it goes to Top Review.`,
            );
            setOpen(item.id);
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

      {open && (
        <FileDialog
          id={open}
          staff={staff}
          batches={batches}
          onClose={() => setOpen(null)}
          onChanged={load}
          onAdd={(item, batch) => void addToBatch(item, batch)}
        />
      )}
    </section>
  );
}

function HandIn({ onDone }: { onDone: (item: HandedInFileDetail) => void }) {
  const [niches, setNiches] = useState<string[]>([]);
  const [niche, setNiche] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .fileNiches()
      .then((found) => {
        setNiches(found);
        if (found.length === 1) setNiche(found[0]!);
      })
      .catch(() => setNiches([]));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!niche) return setError("Choose the niche.");
    if (!file) return setError("Choose an Excel file (.xlsx).");
    setBusy(true);
    setError("");
    try {
      onDone(await api.handIn(file, niche));
      if (input.current) input.current.value = "";
    } catch (err) {
      setError(message(err, "Not uploaded."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card stack-tight" onSubmit={(e) => void submit(e)}>
      <h2>Hand in a lead file</h2>
      <div className="row files-hand-in">
        <label className="field">
          <span>Niche</span>
          <select value={niche} onChange={(e) => setNiche(e.target.value)} required>
            <option value="">Choose…</option>
            {niches.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Excel file (.xlsx), one tab per city</span>
          <input ref={input} type="file" accept=".xlsx" />
        </label>
        <button className="button button-primary" disabled={busy}>
          {busy ? "Checking…" : "Upload and check"}
        </button>
      </div>
      {niches.length === 0 && (
        <p className="small muted">No niche yet: an Owner makes a batch or a benchmark first.</p>
      )}
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}

function CheckCell({ item }: { item: HandedInFile }) {
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

function FileDialog({
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
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .file(id)
      .then(setItem)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [id]);

  async function revise() {
    const file = input.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      setItem(await api.reviseFile(id, file));
      onChanged();
    } catch (err) {
      setError(message(err, "Not uploaded."));
    } finally {
      setBusy(false);
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
  const revisable = item && (item.mine || staff) && item.status === "errors";
  const deletable =
    item &&
    (staff ? ["errors", "needs_top", "ready"] : ["errors"]).includes(item.status) &&
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
    <Modal title={item?.file_name ?? "File"} onClose={onClose} wide>
      {error && <Alert kind="error">{error}</Alert>}
      {!item ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
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
            <a className="button" href={`/api/submissions/${item.id}/marked.xlsx`} download>
              <span aria-hidden>⬇</span> Download problems to fix
            </a>
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

          {item.problems.length + columnWarnings.length > 0 && (
            <div className="table-scroll">
              <table className="table compact-table">
                <caption className="table-caption">Problems by tab and row</caption>
                <thead>
                  <tr>
                    <th>Tab</th>
                    <th className="num">Row</th>
                    <th>Column</th>
                    <th>Business</th>
                    <th>Problem</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {item.problems.map((p, index) => (
                    <tr key={index}>
                      <td>{p.tab}</td>
                      <td className="num">{p.line}</td>
                      <td>{FIELD_NAMES[p.field] ?? p.field}</td>
                      <td className="cell-trunc">{p.business ?? "—"}</td>
                      <td>
                        {p.severity === "error" ? "🔴" : "🟠"} {p.message}
                      </td>
                      <td className="cell-trunc">{p.value || "(empty)"}</td>
                    </tr>
                  ))}
                  {columnWarnings.map((c, index) => (
                    <tr key={`c${index}`}>
                      <td>{c.tab}</td>
                      <td className="num">—</td>
                      <td>{FIELD_NAMES[c.field] ?? c.field}</td>
                      <td>—</td>
                      <td>🟠 {c.message}</td>
                      <td />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
