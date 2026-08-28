import {
  Button,
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
import { useSession } from "../../shell/session";
import { type MembershipOption, loadMemberships } from "./scheduling-api";
import { VISIT_TONE, stateLabel } from "./scheduling-status";
import { type VisitAction, VisitActionModal } from "./visit-modals";

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

/** The §2.2 statuses a visit can still be moved, reassigned or called off from. */
const OPEN_STATUSES = new Set(["scheduled", "published", "in_progress"]);

export function VisitDetail(): JSX.Element {
  const client = useApiClient();
  const { visitId } = useParams<{ visitId: string }>();
  const [visit, setVisit] = useState<VisitDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<VisitAction | null>(null);
  const [memberships, setMemberships] = useState<MembershipOption[]>([]);
  const session = useSession();

  // The roster the reassign picker offers. NOT an eligibility list — the §4.7 D8 gate is the server's.
  useEffect(() => {
    const orgId = session?.organizationId;
    if (!orgId) return;
    void loadMemberships(client, orgId).then(setMemberships);
  }, [client, session]);

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
      header={
        <PageHeader
          title="Visit Detail"
          actions={
            // #91 — the §2.2 ceremonies, offered by the visit's CURRENT status. The server owns every
            // transition; narrowing the offer keeps a scheduler out of one certain to be refused, and
            // the refusal is still rendered where they are looking.
            visit && OPEN_STATUSES.has(visit.status) ? (
              <span style={{ display: "inline-flex", gap: "0.35rem" }}>
                <Button tone="tertiary" onClick={() => setAction("reschedule")}>
                  Reschedule
                </Button>
                <Button tone="tertiary" onClick={() => setAction("reassign")}>
                  Reassign
                </Button>
                <Button tone="tertiary" onClick={() => setAction("no-show")}>
                  No-show
                </Button>
                <Button tone="tertiary" onClick={() => setAction("cancel")}>
                  Cancel
                </Button>
              </span>
            ) : undefined
          }
        />
      }
    >
      {visit && action ? (
        <VisitActionModal
          open
          action={action}
          visitId={visit.id}
          memberships={memberships}
          onClose={() => setAction(null)}
          onDone={() => void load()}
        />
      ) : null}
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
