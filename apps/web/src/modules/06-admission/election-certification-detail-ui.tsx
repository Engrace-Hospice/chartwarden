import { LoadingSpinner, Modal, t } from "@chartwarden/ui";
import type { StatusTone } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";

interface DetailModalProps<T> {
  open: boolean;
  resourceId: string | null;
  title: string;
  errorMessage: string;
  load: (id: string) => Promise<T>;
  onOpenChange: (open: boolean) => void;
  children: (detail: T) => ReactNode;
}

export function DetailModal<T>({
  open,
  resourceId,
  title,
  errorMessage,
  load,
  onOpenChange,
  children,
}: DetailModalProps<T>): JSX.Element {
  const [detail, setDetail] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSequence = useRef(0);

  const loadDetail = useCallback(async (): Promise<void> => {
    if (!open || !resourceId) return;

    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setDetail(null);
    setFailed(false);
    setLoading(true);

    try {
      const result = await load(resourceId);
      if (requestSequence.current !== requestId) return;
      setDetail(result);
      setLoading(false);
    } catch {
      if (requestSequence.current !== requestId) return;
      setFailed(true);
      setLoading(false);
    }
  }, [load, open, resourceId]);

  useEffect(() => {
    void loadDetail();

    return () => {
      requestSequence.current += 1;
    };
  }, [loadDetail]);

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      ariaLabel={`${title} details`}
      width="48rem"
    >
      <div style={modalBody}>
        <header style={modalHeader}>
          <h2 style={modalTitle}>{title}</h2>
          <button
            type="button"
            aria-label={`Close ${title} details`}
            style={closeButton}
            onClick={() => onOpenChange(false)}
          >
            Close
          </button>
        </header>

        {loading ? (
          <div aria-label={`Loading ${title} details`} style={stateContainer}>
            <LoadingSpinner />
          </div>
        ) : failed ? (
          <div role="alert" style={errorState}>
            <p style={errorMessageStyle}>{errorMessage}</p>
            <button type="button" style={retryButton} onClick={() => void loadDetail()}>
              Retry
            </button>
          </div>
        ) : detail ? (
          <div style={sectionStack}>{children(detail)}</div>
        ) : null}
      </div>
    </Modal>
  );
}

export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={section}>
      <h3 style={sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export function DetailGrid({ children }: { children: ReactNode }): JSX.Element {
  return <dl style={detailGrid}>{children}</dl>;
}

export function DetailField({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}): JSX.Element {
  return (
    <div style={detailField}>
      <dt style={detailLabel}>{label}</dt>
      <dd style={detailValue}>{value}</dd>
    </div>
  );
}

export function formatBoolean(value: boolean | null | undefined): string {
  if (value == null) return "Not provided";
  return value ? "Yes" : "No";
}

export function formatDetailDate(value: string | null | undefined): string {
  if (!value) return "Not provided";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function formatDetailDateTime(value: string | null | undefined): string {
  if (!value) return "Not provided";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not provided";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function detailStatusTone(state: string): StatusTone {
  if (state === "signed" || state === "attested" || state === "completed") return "success";
  if (state === "voided" || state === "expired") return "neutral";
  if (state === "late" || state === "overdue") return "warning";
  return "progress";
}

const modalBody: CSSProperties = {
  padding: "1.25rem",
};

const modalHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  paddingBottom: "1rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
};

const modalTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1.25rem",
  fontWeight: 600,
};

const closeButton: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusSm,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: "0.45rem 0.75rem",
  font: "inherit",
  fontSize: "0.8rem",
  fontWeight: 600,
  cursor: "pointer",
};

const stateContainer: CSSProperties = {
  display: "grid",
  minHeight: "12rem",
  placeItems: "center",
};

const errorState: CSSProperties = {
  marginTop: "1rem",
  padding: "1rem",
  borderRadius: t.radiusMd,
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  color: t.error,
};

const errorMessageStyle: CSSProperties = {
  margin: "0 0 0.75rem",
  fontSize: "0.85rem",
};

const retryButton: CSSProperties = {
  border: 0,
  borderRadius: t.radiusSm,
  background: t.primary,
  color: t.onPrimary,
  padding: "0.45rem 0.75rem",
  font: "inherit",
  fontSize: "0.8rem",
  fontWeight: 650,
  cursor: "pointer",
};

const sectionStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  paddingTop: "1rem",
};

const section: CSSProperties = {
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  padding: "1rem",
};

const sectionTitle: CSSProperties = {
  margin: "0 0 0.75rem",
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "0.95rem",
  fontWeight: 600,
};

const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))",
  gap: "0.85rem 1rem",
  margin: 0,
};

const detailField: CSSProperties = {
  minWidth: 0,
};

const detailLabel: CSSProperties = {
  marginBottom: "0.2rem",
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
};

const detailValue: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.84rem",
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};
