import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Batch, type Benchmark, type LeadImport, type LeadList } from "../api";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";
import { when } from "../format";
import { navigate } from "../router";

// Batches (SPEC sections 6.4 and 7): make a batch (a name, one niche, one benchmark of that
// niche), then add Excel files to it at any time. A business stays in the batch it came in
// with. Agents work through the batches chosen for them. The lists (City + Niche) follow.

const STATUS: Record<LeadImport["status"], string> = {
  preview: "Waiting for confirm",
  confirmed: "Sent to the Master Sheet",
  failed: "Failed",
  discarded: "Discarded",
};

export function Batches() {
  const { user } = useAuth();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [lists, setLists] = useState<LeadList[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .batches()
      .then(setBatches)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
    api
      .lists()
      .then(setLists)
      .catch(() => setLists([]));
  }, []);
  useEffect(load, [load]);

  if (!user) return null;
  const staff = user.role === "owner" || user.role === "admin";
  const current = batches?.find((b) => b.id === open);

  if (current) {
    return (
      <BatchView
        batch={current}
        staff={staff}
        onBack={() => {
          setOpen(null);
          load();
        }}
        onChanged={load}
      />
    );
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Batches</h1>
        {staff && !adding && (
          <button className="button button-primary" onClick={() => setAdding(true)}>
            + New batch
          </button>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {adding && (
        <NewBatch
          onCancel={() => setAdding(false)}
          onMade={(made) => {
            setAdding(false);
            load();
            setOpen(made.id);
          }}
        />
      )}
      {batches?.length === 0 && !adding && (
        <p className="muted">
          No batches yet. Make one: give it a name, its niche and a benchmark, then add files.
        </p>
      )}
      {batches && batches.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Niche</th>
                <th>Benchmark</th>
                <th>Businesses</th>
                <th className="hide-narrow">Files</th>
                <th className="hide-narrow">Agents</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id}>
                  <td>
                    <button className="link-button cell-strong" onClick={() => setOpen(batch.id)}>
                      {batch.name}
                    </button>
                  </td>
                  <td>{batch.niche}</td>
                  <td>
                    {batch.benchmark ? (
                      `${batch.benchmark.name} (v${batch.benchmark.version})`
                    ) : (
                      <span className="field-error">Choose a benchmark</span>
                    )}
                  </td>
                  <td>
                    {batch.leads.toLocaleString()}
                    {batch.top > 0 && <span className="muted small"> · {batch.top} Top</span>}
                  </td>
                  <td className="hide-narrow">{batch.files}</td>
                  <td className="hide-narrow small">{batch.agents.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Lists lists={lists} staff={staff} onChange={load} />
    </section>
  );
}

function sameNiche(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function NewBatch({ onCancel, onMade }: { onCancel: () => void; onMade: (b: Batch) => void }) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [benchmarkId, setBenchmarkId] = useState("");
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .benchmarks()
      .then(setBenchmarks)
      .catch(() => setBenchmarks([]));
  }, []);

  const niches = [...new Set(benchmarks.map((b) => b.niche))];
  const choices = benchmarks.filter((b) => niche.trim() && sameNiche(b.niche, niche));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setErrors({});
    try {
      onMade(await api.createBatch({ name, niche, benchmark_id: benchmarkId || null }));
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.message);
      }
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label="New batch" noValidate>
      <h2>New batch</h2>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="connection-fields">
        <Field
          label="Batch name"
          placeholder="Cleaning – Texas – November"
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="field">
          <label htmlFor="batch-niche">Niche (one per batch)</label>
          <input
            id="batch-niche"
            list="batch-niches"
            placeholder="Cleaning"
            value={niche}
            aria-invalid={errors.niche ? true : undefined}
            onChange={(e) => {
              setNiche(e.target.value);
              setBenchmarkId("");
            }}
          />
          <datalist id="batch-niches">
            {niches.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {errors.niche && <p className="field-error">{errors.niche}</p>}
        </div>
        <div className="field">
          <label htmlFor="batch-benchmark">Benchmark</label>
          <select
            id="batch-benchmark"
            value={benchmarkId}
            disabled={choices.length === 0}
            aria-invalid={errors.benchmark_id ? true : undefined}
            onChange={(e) => setBenchmarkId(e.target.value)}
          >
            <option value="">Choose…</option>
            {choices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {errors.benchmark_id ? (
            <p className="field-error">{errors.benchmark_id}</p>
          ) : (
            niche.trim() &&
            choices.length === 0 && (
              <p className="hint">
                No benchmark for this niche yet.{" "}
                <a
                  href="/benchmarks"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/benchmarks");
                  }}
                >
                  Make one on Benchmarks
                </a>{" "}
                first.
              </p>
            )
          )}
        </div>
      </div>
      <div className="row">
        <button className="button button-primary" disabled={busy}>
          Make the batch
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- one batch ----------------------------------------------------------------------------------

