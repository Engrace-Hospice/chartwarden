import {
  Button,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/12-dosespot — medication-order detail (M12 §4.1/§6.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail" (medication detail / the
// prescribe modal in sign-only mode). Read-only view of a single medication order: drug + sig facts, the §2.2
// D2 lifecycle status, the controlled-substance / EPCS posture, the prescriber + pharmacy, the signature
// posture, refills remaining, and the correction lineage (replaces / derived-from-refill). For a transmitted
// order it also loads the DoseSpot transmission status + retry history (§2.6).
//
// #91 — the §2.2 write ceremonies are here now, offered by the order's CURRENT status. The server still
// decides every one of them (`transitionMedicationOrder`); narrowing the offer keeps a prescriber from
// being shown a ceremony that will certainly be refused, and a refusal is still rendered where they are
// looking. `sign-controlled` (the EPCS two-step) is deliberately NOT offered: §2.4/D18 ships Phase 1
// `not_certified`, so `requestSignature` refuses a controlled order outright and the ceremony would
// always fail — see `prescribe-modal.tsx`, which reads that status rather than assuming it.
// The SERVER enforces every scope incl. ABAC (ADR-0030 — out-of-scope orders 404, never 403).
// Reads GET /api/v1/medication-orders/:id and (when transmitted) GET .../transmission.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { type MedicationAction, MedicationActionModal } from "./medication-action-modal";
import { MED_ORDER_TONE, SEND_TONE, controlledLabel, stateLabel } from "./medication-status";

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

const ACTION_LABEL: Record<MedicationAction, string> = {
  "request-signature": "Send for signature",
  sign: "Sign",
  cosign: "Cosign",
  verbal: "Record verbal",
  discontinue: "Discontinue",
  complete: "Complete",
};

export function MedicationDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<MedicationOrderView | null>(null);
  const [tx, setTx] = useState<TransmissionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<MedicationAction | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger a completed write bumps, not read in the body.
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
  }, [client, id, reloadKey]);

  /** The §2.2 transitions this order's CURRENT status permits. The server decides; this narrows the
   *  offer so a prescriber is not shown a ceremony that will certainly be refused (#91). */
  const offered: MedicationAction[] =
    row === null
      ? []
      : row.status === "draft"
        ? ["request-signature"]
        : row.status === "pending_signature"
          ? ["sign"]
          : row.status === "verbal_pending"
            ? ["sign", "cosign"]
            : row.status === "active"
              ? ["discontinue", "complete", ...(row.cosignRequired ? (["cosign"] as const) : [])]
              : [];

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Medication Order"
          actions={
            row ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                {offered.map((a) => (
                  <Button key={a} tone="tertiary" onClick={() => setAction(a)}>
                    {ACTION_LABEL[a]}
                  </Button>
                ))}
                {row.isControlledSubstance ? (
                  <StatusPill
                    label={controlledLabel(row.deaSchedule)}
                    tone="critical"
                    glyph="alert"
                  />
                ) : null}
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={MED_ORDER_TONE[row.status] ?? "neutral"}
                />
              </span>
            ) : undefined
          }
        >
          {row ? (
            <span style={meta}>
              {row.drugName} {row.strength}
            </span>
          ) : null}
        </PageHeader>
      }
    >
      {row && action ? (
        <MedicationActionModal
          open
          action={action}
          orderId={row.id}
          onClose={() => setAction(null)}
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
          <dt style={dt}>Drug</dt>
          <dd style={dd}>
            {row.drugName} {row.strength} {row.doseForm} · {row.route}
          </dd>
          <dt style={dt}>Class</dt>
          <dd style={dd}>{row.medClass}</dd>
          <dt style={dt}>Controlled</dt>
          <dd style={dd}>
            {/* §10 — controlled-substance / EPCS gold `critical` tone. */}
            {row.isControlledSubstance ? (
              <StatusPill
                label={`${controlledLabel(row.deaSchedule)} · EPCS`}
                tone="critical"
                glyph="alert"
              />
            ) : (
              <span style={{ color: "var(--color-muted)" }}>No</span>
            )}
          </dd>
          <dt style={dt}>RxNorm / NDC</dt>
          <dd style={dd} className="wx-data-md">
            {row.rxnormRxcui ?? "—"} / {row.ndc ?? "—"}
          </dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>
            <StatusPill
              label={stateLabel(row.status)}
              tone={MED_ORDER_TONE[row.status] ?? "neutral"}
            />
          </dd>
          <dt style={dt}>Prescriber</dt>
          <dd style={dd}>
            <span className="wx-data-md">{row.prescribingPhysicianMdmId}</span> (
            {stateLabel(row.prescriberDiscipline)})
          </dd>
          <dt style={dt}>Pharmacy</dt>
          <dd style={dd} className="wx-data-md">
            {row.dispensingPharmacyMdmId ?? "—"}
          </dd>
          <dt style={dt}>Signed</dt>
          <dd style={dd} className="tabular-nums">
            {row.signedAt ? `${ts(row.signedAt)} · ${row.signedBy ?? ""}` : "—"}
          </dd>
          <dt style={dt}>Cosignature</dt>
          <dd style={dd}>
            {row.cosignRequired ? (
              <StatusPill
                label={stateLabel(row.cosignStatus ?? "pending")}
                tone={row.cosignStatus === "attached" ? "success" : "warning"}
              />
            ) : (
              <span style={{ color: "var(--color-muted)" }}>Not required</span>
            )}
          </dd>
          <dt style={dt}>Refills remaining</dt>
          <dd style={dd} className="tabular-nums">
            {row.refillsRemaining}
          </dd>
          <dt style={dt}>Corrects order</dt>
          <dd style={dd} className="wx-data-md">
            {row.replacesMedicationOrderId ?? "—"}
          </dd>
          <dt style={dt}>From refill</dt>
          <dd style={dd} className="wx-data-md">
            {row.derivedFromRefillId ?? "—"}
          </dd>
          <dt style={dt}>Discontinued</dt>
          <dd style={dd}>
            {row.discontinuedAt
              ? `${ts(row.discontinuedAt)} · ${row.discontinuationReason ?? ""}`
              : "—"}
          </dd>
          {tx ? (
            <>
              <dt style={dt}>Transmission</dt>
              <dd style={dd}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                  <StatusPill
                    label={stateLabel(tx.status)}
                    tone={SEND_TONE[tx.status] ?? "neutral"}
                  />
                  {tx.retryHistory.length > 0 ? (
                    <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.78rem" }}>
                      {tx.retryHistory.length} retr{tx.retryHistory.length === 1 ? "y" : "ies"}
                    </span>
                  ) : null}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      )}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
const dt = { fontWeight: 600, color: "var(--color-on-surface)" } as const;
const dd = { margin: 0 } as const;
