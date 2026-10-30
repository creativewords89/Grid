import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  api,
  ApiError,
  type BenchmarkHint,
  type ReviewBusiness,
  type ReviewCity,
  type ReviewFileRow,
  type ReviewList,
  type ReviewRow,
  type ReviewShown,
  type SmallPage,
} from "../api";
import { Alert } from "../components/ui";

/** Top Review (steps 32, 39 and 41): once a file handed in on Files is past its Final check
 * without errors, Reviewers choose the Top businesses of each of its cities. A city with a Top
 * is ready: it goes on to its niche's batch an hour later, or at once with Send to batch now.
 * Cities under 10 businesses stay out unless they get a Top; they are ticked on one page.
 * Never a "Loading": the last lists show at once (kept in the browser), the next city is
 * fetched ahead, and ticks are kept as a draft until saved. */

const LISTS: [ReviewShown, string, string][] = [
  ["needs_top", "Not ready", "Cities of 10 businesses or more without a Top yet."],
  ["ready", "Ready", "A Top is chosen: each goes on to its batch an hour later, or now."],
  ["small", "Cities under 10", "They stay out of the batch unless you choose a Top."],
];

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Seconds left as the server counts them: the viewer's clock may be off.
function minutesLeft(seconds: number): string {
  const left = Math.min(60, Math.ceil(seconds / 60));
  return left <= 0 ? "any moment" : `${left} min`;
}

// What the browser keeps (step 41): the last lists, and ticks not saved yet. Never needed:
// without it (a private window) the page just fetches as usual.
function recall<T>(key: string): T | null {
  try {
    const found = window.localStorage.getItem(key);
    return found ? (JSON.parse(found) as T) : null;
  } catch {
    return null;
  }
}

function remember(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // full or blocked: nothing to keep
  }
}

const draftKey = (fileId: string, city: string) => `top-review:draft:${fileId}:${city}`;

// A city fetched ahead (the next one), so it opens at once.
const fetched = new Map<string, Promise<ReviewCity>>();
function fetchCity(fileId: string, city: string): Promise<ReviewCity> {
  const key = `${fileId}:${city}`;
  let found = fetched.get(key);
  if (!found) {
    found = api.reviewCity(fileId, city);
    found.catch(() => fetched.delete(key));
    fetched.set(key, found);
  }
  return found;
}

function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="stack-tight skeleton-list" aria-busy="true" aria-label="Getting the cities">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton" />
      ))}
    </div>
  );
}

/** Top Review (step 45): the niches, each opening to its files; a file opens to its cities,
 * in three lists. */
export function Review() {
  const [file, setFile] = useState<ReviewFileRow | null>(null);
  return file ? (
    <FileReview key={file.file_id} file={file} onBack={() => setFile(null)} />
  ) : (
    <FilesList onOpen={setFile} />
  );
}

const FILES_KEY = "top-review:files";

/** The files in Top Review by niche: a niche is closed until opened, a file opens to its
 * cities. Shown at once from what the browser kept, brought up to date behind. */
