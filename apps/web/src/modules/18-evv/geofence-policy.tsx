import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/18-evv — Geofence Policy (M18 §5.1 `/app/evv/geofence-policy`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Detail Page". The tenant tighten-only default (radius + max-accuracy) atop the
// 200m/50m platform floor (§2.2.2 D3), plus the per-patient-address overrides. The editor (radius/accuracy
// sliders, override-with-reason, step-up) fills in as that write path hardens; the SERVER enforces tighten-only
// + RLS (ADR-0030 — no frontend authz). Reads GET /api/v1/evv/geofence-policy via the typed client. Leaves only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { DataTable, mono } from "./evv-shared";

interface OverrideRow {
  patientAddressId: string;
  radiusM: number;
  maxAccuracyM: number;
}
interface GeofencePolicyView {
  tenant: { radiusM: number; maxAccuracyM: number };
  perAddress: OverrideRow[];
}

export function EvvGeofencePolicy(): JSX.Element {
  const client = useApiClient();
  const [policy, setPolicy] = useState<GeofencePolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/geofence-policy", {});
    if (err) {
      setError("Could not load the geofence policy.");
      setLoading(false);
      return;
    }
    setPolicy((data ?? null) as GeofencePolicyView | null);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DetailPageLayout header={<PageHeader title="Geofence Policy" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !policy ? (
        <LoadingSpinner />
      ) : (
        <>
          <h3 style={{ fontSize: "0.9rem", color: "var(--color-on-surface)" }}>
            Tenant default (tighten-only vs 200m / 50m floor)
          </h3>
          <dl style={{ margin: "0 0 1.5rem", maxWidth: "30rem" }}>
            <Row label="Radius" value={`${policy.tenant.radiusM} m`} />
            <Row label="Max accuracy" value={`${policy.tenant.maxAccuracyM} m`} />
          </dl>
          <h3 style={{ fontSize: "0.9rem", color: "var(--color-on-surface)" }}>
            Per-address overrides
          </h3>
          {policy.perAddress.length === 0 ? (
            <EmptyState
              title="No overrides"
              description="No per-patient-address geofence overrides are configured."
            />
          ) : (
            <DataTable<OverrideRow>
              rows={policy.perAddress}
              rowKey={(o) => o.patientAddressId}
              columns={[
                { header: "Patient address", cell: (o) => mono(o.patientAddressId) },
                {
                  header: "Radius (m)",
                  cell: (o) => <span className="tabular-nums">{o.radiusM}</span>,
                },
                {
                  header: "Max accuracy (m)",
                  cell: (o) => <span className="tabular-nums">{o.maxAccuracyM}</span>,
                },
              ]}
            />
          )}
        </>
      )}
    </DetailPageLayout>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        gap: "1rem",
        padding: "0.4rem 0",
        borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
      }}
    >
      <dt style={{ width: "11rem", color: "var(--color-on-surface-variant)", fontSize: "0.8rem" }}>
        {label}
      </dt>
      <dd
        style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface)" }}
        className="tabular-nums"
      >
        {value}
      </dd>
    </div>
  );
}
