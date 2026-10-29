import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ReviewCity,
  type ReviewCityState,
  type ReviewFile,
  type ReviewFileDetail,
} from "../api";
import { Alert } from "../components/ui";
import { day } from "../format";

/** Top Review (step 32): once a file handed in on Files has no error, Reviewers choose each
 * city's Top businesses in it, one city at a time. Cities under 10 businesses are off. When
 * every city that is on has a Top the file is ready and locked. */

const CITY_STATE: Record<ReviewCityState, [string, string]> = {
  ready: ["badge-ok", "Ready"],
  needs_top: ["badge-warning", "Needs a Top"],
  off: ["badge", "Off · under 10"],
};

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function Review() {
  const [files, setFiles] = useState<ReviewFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    api
      .reviewFiles()
      .then(setFiles)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, []);
  useEffect(load, [load]);

  // Stable, so the views don't load again when this screen changes.
  const back = useCallback(
    (text = "") => {
      setOpen(null);
      setCity(null);
      setNotice(text);
      load();
    },
    [load],
  );

  return (
    <section className="page page-wide">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {open && city ? (
        <CityView
          fileId={open}
          cityKey={city}
          onBack={() => {
            setCity(null);
            setNotice("");
          }}
          onSaved={(detail, name) => {
            if (detail.state === "done") {
              back(`Every city has a Top: ${detail.file_name} is ready and locked.`);
            } else {
              setCity(null);
              setNotice(`Saved the Top of ${name}.`);
            }
          }}
          onLocked={back}
        />
      ) : open ? (
        <FileView
          fileId={open}
          onBack={() => back()}
          onCity={(key) => {
            setNotice("");
            setCity(key);
          }}
          onLocked={back}
        />
      ) : (
        <FileList
          files={files}
          onOpen={(id) => {
            setNotice("");
            setOpen(id);
          }}
        />
      )}
    </section>
  );
}

function FileList({ files, onOpen }: { files: ReviewFile[] | null; onOpen: (id: string) => void }) {
  const waiting = (files ?? []).filter((f) => f.state === "needs_top");
  const done = (files ?? []).filter((f) => f.state === "done");
  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Top Review</h1>
          <p className="muted">
            Choose the Top businesses of each city in these files. A city with fewer than 10
            businesses is off and needs none. When every city has a Top the file is done and locked.
          </p>
        </div>
      </div>
      <div className="card table-card stack-tight">
        <h2>Waiting for Top</h2>
        {files === null ? (
          <p className="muted">Loading…</p>
        ) : waiting.length === 0 ? (
          <p className="muted">No file is waiting.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Niche</th>
                <th className="num">Businesses</th>
                <th>Cities with a Top</th>
                <th className="hide-narrow">Handed in</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button className="link-button cell-strong" onClick={() => onOpen(f.id)}>
                      {f.file_name}
                    </button>
                  </td>
                  <td>{f.niche}</td>
                  <td className="num">{f.businesses.toLocaleString()}</td>
                  <td>
                    {f.cities_topped} of {f.cities_on}
                  </td>
                  <td className="hide-narrow small">{day(f.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {done.length > 0 && (
        <div className="card stack-tight">
          <h2>Done</h2>
          <ul className="stack-tight plain">
            {done.map((f) => (
              <li key={f.id}>
                {f.file_name} <span className="badge badge-ok">Done ✓</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function FileView({
  fileId,
  onBack,
  onCity,
  onLocked,
}: {
  fileId: string;
  onBack: () => void;
  onCity: (key: string) => void;
  onLocked: (text: string) => void;
}) {
  const [file, setFile] = useState<ReviewFileDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .reviewFile(fileId)
      .then(setFile)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "locked") onLocked(err.message);
        else setError(message(err, "Not loaded."));
      });
  }, [fileId, onLocked]);

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
          Top Review
        </a>{" "}
        / {file?.file_name}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {file && (
        <>
          <h1>{file.file_name}</h1>
          <p className="muted">
            {file.niche} · {file.businesses.toLocaleString()} businesses · {file.cities_topped} of{" "}
            {file.cities_on} {file.cities_on === 1 ? "city has" : "cities have"} a Top
          </p>
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>City</th>
                  <th className="num">Businesses</th>
                  <th className="num">Top</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {file.cities.map((c) => (
                  <tr key={c.key} className={c.state === "off" ? "row-muted" : undefined}>
                    <td>
                      {c.state === "off" ? (
                        c.name
                      ) : (
                        <button className="link-button cell-strong" onClick={() => onCity(c.key)}>
                          {c.name}
                        </button>
                      )}
                    </td>
                    <td className="num">{c.businesses.toLocaleString()}</td>
                    <td className="num">{c.state === "off" ? "—" : c.tops}</td>
                    <td>
                      <span className={`badge ${CITY_STATE[c.state][0]}`}>
                        {CITY_STATE[c.state][1]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function CityView({
  fileId,
  cityKey,
  onBack,
  onSaved,
  onLocked,
}: {
  fileId: string;
  cityKey: string;
  onBack: () => void;
  onSaved: (file: ReviewFileDetail, city: string) => void;
  onLocked: (text: string) => void;
}) {
  const [city, setCity] = useState<ReviewCity | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .reviewCity(fileId, cityKey)
      .then((found) => {
        setCity(found);
        setChosen(new Set(found.businesses.filter((b) => b.top).map((b) => b.key)));
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "locked") onLocked(err.message);
        else setError(message(err, "Not loaded."));
      });
  }, [fileId, cityKey, onLocked]);

  function toggle(key: string) {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChosen(next);
  }

  async function save() {
    if (!city) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await api.saveTops(fileId, cityKey, [...chosen]), city.name);
    } catch (err) {
      if (err instanceof ApiError && err.code === "locked") onLocked(err.message);
      else setError(message(err, "Not saved."));
      setBusy(false);
    }
  }

  const value = (b: ReviewCity["businesses"][number], key: string) =>
    key.startsWith("extra:") ? (b.extra[key.slice(6)] ?? "") : (b.values[key] ?? "");

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
          Back to the cities
        </a>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {city && (
        <>
          <div className="review-head">
            <div className="stack-tight">
              <h1>{city.name}</h1>
              <p className="muted">
                {city.businesses.length} businesses · tick the Top ones, then save.
              </p>
            </div>
            <div className="row">
              <span className="small">{chosen.size} Top chosen</span>
              <button className="button button-primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : `Save the Top of ${city.name}`}
              </button>
            </div>
          </div>
          {chosen.size === 0 && (
            <p className="small muted">No Top chosen: this city stays Needs a Top.</p>
          )}
          <div className="card table-card">
            <div className="table-scroll">
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
                  {city.businesses.map((b) => (
                    <tr key={b.key} className={chosen.has(b.key) ? "row-top" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Top: ${b.values.business_name ?? b.key}`}
                          checked={chosen.has(b.key)}
                          onChange={() => toggle(b.key)}
                        />
                      </td>
                      {city.columns.map((c) => (
                        <td key={c.key} className="small" title={value(b, c.key)}>
                          <span className={c.key === "address" ? "cell-clamp" : "cell-trunc"}>
                            {value(b, c.key)}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
