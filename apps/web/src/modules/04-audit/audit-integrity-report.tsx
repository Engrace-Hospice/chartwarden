import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
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
          actions={
            <button type="button" onClick={() => void load()} disabled={loading}>
              {loading ? "Checking…" : "Re-check"}
            </button>
          }
        />
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && !report ? (
        <LoadingSpinner />
      ) : report ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: "40rem" }}>
          <section>
            <h2 style={{ fontSize: "1rem" }}>Append-only guarantee (§10.4)</h2>
            <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
              Live verification that no application role holds UPDATE/DELETE/TRUNCATE on the audit
              log — the guarantee the HIPAA §164.312(b) audit-trail integrity control rests on.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem" }}>
              <StatusPill
                label={report.appendOnly.grantsVerified ? "Verified" : "VIOLATION DETECTED"}
                tone={report.appendOnly.grantsVerified ? "success" : "error"}
              />
              <span className="tabular-nums" style={{ fontSize: "0.8rem" }}>
                Last checked: {new Date(report.appendOnly.lastChecked).toLocaleString()}
              </span>
            </div>
          </section>

          <section>
            <h2 style={{ fontSize: "1rem" }}>Backup sample verification (§12.3)</h2>
            {report.backupSampling ? (
              <p style={{ fontSize: "0.85rem" }}>
                {report.backupSampling.sampled} event(s) sampled, {report.backupSampling.mismatches}{" "}
                mismatch(es) — last run {new Date(report.backupSampling.lastRun).toLocaleString()}.
              </p>
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
                Not yet run — the quarterly sample-vs-backup job has no scheduled run history yet.
              </p>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: "1rem" }}>Hash-chain seal (Phase 2)</h2>
            {report.sealChain ? (
              <p style={{ fontSize: "0.85rem" }}>
                {report.sealChain.contiguous
                  ? `Chain intact through ${report.sealChain.lastSealedPartition}.`
                  : `Chain broken at ${report.sealChain.brokenAt}.`}
              </p>
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
                Not enabled — the hash-chain seal is a Phase 2 feature, currently off.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </DetailPageLayout>
  );
}
