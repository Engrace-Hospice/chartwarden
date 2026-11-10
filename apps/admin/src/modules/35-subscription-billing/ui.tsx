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
  type SettledWrite,
  type WriteResult,
  isStepUpRequired,
} from "@chartwarden/ui";
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

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

/** What the operator sees when a write's request got no answer at all (offline, reset): the change may or may not have landed. */
export const UNREACHABLE_OUTCOME: Outcome = {
  ok: false,
  message:
    "Could not reach the server. Check your connection, and confirm the current state before trying again.",
};

/**
 * The outcome to show for a write that did not succeed, or null when it did. `sent` comes from the kit's `settleWrite` / `sendWrite`,
 * which read success as "no error AND response.ok" (an empty-body non-ok response is a refusal) and turn a rejected request (offline:
 * openapi-fetch rethrows, which would strand the caller's busy lock) into `unreachable`.
 */
export function writeFailure(sent: SettledWrite<WriteResult>, fallback: string): Outcome | null {
  if (sent.status === "ok") return null;
  return sent.status === "unreachable"
    ? UNREACHABLE_OUTCOME
    : failureOutcome(sent.res.error, fallback);
}

/** Navigation state that carries a finished write's confirmation to the page it lands on (see useSuccessRedirect). */
export const confirmationState = (message: string): { confirmation: string } => ({
  confirmation: message,
});

/**
 * The confirmation of the write that sent the operator here, for the destination page to show. The toast announces it and is gone
 * after five seconds, which is too short a record for a money write (a refund approved, a subscription paused): this stays on the
 * page for as long as the operator stays. Not a live region, the toast already announced it.
 *
 * It is consumed ONCE: read from the navigation state into local state, then the history entry's state is replaced with null (same
 * path, search and hash). The message lives in `history.state`, so left there a hard reload or Back/Forward to this entry would show
 * "Refund approved" later, perhaps after the refund executed or failed, as if it were news.
 */
export function ConfirmationBanner(): JSX.Element | null {
  const { pathname, search, hash, state } = useLocation();
  const navigate = useNavigate();
  const arrived = (state as { confirmation?: unknown } | null)?.confirmation;
  const [message, setMessage] = useState<string | null>(
    typeof arrived === "string" ? arrived : null,
  );
  useEffect(() => {
    if (typeof arrived !== "string") return;
    setMessage(arrived);
    navigate({ pathname, search, hash }, { replace: true, state: null });
  }, [arrived, pathname, search, hash, navigate]);
  return message === null ? null : (
    <InlineAlert tone="success" live={false}>
      {message}
    </InlineAlert>
  );
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
    <div className="wx-action-row is-middle">
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
    <div className="wx-action-row is-center">
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
