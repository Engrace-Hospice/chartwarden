import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/07-care-plan — Care Plan Version History (M7 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CARE_PLAN.md — "Use Patient Workspace + Documentation Workspace."
// The immutable version ledger for a plan: every version with its kind, status, signed-at, and the
// signers collected against the Required Signer Set. Reachable from the Care Plan View aside. Reads
// GET /api/v1/care-plans/:planId/versions via the typed client; the server enforces every scope.
// Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";

interface Version {
  id: string;
  sequence: number;
  kind: string;
  status: string;
  signedAt: string | null;
  requiredSignerSet: string[];
  signatures: { signerRole: string; signedAt: string }[];
}

export function CarePlanVersionHistory(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [items, setItems] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!planId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/care-plans/{planId}/versions", {
        params: { path: { planId } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the version history.");
        setLoading(false);
        return;
      }
      setItems((data?.items ?? []) as Version[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, planId]);

  return (
    <DetailPageLayout header={<PageHeader title="Care Plan — Version History" />}>
      {loading ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No versions"
          description="Versions appear as the care plan is drafted and signed."
        />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>Version</th>
              <th style={th}>Kind</th>
              <th style={th}>Status</th>
              <th style={th}>Signed</th>
              <th style={th}>Signers</th>
            </tr>
          </thead>
          <tbody>
            {[...items]
              .sort((a, b) => b.sequence - a.sequence)
              .map((v) => (
                <tr key={v.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={td}>v{v.sequence}</td>
                  <td style={td}>{v.kind}</td>
                  <td style={td}>{v.status}</td>
                  <td style={td}>{v.signedAt ? v.signedAt.slice(0, 10) : "—"}</td>
                  <td style={td}>
                    {v.requiredSignerSet.map((role) => {
                      const signed = v.signatures.some((s) => s.signerRole === role);
                      return (
                        <span
                          key={role}
                          style={{ marginRight: "0.5rem", color: signed ? "#15803d" : "#b45309" }}
                        >
                          {signed ? "✓" : "○"} {role}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const th = { padding: "0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem" } as const;