function BatchView({
  batch,
  staff,
  onBack,
  onChanged,
}: {
  batch: Batch;
  staff: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [imports, setImports] = useState<LeadImport[]>([]);
  const [current, setCurrent] = useState<LeadImport | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .imports(batch.id)
      .then((found) => {
        setImports(found);
        setCurrent((shown) => shown ?? found.find((i) => i.status === "preview") ?? null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [batch.id]);
  useEffect(load, [load]);

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>{batch.name}</h1>
          <p className="muted small">
            {batch.niche} · {batch.leads.toLocaleString()} businesses · {batch.files} files
            {batch.agents.length > 0 && ` · worked on by ${batch.agents.join(", ")}`}
          </p>
        </div>
        <button className="button" onClick={onBack}>
          All batches
        </button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <BatchSettings batch={batch} staff={staff} onChanged={onChanged} onDeleted={onBack} />
      {staff && !current && (
        <UploadForm
          batch={batch}
          onRead={(item) => {
            setCurrent(item);
            load();
          }}
        />
      )}
      {current && (
        <PreviewCard
          item={current}
          staff={staff}
          onDone={(finished) => {
            // Keep showing what was sent; a discarded file closes.
            setCurrent(finished.status === "discarded" ? null : finished);
            load();
            onChanged();
          }}
          onClose={() => setCurrent(null)}
        />
      )}
      <History imports={imports} onOpen={setCurrent} />
    </section>
  );
}

function BatchSettings({
  batch,
  staff,
  onChanged,
  onDeleted,
}: {
  batch: Batch;
  staff: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [benchmarkId, setBenchmarkId] = useState(batch.benchmark?.id ?? "");
  const [name, setName] = useState(batch.name);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .benchmarks()
      .then((all) => setBenchmarks(all.filter((b) => sameNiche(b.niche, batch.niche))))
      .catch(() => setBenchmarks([]));
  }, [batch.niche]);

  async function act(action: () => Promise<unknown>, done: string, deleted = false) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (deleted) {
        onDeleted();
        return;
      }
      setNotice({ kind: "success", text: done });
      onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not saved." });
    } finally {
      setBusy(false);
    }
  }

  if (!staff) {
    return (
      <p className="small">
        Benchmark:{" "}
        {batch.benchmark ? `${batch.benchmark.name} (v${batch.benchmark.version})` : "none yet"}
      </p>
    );
  }
  return (
    <div className="card stack" aria-label="Batch settings">
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {!batch.benchmark && (
        <Alert kind="error">
          This batch has no benchmark yet: the agents skip it until you choose one.
        </Alert>
      )}
      <div className="row">
        <div className="field">
          <label htmlFor="batch-benchmark-change">Benchmark</label>
          <select
            id="batch-benchmark-change"
            value={benchmarkId}
            onChange={(e) => setBenchmarkId(e.target.value)}
          >
            {!batch.benchmark && <option value="">Choose…</option>}
            {benchmarks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} (v{b.version})
              </option>
            ))}
          </select>
        </div>
        <button
          className="button"
          disabled={busy || !benchmarkId || benchmarkId === batch.benchmark?.id}
          onClick={() =>
            void act(
              () => api.updateBatch(batch.id, { benchmark_id: benchmarkId }),
              "Benchmark changed. The agents check this batch's leads against it.",
            )
          }
        >
          Use this benchmark
        </button>
      </div>
      {batch.can_rename && (
        <div className="row">
          <Field label="Batch name" value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="button"
            disabled={busy || !name.trim() || name === batch.name}
            onClick={() => void act(() => api.updateBatch(batch.id, { name }), "Renamed.")}
          >
            Rename
          </button>
        </div>
      )}
      {batch.can_delete && (
        <div>
          <button
            className="button button-danger"
            disabled={busy}
            onClick={() => void act(() => api.deleteBatch(batch.id), "", true)}
          >
            Delete this empty batch
          </button>
        </div>
      )}
    </div>
  );
}

