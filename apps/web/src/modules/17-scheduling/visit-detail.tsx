// apps/web/src/modules/17-scheduling — Visit Detail (M17 §5.1 `/app/scheduling/visit/:visitId`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Detail Page". A single visit's detail: status, scheduled window, purpose/setting,
// assignment, and the reschedule chain back-ref. The reschedule/cancel/reassign + state-history write surfaces
// fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + §4.7 ABAC (ADR-0030 — no frontend
// authz; an out-of-scope visit 404s). Reads GET /api/v1/visits/:visitId via the typed client. Leaves only
// (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { DetailPageLayout, EmptyState, LoadingSpinner, PageHeader, useApiClient } from "@wardenx/ui";
import { VISIT_STATUS_COLOR } from "./visit-table";

interface VisitDetailView {
  id: string;
  patientId: string;
  admissionId: string;
  assignedMembershipId: string;
  visitPurpose: string;
  visitSetting: string;
  scheduledStartedAt: string;
  scheduledEndedAt: string;
  serviceDate: string;
  status: string;
  patientAddressId: string | null;
  externalFacilityId: string | null;
  rescheduledIntoVisitId: string | null;
}

const ts = (v: string): string => v.slice(0, 16).replace("T", " ");

export function VisitDetail(): JSX.Element {
  const client = useApiClient();
  const { visitId } = useParams<{ visitId: string }>();
  const [visit, setVisit] = useState<VisitDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!visitId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/visits/{visitId}", {
      params: { path: { visitId } },
    });
    if (err) {
      setError("This visit is unavailable or outside your scope.");
      setLoading(false);
      return;
    }
    setVisit((data ?? null) as VisitDetailView | null);
    setLoading(false);
  }, [client, visitId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DetailPageLayout
      header={<PageHeader title="Visit Detail" />}
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !visit ? (
        <LoadingSpinner />
      ) : (
        <dl style={dl}>
          <Row label="Status" value={<span style={{ color: VISIT_STATUS_COLOR[visit.status] }}>{visit.status}</span>} />
          <Row label="Service date" value={visit.serviceDate} />
          <Row label="Scheduled start" value={ts(visit.scheduledStartedAt)} />
          <Row label="Scheduled end" value={ts(visit.scheduledEndedAt)} />
          <Row label="Purpose" value={visit.visitPurpose} />
          <Row label="Setting" value={visit.visitSetting} />
          <Row label="Clinician" value={visit.assignedMembershipId} />
          <Row label="Patient" value={visit.patientId} />
          {visit.rescheduledIntoVisitId ? (
            <Row label="Rescheduled into" value={visit.rescheduledIntoVisitId} />
          ) : null}
        </dl>
      )}
    </DetailPageLayout>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "1rem", padding: "0.4rem 0", borderBottom: "1px solid #f3f4f6" }}>
      <dt style={{ width: "10rem", color: "#6b7280", fontSize: "0.8rem" }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: "0.85rem", fontFamily: "monospace" }}>{value}</dd>
    </div>
  );
}

const dl = { margin: 0, maxWidth: "40rem" } as const;
