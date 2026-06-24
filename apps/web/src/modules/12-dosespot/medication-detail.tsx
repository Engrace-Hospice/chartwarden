// apps/web/src/modules/12-dosespot — medication-order detail (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail" (medication detail / the
// prescribe modal in sign-only mode). Read-only view of a single medication order: drug + sig facts, the §2.2
// D2 lifecycle status, the controlled-substance / EPCS posture, the prescriber + pharmacy, the signature
// posture, refills remaining, and the correction lineage (replaces / derived-from-refill). For a transmitted
// order it also loads the DoseSpot transmission status + retry history (§2.6). The sign / sign-controlled /
// discontinue / correct write actions fill in as their write surfaces harden; the SERVER enforces every scope
// incl. ABAC (ADR-0030 — out-of-scope orders 404, never 403). Reads GET /api/v1/medication-orders/:id and
// (when transmitted) GET .../transmission via the typed client. Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface MedicationOrderView {
  id: string;
  patientId: string;
  admissionId: string;
  medClass: string;
  status: string;
  drugName: string;
  strength: string;
  doseForm: string;
  route: string;
  rxnormRxcui: string | null;
  ndc: string | null;
  prescriberDiscipline: string;
  prescribingPhysicianMdmId: string;
  dispensingPharmacyMdmId: string | null;
  isControlledSubstance: boolean;
  deaSchedule: string | null;
  cosignRequired: boolean;
  cosignStatus: "pending" | "attached" | null;
  refillsRemaining: number;
  derivedFromRefillId: string | null;
  replacesMedicationOrderId: string | null;
  signedAt: string | null;
  signedBy: string | null;
  transmittedAt: string | null;
  discontinuedAt: string | null;
  discontinuationReason: string | null;
  createdAt: string;
}

interface TransmissionView {
  orderId: string;
  status: string;
  retryHistory: { attempt: number; at: string; errorClass: string | null }[];
}

const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");

export function MedicationDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<MedicationOrderView | null>(null);
  const [tx, setTx] = useState<TransmissionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/medication-orders/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the medication order.");
        setLoading(false);
        return;
      }
      const order = data as MedicationOrderView;
      setRow(order);
      if (order.transmittedAt) {
        const { data: txData } = await client.GET("/api/v1/medication-orders/{id}/transmission", {
          params: { path: { id } },
        });
        if (active && txData) setTx(txData as TransmissionView);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  return (
    <DetailPageLayout
      header={
        <PageHeader title="Medication Order">
          {row ? (
            <span style={meta}>
              {row.drugName} {row.strength} · {row.status}
            </span>
          ) : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl style={{ display: "grid", gridTemplateColumns: "12rem 1fr", gap: "0.4rem 1rem", fontSize: "0.85rem" }}>
          <dt style={dt}>Drug</dt>
          <dd style={dd}>
            {row.drugName} {row.strength} {row.doseForm} · {row.route}
          </dd>
          <dt style={dt}>Class</dt>
          <dd style={dd}>{row.medClass}</dd>
          <dt style={dt}>Controlled</dt>
          <dd style={{ ...dd, color: row.isControlledSubstance ? "#b45309" : undefined }}>
            {row.isControlledSubstance ? `Schedule ${row.deaSchedule ?? "?"} (EPCS)` : "no"}
          </dd>
          <dt style={dt}>RxNorm / NDC</dt>
          <dd style={dd}>
            {row.rxnormRxcui ?? "—"} / {row.ndc ?? "—"}
          </dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>{row.status}</dd>
          <dt style={dt}>Prescriber</dt>
          <dd style={dd}>
            {row.prescribingPhysicianMdmId} ({row.prescriberDiscipline})
          </dd>
          <dt style={dt}>Pharmacy</dt>
          <dd style={dd}>{row.dispensingPharmacyMdmId ?? "—"}</dd>
          <dt style={dt}>Signed</dt>
          <dd style={dd}>{row.signedAt ? `${ts(row.signedAt)} · ${row.signedBy ?? ""}` : "—"}</dd>
          <dt style={dt}>Cosignature</dt>
          <dd style={dd}>{row.cosignRequired ? (row.cosignStatus ?? "pending") : "not required"}</dd>
          <dt style={dt}>Refills remaining</dt>
          <dd style={dd}>{row.refillsRemaining}</dd>
          <dt style={dt}>Corrects order</dt>
          <dd style={dd}>{row.replacesMedicationOrderId ?? "—"}</dd>
          <dt style={dt}>From refill</dt>
          <dd style={dd}>{row.derivedFromRefillId ?? "—"}</dd>
          <dt style={dt}>Discontinued</dt>
          <dd style={dd}>
            {row.discontinuedAt ? `${ts(row.discontinuedAt)} · ${row.discontinuationReason ?? ""}` : "—"}
          </dd>
          {tx ? (
            <>
              <dt style={dt}>Transmission</dt>
              <dd style={dd}>
                {tx.status}
                {tx.retryHistory.length > 0 ? ` · ${tx.retryHistory.length} retr${tx.retryHistory.length === 1 ? "y" : "ies"}` : ""}
              </dd>
            </>
          ) : null}
        </dl>
      )}
    </DetailPageLayout>
  );
}

const meta = { fontSize: "0.75rem", color: "#6b7280", margin: "0.25rem 0" } as const;
const dt = { fontWeight: 600, color: "#374151" } as const;
const dd = { margin: 0 } as const;