function UploadForm({ batch, onRead }: { batch: Batch; onRead: (item: LeadImport) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setErrors({ file: "Choose the Excel file." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      onRead(await api.uploadLeads(file, batch.id));
    } catch (err) {
      if (err instanceof ApiError) setErrors({ form: err.message, ...err.fields });
      setBusy(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label="Add a lead file" noValidate>
      <h2>Add a lead file</h2>
      <p className="muted">
        An Excel file (.xlsx) of {batch.niche} businesses with one tab per city, as you build them
        now: Business name, MAP, Address, City, Website, Phone, WA, Facebook, Instagram, Email,
        Reviews, Average, and an optional Level column (write Top for businesses we never contact).
        A business already in another batch stays there. Nothing is sent to the Master Sheet until
        you confirm the preview.
      </p>
      {errors.form && <Alert kind="error">{errors.form}</Alert>}
      <div className="field">
        <label htmlFor="import-file">Excel file</label>
        <input
          id="import-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          aria-invalid={errors.file ? true : undefined}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {errors.file && <p className="field-error">{errors.file}</p>}
      </div>
      <div>
        <button className="button button-primary" disabled={busy}>
          {busy ? "Reading the file… (a big file takes up to a minute)" : "Read the file"}
        </button>
      </div>
    </form>
  );
}

function Count({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={`count ${warn && value > 0 ? "count-warn" : ""}`}>
      <span className="count-value">{value.toLocaleString()}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

function Details({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details>
      <summary>{title}</summary>
      <ul className="small">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function PreviewCard({
  item,
  staff,
  onDone,
  onClose,
}: {
  item: LeadImport;
  staff: boolean;
  onDone: (item: LeadImport) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { counts, preview } = item;
  const waiting = item.status === "preview";

  async function act(kind: "confirm" | "discard") {
    setBusy(kind);
    setError("");
    try {
      onDone(
        kind === "confirm" ? await api.confirmImport(item.id) : await api.discardImport(item.id),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Didn't work.");
      setBusy("");
    }
  }

  const unknown = Object.entries(preview.unknown_columns ?? {}).map(
    ([column, tabs]) => `${column} (in ${tabs.length} tab${tabs.length === 1 ? "" : "s"})`,
  );
  return (
    <article className="card stack" aria-label="Preview">
      <div className="agent-head">
        <div>
          <h2>{item.file_name}</h2>
          <p className="muted small">
            {item.batch_name ?? item.niche} · {STATUS[item.status]} · read {when(item.created_at)}
            {item.uploaded_by && ` by ${item.uploaded_by}`}
          </p>
        </div>
        <button className="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {item.status === "confirmed" && (
        <Alert kind="success">
          Sent: {counts.sheet_added ?? 0} rows added and {counts.sheet_updated ?? 0} updated in the
          Master Sheet.
        </Alert>
      )}
      <div className="counts">
        <Count label="businesses" value={counts.leads} />
        <Count label="new" value={counts.new} />
        <Count label="already known (updated)" value={counts.updated} />
        <Count label="already in another batch" value={counts.other_batch ?? 0} warn />
        <Count label="duplicates merged" value={counts.merged} />
        <Count label="Top (never contacted)" value={counts.top} />
        <Count label="cities" value={counts.cities} />
        <Count label="without a GBP link" value={counts.no_gbp_link} warn />
        <Count label="without a website" value={counts.no_website} />
        <Count label="rows skipped" value={counts.skipped_rows} warn />
        <Count label="emails that look wrong" value={counts.invalid_emails} warn />
      </div>
      {!preview.has_level_column && (
        <p className="muted small">
          This file has no Level column, so no business is marked Top and existing Top marks stay as
          they are.
        </p>
      )}
      <Details title="New lists (City + Niche)" items={preview.new_lists ?? []} />
      <Details title="Already known, will be updated" items={preview.updated ?? []} />
      <Details
        title="Already in another batch (they stay there; new details are added)"
        items={preview.other_batch ?? []}
      />
      <Details
        title="Duplicate rows merged into one business"
        items={(preview.merged_rows ?? []).map((rows) => rows.join(" + "))}
      />
      <Details title="Top businesses" items={preview.top ?? []} />
      <Details
        title="Without a GBP link (the GBP agent skips them)"
        items={preview.no_gbp_link ?? []}
      />
      <Details title="Rows skipped (no name and no GBP link)" items={preview.skipped_rows ?? []} />
      <Details title="Emails that look wrong (left out)" items={preview.invalid_emails ?? []} />
      <Details title="Columns that were ignored" items={unknown} />
      <Details title="Empty tabs" items={preview.empty_tabs ?? []} />
      {waiting && staff && (
        <div className="row">
          <button
            className="button button-primary"
            disabled={busy !== ""}
            onClick={() => void act("confirm")}
          >
            {busy === "confirm"
              ? "Sending to the Master Sheet…"
              : `Send ${counts.leads.toLocaleString()} businesses to the Master Sheet`}
          </button>
          <button className="button" disabled={busy !== ""} onClick={() => void act("discard")}>
            Discard
          </button>
        </div>
      )}
    </article>
  );
}

function History({
  imports,
  onOpen,
}: {
  imports: LeadImport[];
  onOpen: (item: LeadImport) => void;
}) {
  if (imports.length === 0) return null;
  return (
    <div className="card table-card">
      <table className="table">
        <caption className="table-caption">Past imports</caption>
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Businesses</th>
            <th className="hide-narrow">When</th>
          </tr>
        </thead>
        <tbody>
          {imports.map((item) => (
            <tr key={item.id}>
              <td>
                <button className="link-button" onClick={() => onOpen(item)}>
                  {item.file_name}
                </button>
              </td>
              <td>{STATUS[item.status]}</td>
              <td>{item.counts.leads?.toLocaleString()}</td>
              <td className="hide-narrow">
                {when(item.created_at)}
                {item.uploaded_by && ` · ${item.uploaded_by}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Lists({
  lists,
  staff,
  onChange,
}: {
  lists: LeadList[];
  staff: boolean;
  onChange: () => void;
}) {
  const [error, setError] = useState("");
  if (lists.length === 0) return null;

  async function toggle(item: LeadList, active: boolean) {
    setError("");
    try {
      await api.updateList(item.id, { active });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
    }
  }

  return (
    <div className="card table-card">
      {error && <Alert kind="error">{error}</Alert>}
      <table className="table">
        <caption className="table-caption">
          Lists: switch one off and the agents leave its businesses alone
        </caption>
        <thead>
          <tr>
            <th>City</th>
            <th>Niche</th>
            <th>Businesses</th>
            <th>Top</th>
            <th>On</th>
          </tr>
        </thead>
        <tbody>
          {lists.map((item) => (
            <tr key={item.id} className={item.active ? undefined : "row-muted"}>
              <td>{item.city}</td>
              <td>{item.niche}</td>
              <td>{item.leads}</td>
              <td>{item.top}</td>
              <td>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={item.active}
                    disabled={!staff}
                    aria-label={`${item.city} · ${item.niche} on or off`}
                    onChange={(e) => void toggle(item, e.target.checked)}
                  />
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
