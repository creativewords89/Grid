import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Batch,
  type BatchStatus,
  type Benchmark,
  type LeadImport,
  type LeadPage,
  type Pipeline,
} from "../api";
import { useAuth } from "../auth";
import { Alert, Confirm, Field } from "../components/ui";
import { when } from "../format";
import { navigate } from "../router";
import { BatchCities } from "./BatchCities";
import { PipelineTab, ResultsTab } from "./BatchPipeline";
import { BatchLeads, LeadDialog } from "./Leads";
import { SheetView } from "./ImportSheet";

// Batches (SPEC sections 6.4 and 7): make a batch (a name, one niche, one benchmark of that
// niche), then add Excel files to it at any time. A business stays in the batch it came in
// with. Each batch chooses its tasks and agents and is started or paused; running batches
// share their agents in the running order.

const BATCH_STATUS: Record<BatchStatus, string> = {
  not_started: "Not started",
  running: "Running",
  paused: "Paused",
};

const STATUS: Record<LeadImport["status"], string> = {
  preview: "Waiting for confirm",
  confirmed: "Saved",
  failed: "Failed",
  discarded: "Discarded",
};

type Tab = "tasks" | "leads" | "cities" | "results" | "files";
const TABS: [Tab, string][] = [
  ["tasks", "Tasks"],
  ["leads", "Leads"],
  ["cities", "Cities"],
  ["results", "Results"],
  ["files", "Files and settings"],
];

/** The open batch and tab from the address: /batches?batch=<id>&tab=<tab>, and the old
 * /leads?batch=<id> opens that batch's Leads tab. */
function fromAddress(): { batch: string | null; tab: Tab | null } {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  const known = TABS.some(([key]) => key === tab) ? (tab as Tab) : null;
  return {
    batch: params.get("batch"),
    tab: window.location.pathname === "/leads" ? "leads" : known,
  };
}

function setAddress(batch: string | null, tab: Tab | null, push = false) {
  const query = batch ? `?batch=${batch}${tab ? `&tab=${tab}` : ""}` : "";
  const target = `/batches${query}`;
  if (window.location.pathname + window.location.search === target) return;
  // From /leads or /import the menu should show Batches: tell the router.
  if (window.location.pathname !== "/batches") navigate(target, true);
  else if (push) window.history.pushState(null, "", target);
  else window.history.replaceState(null, "", target);
}

