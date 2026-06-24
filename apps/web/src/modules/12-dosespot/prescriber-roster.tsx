// apps/web/src/modules/12-dosespot — prescriber roster admin (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (prescriber roster admin).
// The per-tenant DoseSpot prescriber list for org_admin / compliance_officer: membership, enrollment, the
// DEA schedules authorized, and the IAL2 identity-proofing status (§1311.115). The enroll / revoke / IAL2
// re-verification write actions fill in as their write surfaces harden (each step-up enforced server-side).
// `dosespot.epcs` is OFF in Phase 1, so EPCS-enabled prescribers are architecture-only here. Reads
// GET /api/v1/admin/dosespot-prescribers via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface PrescriberRow {
  membershipId: string;
  enrolled: boolean;
  deaAuthorizedSchedules: string[];
  ial2Status: string;
}

const ial2Color: Record<string, string | undefined> = {
  verified: "#15803d",
  pending: "#b45309",
  revoked: "#b91c1c",
};

export function PrescriberRoster(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<PrescriberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admin/dosespot-prescribers", {});
    if (err) {
      setError("Could not load the prescriber roster.");
      setLoading(false);
      return;
    }
    setItems((data?.prescribers ?? []) as PrescriberRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="DoseSpot Prescriber Roster" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState title="No prescribers enrolled" description="No DoseSpot prescribers on this tenant." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Membership</th>
                <th style={th}>Enrolled</th>
                <th style={th}>DEA schedules</th>
                <th style={th}>IAL2 status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.membershipId} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={td}>{p.membershipId}</td>
                  <td style={td}>{p.enrolled ? "yes" : "no"}</td>
                  <td style={td}>
                    {p.deaAuthorizedSchedules.length > 0 ? p.deaAuthorizedSchedules.join(", ") : "—"}
                  </td>
                  <td style={{ ...td, color: ial2Color[p.ial2Status] }}>{p.ial2Status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
