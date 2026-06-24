// apps/web/src/modules/09-assessments — Scale-license registry, admin (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// One row per (org × scale): status chip (active / pending_renewal / expired), vendor, effective/expiry dates,
// seats. Expired licensed scales are auto-disabled for new writes (D3) — historical reads are preserved. The
// record/renew write action (§5.2) fills in as its write path hardens. Reads GET /api/v1/admin/scales/licenses
// via the typed client; the server enforces org-admin scope (ADR-0030 — no authz on the frontend). Leaves only.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

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
        <EmptyState title="No licenses" description="No scale licenses are recorded for this organization." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>Scale</th>
              <th style={th}>Vendor</th>
              <th style={th}>Effective</th>
              <th style={th}>Expires</th>
              <th style={th}>Seats</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l.id} style={{ borderTop: "1px solid #f3f4f6", opacity: l.status === "expired" ? 0.6 : 1 }}>
                <td style={td}>{l.scaleType}</td>
                <td style={td}>{l.vendor}</td>
                <td style={td}>{l.effectiveDate.slice(0, 10)}</td>
                <td style={td}>{l.expiresAt.slice(0, 10)}</td>
                <td style={td}>{l.seats ?? "—"}</td>
                <td style={{ ...td, color: l.status === "expired" ? "#b91c1c" : l.status === "pending_renewal" ? "#92400e" : "#166534" }}>
                  {l.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
