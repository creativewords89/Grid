import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type LeadList } from "../api";
import { Alert } from "../components/ui";

// A batch's cities (SPEC section 6.4 item 8): switched off, a city's businesses in this batch
// are left alone by the agents. Other batches with the same city aren't touched. Cities with
// 10 or more businesses are Ready once a Top is chosen in them and Not ready until then
// (step 20); cities with fewer than 10 are muted by the Hub and listed on their own tab.

const PAGE = 20; // cities a page

type CityTab = "ready" | "not_ready" | "small";

const TABS: [CityTab, string][] = [
  ["ready", "Ready"],
  ["not_ready", "Not ready"],
  ["small", "Small cities (under 10)"],
];

function tabOf(city: LeadList): CityTab {
  if (city.small) return "small";
  return city.ready ? "ready" : "not_ready";
}

const NOTES: Record<CityTab, string> = {
  ready:
    "A Top is chosen in these cities: agents work on their other businesses. Switch a city off to pause it.",
  not_ready:
    "No Top chosen yet: agents leave these cities alone. Open a city and mark its Top businesses; it moves to Ready.",
  small:
    "Cities with fewer than 10 businesses are muted by the Hub; unmute one here and the Hub leaves it as you set it. Agents work on it once a Top is chosen in it.",
};

export function BatchCities({
  batchId,
  staff,
  shown: visible = true,
  onOpenCity,
}: {
  batchId: string;
  staff: boolean;
  shown?: boolean; // hidden while a city's leads are open; loaded again when shown
  onOpenCity: (city: string) => void;
}) {
  const [cities, setCities] = useState<LeadList[] | null>(null);
  const [typed, setTyped] = useState("");
  const [tab, setTab] = useState<CityTab>("ready");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .batchCities(batchId)
      .then(setCities)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Not loaded."));
  }, [batchId]);
  // Again on coming back from a city: marking Top there can move it to Ready.
  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

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
  const onTab = cities.filter((c) => tabOf(c) === tab);
  const shown = wanted ? onTab.filter((c) => c.city.toLowerCase().includes(wanted)) : onTab;
  const off = onTab.filter((c) => !c.active).length;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pages);
  const paged = shown.slice((current - 1) * PAGE, current * PAGE);
  const switchAll = (active: boolean) =>
    tab === "small"
      ? api.switchAllCities(batchId, active, true)
      : api.switchAllCities(batchId, active, false, tab === "ready");
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="sheet-tabs" role="tablist" aria-label="City readiness">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setPage(1);
            }}
          >
            {label} <span className="muted">({cities.filter((c) => tabOf(c) === key).length})</span>
          </button>
        ))}
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
                onClick={() => void act(() => switchAll(true))}
              >
                All on
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => void act(() => switchAll(false))}
              >
                All off
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="muted small">
        {onTab.length.toLocaleString()} cities · {(onTab.length - off).toLocaleString()} on ·{" "}
        {off.toLocaleString()} off. {NOTES[tab]}
      </p>
      <div className="card table-card table-scroll table-tall">
        <table className="table compact-table">
          <thead>
            <tr>
              <th>City</th>
              <th>Businesses</th>
              <th>Top</th>
              {tab === "small" && <th>Ready</th>}
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
                {tab === "small" && <td>{item.ready ? "Ready" : "Not ready"}</td>}
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
