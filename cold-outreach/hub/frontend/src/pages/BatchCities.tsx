import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type LeadList } from "../api";
import { Alert } from "../components/ui";

// A batch's cities (SPEC section 6.4 item 8): switched off, a city's businesses in this batch
// are left alone by the agents. Other batches with the same city aren't touched.

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
  const shown = wanted ? cities.filter((c) => c.city.toLowerCase().includes(wanted)) : cities;
  const off = cities.filter((c) => !c.active).length;
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="filters-row">
        <div className="field">
          <label htmlFor={`cities-search-${batchId}`}>Find a city</label>
          <input
            id={`cities-search-${batchId}`}
            value={typed}
            placeholder="Tulsa"
            onChange={(e) => setTyped(e.target.value)}
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
                onClick={() => void act(() => api.switchAllCities(batchId, true))}
              >
                All on
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => void act(() => api.switchAllCities(batchId, false))}
              >
                All off
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="muted small">
        {cities.length.toLocaleString()} cities · {(cities.length - off).toLocaleString()} on ·{" "}
        {off.toLocaleString()} off. Switch a city off and the agents leave its businesses in this
        batch alone.
      </p>
      <div className="card table-card table-scroll table-tall">
        <table className="table compact-table">
          <thead>
            <tr>
              <th>City</th>
              <th>Businesses</th>
              <th>Top</th>
              <th>On</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id} className={item.active ? undefined : "row-muted"}>
                <td>
                  <button className="link-button" onClick={() => onOpenCity(item.city)}>
                    {item.city}
                  </button>
                </td>
                <td>{item.leads.toLocaleString()}</td>
                <td>{item.top}</td>
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
    </div>
  );
}
