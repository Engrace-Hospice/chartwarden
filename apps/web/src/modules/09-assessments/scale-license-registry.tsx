import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Scale-license registry, admin (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// One row per (org × scale): status chip (active / pending_renewal / expired), vendor, effective/expiry dates,
// seats. Expired licensed scales are auto-disabled for new writes (D3) — historical reads are preserved. The
// record/renew write action (§5.2) fills in as its write path hardens. Reads GET /api/v1/admin/scales/licenses
// via the typed client; the server enforces org-admin scope (ADR-0030 — no authz on the frontend). Leaves only.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { LICENSE_TONE, stateLabel } from "./assessment-status";

interface LicenseRow {
  id: string;
  scaleType: string;
  vendor: string;
  effectiveDate: string;
  expiresAt: string;
  seats: number | null;
  status: string;
}

export function ScaleLicenseRegistry(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<LicenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/admin/scales/licenses");
      if (!active) return;
      if (err) {
        setError("Could not load licenses.");
        setLoading(false);
        return;
      }
      setItems((data?.licenses ?? []) as LicenseRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <DetailPageLayout header={<PageHeader title="Scale licenses" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No licenses"
          description="No scale licenses are recorded for this organization."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Scale</th>
              <th>Vendor</th>
              <th>Effective</th>
              <th>Expires</th>
              <th>Seats</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id} style={{ opacity: l.status === "expired" ? 0.6 : 1 }}>
                <td>{l.scaleType}</td>
                <td>{l.vendor}</td>
                <td className="tabular-nums">{l.effectiveDate.slice(0, 10)}</td>
                <td className="tabular-nums">{l.expiresAt.slice(0, 10)}</td>
                <td className="tabular-nums">{l.seats ?? "—"}</td>
                <td>
                  <StatusPill
                    label={stateLabel(l.status)}
                    tone={LICENSE_TONE[l.status] ?? "neutral"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}
