import { useState, type ReactNode } from "react";
import type { Role } from "./api";
import { useAuth } from "./auth";
import { navigate } from "./router";

type NavItem = { path: string; label: string; roles?: Role[] };

// Sidebar of SPEC section 7; screens are added with their build steps. Hiding items is for
// tidiness only: the server enforces access.
const NAV: NavItem[] = [
  { path: "/", label: "Overview" },
  { path: "/import", label: "Import" },
  { path: "/agents", label: "Agents" },
  { path: "/runs", label: "Runs" },
  { path: "/connections", label: "Connections", roles: ["owner"] },
  { path: "/users", label: "Users", roles: ["owner"] },
];

export function Shell({ path, children }: { path: string; children: ReactNode }) {
  const { user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  if (!user) return null;

  const go = (to: string) => {
    setMenuOpen(false);
    setNavOpen(false);
    navigate(to);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="icon-button nav-toggle"
          aria-label="Menu"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(!navOpen)}
        >
          ☰
        </button>
        <span className="mark" aria-hidden="true">
          GR
        </span>
        <span className="brand">Agent Hub</span>
        <div className="spacer" />
        <div className="menu">
          <button
            className="chip"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {user.name}
          </button>
          {menuOpen && (
            <div className="menu-list" role="menu">
              <button role="menuitem" onClick={() => go("/profile")}>
                Profile
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void signOut().then(() => navigate("/", true));
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="body">
        <nav className={`sidebar ${navOpen ? "open" : ""}`} aria-label="Main">
          {NAV.filter((item) => !item.roles || item.roles.includes(user.role)).map((item) => (
            <a
              key={item.path}
              href={item.path}
              aria-current={path === item.path ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(item.path);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
