// A tiny client-side router: the app has a handful of top-level screens.
import { useEffect, useState } from "react";

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false) {
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  listeners.forEach((listener) => listener());
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

/** The secret in links like /invite#<token>, kept out of server logs. */
export function hashToken(): string {
  return window.location.hash.replace(/^#/, "");
}
