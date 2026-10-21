import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/12-dosespot — refill request detail (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_MEDICATIONS_EMAR.md — "Use Detail" (refill detail). Read-only view
// of a single refill request (§2.7 D9): the source medication-order reference, the request status / age, the
// resulting medication order (once approved → a NEW med_order is minted, derived_from_refill, the original is
// never edited). The approve/deny write actions (mint-on-approve, no-mint-on-deny, schedule-aware refill cap)
// fill in as their write surface hardens; the SERVER enforces the refill_inbox_scope ABAC + the controlled-
// substance refill rules (21 CFR 1306.22) and SUD-consent gating (ADR-0030 — out-of-scope refills 404). Reads
// GET /api/v1/refills/:id via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { REFILL_TONE, stateLabel } from "./medication-status";
import { RefillDecisionModal } from "./refill-decision-modal";

interface RefillRequestView {
  id: string;
  patientId: string;
  sourceMedicationOrderId: string;
  status: string;
  requestedAt: string;
  prescriberMembershipId: string | null;
  resultingMedicationOrderId: string | null;
}

const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");

export function RefillDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<RefillRequestView | null>(null);
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger a completed decision bumps, not read in the body.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/refills/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the refill request.");
        setLoading(false);
        return;
      }
      setRow(data as RefillRequestView);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id, reloadKey]);

  // §2.7 — a refill is decided while it is PENDING. The server owns the transition and the per-schedule
  // refill cap; offering the ceremony on a decided request would be a control certain to be refused.
  const decidable = row?.status === "pending";

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Refill Request"
          actions={
            row ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                {decidable ? (
                  <>
                    <Button tone="tertiary" onClick={() => setDecision("approve")}>
                      Approve
                    </Button>
                    <Button tone="tertiary" onClick={() => setDecision("deny")}>
                      Deny
                    </Button>
                  </>
                ) : null}
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={REFILL_TONE[row.status] ?? "neutral"}
                />
              </span>
            ) : undefined
          }
        />
      }
    >
      {row && decision ? (
        <RefillDecisionModal
          open
          decision={decision}
          refillId={row.id}
          onClose={() => setDecision(null)}
          onDone={() => setReloadKey((k) => k + 1)}
        />
      ) : null}
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "12rem 1fr",
            gap: "0.4rem 1rem",
            fontSize: "0.85rem",
          }}
        >
          <dt style={dt}>Status</dt>
          <dd style={dd}>
            <StatusPill
              label={stateLabel(row.status)}
              tone={REFILL_TONE[row.status] ?? "neutral"}
            />
          </dd>
          <dt style={dt}>Source order</dt>
          <dd style={dd} className="wx-data-md">
            {row.sourceMedicationOrderId}
          </dd>
          <dt style={dt}>Requested</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.requestedAt)}
          </dd>
          <dt style={dt}>Named prescriber</dt>
          <dd style={dd} className="wx-data-md">
            {row.prescriberMembershipId ?? "—"}
          </dd>
          <dt style={dt}>Resulting order</dt>
          <dd style={dd} className="wx-data-md">
            {row.resultingMedicationOrderId ?? "—"}
          </dd>
        </dl>
      )}
    </DetailPageLayout>
  );
}

const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
