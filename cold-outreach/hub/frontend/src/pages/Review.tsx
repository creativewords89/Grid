import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ReviewCity,
  type ReviewList,
  type ReviewRow,
  type ReviewShown,
} from "../api";
import { Alert } from "../components/ui";

/** Top Review (steps 32 and 39): once a file handed in on Files is past its Final check
 * without errors, Reviewers choose the Top businesses of each of its cities, one city at a
 * time. A city with a Top is ready: it goes on to its niche's batch an hour later, or at once
 * with Send to batch now. Cities under 10 businesses stay out unless they get a Top. */

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

export function Review() {
  const [show, setShow] = useState<ReviewShown>("needs_top");
  const [list, setList] = useState<ReviewList | null>(null);
  const [open, setOpen] = useState<ReviewRow | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .reviewCities(show)
      .then(setList)
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [show]);
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

  return (
    <section className="page page-wide">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {open ? (
        <CityView
          fileId={open.file_id}
          cityKey={open.key}
          onBack={() => back()}
          onSaved={(row) =>
            back(
              row.state === "ready"
                ? `Saved the Top of ${row.name}: it goes on to its batch in ${
                    row.moves_in !== null ? minutesLeft(row.moves_in) : "an hour"
                  }.`
                : `Saved ${row.name}: no Top, so it isn't ready.`,
            )
          }
        />
      ) : (
        <>
          <div className="page-head">
            <div className="stack-tight">
              <h1>Top Review</h1>
              <p className="muted">
                Choose the Top businesses of each city. A city with a Top goes on to its niche's
                batch an hour later, or now with Send to batch now.
              </p>
            </div>
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
                }}
              >
                {label}
                {(list?.counts[key] ?? 0) > 0 && (
                  <span className="files-tab-count">{list?.counts[key]}</span>
                )}
              </button>
            ))}
          </nav>
          <p className="small muted">{LISTS.find(([key]) => key === show)?.[2]}</p>
          <div className="card table-card">
            {list === null ? (
              <p className="muted files-empty">Loading…</p>
            ) : list.cities.length === 0 ? (
              <p className="muted files-empty">No city here.</p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>City</th>
                      <th>File</th>
                      <th>Niche</th>
                      <th className="num">Businesses</th>
                      <th className="num">Top</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.cities.map((row) => (
                      <tr key={`${row.file_id}-${row.key}`}>
                        <td>
                          <button
                            className="link-button cell-strong"
                            onClick={() => {
                              setNotice("");
                              setOpen(row);
                            }}
                          >
                            {row.name}
                          </button>
                        </td>
                        <td className="small">
                          {row.file_name} <span className="muted">· F{row.number}</span>
                        </td>
                        <td>{row.niche}</td>
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
        </>
      )}
    </section>
  );
}

function CityView({
  fileId,
  cityKey,
  onBack,
  onSaved,
}: {
  fileId: string;
  cityKey: string;
  onBack: () => void;
  onSaved: (row: ReviewRow) => void;
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
      .catch((err: unknown) => setError(message(err, "Not loaded.")));
  }, [fileId, cityKey]);

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
      onSaved(await api.saveTops(fileId, cityKey, [...chosen]));
    } catch (err) {
      setError(message(err, "Not saved."));
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
          Back to Top Review
        </a>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {city && (
        <>
          <div className="review-head">
            <div className="stack-tight">
              <h1>{city.name}</h1>
              <p className="muted">
                {city.file_name} · {city.businesses.length} businesses · tick the Top ones, then
                save.
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
            <p className="small muted">No Top chosen: this city isn't ready.</p>
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
