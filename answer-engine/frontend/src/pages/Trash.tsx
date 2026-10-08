import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type TrashItem } from "../api";
import { Alert, Confirm } from "../components/ui";
import { formatDate } from "../format";

const KIND_LABEL = {
  file: "File",
  verified_answer: "Verified answer",
  thread: "Thread",
  conversation: "Conversation",
};

export function Trash() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [purging, setPurging] = useState<TrashItem | null>(null);

  const load = useCallback(() => {
    api
      .listTrash()
      .then(setItems)
      .catch((err: unknown) =>
        setNotice({ kind: "error", text: err instanceof ApiError ? err.message : "Not loaded." }),
      );
  }, []);
  useEffect(load, [load]);

  async function act(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      setNotice({ kind: "success", text: done });
    } catch (err) {
      setNotice({
        kind: "error",
        text: err instanceof ApiError ? err.message : "Something went wrong.",
      });
    }
    load();
  }

  return (
    <>
      <p className="muted">Deleted items are kept for 30 days, then removed for good.</p>
      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {items && items.length === 0 && (
        <div className="card empty">
          <p>The trash is empty.</p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Deleted by</th>
                <th>Deleted</th>
                <th>Removed for good</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="cell-strong">{item.title}</div>
                    <div className="muted small">
                      {KIND_LABEL[item.kind]}
                      {item.reason === "replaced" && " · replaced by a new version"}
                    </div>
                  </td>
                  <td>{item.deleted_by ?? "System"}</td>
                  <td className="hide-narrow">{formatDate(item.deleted_at)}</td>
                  <td className="hide-narrow">{formatDate(item.purge_at)}</td>
                  <td className="actions">
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() =>
                        void act(() => api.restoreTrash(item.id), `${item.title} was restored.`)
                      }
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => setPurging(item)}
                    >
                      Delete forever
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {purging && (
        <Confirm
          title="Delete forever?"
          message={
            <>
              <strong>{purging.title}</strong> will be removed for good, including the original
              file. This can't be undone.
            </>
          }
          confirmLabel="Delete forever"
          danger
          onClose={() => setPurging(null)}
          onConfirm={() => {
            const item = purging;
            setPurging(null);
            void act(() => api.purgeTrash(item.id), `${item.title} was deleted for good.`);
          }}
        />
      )}
    </>
  );
}
