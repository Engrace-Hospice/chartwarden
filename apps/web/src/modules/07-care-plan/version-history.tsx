import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
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
import { cap, toneFor } from "./care-plan-status";

interface Version {
  id: string;
  sequence: number;
  kind: string;
  status: string;
  signedAt: string | null;
  // #91 — `{ role, count }`, NOT `string`. The wire has always sent slot OBJECTS; both M7 screens
  // declared `string[]` and rendered each entry through `cap()`, which calls `s.replace` — so the IDG
  // signature checklist would have THROWN the first time a version carried a non-empty signer set, and
  // the `signerRole === role` comparison beside it was an object-vs-string that could only ever be
  // false. It never fired because `requiredSignerSet` is populated at FINALIZE and nothing could
  // finalize; enabling that write is what would have surfaced it.
  requiredSignerSet: { role: string; count: number }[];
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
      setItems((data?.items ?? []) as unknown as Version[]);
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
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Signed</th>
              <th>Signers</th>
            </tr>
          </thead>
          <tbody>
            {[...items]
              .sort((a, b) => b.sequence - a.sequence)
              .map((v) => (
                <tr key={v.id}>
                  <td className="wx-data-md">v{v.sequence}</td>
                  <td>{cap(v.kind)}</td>
                  <td>
                    <StatusPill label={cap(v.status)} tone={toneFor(v.status)} />
                  </td>
                  <td className="tabular-nums">{v.signedAt ? v.signedAt.slice(0, 10) : "—"}</td>
                  <td>
                    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.5rem" }}>
                      {v.requiredSignerSet.map((slot) => {
                        // A slot can require MORE than one signature of a role (`count`); it is met only
                        // when that many have been collected, which the old `some()` could not express.
                        const collected = v.signatures.filter(
                          (sig) => sig.signerRole === slot.role,
                        ).length;
                        const signed = collected >= slot.count;
                        return (
                          <span
                            key={slot.role}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.3rem",
                              color: signed ? "var(--color-success)" : "var(--color-warning)",
                            }}
                          >
                            <Glyph name={signed ? "check-circle" : "clock"} size={13} />
                            {cap(slot.role)}
                            {slot.count > 1 ? ` ${collected}/${slot.count}` : ""}
                          </span>
                        );
                      })}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}
