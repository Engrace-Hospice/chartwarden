import { DetailPageLayout, EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Visit Detail (M17 §5.1 `/app/scheduling/visit/:visitId`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Detail Page". A single visit's detail: status, scheduled window, purpose/setting,
// assignment, and the reschedule chain back-ref. The reschedule/cancel/reassign + state-history write surfaces
// fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + §4.7 ABAC (ADR-0030 — no frontend
// authz; an out-of-scope visit 404s). Reads GET /api/v1/visits/:visitId via the typed client. Leaves only
// (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  FieldValue,
  NewVisitModal,
  SchedulingNav,
  VisitActionPanel,
  findLinkedEncounter,
  formatInstant,
  shortId,
  type EncounterLink,
  type VisitView,
} from "./scheduling-workflow";
import { VISIT_TONE, stateLabel } from "./scheduling-status";

interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export function VisitDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { visitId } = useParams<{ visitId: string }>();
  const [visit, setVisit] = useState<VisitView | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [encounter, setEncounter] = useState<EncounterLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
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
    const loaded = (data ?? null) as VisitView | null;
    setVisit(loaded);
    if (loaded) {
      const [patientRes, linked] = await Promise.all([
        client.GET("/api/v1/patients/{id}", { params: { path: { id: loaded.patientId } } }),
        findLinkedEncounter(client, loaded),
      ]);
      setPatient((patientRes.data ?? null) as PatientSummary | null);
      setEncounter(linked);
    }
    setLoading(false);
  }, [client, visitId]);

  useEffect(() => {
    void load();
  }, [load]);

  const header = (
    <PageHeader title="Visit Detail" breadcrumb="Scheduling">
      <SchedulingNav onNewVisit={() => setCreating(true)} />
    </PageHeader>
  );

  return (
    <>
      <DetailPageLayout header={header}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !visit ? (
        <LoadingSpinner />
      ) : (
        <div style={workspace}>
          <section style={section}>
            <div style={sectionHeader}>
              <div>
                <h2 style={sectionTitle}>
                  {patient ? `${patient.firstName} ${patient.lastName}` : "Scheduled visit"}
                </h2>
                <p style={meta}>
                  {patient ? `MRN ${patient.mrn} · ` : ""}Admission {shortId(visit.admissionId)}
                </p>
              </div>
              <StatusPill label={stateLabel(visit.status)} tone={VISIT_TONE[visit.status] ?? "neutral"} />
            </div>
            <div style={factsGrid}>
              <FieldValue label="Purpose">{stateLabel(visit.visitPurpose)}</FieldValue>
              <FieldValue label="Setting">{stateLabel(visit.visitSetting)}</FieldValue>
              <FieldValue label="Service date">
                <span className="tabular-nums">{visit.serviceDate}</span>
              </FieldValue>
              <FieldValue label="Scheduled start">
                <span className="tabular-nums">{formatInstant(visit.scheduledStartedAt)}</span>
              </FieldValue>
              <FieldValue label="Scheduled end">
                <span className="tabular-nums">{formatInstant(visit.scheduledEndedAt)}</span>
              </FieldValue>
              <FieldValue label="Assigned clinician">
                <span className="wx-data-md">{shortId(visit.assignedMembershipId)}</span>
              </FieldValue>
              <FieldValue label="Location">
                {visit.externalFacilityId
                  ? `Facility ${shortId(visit.externalFacilityId)}`
                  : visit.patientAddressId
                    ? `Address ${shortId(visit.patientAddressId)}`
                    : "Not specified"}
              </FieldValue>
              <FieldValue label="Linked Encounter">
                {encounter ? (
                  <button type="button" style={linkButton} onClick={() => navigate(`/patients/${encounter.patientId}/encounters/${encounter.id}`)}>
                    {stateLabel(encounter.status)}
                  </button>
                ) : (
                  "Processing"
                )}
              </FieldValue>
              {visit.rescheduledIntoVisitId ? (
                <FieldValue label="Rescheduled into">
                  <button type="button" style={linkButton} onClick={() => navigate(`/scheduling/visits/${visit.rescheduledIntoVisitId}`)}>
                    Visit {shortId(visit.rescheduledIntoVisitId)}
                  </button>
                </FieldValue>
              ) : null}
            </div>
          </section>
          <VisitActionPanel
            visit={visit}
            encounter={encounter}
            onChanged={(next) => {
              if (next) setVisit(next);
              void load();
            }}
          />
        </div>
      )}
      </DetailPageLayout>
      <NewVisitModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          navigate(`/scheduling/visits/${created.id}`);
        }}
      />
    </>
  );
}

const workspace = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(18rem, 24rem)",
  gap: "1rem",
  alignItems: "start",
} as const;
const section = {
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  padding: "1rem",
} as const;
const sectionHeader = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  alignItems: "flex-start",
  marginBottom: "1rem",
} as const;
const sectionTitle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "1.25rem",
  fontWeight: 500,
  color: "var(--color-on-surface)",
} as const;
const factsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.9rem",
} as const;
const meta = { margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--color-on-surface-variant)" } as const;
const linkButton = {
  border: "none",
  padding: 0,
  color: "var(--color-primary)",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  fontWeight: 650,
} as const;
