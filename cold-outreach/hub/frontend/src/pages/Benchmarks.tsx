import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Benchmark, type GbpTargets, type Standard } from "../api";
import { useAuth } from "../auth";
import { Alert, Field } from "../components/ui";
import { when } from "../format";

// Benchmarks (SPEC sections 6.5 and 7): named sets such as "Cleaning Benchmark 1", each of
// one niche: the GBP numbers a good profile has and the Website Standard. Not tied to a city.
// Each batch uses one; changing the numbers makes the agents check its leads again.

type Editing = { source: Benchmark | null; copy: boolean } | null;
type Notice = { kind: "error" | "success"; text: string } | null;

export function Benchmarks() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Benchmark[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(() => {
    api
      .benchmarks()
      .then(setRows)
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
  }, []);
  useEffect(load, [load]);

  if (!user) return null;
  const staff = user.role === "owner" || user.role === "admin";

  async function remove(row: Benchmark) {
    setNotice(null);
    try {
      await api.deleteBenchmark(row.id);
      setNotice({ kind: "success", text: `Deleted ${row.name}.` });
      load();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not deleted." });
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <h1>Benchmarks</h1>
        {staff && !editing && (
          <button
            className="button button-primary"
            onClick={() => {
              setNotice(null);
              setEditing({ source: null, copy: false });
            }}
          >
            + New benchmark
          </button>
        )}
      </div>
      <p className="muted">
        What a good business of a niche looks like: its Google Business Profile numbers and its
        website. A benchmark doesn't depend on city or competition. Each batch uses one; when you
        change its numbers, the agents check that batch's leads again.
      </p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {editing && (
        <BenchmarkEditor
          key={`${editing.source?.id ?? "new"}:${editing.copy}`}
          source={editing.source}
          copy={editing.copy}
          onCancel={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            setNotice({
              kind: "success",
              text: created
                ? `Saved ${saved.name}.`
                : `Saved ${saved.name} (version ${saved.version}).`,
            });
            load();
          }}
        />
      )}
      {rows?.length === 0 && !editing && (
        <p className="muted">No benchmarks yet. Make one before the first batch.</p>
      )}
      {rows && rows.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Benchmark</th>
                <th>Niche</th>
                <th>Version</th>
                <th>Used by</th>
                <th className="hide-narrow">Changed</th>
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
                  <td className="cell-strong">{row.name}</td>
                  <td>{row.niche}</td>
                  <td>v{row.version}</td>
                  <td className="small">{row.batches.join(", ") || "—"}</td>
                  <td className="hide-narrow small">
                    {when(row.updated_at)}
                    {row.updated_by && ` · ${row.updated_by}`}
                  </td>
                  {staff && (
                    <td>
                      <div className="row">
                        <button
                          className="link-button"
                          aria-label={`Edit ${row.name}`}
                          onClick={() => setEditing({ source: row, copy: false })}
                        >
                          Edit
                        </button>
                        <button
                          className="link-button"
                          aria-label={`Copy ${row.name}`}
                          onClick={() => setEditing({ source: row, copy: true })}
                        >
                          Copy
                        </button>
                        {row.batches.length === 0 && (
                          <button
                            className="link-button"
                            aria-label={`Delete ${row.name}`}
                            onClick={() => void remove(row)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
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

// --- the editor -------------------------------------------------------------------------------

type GbpNumber = Exclude<keyof GbpTargets, "primary_categories">;

const GBP_FIELDS: [GbpNumber, string, string][] = [
  ["additional_categories", "Additional categories", "4"],
  ["services", "Services", "12"],
  ["photos", "Photos", "100"],
  ["posts_90_days", "Posts in 90 days", "12"],
  ["description_length", "Description length (characters)", "600"],
  ["reviews", "Reviews", "100"],
  ["rating", "Rating (0–5)", "4.7"],
  ["review_reply_pct", "Review replies (%)", "80"],
];

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

function filled(website: Partial<Standard>): Standard {
  return {
    ...EMPTY,
    ...website,
    service_page: { ...EMPTY.service_page, ...website.service_page },
    location_page: { ...EMPTY.location_page, ...website.location_page },
    blog: { ...EMPTY.blog, ...website.blog },
  };
}

function BenchmarkEditor({
  source,
  copy,
  onCancel,
  onSaved,
}: {
  source: Benchmark | null;
  copy: boolean;
  onCancel: () => void;
  onSaved: (saved: Benchmark, created: boolean) => void;
}) {
  const creating = source === null || copy;
  const start = filled(source?.website ?? {});
  const [name, setName] = useState(source ? (copy ? `${source.name} (copy)` : source.name) : "");
  const [niche, setNiche] = useState(source?.niche ?? "");
  const [niches, setNiches] = useState<string[]>([]);
  const [gbp, setGbp] = useState<Record<string, string>>(
    Object.fromEntries(
      GBP_FIELDS.map(([key]) => [
        key,
        source?.gbp[key] === undefined ? "" : String(source.gbp[key]),
      ]),
    ),
  );
  const [primary, setPrimary] = useState((source?.gbp.primary_categories ?? []).join("\n"));
  const [s, setS] = useState<Standard>(start);
  const [topics, setTopics] = useState(start.blog.topics.join("\n"));
  const [pages, setPages] = useState(start.supporting_pages.join(", "));
  // What was typed in each "Also called" box; split into a list when saving.
  const [synonyms, setSynonyms] = useState(start.services.map((svc) => svc.synonyms.join(", ")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .niches()
      .then(setNiches)
      .catch(() => setNiches([]));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setErrors({});
    const targets: GbpTargets = {};
    for (const [key] of GBP_FIELDS) {
      const typed = (gbp[key] ?? "").trim();
      if (typed !== "") targets[key] = Number(typed);
    }
    const right = lines(primary);
    if (right.length > 0) targets.primary_categories = right;
    const website: Standard = {
      ...s,
      services: s.services.map((svc, i) => ({ ...svc, synonyms: lines(synonyms[i] ?? "") })),
      supporting_pages: lines(pages),
      blog: { ...s.blog, topics: lines(topics) },
    };
    try {
      const saved = creating
        ? await api.createBenchmark({ name, niche, gbp: targets, website })
        : await api.saveBenchmark(source.id, { name, gbp: targets, website });
      onSaved(saved, creating);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setError(err.message);
      }
      setBusy(false);
    }
  }

  const setService = (index: number, patch: Partial<Standard["services"][number]>) =>
    setS((x) => ({
      ...x,
      services: x.services.map((svc, i) => (i === index ? { ...svc, ...patch } : svc)),
    }));

  const title = creating ? (copy ? `Copy of ${source?.name}` : "New benchmark") : source.name;
  return (
    <form className="card stack" onSubmit={save} aria-label="Benchmark" noValidate>
      <h2>{title}</h2>
      {!creating && source.batches.length > 0 && (
        <Alert kind="info">
          Used by {source.batches.join(", ")}. Saving new numbers makes the agents check these
          batches' leads again against them.
        </Alert>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <fieldset disabled={busy} className="stack plain">
        <div className="connection-fields">
          <Field
            label="Name"
            placeholder="Cleaning Benchmark 1"
            value={name}
            error={errors.name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="field">
            <label htmlFor="benchmark-niche">Niche</label>
            <input
              id="benchmark-niche"
              list="benchmark-niches"
              placeholder="Cleaning"
              value={niche}
              disabled={!creating}
              aria-invalid={errors.niche ? true : undefined}
              onChange={(e) => setNiche(e.target.value)}
            />
            <datalist id="benchmark-niches">
              {niches.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {errors.niche && <p className="field-error">{errors.niche}</p>}
          </div>
        </div>

        <h3>Google Business Profile</h3>
        <p className="muted small">
          What a good profile in this niche has. Leave a box empty to skip that comparison.
        </p>
        <div className="connection-fields">
          {GBP_FIELDS.map(([key, label, example]) => (
            <Field
              key={key}
              label={label}
              type="number"
              min={0}
              step="any"
              placeholder={example}
              value={gbp[key] ?? ""}
              error={errors[`gbp.${key}`]}
              onChange={(e) => {
                const typed = e.target.value;
                setGbp((all) => ({ ...all, [key]: typed }));
              }}
            />
          ))}
        </div>

        <div className="field">
          <label htmlFor="benchmark-primary">Right primary categories</label>
          <textarea
            id="benchmark-primary"
            rows={3}
            value={primary}
            placeholder={"General contractor\nConstruction company"}
            aria-describedby="benchmark-primary-hint"
            onChange={(e) => setPrimary(e.target.value)}
          />
          <span id="benchmark-primary-hint" className="muted small">
            One a line, as Google names them. A profile whose primary category isn&apos;t one of
            these gets a red finding. Empty: not compared.
          </span>
          {errors["gbp.primary_categories"] && (
            <p className="field-error">{errors["gbp.primary_categories"]}</p>
          )}
        </div>

        <h3>Website</h3>
        <h4>Services</h4>
        {s.services.map((svc, i) => (
          <div className="service-row" key={i}>
            <Field
              label={`Service ${i + 1}`}
              value={svc.name}
              error={errors[`website.services.${i}.name`]}
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
        {errors.website && <p className="field-error">{errors.website}</p>}

        <h4>Service pages</h4>
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

        <h4>Location pages</h4>
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

        <h4>Supporting pages, blog and speed</h4>
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
            error={errors["website.mobile_lcp_seconds"]}
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
      <div className="row">
        <button className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
