import {
  DashboardLayout,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/10-hope — HQRP compliance dashboard (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Dashboard."
// "Are we losing the 4 points?" — four KPI cards: HOPE on-time rate, SFV on-time rate, submission
// acceptance rate, late-completion rate (1 − HOPE on-time). Rates are server-computed (ADR-0030 — no
// frontend authz). Reads GET /api/v1/hope/dashboard/compliance via the typed client. Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";

interface Compliance {
  providerEntityId: string | null;
  hopeOnTimeRate: number;
  sfvOnTimeRate: number;
  submissionAcceptanceRate: number;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function HqrpComplianceDashboard(): JSX.Element {
  const client = useApiClient();
  const [row, setRow] = useState<Compliance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/hope/dashboard/compliance", {
        params: { query: {} },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the HQRP compliance dashboard.");
        setLoading(false);
        return;
      }
      setRow(data as Compliance);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <DashboardLayout
      header={<PageHeader title="HQRP Compliance" />}
      kpis={
        row ? (
          <KpiStrip>
            <KpiCard label="HOPE on-time" value={pct(row.hopeOnTimeRate)} />
            <KpiCard label="SFV on-time" value={pct(row.sfvOnTimeRate)} />
            <KpiCard label="Submission acceptance" value={pct(row.submissionAcceptanceRate)} />
            <KpiCard label="Late completion" value={pct(1 - row.hopeOnTimeRate)} />
          </KpiStrip>
        ) : undefined
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading || !row ? (
          <LoadingSpinner />
        ) : (
          <p
            style={{
              fontSize: "0.8rem",
              color: "var(--color-on-surface-variant)",
              padding: "0 1.5rem",
            }}
          >
            Rates reflect the{" "}
            {row.providerEntityId ? "selected ProviderEntity" : "whole organization"}. The 90-day
            trend sparklines and the late-completion-reason distribution chart fill in as the HQRP
            analytics surface (M30) lands.
          </p>
        )
      }
    />
  );
}
