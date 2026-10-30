import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Batch,
  type BatchFile,
  type BatchStatus,
  type Benchmark,
  type LeadImport,
  type PreviewCheck,
  type LeadPage,
  type Pipeline,
} from "../api";
import { useAuth } from "../auth";
import { Alert, Confirm, Field } from "../components/ui";
import { when } from "../format";
import { navigate } from "../router";
import { BatchCities } from "./BatchCities";
import { PipelineTab, ResultsTab } from "./BatchPipeline";
import { FIELD_NAMES } from "../checkLabels";
import { CheckReportDialog } from "../components/CheckReport";
import { BatchLeads, LeadDialog } from "./Leads";
import { SheetView } from "./ImportSheet";
import { BatchFilesTable, BatchFileView } from "./BatchFiles";

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

// "leads" and "files" are the two views of the Lead files tab (step 23).
type Tab = "handed" | "tasks" | "cities" | "results" | "leads" | "files" | "settings";
const TABS: [Tab, string][] = [
  ["handed", "Files"],
  ["tasks", "Tasks"],
  ["cities", "Cities"],
  ["results", "Results"],
  ["leads", "Lead files"],
  ["settings", "Settings"],
];
const ALL_TABS: Tab[] = ["handed", "tasks", "cities", "results", "leads", "files", "settings"];

/** The open batch and tab from the address: /batches?batch=<id>&tab=<tab>, and the old
 * /leads?batch=<id> opens that batch's Leads tab. */