export function Batches() {
  const { user } = useAuth();
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [open, setOpen] = useState<string | null>(() => fromAddress().batch);
  const [startTab] = useState<Tab | null>(() => fromAddress().tab);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const back = () => setOpen(fromAddress().batch);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const load = useCallback(() => {
    api
      .batches()
      .then(setBatches)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, []);
  useEffect(load, [load]);

  if (!user) return null;
  const staff = user.role === "owner" || user.role === "admin";
  const current = batches?.find((b) => b.id === open);

  async function move(index: number, by: number) {
    if (!batches) return;
    const next = [...batches];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    setError("");
    try {
      setBatches(await api.orderBatches(next.map((b) => b.id)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
      load();
    }
  }

  const openBatch = (id: string | null) => {
    setAddress(id, null, true);
    setOpen(id);
  };

  if (current) {
    return (
      <BatchView
        key={current.id}
        batch={current}
        staff={staff}
        startTab={startTab}
        onBack={() => {
          openBatch(null);
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
            openBatch(made.id);
          }}
        />
      )}
      <FindBusiness batches={batches ?? []} onOpenBatch={openBatch} />
      {batches?.length === 0 && !adding && (
        <p className="muted">
          No batches yet. Make one: give it a name, its niche and a benchmark, then add files.
        </p>
      )}
      {batches && batches.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <caption className="table-caption">
              Running batches share their agents in this order: the higher one goes first.
            </caption>
            <thead>
              <tr>
                {staff && <th>Order</th>}
                <th>Batch</th>
                <th>Status</th>
                <th>Niche</th>
                <th>Benchmark</th>
                <th>Businesses</th>
                <th className="hide-narrow">Files</th>
                <th className="hide-narrow">Agents</th>
                <th className="hide-narrow">Progress</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch, index) => (
                <tr key={batch.id}>
                  {staff && (
                    <td className="nowrap">
                      <button
                        className="icon-button"
                        aria-label={`Move ${batch.name} up`}
                        disabled={index === 0}
                        onClick={() => void move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Move ${batch.name} down`}
                        disabled={index === batches.length - 1}
                        onClick={() => void move(index, 1)}
                      >
                        ↓
                      </button>
                    </td>
                  )}
                  <td>
                    <button className="link-button cell-strong" onClick={() => openBatch(batch.id)}>
                      {batch.name}
                    </button>
                  </td>
                  <td>
                    <span className={`pill pill-batch-${batch.status}`}>
                      {BATCH_STATUS[batch.status]}
                    </span>
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
                  <td className="hide-narrow small">{batch.bots.join(", ") || "—"}</td>
                  <td className="hide-narrow small">
                    {batch.progress_pct === null ? "—" : `${batch.progress_pct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  startTab,
  onBack,
  onChanged,
}: {
  batch: Batch;
  staff: boolean;
  startTab: Tab | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [imports, setImports] = useState<LeadImport[]>([]);
  const [current, setCurrent] = useState<LeadImport | null>(null);
  const [error, setError] = useState("");
  // A new batch starts with its files; one with leads with its tasks and agents.
  const [tab, setTabState] = useState<Tab>(startTab ?? (batch.leads === 0 ? "files" : "tasks"));
  const [city, setCity] = useState("");
  const setTab = useCallback(
    (next: Tab) => {
      setAddress(batch.id, next);
      setTabState(next);
    },
    [batch.id],
  );
  useEffect(() => setAddress(batch.id, tab), [batch.id, tab]);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .pipeline(batch.id)
      .then(setPipeline)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [batch.id]);

  const changed = (next: Pipeline) => {
    setPipeline(next);
    onChanged();
  };

  async function startOrPause(start: boolean) {
    setBusy(true);
    setError("");
    try {
      changed(await (start ? api.startBatch(batch.id) : api.pauseBatch(batch.id)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Didn't work.");
    } finally {
      setBusy(false);
    }
  }
  const status = pipeline?.batch.status ?? batch.status;

  const load = useCallback(() => {
    api
      .imports(batch.id)
      .then((found) => {
        setImports(found);
        const waiting = found.find((i) => i.status === "preview");
        if (waiting) setTab("files");
        setCurrent((shown) => shown ?? waiting ?? null);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [batch.id, setTab]);
  useEffect(load, [load]);

  return (
    <section className="page page-wide">
      <div className="page-head">
        <div>
          <h1>{batch.name}</h1>
          <p className="muted small">
            <span className={`pill pill-batch-${status}`}>{BATCH_STATUS[status]}</span>{" "}
            {batch.niche} · {batch.leads.toLocaleString()} businesses · {batch.files} files
          </p>
        </div>
        <div className="row">
          {batch.can_run && status === "running" && (
            <button className="button" disabled={busy} onClick={() => void startOrPause(false)}>
              Pause
            </button>
          )}
          {batch.can_run && status !== "running" && (
            <button
              className="button button-primary"
              disabled={busy || !pipeline?.can_start}
              title={pipeline?.start_problem ?? undefined}
              onClick={() => void startOrPause(true)}
            >
              {status === "paused" ? "Resume" : "Start"}
            </button>
          )}
          <button className="button" onClick={onBack}>
            All batches
          </button>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {batch.can_run && status !== "running" && pipeline?.start_problem && (
        <p className="muted small">To start: {pipeline.start_problem}</p>
      )}
      <div className="tabs" role="tablist" aria-label="Batch">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              if (key === "leads") setCity("");
              setTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "tasks" && pipeline && (
        <PipelineTab batchId={batch.id} pipeline={pipeline} onChange={changed} />
      )}
      {tab === "leads" && city && (
        <div className="city-bar" role="region" aria-label="Leads of one city">
          <button className="button" onClick={() => setTab("cities")}>
            ← Back to Cities
          </button>
          <span>
            Leads in <strong>{city}</strong>
          </span>
          <button className="link-button" onClick={() => setCity("")}>
            Show all leads
          </button>
        </div>
      )}
      {tab === "leads" && <BatchLeads key={city} batchId={batch.id} city={city} />}
      {/* Kept while a city's leads are open, so Back returns to the same tab, page and search. */}
      {(tab === "cities" || (tab === "leads" && city)) && (
        <div hidden={tab !== "cities"}>
          <BatchCities
            batchId={batch.id}
            staff={staff}
            onOpenCity={(name) => {
              setCity(name);
              setTab("leads");
            }}
          />
        </div>
      )}
      {tab === "results" && pipeline && (
        <ResultsTab batchId={batch.id} pipeline={pipeline} onShowLeads={() => setTab("leads")} />
      )}
      {tab === "files" && (
        <BatchSettings batch={batch} staff={staff} onChanged={onChanged} onDeleted={onBack} />
      )}
      {tab === "files" && staff && !current && (
        <UploadForm
          batch={batch}
          onRead={(item) => {
            setCurrent(item);
            load();
          }}
        />
      )}
      {tab === "files" && current && (
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
      {tab === "files" && (
        <History
          imports={imports}
          staff={staff}
          running={status === "running"}
          onOpen={setCurrent}
          onDeleted={(item) => {
            if (current?.id === item.id) setCurrent(null);
            load();
            onChanged();
          }}
        />
      )}
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
        A business already in another batch stays there. Nothing is saved until you confirm the
        preview.
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
          Saved: {counts.saved_new ?? 0} new and {counts.saved_updated ?? 0} updated.
        </Alert>
      )}
      <div className="counts">
        <Count label="businesses" value={counts.leads} />
        <Count label="new" value={counts.new} />
        <Count label="already known (updated)" value={counts.updated} />
        <Count label="already in another batch" value={counts.other_batch ?? 0} warn />
        <Count label="duplicates merged" value={counts.merged} />
        <Count label="already Top (never contacted)" value={counts.top} />
        <Count label="cities" value={counts.cities} />
        <Count label="without a GBP link" value={counts.no_gbp_link} warn />
        <Count label="without a website" value={counts.no_website} />
        <Count label="rows skipped" value={counts.skipped_rows} warn />
        <Count label="emails that look wrong" value={counts.invalid_emails} warn />
      </div>
      <p className="muted small">
        Top is chosen in the Hub (the batch&apos;s Leads tab), not from the file
        {preview.has_level_column && ": this file's Level column is kept as another column"}.
        Businesses already Top stay Top.
      </p>
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
      <Details title="Other columns (kept with the leads)" items={unknown} />
      <Details title="Empty tabs" items={preview.empty_tabs ?? []} />
      {(item.status === "preview" || item.status === "confirmed") && (
        <SheetView
          key={`${item.id}-${item.status}`}
          importId={item.id}
          saved={item.status === "confirmed"}
        />
      )}
      {waiting && staff && (
        <div className="row">
          <button
            className="button button-primary"
            disabled={busy !== ""}
            onClick={() => void act("confirm")}
          >
            {busy === "confirm" ? "Saving…" : `Save ${counts.leads.toLocaleString()} businesses`}
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
  staff,
  running,
  onOpen,
  onDeleted,
}: {
  imports: LeadImport[];
  staff: boolean;
  running: boolean;
  onOpen: (item: LeadImport) => void;
  onDeleted: (item: LeadImport) => void;
}) {
  const [asking, setAsking] = useState<{
    item: LeadImport;
    going: number;
    staying: number;
  } | null>(null);
  const [error, setError] = useState("");
  if (imports.length === 0) return null;

  async function ask(item: LeadImport) {
    setError("");
    try {
      const what = await api.importDeletion(item.id);
      setAsking({ item, going: what.leads_going, staying: what.leads_staying });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not loaded.");
    }
  }

  async function remove(item: LeadImport) {
    setAsking(null);
    try {
      await api.deleteImport(item.id);
      onDeleted(item);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not deleted.");
    }
  }

  return (
    <div className="card table-card">
      {error && <Alert kind="error">{error}</Alert>}
      <table className="table">
        <caption className="table-caption">
          Past imports
          {staff && running && (
            <span className="muted small"> · to delete a file, pause the batch first</span>
          )}
        </caption>
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Businesses</th>
            <th className="hide-narrow">When</th>
            {staff && (
              <th>
                <span className="sr-only">Delete</span>
              </th>
            )}
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
              {staff && (
                <td>
                  {item.status !== "preview" && (
                    <button
                      className="link-button"
                      disabled={running}
                      title={running ? "Pause the batch first" : undefined}
                      aria-label={`Delete ${item.file_name}`}
                      onClick={() => void ask(item)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {asking && (
        <Confirm
          title={`Delete ${asking.item.file_name}?`}
          message={
            <>
              {asking.going.toLocaleString()} businesses this file brought in go, with their
              agents&apos; results and reports. {asking.staying.toLocaleString()} businesses that
              came from earlier files stay. Top businesses stay on the do-not-contact list.
            </>
          }
          confirmLabel="Delete the file"
          danger
          onConfirm={() => void remove(asking.item)}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
}

/** Find a business in every batch (SPEC section 6.4 item 12). */
function FindBusiness({
  batches,
  onOpenBatch,
}: {
  batches: Batch[];
  onOpenBatch: (id: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<LeadPage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!typed.trim()) {
      setFound(null);
      return;
    }
    setError("");
    try {
      setFound(await api.leads({ q: typed.trim() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not found.");
    }
  }

  return (
    <div className="card stack">
      <form className="filters-row" onSubmit={search} aria-label="Find a business">
        <Field
          label="Find a business in every batch"
          placeholder="Name, Lead ID, email, phone, website…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <div className="field">
          <span className="label-spacer" aria-hidden="true">
            &nbsp;
          </span>
          <button className="button">Find</button>
        </div>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {found && found.total === 0 && <p className="muted small">No business matches.</p>}
      {found && found.total > 0 && (
        <div className="table-scroll">
          <table className="table compact-table">
            <caption className="table-caption">
              {found.total.toLocaleString()} found
              {found.pages > 1 && " (the first 100 shown)"}
            </caption>
            <thead>
              <tr>
                <th>Lead ID</th>
                <th>Business</th>
                <th>City</th>
                <th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {found.leads.map((lead) => (
                <tr key={lead.lead_id}>
                  <td className="small">{lead.lead_id}</td>
                  <td>
                    <button className="link-button" onClick={() => setOpen(lead.lead_id)}>
                      {lead.business_name || lead.lead_id}
                    </button>
                  </td>
                  <td>{lead.city}</td>
                  <td>
                    {lead.batch_id && batches.some((b) => b.id === lead.batch_id) ? (
                      <button className="link-button" onClick={() => onOpenBatch(lead.batch_id!)}>
                        {lead.batch_name}
                      </button>
                    ) : (
                      (lead.batch_name ?? "—")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <LeadDialog
          id={open}
          agents={found?.agents ?? {}}
          onClose={() => setOpen(null)}
          onChanged={() => void 0}
        />
      )}
    </div>
  );
}
