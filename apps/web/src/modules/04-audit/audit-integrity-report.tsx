import {
  Button,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/04-audit — Audit Integrity Report (GAP-003, M4 spec §4.2/§10.4).
// Single-panel view over the real route GET /api/v1/audit/integrity/report via the generated typed
// client. `backupSampling`/`sealChain` are honestly omitted server-side until their jobs are wired
// (see apps/backend/.../routes/audit-integrity.ts) — the UI reflects that, it does not fabricate them.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface IntegrityReport {
  appendOnly: { grantsVerified: boolean; lastChecked: string };
  backupSampling?: { lastRun: string; sampled: number; mismatches: number };
  sealChain?: { contiguous: boolean; lastSealedPartition: string; brokenAt: string | null };
}

export function AuditIntegrityReport(): JSX.Element {
  const client = useApiClient();
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/audit/integrity/report", {});
    if (err || !data) {
      setError("Could not load the integrity report.");
      setLoading(false);
      return;
    }
    setReport(data as IntegrityReport);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Audit Integrity Report"
          breadcrumb="Compliance / Audit"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? "Checking..." : "Re-check"}
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Verify append-only permissions and inspect the integrity controls that protect the audit
            ledger from tampering.
          </div>
        </PageHeader>
      }
    >
      {error ? (
        <div style={{ padding: "1.5rem" }}>
          <EmptyState title="Unavailable" description={error} />
        </div>
      ) : loading && !report ? (
        <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
          <LoadingSpinner />
        </div>
      ) : report ? (
        <div style={pageContentStyle}>
          <section style={heroSectionStyle}>
            <div style={heroIconStyle(report.appendOnly.grantsVerified)}>
              <Glyph name={report.appendOnly.grantsVerified ? "check-circle" : "alert"} size={24} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}
              >
                <h2 style={heroTitleStyle}>Append-only guarantee</h2>
                <StatusPill
                  label={report.appendOnly.grantsVerified ? "Verified" : "Violation detected"}
                  tone={report.appendOnly.grantsVerified ? "success" : "error"}
                />
              </div>
              <p style={heroDescriptionStyle}>
                Live verification that no application role holds update, delete, or truncate grants
                on the audit log.
              </p>
              <div className="tabular-nums" style={timestampStyle}>
                Last checked: {formatDateTime(report.appendOnly.lastChecked)}
              </div>
            </div>
          </section>

          <div style={sectionGridStyle}>
            <IntegritySection
              title="Backup Sample Verification"
              subtitle="Quarterly sample-vs-backup check"
              status={
                report.backupSampling
                  ? report.backupSampling.mismatches === 0
                    ? "verified"
                    : "warning"
                  : "not_run"
              }
            >
              {report.backupSampling ? (
                <div style={factsGridStyle}>
                  <Fact label="Sampled" value={String(report.backupSampling.sampled)} />
                  <Fact label="Mismatches" value={String(report.backupSampling.mismatches)} />
                  <Fact label="Last run" value={formatDateTime(report.backupSampling.lastRun)} />
                </div>
              ) : (
                <p style={mutedParagraphStyle}>
                  Not yet run. The quarterly sample-vs-backup job has no scheduled run history yet.
                </p>
              )}
            </IntegritySection>

            <IntegritySection
              title="Hash-Chain Seal"
              subtitle="Phase 2 tamper-evidence chain"
              status={
                report.sealChain
                  ? report.sealChain.contiguous
                    ? "verified"
                    : "error"
                  : "not_enabled"
              }
            >
              {report.sealChain ? (
                <div style={factsGridStyle}>
                  <Fact
                    label="State"
                    value={report.sealChain.contiguous ? "Chain intact" : "Chain broken"}
                  />
                  <Fact
                    label="Last sealed partition"
                    value={report.sealChain.lastSealedPartition}
                  />
                  <Fact label="Broken at" value={report.sealChain.brokenAt ?? "—"} />
                </div>
              ) : (
                <p style={mutedParagraphStyle}>
                  Not enabled. The hash-chain seal is a Phase 2 feature and is currently off.
                </p>
              )}
            </IntegritySection>
          </div>
        </div>
      ) : null}
    </DetailPageLayout>
  );
}

function IntegritySection({
  title,
  subtitle,
  status,
  children,
}: {
  title: string;
  subtitle: string;
  status: "verified" | "warning" | "error" | "not_run" | "not_enabled";
  children: JSX.Element;
}): JSX.Element {
  const meta = sectionStatusMeta(status);
  return (
    <section style={sectionStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <div>
          <h2 style={sectionTitleStyle}>{title}</h2>
          <div style={sectionSubtitleStyle}>{subtitle}</div>
        </div>
        <StatusPill label={meta.label} tone={meta.tone} />
      </div>
      <div style={{ marginTop: "1rem" }}>{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={factStyle}>
      <div style={factLabelStyle}>{label}</div>
      <div className="tabular-nums" style={factValueStyle}>
        {value}
      </div>
    </div>
  );
}

function sectionStatusMeta(status: "verified" | "warning" | "error" | "not_run" | "not_enabled"): {
  label: string;
  tone: "success" | "warning" | "error" | "neutral";
} {
  switch (status) {
    case "verified":
      return { label: "Verified", tone: "success" };
    case "warning":
      return { label: "Mismatch", tone: "warning" };
    case "error":
      return { label: "Broken", tone: "error" };
    case "not_enabled":
      return { label: "Not enabled", tone: "neutral" };
    case "not_run":
      return { label: "Not run", tone: "neutral" };
  }
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const pageContentStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
  maxWidth: "64rem",
};

const heroSectionStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: "1rem",
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const heroIconStyle = (verified: boolean) => ({
  width: "3rem",
  height: "3rem",
  borderRadius: "9999px",
  background: verified
    ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
    : "color-mix(in srgb, var(--color-error) 12%, transparent)",
  color: verified ? "var(--color-success)" : "var(--color-error)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

const heroTitleStyle = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const heroDescriptionStyle = {
  margin: "0.35rem 0 0",
  fontSize: "0.875rem",
  color: "var(--color-on-surface-variant)",
};

const timestampStyle = {
  marginTop: "0.65rem",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
};

const sectionGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
  gap: "1rem",
};

const sectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
};

const sectionTitleStyle = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const sectionSubtitleStyle = {
  marginTop: "0.2rem",
  fontSize: "0.78rem",
  color: "var(--color-on-surface-variant)",
};

const factsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
  gap: "0.75rem",
};

const factStyle = {
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
};

const factLabelStyle = {
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};

const factValueStyle = {
  marginTop: "0.25rem",
  fontSize: "0.9rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
  overflowWrap: "anywhere" as const,
};

const mutedParagraphStyle = {
  margin: 0,
  fontSize: "0.85rem",
  color: "var(--color-on-surface-variant)",
};
