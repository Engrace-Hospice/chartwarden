// apps/admin/src/modules/35-subscription-billing — shared presentational bits for the §5.2 console screens.
// The redesign's list + right drawer chrome lives in the shared `wx-*` classes (packages/ui list-chrome.css);
// these helpers only compose it with the @chartwarden/ui kit so the 14 screens write it once. No inline styles.
import {
  Button,
  Glyph,
  type GlyphName,
  InlineAlert,
  LoadingSpinner,
  ReverifyLink,
  isStepUpRequired,
} from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";

/** A server result surfaced to the operator. `stepUp`: the refusal was STEP_UP_REQUIRED (offer Re-verify). */
export interface Outcome {
  readonly ok: boolean;
  readonly message: string;
  readonly stepUp?: boolean;
}

export const STEP_UP_MESSAGE = "This action needs a fresh verification. Re-verify, then try again.";

/**
 * The outcome for a failed write: a STEP_UP_REQUIRED refusal (session valid but not fresh enough) becomes
 * the re-verify outcome, anything else `fallback`. `error` is the parsed error body openapi-fetch returns —
 * the standard envelope `{ error: { code } }` (reading a top-level `.code` off it never matched).
 */
export function failureOutcome(error: unknown, fallback: string): Outcome {
  return isStepUpRequired(error)
    ? { ok: false, message: STEP_UP_MESSAGE, stepUp: true }
    : { ok: false, message: fallback };
}

/**
 * A first-class outcome banner (success/error) surfacing a server result to the operator. A step-up refusal
 * also carries a Re-verify link to the console's /step-up page, which returns here — never an automatic
 * redirect, so a form with typed input is not torn away.
 */
export function OutcomeBanner({
  ok,
  message,
  stepUp = false,
  onReverify,
}: Outcome & {
  /** Called as the operator leaves for /step-up, to keep their typed form for the return trip (#597). */
  onReverify?: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <InlineAlert tone={ok ? "success" : "error"}>{message}</InlineAlert>
      {stepUp ? <ReverifyLink onNavigate={onReverify} /> : null}
    </div>
  );
}

/** True when a read answered 404: the record is gone, so "Try again" cannot succeed (#597, F-044). */
export const isNotFound = (res: { response?: { status?: number } }): boolean =>
  res.response?.status === 404;

/** A keyset "Load more" affordance shared by the cursor-paged lists. */
export function LoadMore({
  hasMore,
  loading,
  onMore,
}: { hasMore: boolean; loading: boolean; onMore: () => void }): JSX.Element | null {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center">
      <Button tone="secondary" loading={loading} onClick={onMore}>
        Load more
      </Button>
    </div>
  );
}

/** The loading state of a list or page body. */
export function StateLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="wx-list-state">
      <LoadingSpinner label={label} />
    </div>
  );
}

/** The error state of a list or page body, with a retry. */
export function StateError({
  message,
  onRetry,
}: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="wx-list-state">
      <InlineAlert tone="error">{message}</InlineAlert>
      {onRetry ? (
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** The empty state of a list or page body. */
export function StateEmpty({
  icon = "check-circle",
  children,
}: { icon?: GlyphName; children: ReactNode }): JSX.Element {
  return (
    <div className="wx-list-state">
      <Glyph name={icon} size={24} />
      <span>{children}</span>
    </div>
  );
}

/** The right drawer's header: icon, title + sub line, and a Close button. */
export function DrawerHead({
  icon,
  title,
  sub,
  onClose,
}: {
  icon: GlyphName;
  title: ReactNode;
  sub?: ReactNode;
  onClose?: () => void;
}): JSX.Element {
  return (
    <header className="wx-drawer-head">
      <span className="wx-rail-icon" aria-hidden>
        <Glyph name={icon} size={16} />
      </span>
      <div className="wx-drawer-head-main">
        <h2>{title}</h2>
        {sub ? <span className="wx-row-sub">{sub}</span> : null}
      </div>
      {onClose ? (
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      ) : null}
    </header>
  );
}
