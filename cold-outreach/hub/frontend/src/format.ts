/** "1 day", "3 days". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(value: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${plural(Math.round(hours / 24), "day")} ago`;
}

/** "$1.25" from a decimal string such as "1.2500". */
export function money(value: string | number): string {
  return `$${Number(value).toFixed(2)}`;
}

/** "28 Oct 2026" in the viewer's own time zone. */
export function day(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "Tue 28 Oct, 02:00" in the viewer's own time zone. */
export function when(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
