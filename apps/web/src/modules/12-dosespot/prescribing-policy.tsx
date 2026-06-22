// apps/web/src/modules/12-dosespot — prescribing policy admin (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (refill SLA & controlled-
// substance policy admin). Two read-only tenant-config panes for org_admin / compliance_officer: the refill-
// inbox SLA (warn/critical hours, with the platform floors the tenant config may only TIGHTEN beyond, §2.7 D9)
// and the controlled-substance policy (schedule-II / III–V refill caps per 21 CFR 1306.22 + the EPCS
// certification status gate, D18). The tighten-only PATCH write actions fill in as their write surfaces harden;
// the SERVER enforces the platform floors. Reads GET /api/v1/admin/refill-inbox-policy and
// GET /api/v1/admin/controlled-substance-policy via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface RefillPolicyView {
  slaWarnHours: number;
  slaCriticalHours: number;
  platformFloorWarnHours: number;
  platformFloorCriticalHours: number;
}

interface ControlledPolicyView {
  scheduleIiMaxRefills: number;
  scheduleIiiToVMaxRefills: number;
  epcsCertificationStatus: string;
}

export function PrescribingPolicy(): JSX.Element {
  const client = useApiClient();
  const [refill, setRefill] = useState<RefillPolicyView | null>(null);
  const [controlled, setControlled] = useState<ControlledPolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [r, c] = await Promise.all([
      client.GET("/api/v1/admin/refill-inbox-policy", {}),
      client.GET("/api/v1/admin/controlled-substance-policy", {}),
    ]);
    if (r.error || c.error) {
      setError("Could not load the prescribing policy.");
      setLoading(false);
      return;
    }
    setRefill(r.data as RefillPolicyView);
    setControlled(c.data as ControlledPolicyView);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Prescribing Policy" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading || !refill || !controlled ? (
          <LoadingSpinner />
        ) : (
          <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
            <section>
              <h3 style={h3}>Refill inbox SLA (§2.7 D9)</h3>
              <dl style={dl}>
                <dt style={dt}>Warn after</dt>
                <dd style={dd}>
                  {refill.slaWarnHours}h <span style={floor}>(floor {refill.platformFloorWarnHours}h)</span>
                </dd>
                <dt style={dt}>Critical after</dt>
                <dd style={dd}>
                  {refill.slaCriticalHours}h{" "}
                  <span style={floor}>(floor {refill.platformFloorCriticalHours}h)</span>
                </dd>
              </dl>
            </section>
            <section>
              <h3 style={h3}>Controlled-substance policy (21 CFR 1306.22 / D18)</h3>
              <dl style={dl}>
                <dt style={dt}>Schedule II max refills</dt>
                <dd style={dd}>{controlled.scheduleIiMaxRefills}</dd>
                <dt style={dt}>Schedule III–V max refills</dt>
                <dd style={dd}>{controlled.scheduleIiiToVMaxRefills}</dd>
                <dt style={dt}>EPCS certification</dt>
                <dd
                  style={{
                    ...dd,
                    color: controlled.epcsCertificationStatus === "certified" ? "#15803d" : "#b45309",
                  }}
                >
                  {controlled.epcsCertificationStatus}
                </dd>
              </dl>
            </section>
          </div>
        )
      }
    />
  );
}

const h3 = { fontSize: "0.9rem", fontWeight: 600, margin: "0 0 0.5rem" } as const;
const dl = { display: "grid", gridTemplateColumns: "14rem 1fr", gap: "0.4rem 1rem", fontSize: "0.85rem", margin: 0 } as const;
const dt = { fontWeight: 600, color: "#374151" } as const;
const dd = { margin: 0 } as const;
const floor = { color: "#9ca3af", fontSize: "0.75rem" } as const;
