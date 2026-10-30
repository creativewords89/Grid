import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Agent,
  type AgentTest,
  type AgentTestReport,
  type Batch,
} from "../api";
import { Alert, Field, Modal } from "../components/ui";
import { ago, money, when } from "../format";
import { RUN_STATUS } from "../labels";
import { navigate } from "../router";

/** Test runs (step 50): an agent tried now on a few leads, from a batch or pasted GBP
 * links; its report stays in the run and never reaches the leads. */

const MAX_LEADS = 10;

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function pending(test: AgentTest): boolean {
  return test.status === "queued" || test.status === "running";
}

function outcome(test: AgentTest): string {
  if (pending(test)) return test.status === "queued" ? "Waiting to start" : "Working…";
  const parts = Object.entries(test.statuses).map(
    ([status, count]) => `${count} ${status.toLowerCase().replace(/_/g, " ")}`,
  );
  if (test.status !== "succeeded")
    return `${RUN_STATUS[test.status]}${test.stop_reason ? `: ${test.stop_reason}` : ""}`;
  return parts.join(" · ") || "No lead handled";
}

/** The Test window: a batch's first leads, some Lead IDs, or pasted GBP links. */
export function TestDialog({
  agent,
  onClose,
  onStarted,
}: {
  agent: Agent;
  onClose: () => void;
  onStarted: (test: AgentTest) => void;
}) {
  const [tab, setTab] = useState<"batch" | "links">("batch");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [count, setCount] = useState("5");
  const [ids, setIds] = useState("");
  const [links, setLinks] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .batches()
      .then((found) => {
        setBatches(found);
        const first = found.find((b) => b.leads > 0) ?? found[0];
        if (first) setBatchId((now) => now || first.id);
      })
      .catch(() => setBatches([]));
  }, []);

  const leadIds = ids
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const pasted = links
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const how =
    tab === "links" ? pasted.length : leadIds.length || Math.min(Number(count) || 0, MAX_LEADS);
  const each = agent.manifest?.cost_per_item_usd ?? 0;

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body =
        tab === "links"
          ? { links: pasted }
          : leadIds.length > 0
            ? { lead_ids: leadIds }
            : { batch_id: batchId, count: Number(count) };
      onStarted(await api.startTest(agent.key, body));
    } catch (err) {
      setError(message(err, "The test didn't start."));
      setBusy(false);
    }
  }

  const tooMany = how > MAX_LEADS;
  return (
    <Modal title={`Test ${agent.name}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void start(e)} noValidate>
        <p className="muted small">
          Runs now on a few leads and shows its report. Their results in the batch don&apos;t
          change.
        </p>
        {error && <Alert kind="error">{error}</Alert>}
        <nav className="files-tabs" aria-label="Which leads">
          <button
            type="button"
            className={tab === "batch" ? "on" : undefined}
            aria-pressed={tab === "batch"}
            onClick={() => setTab("batch")}
          >
            From a batch
          </button>
          <button
            type="button"
            className={tab === "links" ? "on" : undefined}
            aria-pressed={tab === "links"}
            onClick={() => setTab("links")}
          >
            Paste GBP links
          </button>
        </nav>
        {tab === "batch" ? (
          <>
            <div className="test-fields">
              <div className="field">
                <label htmlFor="test-batch">Batch</label>
                <select
                  id="test-batch"
                  value={batchId}
                  onChange={(e) => setBatchId(e.target.value)}
                >
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.leads} leads)
                    </option>
                  ))}
                </select>
              </div>
              <Field
                label="How many leads"
                type="number"
                min={1}
                max={MAX_LEADS}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
            <Field
              label="Or these Lead IDs (optional)"
              value={ids}
              placeholder="L-000123, L-000124"
              onChange={(e) => setIds(e.target.value)}
            />
          </>
        ) : (
          <div className="field">
            <label htmlFor="test-links">GBP links</label>
            <textarea
              id="test-links"
              rows={5}
              value={links}
              placeholder="https://share.google/…"
              aria-describedby="test-links-hint"
              onChange={(e) => setLinks(e.target.value)}
            />
            <span id="test-links-hint" className="muted small">
              One link a line, up to 10. No file or batch needed.
            </span>
          </div>
        )}
        <p className={`small ${tooMany ? "field-error" : "muted"}`}>
          {tooMany
            ? `At most ${MAX_LEADS} leads in a test.`
            : `${how} ${how === 1 ? "lead" : "leads"}${each ? ` · about ${money(how * each)}` : ""} · counts in today's budget`}
        </p>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={
              busy || how === 0 || tooMany || (tab === "batch" && !batchId && !leadIds.length)
            }
          >
            Start test
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** An agent's last tests, on its card; refreshed while one is waiting or working. */
export function TestReports({ agent, version }: { agent: Agent; version: number }) {
  const [tests, setTests] = useState<AgentTest[] | null>(null);
  const load = useCallback(() => {
    api
      .agentTests(agent.key)
      .then(setTests)
      .catch(() => setTests([]));
  }, [agent.key]);
  useEffect(load, [load, version]);
  const waiting = tests?.some(pending) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  if (!tests || tests.length === 0) return null;
  return (
    <div className="stack-tight">
      <h3 className="small">Test reports</h3>
      <div className="table-scroll">
        <table className="table" aria-label={`${agent.name} test reports`}>
          <thead>
            <tr>
              <th>When</th>
              <th>Leads</th>
              <th>Result</th>
              <th className="num">Cost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tests.map((test) => (
              <tr key={test.id}>
                <td>{ago(test.queued_at)}</td>
                <td>{test.what}</td>
                <td className={test.status === "failed" ? "field-error" : undefined}>
                  {outcome(test)}
                </td>
                <td className="num">{pending(test) ? "—" : money(test.cost_usd)}</td>
                <td>
                  <a
                    className="button button-small"
                    href={`/agents/${agent.key}/tests/${test.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/agents/${agent.key}/tests/${test.id}`);
                    }}
                  >
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">The last 20 tests are kept.</p>
    </div>
  );
}

type Data = Record<string, unknown>;

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map((x) => text(x)).join(", ") : "—";
  if (typeof value === "object")
    return Object.entries(value as Data)
      .map(([k, v]) => `${k}: ${text(v)}`)
      .join(" · ");
  return String(value);
}

function Facts({ rows }: { rows: [string, unknown][] }) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={value === null || value === undefined ? "muted" : undefined}>
            {value === null || value === undefined ? "Not given by DataForSEO" : text(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What the GBP audit agent collected for one lead (agents/gbp-audit/SPEC.md section 4). */
function GbpData({ data }: { data: Data }) {
  const b = (data.basics ?? {}) as Data;
  const c = (data.categories ?? {}) as Data;
  const d = (data.description ?? {}) as Data;
  const p = (data.photos ?? {}) as Data;
  const r = (data.reviews ?? {}) as Data;
  const posts = data.posts as Data | null;
  const services = c.services as { name: string; description: string | null }[] | null;
  const items = (posts?.items ?? []) as Data[];
  const unknown = (data.unknown ?? []) as string[];
  return (
    <div className="stack">
      <div className="test-grid">
        <section className="card-inner stack-tight">
          <h4>Basics</h4>
          <Facts
            rows={[
              ["Name", b.name],
              ["Claimed", b.claimed],
              ["Phone", b.phone],
              ["Website", b.website],
              ["Address", b.address],
              ["Hours", b.hours],
              ["Status", b.status],
              ["Booking link", b.booking_link],
              ["Attributes", b.attributes],
              ["Payments", b.payments],
              ["Last updated", b.last_updated],
              ["People also search", b.people_also_search],
            ]}
          />
        </section>
        <section className="card-inner stack-tight">
          <h4>Categories &amp; Services</h4>
          <Facts
            rows={[
              ["Primary", c.primary],
              ["Additional", c.additional],
            ]}
          />
          {services ? (
            <ul className="small">
              {services.map((s) => (
                <li key={s.name}>
                  {s.name} {s.description ? "✓ description" : "· no description"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Services: not given by DataForSEO</p>
          )}
          <h4>Description</h4>
          <p className="small">{(d.text as string | null) ?? "—"}</p>
          <p className="muted small">{Number(d.length ?? 0)} characters</p>
        </section>
        <section className="card-inner stack-tight">
          <h4>Photos</h4>
          <Facts
            rows={[
              ["Photos", p.total],
              ["Logo", p.logo ? "Yes" : p.logo],
              ["Cover", p.cover ? "Yes" : p.cover],
            ]}
          />
        </section>
        <section className="card-inner stack-tight">
          <h4>Reviews (shown only)</h4>
          <Facts
            rows={[
              ["Reviews", r.count],
              ["Rating", r.rating],
              ["Stars", r.stars],
              ["Last review", r.last],
              [
                "Reply rate",
                r.reply_pct === null || r.reply_pct === undefined
                  ? null
                  : `${String(r.reply_pct)}%`,
              ],
              ["Unanswered 1–2★", r.unanswered_low],
            ]}
          />
        </section>
      </div>
      <section className="card-inner stack-tight">
        <h4>
          Posts
          {posts
            ? ` · last ${text(posts.last)} · ${text(posts.last_30_days)} in 30 days · ${text(posts.last_90_days)} in 90 days`
            : ""}
        </h4>
        {!posts ? (
          <p className="muted small">Not collected.</p>
        ) : items.length === 0 ? (
          <p className="small">No posts.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Text</th>
                  <th>Image</th>
                  <th>Button</th>
                </tr>
              </thead>
              <tbody>
                {items.map((post, i) => (
                  <tr key={i}>
                    <td>{text(post.date)}</td>
                    <td>{text(post.text)}</td>
                    <td>{text(post.image)}</td>
                    <td>{text(post.button)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {unknown.length > 0 && (
        <p className="muted small">
          Not given by DataForSEO (unable to verify, never a problem): {unknown.join(" · ")}
        </p>
      )}
    </div>
  );
}

/** A test's report: every lead's status and summary, one lead open at a time. */
export function TestReportPage({ agentKey, testId }: { agentKey: string; testId: string }) {
  const [report, setReport] = useState<AgentTestReport | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .agentTest(agentKey, testId)
      .then((found) => {
        setReport(found);
        setOpen((now) => now ?? found.leads.find((l) => l.result)?.key ?? null);
      })
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [agentKey, testId]);
  useEffect(load, [load]);
  const waiting = report ? pending(report) : false;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  const shown = report?.leads.find((l) => l.key === open);
  const details = (shown?.result?.details ?? {}) as Data;
  const collected = (details.data as Data | undefined)?.basics as Data | undefined;
  return (
    <section className="page page-wide">
      <nav className="small muted" aria-label="Breadcrumb">
        <a
          href="/agents"
          onClick={(e) => {
            e.preventDefault();
            navigate("/agents");
          }}
        >
          Agents
        </a>{" "}
        / {report?.agent_name ?? agentKey} / Test
        {report && ` of ${when(report.queued_at)}`}
      </nav>
      {error && <Alert kind="error">{error}</Alert>}
      {!report ? (
        !error && <p className="muted">Getting the report…</p>
      ) : (
        <>
          <div className="page-head">
            <div className="stack-tight">
              <h1>Test report · {report.agent_name}</h1>
              <p className="muted">
                {report.what}
                {report.requested_by && ` · started by ${report.requested_by}`} ·{" "}
                {money(report.cost_usd)} · not saved to the leads
              </p>
            </div>
            <span className="small">
              <strong>{waiting ? outcome(report) : RUN_STATUS[report.status]}</strong>
              {report.stop_reason && ` · ${report.stop_reason}`}
            </span>
          </div>
          <div className="card table-card">
            <div className="table-scroll">
              <table className="table" aria-label="Tested leads">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Status</th>
                    <th>Summary</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {report.leads.map((lead) => (
                    <tr key={lead.key} className={lead.key === open ? "row-on" : undefined}>
                      <td>
                        <span className="cell-strong">
                          {lead.business_name || lead.gbp_link || lead.key}
                        </span>
                        <div className="small muted">
                          {lead.lead_id || "Pasted link"}
                          {lead.city && ` · ${lead.city}`}
                        </div>
                      </td>
                      <td>{lead.result?.status ?? (waiting ? "Waiting…" : "Not handled")}</td>
                      <td className="small">{lead.result?.summary ?? ""}</td>
                      <td>
                        {lead.result && (
                          <button
                            className="button button-small"
                            aria-pressed={lead.key === open}
                            onClick={() => setOpen(lead.key)}
                          >
                            {lead.key === open ? "Shown below" : "Open"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {shown?.result && (
            <article className="card stack" aria-label={shown.business_name || shown.key}>
              <div className="page-head">
                <div className="stack-tight">
                  <h2>{shown.business_name || text(collected?.name ?? shown.key)}</h2>
                  <p className="muted small">
                    {shown.lead_id || "Pasted link"}
                    {shown.gbp_link && (
                      <>
                        {" · "}
                        <a href={shown.gbp_link} target="_blank" rel="noreferrer">
                          GBP link
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <div className="batch-head-actions">
                  {shown.files.map((name) => (
                    <a
                      key={name}
                      className="button button-small"
                      href={`/api/agents/${agentKey}/tests/${testId}/files/${shown.key}/${name}`}
                      download
                    >
                      Download {name}
                    </a>
                  ))}
                </div>
              </div>
              <p>
                <strong>{shown.result.status}</strong>
                {shown.result.score !== null && ` · score ${shown.result.score}`} ·{" "}
                {shown.result.summary}
              </p>
              {details.agent === "gbp" && details.data ? (
                <GbpData data={details.data as Data} />
              ) : (
                <pre className="test-json">{JSON.stringify(details, null, 2)}</pre>
              )}
            </article>
          )}
        </>
      )}
    </section>
  );
}
