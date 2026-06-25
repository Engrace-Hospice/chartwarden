import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — prescriber roster admin (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (prescriber roster admin).
// The per-tenant DoseSpot prescriber list for org_admin / compliance_officer: membership, enrollment, the
// DEA schedules authorized, and the IAL2 identity-proofing status (§1311.115). The enroll / revoke / IAL2
// re-verification write actions fill in as their write surfaces harden (each step-up enforced server-side).
// `dosespot.epcs` is OFF in Phase 1, so EPCS-enabled prescribers are architecture-only here. Reads
// GET /api/v1/admin/dosespot-prescribers via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { IAL2_TONE, stateLabel } from "./medication-status";

interface PrescriberRow {
  membershipId: string;
  enrolled: boolean;
  deaAuthorizedSchedules: string[];
  ial2Status: string;
}

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
          <EmptyState
            title="No prescribers enrolled"
            description="No DoseSpot prescribers on this tenant."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Membership</th>
                <th>Enrolled</th>
                <th>DEA schedules</th>
                <th>IAL2 status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.membershipId}>
                  <td className="wx-data-md">{p.membershipId}</td>
                  <td>
                    <StatusPill
                      label={p.enrolled ? "Enrolled" : "Not enrolled"}
                      tone={p.enrolled ? "success" : "neutral"}
                    />
                  </td>
                  <td>
                    {/* DEA schedule authorizations are controlled-substance scope → gold `critical`. */}
                    {p.deaAuthorizedSchedules.length > 0 ? (
                      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.25rem" }}>
                        {p.deaAuthorizedSchedules.map((s) => (
                          <StatusPill key={s} label={`C-${s}`} tone="critical" glyph="alert" />
                        ))}
                      </span>
                    ) : (
                      <span style={{ color: "var(--color-muted)" }}>—</span>
                    )}
                  </td>
                  <td>
                    <StatusPill
                      label={stateLabel(p.ial2Status)}
                      tone={IAL2_TONE[p.ial2Status] ?? "neutral"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
