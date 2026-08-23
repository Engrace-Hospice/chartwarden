import {
  Button,
  EmptyState,
  Glyph,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — M25, the DENIAL TAXONOMY overlay (R2, §5 / D5 / M25-F09). Look up a
// CARC and see the merged view: the M38 platform floor (category + default plain-language — READ-ONLY, the
// regulatory floor tenants can NEVER edit) plus the per-tenant overlay (plain-language override + suggested
// action + owner role + severity). The edit surface is `taxonomy.edit`-gated server-side. Lantern:
// WorkQueueLayout + §6.6 severity pill; CSS-var tokens only.
import { useCallback, useState } from "react";
import type { JSX, ReactNode } from "react";
import { humanize } from "./remittance-status";

interface TaxonomyView {
  carcCode: string;
  rarcCode: string | null;
  category: string;
  plainLanguage: string;
  suggestedAction: string | null;
  ownerRole: string | null;
  severity: string | null;
  hasOverlay: boolean;
  overlayVersion: number | null;
}

const SEVERITY_TONE: Record<string, "neutral" | "warning" | "error"> = {
  info: "neutral",
  warn: "warning",
  critical: "error",
};

export function TaxonomyOverlay(): JSX.Element {
  const client = useApiClient();
  const [code, setCode] = useState("");
  const [lastLookup, setLastLookup] = useState("");
  const [view, setView] = useState<TaxonomyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(
    async (carc: string) => {
      const normalized = carc.trim().toUpperCase();
      if (!normalized) return;
      setLoading(true);
      setError(null);
      setLastLookup(normalized);
      const res = await client.GET("/api/v1/taxonomy/carc/{code}", {
        params: { path: { code: normalized } },
      });
      if (res.error) {
        setError("Lookup failed — the code may be unknown, or you lack scope.");
        setView(null);
      } else {
        setView(res.data as unknown as TaxonomyView);
      }
      setLoading(false);
    },
    [client],
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Denial Taxonomy" breadcrumb="Revenue Cycle — CARC / RARC">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Look up the regulatory CARC/RARC floor and the tenant-specific action overlay.
          </div>
        </PageHeader>
      }
      kpis={
        <KpiStrip>
          <KpiCard
            label="Lookup"
            value={loading ? "..." : lastLookup || "—"}
            detail="Current CARC"
            tone="info"
            accentColor="var(--color-primary)"
          />
          <KpiCard
            label="Category"
            value={view ? humanize(view.category) : "—"}
            detail="M38 floor"
            tone="neutral"
            accentColor="var(--color-outline-variant)"
          />
          <KpiCard
            label="Severity"
            value={view?.severity ? humanize(view.severity) : "—"}
            detail="Tenant overlay"
            tone={
              view?.severity === "critical"
                ? "danger"
                : view?.severity === "warn"
                  ? "warning"
                  : "neutral"
            }
            accentColor={
              view?.severity === "critical"
                ? "var(--color-error)"
                : view?.severity === "warn"
                  ? "var(--color-warning)"
                  : "var(--color-outline-variant)"
            }
          />
          <KpiCard
            label="Overlay"
            value={view ? (view.hasOverlay ? "Present" : "Floor") : "—"}
            detail={view?.hasOverlay ? `v${view.overlayVersion ?? "?"}` : "Read-only default"}
            tone={view?.hasOverlay ? "warning" : "neutral"}
            accentColor={view?.hasOverlay ? "var(--color-warning)" : "var(--color-outline-variant)"}
          />
        </KpiStrip>
      }
      filters={
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(code);
          }}
          style={filterPanelStyle}
        >
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <Glyph name="alert" size={16} />
              <span>{error}</span>
            </div>
          ) : null}
          <div style={filterRowStyle}>
            <div style={{ position: "relative", minWidth: "18rem", flex: "1 1 18rem" }}>
              <input
                aria-label="CARC code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter a CARC code, e.g. 16, 50, 197"
                style={searchInputStyle}
              />
              <div style={searchIconStyle}>
                <Glyph name="eye" size={14} />
              </div>
            </div>
            <Button type="submit" tone="primary" size="sm" disabled={!code.trim() || loading}>
              {loading ? "Looking up..." : "Look up"}
            </Button>
            {code || view || error ? (
              <Button
                type="button"
                tone="tertiary"
                size="sm"
                onClick={() => {
                  setCode("");
                  setLastLookup("");
                  setView(null);
                  setError(null);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </form>
      }
      table={
        loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Not found" description={error} />
          </div>
        ) : view ? (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            <article style={detailPanelStyle}>
              <header style={detailHeaderStyle}>
                <h2 style={titleStyle}>
                  CARC {view.carcCode}
                  {view.rarcCode ? ` · RARC ${view.rarcCode}` : ""}
                </h2>
                {view.severity ? (
                  <StatusPill
                    label={humanize(view.severity)}
                    tone={SEVERITY_TONE[view.severity] ?? "neutral"}
                  />
                ) : null}
              </header>
              <Field label="Category (M38 floor)">{humanize(view.category)}</Field>
              <Field label="Plain language">{view.plainLanguage || "—"}</Field>
              <Field label="Suggested action">{view.suggestedAction || "—"}</Field>
              <Field label="Owner role">{view.ownerRole ? humanize(view.ownerRole) : "—"}</Field>
              <Field label="Tenant overlay">
                {view.hasOverlay
                  ? `Present (v${view.overlayVersion ?? "?"})`
                  : "None — using the M38 floor"}
              </Field>
            </article>
          </div>
        ) : (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No code selected"
              description="Enter a CARC code to inspect the regulatory floor and tenant overlay."
            />
          </div>
        )
      }
      detail={
        <span style={mutedStyle}>
          Platform taxonomy is read-only. Tenant overlays can add operational language, owner role,
          and severity without changing the regulatory floor.
        </span>
      }
      fullPageScroll
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <span style={fieldValueStyle}>{children}</span>
    </div>
  );
}

const filterPanelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const filterRowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.75rem",
  alignItems: "flex-end",
};
const searchInputStyle = {
  width: "100%",
  paddingLeft: "2rem",
  height: "2.25rem",
  fontSize: "0.85rem",
};
const searchIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: "var(--color-on-surface-variant)",
  pointerEvents: "none" as const,
};
const errorBannerStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const detailPanelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-soft)",
  padding: "1rem 1.25rem",
};
const detailHeaderStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  paddingBottom: "0.5rem",
};
const titleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "1.125rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
};
const fieldStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(12rem, 16rem) 1fr",
  gap: "0.75rem",
  padding: "0.6rem 0",
  borderTop: "1px solid var(--color-surface-container)",
};
const fieldLabelStyle = {
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};
const fieldValueStyle = {
  color: "var(--color-on-surface)",
};
const mutedStyle = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" };
