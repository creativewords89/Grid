import { useState } from "react";
import { api, type NotificationItem } from "../api";
import { ago } from "../format";
import { navigate } from "../router";

/** The 🔔 in the top bar (SPEC section 6.11). */
export function Bell({ unread, onChange }: { unread: number; onChange: (unread: number) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const list = await api.listNotifications().catch(() => null);
    if (list) {
      setItems(list.items);
      onChange(list.unread);
    }
  }

  async function go(item: NotificationItem) {
    setOpen(false);
    if (!item.read_at) {
      const list = await api.markRead([item.id]).catch(() => null);
      if (list) onChange(list.unread);
    }
    if (item.link) navigate(item.link);
  }

  async function readAll() {
    const list = await api.markRead().catch(() => null);
    if (list) {
      setItems(list.items);
      onChange(list.unread);
    }
  }

  return (
    <div className="menu">
      <button
        className="icon-button bell"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        🔔{unread > 0 && <span className="badge bell-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="menu-list bell-list" role="menu">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="link-button small" onClick={() => void readAll()}>
                Mark all read
              </button>
            )}
          </div>
          {items === null && <p className="muted small">Loading…</p>}
          {items?.length === 0 && <p className="muted small">Nothing yet.</p>}
          {items?.map((item) => (
            <button
              key={item.id}
              role="menuitem"
              className={item.read_at ? "bell-item" : "bell-item unread"}
              onClick={() => void go(item)}
            >
              <span className="bell-title">{item.title}</span>
              {item.body && <span className="muted small bell-body">{item.body}</span>}
              <span className="muted small">{ago(item.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
