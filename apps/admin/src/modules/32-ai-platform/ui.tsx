// apps/admin/src/modules/32-ai-platform — shared presentational bits for the §5.1 AI Safety Owner
// console (GAP-049), in the 2026-09-25 redesign's list chrome: the `wx-*` classes from
// packages/ui/src/web/styles/list-chrome.css plus the @wardenx/ui kit — no inline styles, no raw colour.
import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
} from "@wardenx/ui";
import type { GlyphName } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";

/** The redesign's page title block (`wx-page-head`) with optional right-hand actions. */
export function PageHead({
  title,
  description,
  children,
}: { title: ReactNode; description: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <header className="wx-page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children ? <div className="wx-list-toolbar-end">{children}</div> : null}
    </header>
  );
}

/** A page section heading above a table (the redesign has no section card for a bare table). */
export function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h2 className="m-0 text-base font-semibold">{children}</h2>;
}

/** Loading state in the list-state card. */
export function LoadingState({ label }: { label: string }): JSX.Element {
  return (
    <div className="wx-list-state">
      <LoadingSpinner label={label} />
    </div>
  );
}

/** Error state in the list-state card, with a retry. */
export function ErrorState({
  message,
  onRetry,
}: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="wx-list-state" role="alert">
      <InlineAlert tone="error">{message}</InlineAlert>
      <Button tone="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Empty state in the list-state card. */
export function EmptyListState({
  title,
  description,
  glyph = "check-circle",
}: { title: string; description?: string; glyph?: GlyphName }): JSX.Element {
  return (
    <div className="wx-list-state">
      <Glyph name={glyph} size={24} />
      <span className="font-semibold">{title}</span>
      {description ? <span className="text-sm">{description}</span> : null}
    </div>
  );
}

/** A first-class outcome banner surfacing a server result to the operator. */
export function OutcomeBanner({ ok, message }: { ok: boolean; message: string }): JSX.Element {
  return <InlineAlert tone={ok ? "success" : "error"}>{message}</InlineAlert>;
}

/**
 * A persistent, non-dismissible notice. §5.1.4 requires the PHI-masking banner to be a HEADER banner
 * rather than a toast: the operator must be able to see, at any moment while reading the table, that
 * what they are looking at is masked. A dismissible affordance would defeat that.
 */
export function StandingNotice({
  tone,
  children,
}: { tone: StatusTone; children: ReactNode }): JSX.Element {
  return (
    <div role="note" className="wx-drawer-card flex items-center gap-3">
      <StatusPill label={tone === "success" ? "OK" : "Notice"} tone={tone} />
      <span className="text-sm">{children}</span>
    </div>
  );
}

/** Enter/Space activates a selectable table row, as a click does. */
export function onRowKey(
  open: () => void,
): (e: { key: string; preventDefault: () => void }) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

const ACRONYMS = new Set(["ai", "zdr", "sla", "phi", "hitl", "pr", "id"]);

/** Sentence-case an underscore enum value, e.g. `dangerous_clinical_suggestion` → `Dangerous clinical suggestion`. */
export function cap(s: string): string {
  const words = s
    .split("_")
    .filter((w) => w !== "")
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Absolute-instant formatting; `null` renders an em dash rather than "Invalid Date". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** Whole-number formatting for token counts. */
export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}
