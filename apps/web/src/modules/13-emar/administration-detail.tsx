// apps/web/src/modules/13-emar — administration detail (M13 §4.1/§6.1 #11, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail". Read-only detail of a single
// administration within the retention-class-C audit boundary: the §2.2 lifecycle status, the §2.5 late-entry
// tier, the actor kind (clinician / caregiver-attested), the witness pair for controlled substances, the §2.9
// BCMA match result, and the caregiver-cosign posture. The correct / void / acknowledge / dispute write actions
// fill in as their write surfaces harden; the SERVER enforces every scope incl. ABAC (ADR-0030 — out-of-scope
// rows 404, never 403). Reads GET /api/v1/administrations/:id via the typed client. Leaves only (@wardenx/ui).
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

interface AdministrationView {
  id: string;
  patientId: string;
  admissionId: string;
  medicationOrderId: string;
  mode: string;
  status: string;
  actorKind: string;
  administeredAt: string;
  recordedAt: string;
  lateEntryTier: string;
  administeringClinicianMembershipId: string | null;
  witnessMembershipId: string | null;
  encounterId: string | null;
  scheduledDoseId: string | null;
  comfortKitDeploymentId: string | null;
  ivSessionId: string | null;
  isControlledSubstance: boolean;
  isComfortKitDrawdown: boolean;
  requiresRnReview: boolean;
  supersededById: string | null;
  barcodeMatchResult: string | null;
}

const ts = (v: string | null): string => (v ? v.slice(0, 16).replace("T", " ") : "—");

export function AdministrationDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<AdministrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/administrations/{id}", {
        params: { path: { id } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load the administration.");
        setLoading(false);
        return;
      }
      setRow(data as AdministrationView);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  return (
    <DetailPageLayout
      header={
        <PageHeader title="Administration">
          {row ? (
            <span style={meta}>
              {row.mode} · {row.status}
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
        <dl style={{ display: "grid", gridTemplateColumns: "14rem 1fr", gap: "0.4rem 1rem", fontSize: "0.85rem" }}>
          <dt style={dt}>Order</dt>
          <dd style={dd}>{row.medicationOrderId}</dd>
          <dt style={dt}>Mode</dt>
          <dd style={dd}>{row.mode}</dd>
          <dt style={dt}>Status</dt>
          <dd style={{ ...dd, color: row.requiresRnReview ? "#b45309" : undefined }}>
            {row.status}
            {row.requiresRnReview ? " · awaiting RN review" : ""}
          </dd>
          <dt style={dt}>Actor</dt>
          <dd style={dd}>{row.actorKind}</dd>
          <dt style={dt}>Administered</dt>
          <dd style={dd}>{ts(row.administeredAt)}</dd>
          <dt style={dt}>Recorded</dt>
          <dd style={dd}>{ts(row.recordedAt)}</dd>
          <dt style={dt}>Late-entry tier</dt>
          <dd style={{ ...dd, color: row.lateEntryTier !== "normal" ? "#b45309" : undefined }}>
            {row.lateEntryTier}
          </dd>
          <dt style={dt}>Controlled</dt>
          <dd style={{ ...dd, color: row.isControlledSubstance ? "#b45309" : undefined }}>
            {row.isControlledSubstance ? "yes" : "no"}
          </dd>
          <dt style={dt}>Administering clinician</dt>
          <dd style={dd}>{row.administeringClinicianMembershipId ?? "—"}</dd>
          <dt style={dt}>Witness</dt>
          <dd style={dd}>{row.witnessMembershipId ?? "—"}</dd>
          <dt style={dt}>BCMA match</dt>
          <dd style={dd}>{row.barcodeMatchResult ?? "—"}</dd>
          <dt style={dt}>Comfort-kit drawdown</dt>
          <dd style={dd}>{row.isComfortKitDrawdown ? (row.comfortKitDeploymentId ?? "yes") : "—"}</dd>
          <dt style={dt}>IV session</dt>
          <dd style={dd}>{row.ivSessionId ?? "—"}</dd>
          <dt style={dt}>Encounter</dt>
          <dd style={dd}>{row.encounterId ?? "—"}</dd>
          <dt style={dt}>Superseded by</dt>
          <dd style={dd}>{row.supersededById ?? "—"}</dd>
        </dl>
      )}
    </DetailPageLayout>
  );
}

const meta = { fontSize: "0.75rem", color: "#6b7280", margin: "0.25rem 0" } as const;
const dt = { fontWeight: 600, color: "#374151" } as const;
const dd = { margin: 0 } as const;
