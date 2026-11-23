import { useCallback, useEffect, useRef, useState } from "react";

/** Copy text to the clipboard. The modern clipboard API is refused when the browser or a
 * site setting blocks clipboard access (or the page isn't focused), so fall back to copying
 * from a hidden text box, which browsers still allow on a click. True when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: try the older way below.
  }
  return copyFromTextBox(text);
}

function copyFromTextBox(text: string): boolean {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.setAttribute("aria-hidden", "true");
  box.style.position = "fixed";
  box.style.top = "0";
  box.style.left = "0";
  box.style.opacity = "0";
  document.body.append(box);
  box.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    box.remove();
    before?.focus();
  }
}

export type CopyState = "idle" | "copied" | "failed";

/** A Copy button's state: "copied" for a moment after it worked, "failed" for a little
 * longer when the browser refused, so the person knows to copy by hand. */
export function useCopy(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    void copyText(text).then((ok) => {
      window.clearTimeout(timer.current);
      setState(ok ? "copied" : "failed");
      timer.current = window.setTimeout(() => setState("idle"), ok ? 1500 : 4000);
    });
  }, []);
  return [state, copy];
}

/** The button text for a copy state. */
export function copyLabel(state: CopyState, label = "Copy"): string {
  return state === "copied" ? "Copied ✓" : state === "failed" ? "Couldn't copy" : label;
}

export const COPY_FAILED = "Your browser blocked copying. Select the text and press Ctrl+C.";
