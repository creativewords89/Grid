import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Batch, type BatchCity, type BatchFile } from "../api";
import { Alert } from "../components/ui";

/** A niche's batch and the files its cities came from (step 46): the files of a batch, and
 * one file's cities in it (on or off, leads, Top, done by agents, Lead Check problems), each
 * of which can be sent back to Top Review. */

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The batch's files, oldest first, each opening to its cities. */
export function BatchFilesTable({
  batch,
  onOpen,
}: {
  batch: Batch;
  onOpen: (file: BatchFile) => void;
}) {
  const [files, setFiles] = useState<BatchFile[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .batchFiles(batch.id)
      .then(setFiles)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [batch.id]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (files === null) return <p className="muted files-empty">Getting its files…</p>;
  if (files.length === 0)
    return (
      <p className="muted files-empty">
        No files yet: its cities come from Top Review once they have their Top.
      </p>
    );
  return (
    <div className="table-scroll">
      <table className="table" aria-label={`${batch.name} files`}>
        <thead>
          <tr>
            <th>File</th>
            <th>Handed in by</th>
            <th className="num">Cities</th>
            <th className="num">Businesses</th>
            <th className="num">Done by agents</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.file_id}>
              <td>
                <button className="link-button cell-strong" onClick={() => onOpen(f)}>
                  {f.file_name}
                </button>
                <div className="small muted">
                  F{f.number} · {f.cities} {f.cities === 1 ? "city" : "cities"} in the batch
                  {f.cities_in_review > 0 && ` (${f.cities_in_review} still in Top Review)`}
                </div>
              </td>
              <td>{f.uploaded_by ?? "—"}</td>
              <td className="num">{f.cities}</td>
              <td className="num">
                {f.leads.toLocaleString()}
                {f.top > 0 && <span className="muted small"> · {f.top} Top</span>}
              </td>
              <td className="num">{f.done_pct === null ? "—" : `${f.done_pct}%`}</td>
              <td>
                <button
                  className="button button-small"
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
  );
}

type CityTab = "on" | "off" | "problems";
const CITY_TABS: [CityTab, string][] = [
  ["on", "On"],
  ["off", "Off"],
  ["problems", "Lead Check problems"],
];

/** One file's cities in the batch. A city opens to its leads in the batch. */
export function BatchFileView({
  batch,
  file,
  staff,
  onBack,
  onOpenCity,
}: {
  batch: Batch;
  file: BatchFile;
  staff: boolean;
  onBack: () => void;
  onOpenCity: (city: string) => void;
}) {
  const [cities, setCities] = useState<BatchCity[] | null>(null);
  const [tab, setTab] = useState<CityTab>("on");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .batchFileCities(batch.id, file.file_id)
      .then(setCities)
      .catch((err: unknown) => {
        // Its last city sent back: nothing of it is in the batch any more.
        if (err instanceof ApiError && err.status === 404) setCities([]);
        else setError(message(err, "Not loaded."));
      });
  }, [batch.id, file.file_id]);
  useEffect(load, [load]);

  async function act(action: () => Promise<unknown>, failed: string, done = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (done) setNotice(done);
      load();
    } catch (err) {
      setError(message(err, failed));
    } finally {
      setBusy(false);
    }
  }

  const all = cities ?? [];
  const inTab = (c: BatchCity) =>
    tab === "on" ? c.active : tab === "off" ? !c.active : c.problems > 0;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((c) => inTab(c) && words.every((w) => c.name.toLowerCase().includes(w)));
  const count = (t: CityTab) =>
    all.filter((c) => (t === "on" ? c.active : t === "off" ? !c.active : c.problems > 0)).length;

  return (
    <section className="page page-wide">
      <nav className="small muted" aria-label="Breadcrumb">
        <a
          href="/batches"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
        >
          Batches
        </a>{" "}
        / {batch.name} / {file.file_name}
      </nav>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <div className="page-head">
        <div className="stack-tight">
          <h1>{file.file_name}</h1>
          <p className="muted">
            In {batch.name} · F{file.number}
            {file.uploaded_by && ` · handed in by ${file.uploaded_by}`} · {all.length}{" "}
            {all.length === 1 ? "city" : "cities"} here
            {file.cities_in_review > 0 && `, ${file.cities_in_review} still in Top Review`}
          </p>
        </div>
        <label className="files-search review-search">
          <span className="sr-only">Search cities</span>
          <input
            type="search"
            placeholder="Search a city"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <nav className="files-tabs" aria-label="Cities">
        {CITY_TABS.map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "on" : undefined}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
            {count(key) > 0 && (
              <span className={`files-tab-count ${key === "problems" ? "bad" : ""}`}>
                {count(key)}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="card table-card">
        {cities === null ? (
          <p className="muted files-empty">Getting its cities…</p>
        ) : shown.length === 0 ? (
          <p className="muted files-empty">No city here.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>City</th>
                  <th className="num">Leads</th>
                  <th className="num">Top</th>
                  <th className="num">Done by agents</th>
                  <th className="num">Problems</th>
                  <th>On</th>
                  {staff && <th />}
                </tr>
              </thead>
              <tbody>
                {shown.map((city) => (
                  <tr key={city.key}>
                    <td>
                      <button
                        className="link-button cell-strong"
                        onClick={() => onOpenCity(city.name)}
                      >
                        {city.name}
                      </button>
                    </td>
                    <td className="num">{city.leads}</td>
                    <td className="num">{city.top}</td>
                    <td className="num">
                      {city.done} of {city.leads - city.top}
                    </td>
                    <td className="num">{city.problems > 0 ? city.problems : "—"}</td>
                    <td>
                      <label className="switch">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={city.active}
                          disabled={!staff || busy || city.list_id === null}
                          aria-label={`${city.name} on or off`}
                          onChange={(e) => {
                            const listId = city.list_id;
                            if (listId)
                              void act(
                                () => api.updateList(listId, { active: e.target.checked }),
                                "Not changed.",
                              );
                          }}
                        />
                      </label>
                    </td>
                    {staff && (
                      <td>
                        <button
                          className="button button-small"
                          disabled={busy || batch.status === "running"}
                          title={batch.status === "running" ? "Pause the batch first" : undefined}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Send ${city.name} back to Top Review? Its leads in this batch go, with their agents' results; its Top is chosen again.`,
                              )
                            )
                              void act(
                                () => api.sendBackCity(file.file_id, city.key),
                                "Not sent back.",
                                `${city.name} is back in Top Review.`,
                              );
                          }}
                        >
                          Send back to Top Review
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="small muted">
        A city opens to its leads, with every agent&apos;s result. Off: agents leave its leads
        alone.
      </p>
    </section>
  );
}
