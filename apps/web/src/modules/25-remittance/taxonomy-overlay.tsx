import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/25-remittance — M25, the DENIAL TAXONOMY overlay (R2, §5 / D5 / M25-F09). Look up a
// CARC and see the merged view: the M38 platform floor (category + default plain-language — READ-ONLY, the
// regulatory floor tenants can NEVER edit) plus the per-tenant overlay (plain-language override + suggested
// action + owner role + severity). The edit surface is `taxonomy.edit`-gated server-side. Lantern:
// DetailPageLayout + §6.6 severity pill; CSS-var tokens only.
import { useCallback, useState } from "react";
import type { JSX } from "react";
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
  const [view, setView] = useState<TaxonomyView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = useCallback(
    async (carc: string) => {
      if (!carc) return;
      setLoading(true);
      setError(null);
      const res = await client.GET("/api/v1/taxonomy/carc/{code}", {
        params: { path: { code: carc } },
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
    <DetailPageLayout header={<PageHeader title="Denial Taxonomy" breadcrumb="Revenue Cycle — CARC / RARC" />}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(code.trim());
        }}
        style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1.5rem" }}
      >
        <input
          aria-label="CARC code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Enter a CARC code (e.g. 16, 50, 197)"
          style={inputStyle}
        />
        <button type="submit" style={buttonStyle}>
          Look up
        </button>
      </form>

      {loading ? <LoadingSpinner /> : null}
      {error ? <EmptyState title="Not found" description={error} /> : null}

      {view && !loading ? (
        <article style={cardStyle}>
          <header style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: "1.25rem" }}>
              CARC {view.carcCode}
              {view.rarcCode ? ` · RARC ${view.rarcCode}` : ""}
            </h2>
            {view.severity ? (
              <StatusPill label={humanize(view.severity)} tone={SEVERITY_TONE[view.severity] ?? "neutral"} />
            ) : null}
          </header>

          <Field label="Category (M38 regulatory floor — read-only)">
            <span style={{ fontWeight: 500 }}>{humanize(view.category)}</span>
          </Field>
          <Field label="Plain language">{view.plainLanguage || "—"}</Field>
          <Field label="Suggested action">{view.suggestedAction || "—"}</Field>
          <Field label="Owner role">{view.ownerRole ? humanize(view.ownerRole) : "—"}</Field>
          <Field label="Tenant overlay">
            {view.hasOverlay ? `Present (v${view.overlayVersion ?? "?"})` : "None — using the M38 floor"}
          </Field>
        </article>
      ) : null}
    </DetailPageLayout>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "16rem 1fr", gap: "0.5rem", padding: "0.5rem 0", borderTop: "1px solid var(--color-surface-container)" }}>
      <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span style={{ color: "var(--color-on-surface)" }}>{children}</span>
    </div>
  );
}

const inputStyle = {
  flex: 1,
  padding: "0.5rem 0.75rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "1px solid var(--color-surface-container-high)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};
const buttonStyle = {
  padding: "0.5rem 1rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "none",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.9rem",
  cursor: "pointer",
};
const cardStyle = {
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-xl, 1rem)",
  boxShadow: "var(--shadow-soft)",
  padding: "1.25rem 1.5rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
};
