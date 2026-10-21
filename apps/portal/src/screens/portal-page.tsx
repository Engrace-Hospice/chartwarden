import { Card, EmptyState, ErrorState, LoadingSpinner, t } from "@chartwarden/ui";
// @chartwarden/portal — shared screen frame for the §5.1 caregiver surfaces. A titled card column inside the
// portal's centered reading width, with the loading / error / empty triad every read screen needs. Keeps
// the individual screens focused on their data shape rather than re-deriving layout chrome.
import type { CSSProperties, JSX, ReactNode } from "react";

export interface PortalPageProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  width?: "reading" | "standard" | "workspace";
  className?: string;
}

/** A page frame whose width reflects the task instead of forcing every workflow into one column. */
export function PortalPage({
  title,
  subtitle,
  actions,
  children,
  width = "standard",
  className,
}: PortalPageProps): JSX.Element {
  return (
    <div className={`wx-portal-page wx-portal-page--${width}${className ? ` ${className}` : ""}`}>
      <header className="wx-portal-page__header">
        <div className="wx-portal-page__intro">
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="wx-portal-page__actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export const PortalPageContainer = PortalPage;

/** A titled card holding a screen section. */
export function PortalCard({
  heading,
  children,
}: { heading?: string; children: ReactNode }): JSX.Element {
  return (
    <Card>
      {heading ? <h2 className="wx-portal-card__heading">{heading}</h2> : null}
      {children}
    </Card>
  );
}

/**
 * The load-state triad. `state` drives which of spinner / error / empty / content renders, so each screen
 * expresses "no PHI until resolved" once, in one place, instead of re-implementing the branch.
 */
export function PortalLoadState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyDescription,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  onRetry?: () => void;
  children: ReactNode;
}): JSX.Element {
  if (loading)
    return (
      <div className="wx-portal-load-state" aria-live="polite">
        <LoadingSpinner label="Loading…" />
      </div>
    );
  if (error) return <ErrorState title="Unavailable" description={error} onRetry={onRetry} />;
  if (empty) return <EmptyState title={emptyTitle} description={emptyDescription} />;
  return <>{children}</>;
}

export const tableCell: CSSProperties = {
  padding: "0.55rem 0.75rem",
  textAlign: "left",
  verticalAlign: "middle",
};
export const tableHead: CSSProperties = {
  ...tableCell,
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
  fontWeight: 600,
};
export const tableRow: CSSProperties = { borderTop: `1px solid ${t.surfaceContainer}` };
