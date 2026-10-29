import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  api,
  ApiError,
  download,
  type Batch,
  type FileFixResult,
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
  final_check: ["badge-ok", "Final check"],
  needs_top: ["badge-warning", "Needs Top"],
  ready: ["badge-ok", "Ready"],
  adding: ["badge-warning", "Being added"],
  used: ["badge", "Used"],
};

// The way a file goes (step 36), each stage with the states it holds.
type Stage = { key: string; label: string; statuses: HandedInFile["status"][] };
const STAGES: Stage[] = [
  { key: "checking", label: "Checking", statuses: ["checking", "failed"] },
  { key: "errors", label: "Fix errors", statuses: ["errors"] },
  { key: "final_check", label: "Final check", statuses: ["final_check"] },
  { key: "needs_top", label: "Top Review", statuses: ["needs_top"] },
  { key: "ready", label: "Ready", statuses: ["ready"] },
  { key: "batch", label: "In a batch", statuses: ["adding", "used"] },
];
const stageOf = (status: HandedInFile["status"]) =>
  STAGES.findIndex((stage) => stage.statuses.includes(status));
const DRAG_TYPE = "application/x-hub-file";
const POLL_MS = 2000; // how often a file being checked is looked at again
const FINAL_POLL_MS = 30_000; // and a file in its Final check (the scheduler sends it on)

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
  const [filter, setFilter] = useState("");
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
  const waiting = (items ?? []).some((f) => f.status === "final_check");
  useEffect(() => {
    if ((!checking && !waiting) || open) return;
    const timer = window.setTimeout(load, checking ? POLL_MS : FINAL_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [checking, waiting, items, open, load]);
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

  const stage = STAGES.find((s) => s.key === filter);
  const shown = (items ?? []).filter((f) => !stage || stage.statuses.includes(f.status));
  const count = (s: Stage) => (items ?? []).filter((f) => s.statuses.includes(f.status)).length;
  const readyCount = (items ?? []).filter((f) => f.status === "ready").length;

  return (
    <section className="page page-wide">
      <div className="page-head">
        <div className="stack-tight">
          <h1>Files</h1>
          <p className="muted files-intro">
            {role === "collector"
              ? "Hand in your lead files. Lead Check marks every error: fix them and upload the fixes. With no error left the file goes on to Top Review."
              : "Lead files handed in by the team: checked, fixed, given their Top, then added to a batch of their niche, once."}
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

      <nav className="files-stages" aria-label="Stages">
        <button
          className={`files-stage ${filter === "" ? "on" : ""}`}
          aria-pressed={filter === ""}
          onClick={() => setFilter("")}
        >
          <span className="files-stage-count">{(items ?? []).length}</span>
          <span>All</span>
        </button>
        {STAGES.map((s, index) => (
          <button
            key={s.key}
            className={`files-stage ${filter === s.key ? "on" : ""}`}
            aria-pressed={filter === s.key}
            onClick={() => setFilter(s.key)}
          >
            <span className="files-stage-count">{count(s)}</span>
            <span>
              <span className="files-stage-number" aria-hidden>
                {index + 1}
              </span>{" "}
              {s.label}
            </span>
          </button>
        ))}
      </nav>

      <div className={staff ? "files-layout" : undefined}>
        <div className="stack-tight" aria-label="Files" role="list">
          {items === null ? (
            <p className="muted">Loading…</p>
          ) : shown.length === 0 ? (
            <div className="card empty">
              <p>{items.length === 0 ? "No files yet." : "No file at this stage."}</p>
            </div>
          ) : (
            shown.map((item) => (
              <FileCard
                key={item.id}
                item={item}
                staff={staff}
                collector={role === "collector"}
                onOpen={() => setOpen(item.id)}
                onDrag={setDragging}
                onChanged={load}
                onError={setError}
              />
            ))
          )}
        </div>

        {staff && (
          <BatchTargets
            batches={batches}
            dragging={dragging}
            ready={readyCount}
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
  const [over, setOver] = useState(false);
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

  async function send(file: File | undefined) {
    if (!file) return;
    if (!niche) return setError("Choose the niche first.");
    if (!file.name.toLowerCase().endsWith(".xlsx"))
      return setError("Hand in an Excel file (.xlsx).");
    setSent(0);
    setError("");
    try {
      // Uploading is shown as it goes; the check then runs on the server (step 33).
      onDone(await api.handIn(file, niche, setSent));
    } catch (err) {
      setError(message(err, "Not uploaded."));
    } finally {
      setSent(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="card stack-tight" aria-label="Hand in a lead file">
      <div className="files-hand-in-head">
        <h2>Hand in a lead file</h2>
        <label className="field files-niche">
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
      </div>
      {adding && (
        <NewNiche
          onCancel={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            loadNiches(name);
          }}
        />
      )}
      <div
        className={`files-drop ${over ? "over" : ""} ${sent !== null ? "busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (sent === null) void send(e.dataTransfer.files[0]);
        }}
      >
        {sent === null ? (
          <>
            <span className="files-drop-icon" aria-hidden>
              ⬆
            </span>
            <p>
              <strong>Drop your Excel file here</strong>, or{" "}
              <label className="link-button files-choose">
                choose a file
                <input
                  ref={input}
                  className="sr-only"
                  type="file"
                  accept=".xlsx"
                  aria-label="Excel file (.xlsx), one tab per city"
                  onChange={(e) => void send(e.target.files?.[0])}
                />
              </label>
            </p>
            <p className="small muted">
              .xlsx, one tab per city. It is checked as soon as it is uploaded.
            </p>
          </>
        ) : (
          <div className="stack-tight files-drop-progress">
            <p>
              <strong>Uploading {sent}%</strong>: keep this page open until it is done.
            </p>
            <ProgressBar percent={sent} label="Uploading" />
          </div>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </section>
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

function minutesLeft(until: string): string {
  const left = Math.ceil((new Date(until).getTime() - Date.now()) / 60_000);
  return left <= 0 ? "any moment" : `${left} min`;
}

/** Where a file is on its way: a dot per stage. */
function StageTrack({ status }: { status: HandedInFile["status"] }) {
  const at = stageOf(status);
  return (
    <ol className="stage-track" aria-label={`Stage ${at + 1} of ${STAGES.length}`}>
      {STAGES.map((s, index) => (
        <li
          key={s.key}
          className={index < at ? "done" : index === at ? "now" : undefined}
          title={s.label}
        >
          <span className="sr-only">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** One file: where it is, and what to do next there (step 36). */
function FileCard({
  item,
  staff,
  collector,
  onOpen,
  onDrag,
  onChanged,
  onError,
}: {
  item: HandedInFile;
  staff: boolean;
  collector: boolean;
  onOpen: () => void;
  onDrag: (item: HandedInFile | null) => void;
  onChanged: () => void;
  onError: (text: string) => void;
}) {
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState(false);
  const movable = staff && item.status === "ready";
  const mayChange = item.mine || staff;
  const stage = STAGES[stageOf(item.status)];

  async function act(action: () => Promise<unknown>, failed: string) {
    setBusy(true);
    onError("");
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(`${item.file_name}: ${message(err, failed)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      role="listitem"
      aria-label={item.file_name}
      className={`card file-card ${movable ? "file-draggable" : ""}`}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "copy";
        onDrag(item);
      }}
      onDragEnd={() => onDrag(null)}
      title={movable ? "Drag onto a batch" : undefined}
    >
      <div className="file-card-head">
        <div className="stack-tight">
          <div>
            {movable && (
              <span className="drag-handle" aria-hidden>
                ⠿{" "}
              </span>
            )}
            <button className="link-button cell-strong" onClick={onOpen}>
              {item.file_name}
            </button>
          </div>
          <span className="small muted">
            {item.niche} · {item.businesses.toLocaleString()} businesses · version {item.version}
            {!collector && item.uploaded_by && ` · ${item.uploaded_by}`} · {day(item.updated_at)}
          </span>
          {item.same_as && <span className="small files-same">⚠ {item.same_as}</span>}
        </div>
        <div className="file-card-stage">
          <StageTrack status={item.status} />
          <span className="small">
            {stageOf(item.status) + 1}. {stage?.label}
          </span>
        </div>
      </div>

      <div className="file-card-body">
        {item.status === "checking" && (
          <div className="stack-tight file-card-progress">
            <span>Checking {item.progress}%</span>
            <ProgressBar percent={item.progress} label={`Checking ${item.file_name}`} />
          </div>
        )}
        {item.status === "failed" && (
          <span className="field-error">Couldn't read it: {item.error}</span>
        )}
        {item.status === "errors" && (
          <span>
            <span className="badge badge-error">
              🔴 {item.errors.toLocaleString()} {item.errors === 1 ? "error" : "errors"}
            </span>{" "}
            to fix
          </span>
        )}
        {item.status === "final_check" && (
          <span>
            <span className="badge badge-ok">✓ No errors</span> Goes to Top Review in{" "}
            {item.sends_at ? minutesLeft(item.sends_at) : "an hour"}
          </span>
        )}
        {item.status === "needs_top" && (
          <span>
            Waiting for Top Review: {item.cities_topped} of {item.cities_on}{" "}
            {item.cities_on === 1 ? "city has" : "cities have"} a Top
          </span>
        )}
        {item.status === "ready" && (
          <span>
            <span className="badge badge-ok">✅ Ready</span>{" "}
            {staff ? "Drag it onto a batch of its niche." : "Waiting to be added to a batch."}
          </span>
        )}
        {(item.status === "adding" || item.status === "used") && <UsedIn item={item} />}

        <div className="file-card-actions">
          {["errors", "final_check"].includes(item.status) && (
            <button
              className="button button-small"
              disabled={busy}
              onClick={() =>
                void act(
                  () => download(`/submissions/${item.id}/marked.xlsx`, "problems-to-fix.xlsx"),
                  "the file wasn't downloaded.",
                )
              }
            >
              <span aria-hidden>⬇</span> Download problems to fix
            </button>
          )}
          {mayChange && ["errors", "final_check"].includes(item.status) && (
            <button className="button button-small" disabled={busy} onClick={() => setFixing(true)}>
              <span aria-hidden>⬆</span> Upload fixes
            </button>
          )}
          {mayChange && item.status === "final_check" && (
            <button
              className="button button-small button-primary"
              disabled={busy}
              onClick={() => void act(() => api.sendToReview(item.id), "not sent.")}
            >
              Send to Top Review now
            </button>
          )}
          <button className="button button-small" onClick={onOpen}>
            Open
          </button>
        </div>
      </div>
      {fixing && (
        <FileFixDialog
          id={item.id}
          onClose={() => setFixing(false)}
          onSaved={() => {
            setFixing(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

function BatchTargets({
  batches,
  dragging,
  ready,
  files,
  onDrop,
}: {
  batches: Batch[];
  dragging: HandedInFile | null;
  ready: number;
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
      <p className="small muted">
        {ready
          ? `${ready} ready ${ready === 1 ? "file" : "files"}: drag one onto a batch of its niche.`
          : "When a file is Ready, drag it here onto a batch of its niche."}
      </p>
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

  const [downloading, setDownloading] = useState(false);
  const [fixesOpen, setFixesOpen] = useState(false);

  async function downloadMarked() {
    setDownloading(true);
    setError("");
    try {
      await download(`/submissions/${id}/marked.xlsx`, "problems-to-fix.xlsx");
    } catch (err) {
      setError(`The file wasn't downloaded: ${message(err, "try again.")}`);
    } finally {
      setDownloading(false);
    }
  }

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
  const fixing = ["checking", "failed", "errors", "final_check"];
  const revisable = item && (item.mine || staff) && fixing.includes(item.status);
  const deletable =
    item &&
    (staff ? [...fixing, "needs_top", "ready"] : fixing).includes(item.status) &&
    (item.mine || staff);

  async function sendOn() {
    setBusy(true);
    setError("");
    try {
      await api.sendToReview(id);
      setItem(await api.file(id));
      onChanged();
    } catch (err) {
      setError(message(err, "Not sent."));
    } finally {
      setBusy(false);
    }
  }

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
          {item.status === "final_check" && (
            <p>
              ✓ No errors. Final check: this file goes on to Top Review in{" "}
              {item.sends_at ? minutesLeft(item.sends_at) : "an hour"}, or now with{" "}
              <strong>Send to Top Review now</strong>. Until then it can still be fixed.
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
              <button
                className="button"
                disabled={busy || downloading}
                onClick={() => void downloadMarked()}
              >
                <span aria-hidden>⬇</span>{" "}
                {downloading ? "Preparing the file…" : "Download problems to fix"}
              </button>
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
            {revisable && ["errors", "final_check"].includes(item.status) && (
              <button className="button" disabled={busy} onClick={() => setFixesOpen(true)}>
                <span aria-hidden>⬆</span> Upload fixes
              </button>
            )}
            {revisable && item.status === "final_check" && (
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void sendOn()}
              >
                Send to Top Review now
              </button>
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
          {fixesOpen && (
            <FileFixDialog
              id={item.id}
              onClose={() => setFixesOpen(false)}
              onSaved={() => {
                setFixesOpen(false);
                load();
                onChanged();
              }}
            />
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
            <option value="">All ({data?.counts.all ?? 0})</option>
            <option value="problems">
              Problems: errors and warnings ({data?.counts.problems ?? 0})
            </option>
            <option value="errors">🔴 Errors ({data?.counts.errors ?? 0})</option>
            <option value="warnings">🟠 Warnings ({data?.counts.warnings ?? 0})</option>
            <option value="ok">✓ OK ({data?.counts.ok ?? 0})</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Sort by</span>
          <select
            value={filters.sort ?? "row"}
            onChange={(e) => set({ sort: e.target.value as FileLeadFilters["sort"] })}
          >
            <option value="row">Sort: File ID</option>
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
                    <th>File ID</th>
                    <th>Business name</th>
                    <th>Check</th>
                    {TABLE_COLUMNS.slice(1).map((key) => (
                      <th key={key}>{FIELD_NAMES[key] ?? key}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.leads.map((lead) => (
                    <tr key={lead.id || lead.rows[0]}>
                      <td className="small nowrap" title={`${lead.tab}, row ${lead.line}`}>
                        {lead.id}
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
                            className={wrong.length ? "cell-problem small" : "small"}
                            title={
                              wrong.length
                                ? wrong.map((i) => i.message).join("\n")
                                : value || undefined
                            }
                          >
                            {/* Cut to one line (the address to two) inside the cell, so the
                                table keeps its rows. */}
                            <span className={key === "address" ? "cell-clamp" : "cell-trunc"}>
                              {link ? (
                                <a href={link} target="_blank" rel="noopener noreferrer">
                                  {value}
                                </a>
                              ) : (
                                value || <span className="muted">—</span>
                              )}
                            </span>
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

/** The fix file back from Excel (step 34): first what would change, then saved as a new
 * version of the file, which is checked again. */
function FileFixDialog({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<FileFixResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(confirm: boolean) {
    if (!file) return setError("Choose the fixed file.");
    setBusy(true);
    setError("");
    try {
      const found = await api.uploadFileFixes(id, file, confirm);
      if (found.saved) onSaved();
      else setResult(found);
    } catch (err) {
      setError(message(err, "Didn't work."));
    } finally {
      setBusy(false);
    }
  }

  const changes = result ? result.changed.reduce((n, r) => n + r.changes.length, 0) : 0;
  const nothing = result && result.changed.length === 0 && result.removed.length === 0;

  return (
    <Modal title="Upload fixes" onClose={onClose} wide>
      <div className="stack">
        <p className="muted">
          The file from <strong>Download problems to fix</strong>, fixed in Excel. Each row is found
          by its File ID; an empty cell clears the value; Delete = Yes takes the business out of the
          file. Nothing changes until you save.
        </p>
        <label className="field">
          <span>Fixed file (.xlsx)</span>
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
            }}
          />
        </label>
        {error && <Alert kind="error">{error}</Alert>}
        {!result && (
          <div className="row">
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void send(false)}
            >
              {busy ? "Checking…" : "Check the file"}
            </button>
          </div>
        )}
        {result && (
          <>
            <p>
              <strong>{changes}</strong> {changes === 1 ? "change" : "changes"} in{" "}
              {result.changed.length} {result.changed.length === 1 ? "business" : "businesses"}
              {result.removed.length > 0 && (
                <>
                  , <strong>{result.removed.length}</strong> taken out
                </>
              )}
              . The file will have {result.businesses_after.toLocaleString()} businesses.
            </p>
            {result.removed.length > 0 && (
              <Alert kind="error">
                Taken out of the file:{" "}
                {result.removed.map((r) => `${r.business_name} (${r.file_id})`).join(", ")}
              </Alert>
            )}
            {result.changed.length > 0 && (
              <div className="table-scroll">
                <table className="table compact-table">
                  <thead>
                    <tr>
                      <th>File ID</th>
                      <th>Business</th>
                      <th>Column</th>
                      <th>From</th>
                      <th>To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.changed.flatMap((r) =>
                      r.changes.map((c, index) => (
                        <tr key={`${r.file_id}-${index}`}>
                          <td className="nowrap small">{r.file_id}</td>
                          <td>{r.business_name}</td>
                          <td>{c.field}</td>
                          <td className="small">
                            <span className="cell-trunc">{c.from || "(empty)"}</span>
                          </td>
                          <td className="small">
                            <span className="cell-trunc">{c.to || "(empty)"}</span>
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {result.skipped.length > 0 && (
              <ul className="check-list small">
                {result.skipped.map((r) => (
                  <li key={`${r.tab}-${r.line}`}>
                    🟠 {r.tab} row {r.line} ({r.file_id || "no File ID"}): {r.reason}
                  </li>
                ))}
              </ul>
            )}
            <div className="row">
              {nothing ? (
                <p className="muted">Nothing to change.</p>
              ) : (
                <button
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void send(true)}
                >
                  {busy
                    ? "Saving…"
                    : `Save ${changes} ${changes === 1 ? "change" : "changes"}${result.removed.length ? ` and take out ${result.removed.length}` : ""}`}
                </button>
              )}
              <button className="link-button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
