import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/13-emar — administration detail (M13 §4.1/§6.1 #11, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md — "Use Detail". Read-only detail of a single
// administration within the retention-class-C audit boundary: the §2.2 lifecycle status, the §2.5 late-entry
// tier, the actor kind (clinician / caregiver-attested), the witness pair for controlled substances, the §2.9
// BCMA match result, and the caregiver-cosign posture. The correct / void / acknowledge / dispute write actions
// fill in as their write surfaces harden; the SERVER enforces every scope incl. ABAC (ADR-0030 — out-of-scope
// rows 404, never 403). Reads GET /api/v1/administrations/:id via the typed client. Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { ADMIN_STATUS_TONE, lateEntryTone, stateLabel } from "./emar-status";

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
        <PageHeader
          title="Administration"
          actions={
            row ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                {row.isControlledSubstance ? (
                  <StatusPill label="Controlled" tone="critical" glyph="alert" />
                ) : null}
                <StatusPill
                  label={stateLabel(row.status)}
                  tone={ADMIN_STATUS_TONE[row.status] ?? "neutral"}
                />
              </span>
            ) : undefined
          }
        >
          {row ? <span style={meta}>{stateLabel(row.mode)}</span> : null}
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "14rem 1fr",
            gap: "0.4rem 1rem",
            fontSize: "0.85rem",
          }}
        >
          <dt style={dt}>Order</dt>
          <dd style={dd} className="wx-data-md">
            {row.medicationOrderId}
          </dd>
          <dt style={dt}>Mode</dt>
          <dd style={dd}>{stateLabel(row.mode)}</dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
              <StatusPill
                label={stateLabel(row.status)}
                tone={ADMIN_STATUS_TONE[row.status] ?? "neutral"}
              />
              {row.requiresRnReview ? (
                <StatusPill label="Awaiting RN review" tone="warning" />
              ) : null}
            </span>
          </dd>
          <dt style={dt}>Actor</dt>
          <dd style={dd}>{stateLabel(row.actorKind)}</dd>
          <dt style={dt}>Administered</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.administeredAt)}
          </dd>
          <dt style={dt}>Recorded</dt>
          <dd style={dd} className="tabular-nums">
            {ts(row.recordedAt)}
          </dd>
          <dt style={dt}>Late-entry tier</dt>
          <dd style={dd}>
            <StatusPill
              label={stateLabel(row.lateEntryTier)}
              tone={lateEntryTone(row.lateEntryTier)}
            />
          </dd>
          <dt style={dt}>Controlled</dt>
          <dd style={dd}>
            {/* §10 — controlled-substance gold `critical` tone. */}
            {row.isControlledSubstance ? (
              <StatusPill label="Controlled" tone="critical" glyph="alert" />
            ) : (
              <span style={{ color: "var(--color-muted)" }}>No</span>
            )}
          </dd>
          <dt style={dt}>Administering clinician</dt>
          <dd style={dd} className="wx-data-md">
            {row.administeringClinicianMembershipId ?? "—"}
          </dd>
          <dt style={dt}>Witness</dt>
          <dd style={dd} className="wx-data-md">
            {row.witnessMembershipId ?? "—"}
          </dd>
          <dt style={dt}>BCMA match</dt>
          <dd style={dd}>{row.barcodeMatchResult ? stateLabel(row.barcodeMatchResult) : "—"}</dd>
          <dt style={dt}>Comfort-kit drawdown</dt>
          <dd style={dd} className="wx-data-md">
            {row.isComfortKitDrawdown ? (row.comfortKitDeploymentId ?? "yes") : "—"}
          </dd>
          <dt style={dt}>IV session</dt>
          <dd style={dd} className="wx-data-md">
            {row.ivSessionId ?? "—"}
          </dd>
          <dt style={dt}>Encounter</dt>
          <dd style={dd} className="wx-data-md">
            {row.encounterId ?? "—"}
          </dd>
          <dt style={dt}>Superseded by</dt>
          <dd style={dd} className="wx-data-md">
            {row.supersededById ?? "—"}
          </dd>
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
