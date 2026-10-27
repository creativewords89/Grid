import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Benchmark,
  type BenchmarkUpload,
  type NicheStandard,
  type Standard,
} from "../api";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";
import { when } from "../format";

// Benchmarks (SPEC sections 6.5 and 7): the GBP benchmark per City + Niche, uploaded as
// Excel, and each niche's Website Standard, edited as a draft and locked into versions.

export function Benchmarks() {
  const { user } = useAuth();
  if (!user) return null;
  const staff = user.role === "owner" || user.role === "admin";
  return (
    <section className="page">
      <h1>Benchmarks</h1>
      <GbpBenchmarks staff={staff} />
      <WebsiteStandards />
    </section>
  );
}

// --- GBP benchmarks -------------------------------------------------------------------------

const COLUMNS: [keyof Benchmark, string][] = [
  ["additional_categories", "Extra categories"],
  ["services", "Services"],
  ["photos", "Photos"],
  ["posts_90_days", "Posts (90 days)"],
  ["description_length", "Description length"],
  ["reviews", "Reviews"],
  ["rating", "Rating"],
  ["review_reply_pct", "Reply %"],
];

function shown(value: string | null): string {
  return value === null ? "—" : String(Number(value));
}

function GbpBenchmarks({ staff }: { staff: boolean }) {
  const [rows, setRows] = useState<Benchmark[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<BenchmarkUpload | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .benchmarks()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load]);

  async function send(apply: boolean) {
    if (!file) {
      setNotice({ kind: "error", text: "Choose the benchmark file first." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.uploadBenchmarks(file, apply);
      if (apply) {
        setCheck(null);
        setNotice({ kind: "success", text: `Saved ${result.rows.length} benchmarks.` });
        load();
      } else setCheck(result);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Didn't work." });
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Benchmark) {
    try {
      await api.deleteBenchmark(row.id);
      load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not deleted." });
    }
  }

  return (
    <div className="card stack" aria-labelledby="gbp-benchmarks">
      <h2 id="gbp-benchmarks">GBP benchmarks</h2>
      <p className="muted">
        One row per City + Niche: City, Niche, Additional categories, Services, Photos, Posts (90
        days), Description length, Reviews, Rating, Review reply %, Reference businesses. Leave a
        cell empty to skip that comparison. Each row replaces the benchmark of its City + Niche.
      </p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {staff && (
        <div className="row">
          <input
            type="file"
            aria-label="Benchmark file"
            accept=".xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setCheck(null);
            }}
          />
          <button className="button" disabled={busy} onClick={() => void send(false)}>
            Check the file
          </button>
        </div>
      )}
      {check && (
        <div className="stack" aria-label="Benchmark check">
          <p>
            {check.rows.length} benchmarks found
            {check.replaces > 0 && `, ${check.replaces} of them replace existing ones`}.
            {check.ignored_columns.length > 0 && ` Ignored: ${check.ignored_columns.join(", ")}.`}
          </p>
          {check.errors.length > 0 && (
            <Alert kind="error">
              Fix these rows first, then check again:
              <ul>
                {check.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}
          <div>
            <button
              className="button button-primary"
              disabled={busy || check.errors.length > 0 || check.rows.length === 0}
              onClick={() => void send(true)}
            >
              Save {check.rows.length} benchmarks
            </button>
          </div>
        </div>
      )}
      {rows.length > 0 ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>City · Niche</th>
                {COLUMNS.map(([key, label]) => (
                  <th key={key}>{label}</th>
                ))}
                <th>Reference businesses</th>
                {staff && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="cell-strong">
                    {row.city} · {row.niche}
                  </td>
                  {COLUMNS.map(([key]) => (
                    <td key={key}>{shown(row[key] as string | null)}</td>
                  ))}
                  <td className="small">{row.reference_businesses || "—"}</td>
                  {staff && (
                    <td>
                      <button className="link-button" onClick={() => void remove(row)}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No GBP benchmarks yet.</p>
      )}
    </div>
  );
}

// --- Website Standards ------------------------------------------------------------------------

const EMPTY: Standard = {
  services: [],
  service_page: {
    min_words: 600,
    min_sections: 4,
    faq: true,
    price: true,
    own_photos: true,
    reviews: true,
    cta: true,
    service_area: true,
  },
  location_page: {
    min_words: 400,
    city_in_title: true,
    local_content: true,
    local_photos: true,
    all_services_linked: true,
    local_reviews: true,
    map: true,
    faq: true,
    cta: true,
    max_shared_text_pct: 60,
  },
  supporting_pages: ["FAQ", "Reviews", "Gallery", "About", "Contact", "Pricing"],
  blog: { posts_per_month: 2, topics: [] },
  mobile_lcp_seconds: 2.5,
};

const SERVICE_CHECKS: [keyof Standard["service_page"], string][] = [
  ["faq", "FAQ"],
  ["price", "Price or “starting from”"],
  ["own_photos", "Own photos"],
  ["reviews", "Reviews"],
  ["cta", "Call to action / booking"],
  ["service_area", "Service area mentioned"],
];

const LOCATION_CHECKS: [keyof Standard["location_page"], string][] = [
  ["city_in_title", "City in title and H1"],
  ["local_content", "Local content"],
  ["local_photos", "Local photos"],
  ["all_services_linked", "All services linked"],
  ["local_reviews", "Local reviews"],
  ["map", "Map"],
  ["faq", "City FAQ"],
  ["cta", "Call to action"],
];

function lines(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function WebsiteStandards() {
  const [all, setAll] = useState<NicheStandard[]>([]);
  const [niche, setNiche] = useState("");
  const [current, setCurrent] = useState<NicheStandard | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .standards()
      .then((found) => {
        setAll(found);
        if (found[0]) setNiche((n) => n || found[0]!.niche);
      })
      .catch(() => setAll([]));
  }, []);

  useEffect(() => {
    if (!niche) return;
    api
      .standard(niche)
      .then(setCurrent)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [niche]);

  const [typed, setTyped] = useState("");
  // Kept here: saving remounts the editor, and the message must outlive that.
  const [notice, setNotice] = useState<Notice>(null);
  return (
    <div className="card stack" aria-labelledby="website-standards">
      <h2 id="website-standards">Website Standards</h2>
      <p className="muted">
        What a good website looks like in each niche. The Website agent compares every lead's site
        with the niche's latest locked version. Admins edit a draft; an Owner locks it.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        <div className="field">
          <label htmlFor="standard-niche">Niche</label>
          <select
            id="standard-niche"
            value={niche}
            onChange={(e) => {
              setCurrent(null);
              setNiche(e.target.value);
            }}
          >
            {!niche && <option value="">Choose…</option>}
            {all.map((s) => (
              <option key={s.niche} value={s.niche}>
                {s.niche}
              </option>
            ))}
            {niche && !all.some((s) => s.niche === niche) && <option value={niche}>{niche}</option>}
          </select>
        </div>
        <Field
          label="Or start a new niche"
          placeholder="Construction"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button
          className="button"
          disabled={!typed.trim()}
          onClick={() => {
            setCurrent(null);
            setNiche(typed.trim());
            setTyped("");
          }}
        >
          Open
        </button>
      </div>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {current && (
        <StandardEditor
          onNotice={setNotice}
          key={`${current.niche}:${current.draft?.edited_at ?? ""}:${current.locked?.version ?? 0}`}
          data={current}
          onSaved={(saved) => {
            setCurrent(saved);
            setAll((list) =>
              list.some((s) => s.niche === saved.niche)
                ? list.map((s) => (s.niche === saved.niche ? saved : s))
                : [...list, saved],
            );
          }}
        />
      )}
    </div>
  );
}

type Notice = { kind: "error" | "success"; text: string } | null;

function StandardEditor({
  data,
  onSaved,
  onNotice,
}: {
  data: NicheStandard;
  onSaved: (data: NicheStandard) => void;
  onNotice: (notice: Notice) => void;
}) {
  const start = data.draft?.standard ?? data.locked?.standard ?? EMPTY;
  const [s, setS] = useState<Standard>(start);
  const [topics, setTopics] = useState(start.blog.topics.join("\n"));
  const [pages, setPages] = useState(start.supporting_pages.join(", "));
  // What was typed in each "Also called" box; split into a list when saving.
  const [synonyms, setSynonyms] = useState(start.services.map((svc) => svc.synonyms.join(", ")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const editable = data.can_edit;

  async function run(action: () => Promise<NicheStandard>, done: string) {
    setBusy(true);
    onNotice(null);
    setErrors({});
    try {
      const saved = await action();
      onNotice({ kind: "success", text: done });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        onNotice({ kind: "error", text: err.message });
      }
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const body: Standard = {
      ...s,
      services: s.services.map((svc, i) => ({ ...svc, synonyms: lines(synonyms[i] ?? "") })),
      supporting_pages: lines(pages),
      blog: { ...s.blog, topics: lines(topics) },
    };
    void run(() => api.saveDraft(data.niche, body), "Draft saved.");
  }

  const setService = (index: number, patch: Partial<Standard["services"][number]>) =>
    setS((x) => ({
      ...x,
      services: x.services.map((svc, i) => (i === index ? { ...svc, ...patch } : svc)),
    }));

  return (
    <form className="stack" onSubmit={save} aria-label={`${data.niche} standard`}>
      <p className="small">
        {data.locked
          ? `In use: ${data.locked.label}, locked ${when(data.locked.locked_at ?? data.locked.edited_at)}${data.locked.locked_by ? ` by ${data.locked.locked_by}` : ""}.`
          : "No locked version yet: the Website agent skips this niche (NO_STANDARD)."}{" "}
        {data.draft
          ? `Draft edited ${when(data.draft.edited_at)}${data.draft.edited_by ? ` by ${data.draft.edited_by}` : ""}.`
          : data.locked
            ? "Editing starts a new draft from the version in use."
            : ""}
      </p>
      <fieldset disabled={!editable || busy} className="stack plain">
        <h3>Services</h3>
        {s.services.map((svc, i) => (
          <div className="service-row" key={i}>
            <Field
              label={`Service ${i + 1}`}
              value={svc.name}
              error={errors[`services.${i}.name`]}
              onChange={(e) => setService(i, { name: e.target.value })}
            />
            <Field
              label="Also called (comma separated)"
              value={synonyms[i] ?? ""}
              onChange={(e) => {
                const text = e.target.value;
                setSynonyms((all) => all.map((old, j) => (j === i ? text : old)));
              }}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={svc.must_have}
                onChange={(e) => setService(i, { must_have: e.target.checked })}
              />
              Must-have
            </label>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setS((x) => ({ ...x, services: x.services.filter((_, j) => j !== i) }));
                setSynonyms((all) => all.filter((_, j) => j !== i));
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="button"
            onClick={() => {
              setS((x) => ({
                ...x,
                services: [...x.services, { name: "", synonyms: [], must_have: true }],
              }));
              setSynonyms((all) => [...all, ""]);
            }}
          >
            + Add a service
          </button>
        </div>
        {errors.standard && <p className="field-error">{errors.standard}</p>}

        <h3>Service pages</h3>
        <div className="connection-fields">
          <Field
            label="Words at least"
            type="number"
            min={0}
            value={String(s.service_page.min_words)}
            onChange={(e) =>
              setS((x) => ({
                ...x,
                service_page: { ...x.service_page, min_words: Number(e.target.value) },
              }))
            }
          />
          <Field
            label="Sections (H2) at least"
            type="number"
            min={0}
            value={String(s.service_page.min_sections)}
            onChange={(e) =>
              setS((x) => ({
                ...x,
                service_page: { ...x.service_page, min_sections: Number(e.target.value) },
              }))
            }
          />
        </div>
        <div className="checks">
          {SERVICE_CHECKS.map(([key, label]) => (
            <label className="check" key={key}>
              <input
                type="checkbox"
                checked={Boolean(s.service_page[key])}
                onChange={(e) =>
                  setS((x) => ({
                    ...x,
                    service_page: { ...x.service_page, [key]: e.target.checked },
                  }))
                }
              />
              {label}
            </label>
          ))}
        </div>

        <h3>Location pages</h3>
        <div className="connection-fields">
          <Field
            label="Words at least"
            type="number"
            min={0}
            value={String(s.location_page.min_words)}
            onChange={(e) =>
              setS((x) => ({
                ...x,
                location_page: { ...x.location_page, min_words: Number(e.target.value) },
              }))
            }
          />
          <Field
            label="Most text shared with another location page (%)"
            type="number"
            min={0}
            max={100}
            value={String(s.location_page.max_shared_text_pct)}
            onChange={(e) =>
              setS((x) => ({
                ...x,
                location_page: { ...x.location_page, max_shared_text_pct: Number(e.target.value) },
              }))
            }
          />
        </div>
        <div className="checks">
          {LOCATION_CHECKS.map(([key, label]) => (
            <label className="check" key={key}>
              <input
                type="checkbox"
                checked={Boolean(s.location_page[key])}
                onChange={(e) =>
                  setS((x) => ({
                    ...x,
                    location_page: { ...x.location_page, [key]: e.target.checked },
                  }))
                }
              />
              {label}
            </label>
          ))}
        </div>

        <h3>Supporting pages, blog and speed</h3>
        <Field
          label="Supporting pages good sites have (comma separated)"
          value={pages}
          onChange={(e) => setPages(e.target.value)}
        />
        <div className="connection-fields">
          <Field
            label="Blog posts a month"
            type="number"
            min={0}
            step="0.5"
            value={String(s.blog.posts_per_month)}
            onChange={(e) =>
              setS((x) => ({ ...x, blog: { ...x.blog, posts_per_month: Number(e.target.value) } }))
            }
          />
          <Field
            label="Mobile LCP target (seconds)"
            type="number"
            min={0.5}
            step="0.1"
            value={String(s.mobile_lcp_seconds)}
            error={errors.mobile_lcp_seconds}
            onChange={(e) => setS((x) => ({ ...x, mobile_lcp_seconds: Number(e.target.value) }))}
          />
        </div>
        <div className="field">
          <label htmlFor="standard-topics">Blog topics good sites cover (one per line)</label>
          <textarea
            id="standard-topics"
            rows={5}
            value={topics}
            onChange={(e) => setTopics(e.target.value)}
          />
        </div>
      </fieldset>
      {editable && (
        <div className="row">
          <button className="button button-primary" disabled={busy}>
            Save draft
          </button>
          {data.draft && data.can_lock && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.lockStandard(data.niche),
                  "Locked. The Website agent uses it from its next run.",
                )
              }
            >
              Lock as the next version
            </button>
          )}
          {data.draft && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void run(() => api.dropDraft(data.niche), "Draft discarded.")}
            >
              Discard draft
            </button>
          )}
        </div>
      )}
    </form>
  );
}
