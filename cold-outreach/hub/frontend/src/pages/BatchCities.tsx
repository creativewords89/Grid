import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type LeadList } from "../api";
import { Alert } from "../components/ui";

// A batch's cities (SPEC section 6.4 item 8): switched off, a city's businesses in this batch
// are left alone by the agents. Other batches with the same city aren't touched. Cities with
// fewer than 10 businesses are muted by the Hub and listed on their own tab.

const PAGE = 20; // cities a page

export function BatchCities({
  batchId,
  staff,
  onOpenCity,
}: {
  batchId: string;
  staff: boolean;
  onOpenCity: (city: string) => void;
}) {
  const [cities, setCities] = useState<LeadList[] | null>(null);
  const [typed, setTyped] = useState("");
  const [small, setSmall] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .batchCities(batchId)
      .then(setCities)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [batchId]);
  useEffect(load, [load]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!cities) return error ? <Alert kind="error">{error}</Alert> : null;
  if (cities.length === 0) {
    return <p className="muted">No cities yet: they come with the batch&apos;s lead files.</p>;
  }
  const wanted = typed.trim().toLowerCase();
  const onTab = cities.filter((c) => c.small === small);
  const shown = wanted ? onTab.filter((c) => c.city.toLowerCase().includes(wanted)) : onTab;
  const off = onTab.filter((c) => !c.active).length;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pages);
  const paged = shown.slice((current - 1) * PAGE, current * PAGE);
  const smallCount = cities.filter((c) => c.small).length;
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="sheet-tabs" role="tablist" aria-label="City size">
        <button
          role="tab"
          aria-selected={!small}
          onClick={() => {
            setSmall(false);
            setPage(1);
          }}
        >
          Cities (10+) <span className="muted">({cities.length - smallCount})</span>
        </button>
        <button
          role="tab"
          aria-selected={small}
          onClick={() => {
            setSmall(true);
            setPage(1);
          }}
        >
          Small cities (under 10) <span className="muted">({smallCount})</span>
        </button>
      </div>
      <div className="filters-row">
        <div className="field">
          <label htmlFor={`cities-search-${batchId}`}>Find a city</label>
          <input
            id={`cities-search-${batchId}`}
            value={typed}
            placeholder="Tulsa"
            onChange={(e) => {
              setTyped(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {staff && (
          <div className="field">
            <span className="label-spacer" aria-hidden="true">
              &nbsp;
            </span>
            <div className="row">
              <button
                className="button"
                disabled={busy}
                onClick={() => void act(() => api.switchAllCities(batchId, true, small))}
              >
                All on
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => void act(() => api.switchAllCities(batchId, false, small))}
              >
                All off
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="muted small">
        {onTab.length.toLocaleString()} cities · {(onTab.length - off).toLocaleString()} on ·{" "}
        {off.toLocaleString()} off.{" "}
        {small
          ? "Cities with fewer than 10 businesses are muted by the Hub; unmute one here and the Hub leaves it as you set it."
          : "Switch a city off and the agents leave its businesses in this batch alone."}
      </p>
      <div className="card table-card table-scroll table-tall">
        <table className="table compact-table">
          <thead>
            <tr>
              <th>City</th>
              <th>Businesses</th>
              <th>Top</th>
              <th>Set</th>
              <th>On</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((item) => (
              <tr key={item.id} className={item.active ? undefined : "row-muted"}>
                <td>
                  <button className="link-button" onClick={() => onOpenCity(item.city)}>
                    {item.city}
                  </button>
                </td>
                <td>{item.leads.toLocaleString()}</td>
                <td>{item.top}</td>
                <td className="small muted">{item.set_by_hand ? "Set by hand" : "By the Hub"}</td>
                <td>
                  <label className="switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={item.active}
                      disabled={!staff || busy}
                      aria-label={`${item.city} on or off`}
                      onChange={(e) =>
                        void act(() => api.updateList(item.id, { active: e.target.checked }))
                      }
                    />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="row">
          <button className="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          <span className="small">
            Page {current} of {pages} · {shown.length.toLocaleString()} cities
          </span>
          <button
            className="button"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
