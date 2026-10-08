// @wardenx/ui — the way back from a STEP_UP_REQUIRED refusal. A 403 carrying `STEP_UP_REQUIRED` means the
// session is valid but not FRESH enough for this action; the remedy is the app's `/step-up?returnTo=` page
// (StepUpCard), which re-verifies and comes back. Any other 403 is a permanent "not allowed", so only that
// code qualifies. Lives in the kit (not one app's shell) because both apps/web and apps/admin need it, and
// feature-module slices may import the kit but not another module's shell.
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { t } from "../theme/tokens";

export const STEP_UP_REQUIRED_CODE = "STEP_UP_REQUIRED";

type ErrorBody = { code?: unknown; error?: { code?: unknown } } | null | undefined;

/**
 * True when `error` (the parsed error body openapi-fetch hands back) is the step-up refusal. Reads the
 * standard envelope `{ error: { code } }` and, defensively, a flat `{ code }`.
 */
export function isStepUpRequired(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const body = error as ErrorBody;
  return (body?.error?.code ?? body?.code) === STEP_UP_REQUIRED_CODE;
}

/** `/step-up?returnTo=<returnTo>` — the step-up page, coming back to `returnTo` (an app-relative path). */
export function stepUpPath(returnTo: string): string {
  return `/step-up?returnTo=${encodeURIComponent(returnTo)}`;
}

export interface ReverifyLinkProps {
  /** Link text. Default "Re-verify". */
  children?: ReactNode;
  /** Called just before navigating (e.g. to stash a typed-in draft). */
  onNavigate?: () => void;
}

const linkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.primary}`,
  background: t.primary,
  color: t.onPrimary,
  fontFamily: t.fontSans,
  fontSize: "0.75rem",
  fontWeight: 600,
  textDecoration: "none",
};

/**
 * A router link to the step-up page that returns to the CURRENT location (path + search). A link, not an
 * automatic redirect: the user decides when to leave, so a form with typed input is never torn away.
 */
export function ReverifyLink({
  children = "Re-verify",
  onNavigate,
}: ReverifyLinkProps): JSX.Element {
  const location = useLocation();
  return (
    <Link
      to={stepUpPath(`${location.pathname}${location.search}`)}
      onClick={onNavigate}
      className="wx-button wx-button-primary"
      style={linkStyle}
    >
      {children}
    </Link>
  );
}
