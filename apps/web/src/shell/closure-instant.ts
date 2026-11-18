// apps/web/src/shell — the one way every visit-note closure surface prints an instant (ADR-0113). A leaf (no React, no client): the shell's
// banner and the encounters module's My notes, overdue board, drawer and policy screen all import it, so the same deadline never reads
// two ways. Modules may import the shell; the shell never imports a feature module (ADR-0030).

/** An instant in the viewer's locale and time zone ("Nov 18, 3:40 PM"); an unparseable value is shown as a dash, never "Invalid Date". */
export function formatClosureInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