function fromAddress(): { batch: string | null; tab: Tab | null } {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  const known = ALL_TABS.includes(tab as Tab) ? (tab as Tab) : null;
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
  const [startTab, setStartTab] = useState<Tab | null>(() => fromAddress().tab);
  const [startCity, setStartCity] = useState("");
  // A batch's file open on its own (step 46), and the batches opened in the list.
  const [file, setFile] = useState<{ batch: Batch; file: BatchFile } | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
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

  async function startOrPause(batch: Batch, start: boolean) {
    setError("");
    try {
      await (start ? api.startBatch(batch.id) : api.pauseBatch(batch.id));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Didn't work.");
    }
  }

  if (file) {
    return (
      <BatchFileView
        batch={file.batch}
        file={file.file}
        staff={staff}
        onBack={() => {
          setFile(null);
          load();
        }}
        onOpenCity={(city) => {
          setFile(null);
          setStartTab("leads");
          setStartCity(city);
          openBatch(file.batch.id);
        }}
      />
    );
  }

  if (current) {
    return (
      <BatchView
        key={current.id}
        batch={current}
        staff={staff}
        startTab={startTab}
        startCity={startCity}
        onOpenFile={(f) => setFile({ batch: current, file: f })}
        onBack={() => {
          setStartTab(null);
          setStartCity("");
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
        <div className="stack-tight">
          <h1>Batches</h1>
          <p className="muted">
            One batch per niche, named after it: its cities come from the Files screen once they
            have their Top (Top Review).
          </p>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <FindBusiness batches={batches ?? []} onOpenBatch={openBatch} />
      {batches?.length === 0 && (
        <p className="muted">
          No batches yet. A niche's batch is made when its first city comes from Top Review.
        </p>
      )}
      {/* A section per batch (step 46): closed until opened, then the files its cities came
          from. The running order: the higher batch shares its agents first. */}
      {batches && batches.length > 0 && (
        <p className="small muted">
          Running batches share their agents in this order: the higher one goes first.
        </p>
      )}
      {(batches ?? []).map((batch, index) => {
        const open = opened[batch.id] ?? false;
        return (
          <section
            key={batch.id}
            className="card table-card files-niche"
            aria-label={`${batch.name} batch`}
          >
            <div className="files-niche-head batch-head-row">
              <button
                className="icon-button"
                aria-expanded={open}
                aria-label={`${open ? "Hide" : "Show"} the files of ${batch.name}`}
                onClick={() => setOpened({ ...opened, [batch.id]: !open })}
              >
                {open ? "▾" : "▸"}
              </button>
              <button
                className="link-button files-niche-title cell-strong"
                onClick={() => openBatch(batch.id)}
              >
                {batch.name}
              </button>
              <span className={`pill pill-batch-${batch.status}`}>
                {BATCH_STATUS[batch.status]}
              </span>
              <span className="small muted">
                {batch.benchmark ? (
                  `${batch.benchmark.name} (v${batch.benchmark.version})`
                ) : (
                  <span className="field-error">Choose a benchmark</span>
                )}{" "}
                · {batch.files} {batch.files === 1 ? "file" : "files"} ·{" "}
                {batch.leads.toLocaleString()} businesses
                {batch.top > 0 && ` · ${batch.top} Top`} · {batch.bots.length}{" "}
                {batch.bots.length === 1 ? "agent" : "agents"}
              </span>
              <span className="batch-head-actions">
                {batch.progress_pct !== null && (
                  <span className="small">{batch.progress_pct}% done</span>
                )}
                {staff && (
                  <>
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
                      disabled={index === (batches ?? []).length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      ↓
                    </button>
                  </>
                )}
                {batch.can_run && batch.status === "running" && (
                  <button
                    className="button button-small"
                    onClick={() => void startOrPause(batch, false)}
                  >
                    Pause
                  </button>
                )}
                {batch.can_run && batch.status === "paused" && (
                  <button
                    className="button button-small"
                    onClick={() => void startOrPause(batch, true)}
                  >
                    Resume
                  </button>
                )}
                <button
                  className="button button-small button-primary"
                  aria-label={`Open ${batch.name}`}
                  onClick={() => openBatch(batch.id)}
                >
                  Open batch
                </button>
              </span>
            </div>
            {open && <BatchFilesTable batch={batch} onOpen={(f) => setFile({ batch, file: f })} />}
          </section>
        );
      })}
    </section>
  );
}

function sameNiche(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function BatchView({
  batch,
  staff,
  startTab,
  startCity = "",
  onOpenFile,
  onBack,
  onChanged,
}: {
  batch: Batch;
  staff: boolean;
  startTab: Tab | null;
  startCity?: string;
  onOpenFile: (file: BatchFile) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [imports, setImports] = useState<LeadImport[]>([]);
  const [current, setCurrent] = useState<LeadImport | null>(null);
  const [error, setError] = useState("");
  // A batch opens on its files (step 46): its cities come from them, through Top Review.
  const [tab, setTabState] = useState<Tab>(startTab ?? "handed");
  const [city, setCity] = useState(startCity);
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
      <div className="batch-head">
        <div className="stack-tight">
          <div className="small muted">
            <a
              href="/batches"
              onClick={(e) => {
                e.preventDefault();
                onBack();
              }}
            >
              Batches
            </a>{" "}
            / {batch.name}
          </div>
          <h1>{batch.name}</h1>
          <div className="batch-meta">
            <span>{batch.niche}</span>
            <span>·</span>
            <span>
              {batch.benchmark
                ? `${batch.benchmark.name} (v${batch.benchmark.version})`
                : "No benchmark yet"}
            </span>
            <span>·</span>
            <span>{batch.leads.toLocaleString()} businesses</span>
            <span>·</span>
            <span>{batch.top.toLocaleString()} Top</span>
          </div>
        </div>
        <div className="row">
          <span className={`batch-state batch-state-${status}`}>
            {status === "running" ? "● " : ""}
            {BATCH_STATUS[status]}
          </span>
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
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {batch.can_run && status !== "running" && pipeline?.start_problem && (
        <p className="muted small">To start: {pipeline.start_problem}</p>
      )}
      <nav className="batch-tabs" role="tablist" aria-label="Batch">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={
              key === "leads"
                ? (tab === "leads" && !city) || tab === "files"
                : key === "cities"
                  ? tab === "cities" || (tab === "leads" && !!city)
                  : tab === key
            }
            onClick={() => {
              if (key === "leads") setCity("");
              setTab(key);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "handed" && (
        <div className="card table-card">
          <BatchFilesTable batch={batch} onOpen={onOpenFile} />
        </div>
      )}
      {tab === "tasks" && pipeline && (
        <PipelineTab batchId={batch.id} pipeline={pipeline} onChange={changed} />
      )}
      {/* The Lead files tab: the leads the files brought, and the files themselves. */}
      {(tab === "files" || (tab === "leads" && !city)) && (
        <div className="sheet-tabs" role="tablist" aria-label="Lead files">
          <button role="tab" aria-selected={tab === "leads"} onClick={() => setTab("leads")}>
            Leads
          </button>
          <button role="tab" aria-selected={tab === "files"} onClick={() => setTab("files")}>
            Imports
          </button>
        </div>
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
            shown={tab === "cities"}
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
      {tab === "settings" && (
        <BatchSettings batch={batch} staff={staff} onChanged={onChanged} onDeleted={onBack} />
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
      {tab === "files" && imports.length === 0 && !current && (
        <p className="muted">
          No files yet: each city comes here from Top Review, as its file and city.
        </p>
      )}
      {tab === "files" && (
        <History
          imports={imports}
          staff={staff}
          running={status === "running"}
          onOpen={setCurrent}
          onChanged={load}
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
      {preview.check && (
        <LeadCheckSummary
          check={preview.check}
          saved={item.status === "confirmed"}
          held={(item.check_errors ?? 0) > 0}
        />
      )}
      <p className="muted small">
        Top is chosen in the Hub (a city on the batch&apos;s Cities tab), not from the file
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

/** Lead Check of a file in its preview (step 26): errors and warnings by tab, and what
 * saving it means for its leads. */
function LeadCheckSummary({
  check,
  saved,
  held,
}: {
  check: PreviewCheck;
  saved: boolean;
  held: boolean;
}) {
  const tabs = Object.entries(check.tabs).filter(
    ([, t]) => t.errors > 0 || t.warnings > 0 || t.columns.length > 0,
  );
  const message = saved
    ? held
      ? "Saved, and held: agents wait for every lead of this file until its errors are fixed. See the file's Lead Check report under Past imports."
      : "Saved with no errors: agents can work on its leads."
    : check.errors > 0
      ? "Saving it holds every lead of this file back from the agents until the errors are fixed. Fix the Excel file and add it again, or save it and fix the leads in the Hub."
      : "No errors: agents can work on its leads once it is saved.";
  return (
    <div className="stack-tight" role="region" aria-label="Lead Check">
      <Alert kind={check.errors > 0 && !(saved && !held) ? "error" : "success"}>
        <strong>Lead Check:</strong> 🔴 {check.errors} {check.errors === 1 ? "error" : "errors"} ·
        🟠 {check.warnings} {check.warnings === 1 ? "warning" : "warnings"}. {message}
      </Alert>
      {tabs.length > 0 && (
        <table className="table compact-table" aria-label="Lead Check by tab">
          <thead>
            <tr>
              <th>Tab</th>
              <th>🔴 Errors</th>
              <th>🟠 Warnings</th>
              <th>Columns</th>
            </tr>
          </thead>
          <tbody>
            {tabs.map(([name, t]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{t.errors}</td>
                <td>{t.warnings}</td>
                <td className="small">
                  {t.columns
                    .map((i) => `${i.message}: ${FIELD_NAMES[i.field] ?? i.field}`)
                    .join("; ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function History({
  imports,
  staff,
  running,
  onOpen,
  onDeleted,
  onChanged,
}: {
  imports: LeadImport[];
  staff: boolean;
  running: boolean;
  onOpen: (item: LeadImport) => void;
  onDeleted: (item: LeadImport) => void;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState<{
    item: LeadImport;
    going: number;
    staying: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<string | null>(null); // a file's Lead Check report
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

  async function sendBack(item: LeadImport) {
    if (
      !window.confirm(
        `Send ${item.file_name} back to Top Review? Its leads in this batch go, with their agents' results; the city is chosen its Top again.`,
      )
    )
      return;
    setError("");
    try {
      await api.sendBackImport(item.id);
      onDeleted(item);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not sent back.");
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
            <th>Lead Check</th>
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
              <td>
                {item.status === "confirmed" && item.check_errors != null ? (
                  <button
                    className="link-button nowrap"
                    aria-label={`Lead Check report of ${item.file_name}`}
                    onClick={() => setReport(item.id)}
                  >
                    {item.check_errors > 0
                      ? `🔴 ${item.check_errors} ${item.check_errors === 1 ? "lead" : "leads"} · held`
                      : "✅ Clear"}
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
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
                  {item.from_top_review && item.status === "confirmed" && (
                    <button
                      className="link-button nowrap"
                      disabled={running}
                      title={running ? "Pause the batch first" : undefined}
                      onClick={() => void sendBack(item)}
                    >
                      Send back to Top Review
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {report && (
        <CheckReportDialog
          importId={report}
          batchId={imports.find((i) => i.id === report)?.batch_id ?? ""}
          staff={staff}
          onClose={() => setReport(null)}
          onChanged={onChanged}
        />
      )}
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
