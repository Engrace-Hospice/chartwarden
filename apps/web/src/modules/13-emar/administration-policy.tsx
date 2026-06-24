// apps/web/src/modules/13-emar — administration policy admin (M13 §4.1/§6.1 #12, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Work Queue" (administration-policy admin).
// Read-only tenant configuration for org_admin / compliance_officer: the grace window, the PRN minimum-interval
// default, and the eMAR-PDF-on-commit toggle. The tighten-only PUT write action (step-up enforced server-side)
// fills in as its write surface hardens; the SERVER owns the platform floors and the §2.5 grace-window policy
// (ADR-0030). Reads GET /api/v1/admin/administration-policy via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface AdministrationPolicyView {
  graceWindowMinutes: number;
  prnMinimumIntervalMinutes: number;
  emarPdfOnCommit: boolean;
}

export function AdministrationPolicy(): JSX.Element {
  const client = useApiClient();
  const [policy, setPolicy] = useState<AdministrationPolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admin/administration-policy", {});
    if (err) {
      setError("Could not load the administration policy.");
      setLoading(false);
      return;
    }
    setPolicy(data as AdministrationPolicyView);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Administration Policy" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading || !policy ? (
          <LoadingSpinner />
        ) : (
          <div style={{ display: "grid", gap: "1.5rem", maxWidth: "40rem" }}>
            <section>
              <h3 style={h3}>Scheduling & late entry (§2.5)</h3>
              <dl style={dl}>
                <dt style={dt}>Grace window</dt>
                <dd style={dd}>{policy.graceWindowMinutes} min</dd>
                <dt style={dt}>PRN minimum interval</dt>
                <dd style={dd}>{policy.prnMinimumIntervalMinutes} min</dd>
                <dt style={dt}>eMAR PDF on commit</dt>
                <dd style={dd}>{policy.emarPdfOnCommit ? "enabled" : "disabled"}</dd>
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