function FilesList({ onOpen }: { onOpen: (file: ReviewFileRow) => void }) {
  const [files, setFiles] = useState<ReviewFileRow[] | null>(() => recall(FILES_KEY));
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .reviewFiles()
      .then((found) => {
        setFiles(found);
        remember(FILES_KEY, found);
      })
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, []);

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (files ?? []).filter((f) =>
    words.every((w) =>
      [f.file_name, f.niche, f.uploaded_by ?? ""].join(" ").toLowerCase().includes(w),
    ),
  );
  const niches: { key: string; name: string; files: ReviewFileRow[] }[] = [];
  for (const f of shown) {
    const key = f.niche.trim().toLowerCase();
    const group = niches.find((n) => n.key === key);
    if (group) group.files.push(f);
    else niches.push({ key, name: f.niche.trim(), files: [f] });
  }
  const sum = (list: ReviewFileRow[], state: ReviewShown) =>
    list.reduce((total, f) => total + f.counts[state], 0);

  return (
    <section className="page page-wide">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="page-head">
        <div className="stack-tight">
          <h1>Top Review</h1>
          <p className="muted">
            Open a niche to see its files, then a file to choose its cities' Top.
          </p>
        </div>
      </div>
      {(files ?? []).length > 0 && (
        <label className="files-search">
          <span className="sr-only">Search files</span>
          <input
            type="search"
            placeholder="Search a file, a niche or who handed it in"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      )}
      {files === null ? (
        <div className="card">
          <Skeleton />
        </div>
      ) : shown.length === 0 ? (
        <div className="card">
          <p className="muted files-empty">
            {files.length === 0 ? "No file is in Top Review." : "No file matches the search."}
          </p>
        </div>
      ) : (
        niches.map((niche) => {
          const open = opened[niche.key] ?? words.length > 0; // closed until opened
          return (
            <section key={niche.key} className="card table-card files-niche">
              <button
                className="files-niche-head"
                aria-expanded={open}
                onClick={() => setOpened({ ...opened, [niche.key]: !open })}
              >
                <span className="files-niche-title">
                  <span aria-hidden>{open ? "▾" : "▸"}</span> <strong>{niche.name}</strong>
                </span>
                <span className="small muted">
                  {niche.files.length} {niche.files.length === 1 ? "file" : "files"} ·{" "}
                  {sum(niche.files, "needs_top")} not ready · {sum(niche.files, "ready")} ready ·{" "}
                  {sum(niche.files, "small")} under 10
                </span>
              </button>
              {open && (
                <div className="table-scroll">
                  <table className="table" aria-label={`${niche.name} files`}>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Handed in by</th>
                        <th className="num">Not ready</th>
                        <th className="num">Ready</th>
                        <th className="num">Under 10</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {niche.files.map((f) => (
                        <tr key={f.file_id}>
                          <td>
                            <button className="link-button cell-strong" onClick={() => onOpen(f)}>
                              {f.file_name}
                            </button>
                            <div className="small muted">F{f.number}</div>
                          </td>
                          <td>{f.uploaded_by ?? "—"}</td>
                          <td className="num">{f.counts.needs_top}</td>
                          <td className="num">{f.counts.ready}</td>
                          <td className="num">{f.counts.small}</td>
                          <td>
                            <button
                              className="button button-small button-primary"
                              aria-label={`Open ${f.file_name}`}
                              onClick={() => onOpen(f)}
                            >
                              Open
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}
    </section>
  );
}

/** One file's cities (step 45): Not ready, Ready and Cities under 10. */
function FileReview({ file, onBack }: { file: ReviewFileRow; onBack: () => void }) {
  const listKey = (show: ReviewShown) => `top-review:list:${file.file_id}:${show}`;
  const [show, setShow] = useState<ReviewShown>("needs_top");
  const [list, setList] = useState<ReviewList | null>(() => recall(listKey("needs_top")));
  const [open, setOpen] = useState<ReviewRow | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const key = `top-review:list:${file.file_id}:${show}`;
    api
      .reviewCities(show, file.file_id)
      .then((found) => {
        setList(found);
        remember(key, found);
      })
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [show, file.file_id]);
  useEffect(load, [load]);

  const back = useCallback(
    (text = "") => {
      setOpen(null);
      setNotice(text);
      load();
    },
    [load],
  );

  async function sendNow(row: ReviewRow) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.sendCities(row.file_id, row.key);
      setNotice(`${row.name} is in its batch.`);
      load();
    } catch (err) {
      setError(message(err, "Not sent."));
    } finally {
      setBusy(false);
    }
  }

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (list?.cities ?? []).filter((r) =>
    words.every((w) => r.name.toLowerCase().includes(w)),
  );
  const at = open ? rows.findIndex((r) => r.key === open.key) : -1;
  const next = at >= 0 ? (rows[at + 1] ?? null) : null;
  const counts = list?.counts ?? file.counts;
  const total = counts.needs_top + counts.ready + counts.small;

  function saved(row: ReviewRow, goOn: boolean) {
    const text =
      row.state === "ready"
        ? `Saved the Top of ${row.name}: it goes on to its batch in ${
            row.moves_in !== null ? minutesLeft(row.moves_in) : "an hour"
          }.`
        : `Saved ${row.name}: no Top, so it isn't ready.`;
    if (goOn && next) {
      setNotice(text);
      setOpen(next);
      load();
    } else back(text);
  }

  return (
    <section className="page page-wide">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {open ? (
        <CityView
          key={`${open.file_id}:${open.key}`}
          row={open}
          next={next}
          onBack={() => back()}
          onSaved={saved}
        />
      ) : (
        <>
          <nav className="small muted" aria-label="Breadcrumb">
            <a
              href="/review"
              onClick={(e) => {
                e.preventDefault();
                onBack();
              }}
            >
              Top Review
            </a>{" "}
            / {file.niche} / {file.file_name}
          </nav>
          <div className="page-head">
            <div className="stack-tight">
              <h1>{file.file_name}</h1>
              <p className="muted">
                {file.niche} · F{file.number}
                {file.uploaded_by && ` · handed in by ${file.uploaded_by}`} · {counts.ready} of{" "}
                {total} {total === 1 ? "city" : "cities"} with a Top
              </p>
            </div>
            {show !== "small" && (
              <label className="files-search review-search">
                <span className="sr-only">Search cities</span>
                <input
                  type="search"
                  placeholder="Search a city"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            )}
          </div>
          <nav className="files-tabs" aria-label="Cities">
            {LISTS.map(([key, label]) => (
              <button
                key={key}
                className={show === key ? "on" : undefined}
                aria-pressed={show === key}
                onClick={() => {
                  setNotice("");
                  setShow(key);
                  setList(recall(listKey(key)));
                }}
              >
                {label}
                {counts[key] > 0 && <span className="files-tab-count">{counts[key]}</span>}
              </button>
            ))}
          </nav>
          <p className="small muted">{LISTS.find(([key]) => key === show)?.[2]}</p>
          {show === "small" ? (
            <SmallCities fileId={file.file_id} onSaved={(text) => back(text)} />
          ) : (
            <div className="card table-card">
              {list === null ? (
                <Skeleton />
              ) : rows.length === 0 ? (
                <p className="muted files-empty">No city here.</p>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>City</th>
                        <th className="num">Businesses</th>
                        <th className="num">Top</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={`${row.file_id}-${row.key}`}>
                          <td>
                            <button
                              className="link-button cell-strong"
                              onMouseEnter={() => void fetchCity(row.file_id, row.key)}
                              onClick={() => {
                                setNotice("");
                                setOpen(row);
                              }}
                            >
                              {row.name}
                            </button>
                          </td>
                          <td className="num">{row.businesses.toLocaleString()}</td>
                          <td className="num">{row.tops > 0 ? row.tops : "—"}</td>
                          <td>
                            {row.state === "ready" && (
                              <div className="file-row-actions">
                                {row.moves_in !== null && (
                                  <span className="small muted">
                                    Goes on in {minutesLeft(row.moves_in)}
                                  </span>
                                )}
                                <button
                                  className="button button-small button-primary"
                                  disabled={busy}
                                  onClick={() => void sendNow(row)}
                                >
                                  Send to batch now
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function hintText(hint: BenchmarkHint | null): string {
  if (!hint) return "";
  const parts = [
    hint.reviews !== null && `${hint.reviews.toLocaleString()}+ reviews`,
    hint.rating !== null && `${hint.rating}+ rating`,
  ].filter(Boolean);
  return parts.length ? `⭐ meets ${hint.name} (${parts.join(", ")}): a likely Top` : "";
}

const cellValue = (b: ReviewBusiness, key: string) =>
  key.startsWith("extra:") ? (b.extra[key.slice(6)] ?? "") : (b.values[key] ?? "");

/** One city: tick its Top, Save, or Save & next city (the next one is fetched ahead). The
 * keyboard works too: ↑ ↓ to move, Space to tick, Enter to save and go on. */
function CityView({
  row,
  next,
  onBack,
  onSaved,
}: {
  row: ReviewRow;
  next: ReviewRow | null;
  onBack: () => void;
  onSaved: (row: ReviewRow, goOn: boolean) => void;
}) {
  const [city, setCity] = useState<ReviewCity | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [at, setAt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const table = useRef<HTMLDivElement>(null);
  const draft = draftKey(row.file_id, row.key);

  useEffect(() => {
    const coming = fetchCity(row.file_id, row.key);
    fetched.delete(`${row.file_id}:${row.key}`); // fetched ahead once: a later visit fetches again
    coming
      .then((found) => {
        setCity(found);
        const kept = recall<string[]>(draft);
        setChosen(new Set(kept ?? found.businesses.filter((b) => b.top).map((b) => b.key)));
        table.current?.focus();
      })
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [row.file_id, row.key, draft]);
  // The next city is fetched while this one is worked on.
  useEffect(() => {
    if (city && next) void fetchCity(next.file_id, next.key);
  }, [city, next]);

  function toggle(key: string) {
    const changed = new Set(chosen);
    if (changed.has(key)) changed.delete(key);
    else changed.add(key);
    setChosen(changed);
    remember(draft, [...changed]); // kept until saved, through a reload or going offline
  }

  async function save(goOn: boolean) {
    if (!city || busy) return;
    setBusy(true);
    setError("");
    try {
      const done = await api.saveTops(row.file_id, row.key, [...chosen]);
      remember(draft, null);
      onSaved(done, goOn);
    } catch (err) {
      setError(message(err, "Not saved."));
      setBusy(false);
    }
  }

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (!city || (event.target as HTMLElement).tagName === "BUTTON") return;
    const last = city.businesses.length - 1;
    if (event.key === "ArrowDown") setAt((i) => Math.min(last, i + 1));
    else if (event.key === "ArrowUp") setAt((i) => Math.max(0, i - 1));
    else if (event.key === " ") {
      const business = city.businesses[at];
      if (business) toggle(business.key);
    } else if (event.key === "Enter") void save(true);
    else return;
    event.preventDefault();
  }

  return (
    <>
      <div className="small muted">
        <a
          href="/review"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          Back to Top Review
        </a>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="review-head">
        <div className="stack-tight">
          <h1>{row.name}</h1>
          <p className="muted">
            {row.file_name} · {row.businesses} businesses, most reviews first · tick the Top ones,
            then save.
          </p>
          {city?.benchmark && <p className="small">{hintText(city.benchmark)}</p>}
        </div>
        <div className="row">
          <span className="small">{chosen.size} Top chosen</span>
          <button className="button" disabled={busy || !city} onClick={() => void save(false)}>
            Save
          </button>
          {next && (
            <button
              className="button button-primary"
              disabled={busy || !city}
              onClick={() => void save(true)}
            >
              Save &amp; next city ({next.name})
            </button>
          )}
          {!next && (
            <button
              className="button button-primary"
              disabled={busy || !city}
              onClick={() => void save(false)}
            >
              {busy ? "Saving…" : `Save the Top of ${row.name}`}
            </button>
          )}
        </div>
      </div>
      {city && chosen.size === 0 && (
        <p className="small muted">No Top chosen: this city isn't ready.</p>
      )}
      <p className="small muted">Keys: ↑ ↓ move · Space ticks · Enter saves and goes on.</p>
      <div className="card table-card">
        {!city ? (
          <Skeleton rows={Math.min(10, row.businesses)} />
        ) : (
          <div
            className="table-scroll review-keys"
            tabIndex={0}
            ref={table}
            onKeyDown={keys}
            aria-label={`Businesses of ${row.name}`}
          >
            <table className="table compact-table review-table">
              <thead>
                <tr>
                  <th>Top</th>
                  {city.columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {city.businesses.map((b, index) => (
                  <tr
                    key={b.key}
                    className={[chosen.has(b.key) && "row-top", index === at && "row-at"]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="nowrap">
                      <input
                        type="checkbox"
                        aria-label={`Top: ${b.values.business_name ?? b.key}`}
                        checked={chosen.has(b.key)}
                        onChange={() => {
                          setAt(index);
                          toggle(b.key);
                        }}
                      />{" "}
                      {b.likely && (
                        <span title="Meets the benchmark: a likely Top" aria-label="Likely Top">
                          ⭐
                        </span>
                      )}
                    </td>
                    {city.columns.map((c) => (
                      <td key={c.key} className="small" title={cellValue(b, c.key)}>
                        <span className={c.key === "address" ? "cell-clamp" : "cell-trunc"}>
                          {cellValue(b, c.key)}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/** The cities under 10 on one page (step 41): tick their Tops and save them all at once. */
function SmallCities({ fileId, onSaved }: { fileId: string; onSaved: (text: string) => void }) {
  const [page, setPage] = useState(1);
  const [found, setFound] = useState<SmallPage | null>(() =>
    recall(`top-review:small:${fileId}:1`),
  );
  const [chosen, setChosen] = useState<Record<string, string[]>>(
    () => recall("top-review:draft:small") ?? {},
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .smallCities(page, fileId)
      .then((got) => {
        setFound(got);
        remember(`top-review:small:${fileId}:${page}`, got);
      })
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [page, fileId]);

  const id = (c: { file_id: string; key: string }) => `${c.file_id}:${c.key}`;
  function toggle(city: string, key: string) {
    const now = new Set(chosen[city] ?? []);
    if (now.has(key)) now.delete(key);
    else now.add(key);
    const changed = { ...chosen, [city]: [...now] };
    if (now.size === 0) delete changed[city];
    setChosen(changed);
    remember("top-review:draft:small", changed);
  }
  const picked = (found?.cities ?? []).filter((c) => (chosen[id(c)] ?? []).length > 0);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.saveManyTops(
        picked.map((c) => ({ file_id: c.file_id, city: c.key, tops: chosen[id(c)] ?? [] })),
      );
      const left = { ...chosen };
      for (const c of picked) delete left[id(c)];
      setChosen(left);
      remember("top-review:draft:small", left);
      onSaved(
        `Saved the Top of ${picked.length} ${picked.length === 1 ? "city" : "cities"}: they go on to their batch in an hour.`,
      );
    } catch (err) {
      setError(message(err, "Not saved."));
      setBusy(false);
    }
  }

  if (!found) return <Skeleton />;
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row">
        <span className="small">
          {found.total} {found.total === 1 ? "city" : "cities"} under 10
          {found.pages > 1 && ` · page ${found.page} of ${found.pages}`}
        </span>
        <button
          className="button button-primary"
          disabled={busy || picked.length === 0}
          onClick={() => void save()}
        >
          Save the Tops of {picked.length} {picked.length === 1 ? "city" : "cities"}
        </button>
        {found.page > 1 && (
          <button className="button" onClick={() => setPage(found.page - 1)}>
            ← Previous
          </button>
        )}
        {found.page < found.pages && (
          <button className="button" onClick={() => setPage(found.page + 1)}>
            Next →
          </button>
        )}
      </div>
      {found.benchmark && <p className="small">{hintText(found.benchmark)}</p>}
      {found.cities.length === 0 && <p className="muted files-empty">No city here.</p>}
      {found.cities.map((c) => (
        <section key={id(c)} className="card table-card" aria-label={`${c.name}, ${c.file_name}`}>
          <h2 className="small-city-head">
            {c.name}{" "}
            <span className="small muted">
              · {c.file_name} · F{c.number} · {c.niche}
            </span>
          </h2>
          <div className="table-scroll">
            <table className="table compact-table review-table">
              <thead>
                <tr>
                  <th>Top</th>
                  {found.columns.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.businesses_list.map((b) => {
                  const on = (chosen[id(c)] ?? []).includes(b.key);
                  return (
                    <tr key={b.key} className={on ? "row-top" : undefined}>
                      <td className="nowrap">
                        <input
                          type="checkbox"
                          aria-label={`Top: ${b.values.business_name ?? b.key} (${c.name})`}
                          checked={on}
                          onChange={() => toggle(id(c), b.key)}
                        />{" "}
                        {b.likely && (
                          <span title="Meets the benchmark: a likely Top" aria-label="Likely Top">
                            ⭐
                          </span>
                        )}
                      </td>
                      {found.columns.map((col) => (
                        <td key={col.key} className="small" title={cellValue(b, col.key)}>
                          <span className={col.key === "address" ? "cell-clamp" : "cell-trunc"}>
                            {cellValue(b, col.key)}
                          </span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
