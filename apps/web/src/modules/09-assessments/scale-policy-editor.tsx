import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Scale-policy editor, admin (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// Per-scale enable/disable state. The threshold/cadence tuners (platform floor read-only · tenant override
// floor-enforced both client- and server-side, §5.2) fill in with the policy write surface; this read view shows
// the enabled state per scale. Reads GET /api/v1/admin/scales/policies via the typed client; the server enforces
// org-admin scope and the floor (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";

interface PolicyRow {
  scaleType: string;
  enabled: boolean;
}

export function ScalePolicyEditor(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<PolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/admin/scales/policies");
      if (!active) return;
      if (err) {
        setError("Could not load scale policies.");
        setLoading(false);
        return;
      }
      setItems((data?.policies ?? []) as PolicyRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <DetailPageLayout header={<PageHeader title="Scale policies" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No policies"
          description="No scale policies are configured for this organization."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Scale</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.scaleType}>
                <td>{p.scaleType}</td>
                <td>
                  <StatusPill
                    label={p.enabled ? "Enabled" : "Disabled"}
                    tone={p.enabled ? "success" : "neutral"}
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
