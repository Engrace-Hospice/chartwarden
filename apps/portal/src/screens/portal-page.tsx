import { EmptyState, LoadingSpinner, cardSurface, t } from "@wardenx/ui";
// @wardenx/portal — shared screen frame for the §5.1 caregiver surfaces. A titled card column inside the
// portal's centered reading width, with the loading / error / empty triad every read screen needs. Keeps
// the individual screens focused on their data shape rather than re-deriving layout chrome.
import type { CSSProperties, JSX, ReactNode } from "react";

const column: CSSProperties = {
  width: "100%",
  maxWidth: "44rem",
  margin: "0 auto",
  padding: "1.5rem 1.25rem 3rem",
  display: "flex",
  flexDirection: "column",
  gap: "1.25rem",
};

export interface PortalPageProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** Titled reading column — the frame for every non-dashboard §5.1 screen. */
export function PortalPage({ title, subtitle, actions, children }: PortalPageProps): JSX.Element {
  return (
    <main style={column}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.6rem", fontWeight: 500 }}>
            {title}
          </h1>
          {subtitle ? (
            <p style={{ margin: "0.25rem 0 0", color: t.onSurfaceVariant, fontSize: "0.9rem" }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? <div>{actions}</div> : null}
      </header>
      {children}
    </main>
  );
}

/** A titled card holding a screen section. */
export function PortalCard({
  heading,
  children,
}: { heading?: string; children: ReactNode }): JSX.Element {
  return (
    <section style={cardSurface}>
      {heading ? <h2 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>{heading}</h2> : null}
      {children}
    </section>
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
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  children: ReactNode;
}): JSX.Element {
  if (loading) return <LoadingSpinner label="Loading…" />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
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
