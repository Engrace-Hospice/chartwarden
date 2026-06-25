import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Visit Detail (M17 §5.1 `/app/scheduling/visit/:visitId`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Detail Page". A single visit's detail: status, scheduled window, purpose/setting,
// assignment, and the reschedule chain back-ref. The reschedule/cancel/reassign + state-history write surfaces
// fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + §4.7 ABAC (ADR-0030 — no frontend
// authz; an out-of-scope visit 404s). Reads GET /api/v1/visits/:visitId via the typed client. Leaves only
// (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { VISIT_TONE, stateLabel } from "./scheduling-status";

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
    <DetailPageLayout header={<PageHeader title="Visit Detail" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !visit ? (
        <LoadingSpinner />
      ) : (
        <dl style={dl}>
          <Row
            label="Status"
            value={
              <StatusPill
                label={stateLabel(visit.status)}
                tone={VISIT_TONE[visit.status] ?? "neutral"}
              />
            }
          />
          <Row
            label="Service date"
            value={<span className="tabular-nums">{visit.serviceDate}</span>}
          />
          <Row
            label="Scheduled start"
            value={<span className="tabular-nums">{ts(visit.scheduledStartedAt)}</span>}
          />
          <Row
            label="Scheduled end"
            value={<span className="tabular-nums">{ts(visit.scheduledEndedAt)}</span>}
          />
          <Row label="Purpose" value={stateLabel(visit.visitPurpose)} />
          <Row label="Setting" value={stateLabel(visit.visitSetting)} />
          <Row
            label="Clinician"
            value={<span className="wx-data-md">{visit.assignedMembershipId}</span>}
          />
          <Row label="Patient" value={<span className="wx-data-md">{visit.patientId}</span>} />
          {visit.rescheduledIntoVisitId ? (
            <Row
              label="Rescheduled into"
              value={<span className="wx-data-md">{visit.rescheduledIntoVisitId}</span>}
            />
          ) : null}
        </dl>
      )}
    </DetailPageLayout>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        gap: "1rem",
        padding: "0.4rem 0",
        borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
      }}
    >
      <dt style={{ width: "10rem", color: "var(--color-on-surface-variant)", fontSize: "0.8rem" }}>
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface)" }}>{value}</dd>
    </div>
  );
}

const dl = { margin: 0, maxWidth: "40rem" } as const;
