// apps/web/src/modules/17-scheduling — Visit Detail (M17 §5.1 `/app/scheduling/visit/:visitId`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Detail Page". A single visit's detail: status, scheduled window, purpose/setting,
// assignment, and the reschedule chain back-ref. The reschedule/cancel/reassign + state-history write surfaces
// fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + §4.7 ABAC (ADR-0030 — no frontend
// authz; an out-of-scope visit 404s). Reads GET /api/v1/visits/:visitId via the typed client. Leaves only
// (@chartwarden/ui).
import { formatMrn } from "@chartwarden/types";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { VISIT_TONE, stateLabel } from "./scheduling-status";
import {
  type EncounterLink,
  FieldValue,
  NewVisitButton,
  NewVisitModal,
  VisitActionPanel,
  type VisitView,
  findLinkedEncounter,
  formatInstant,
} from "./scheduling-workflow";

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
  const [params] = useSearchParams();
  const { visitId } = useParams<{ visitId: string }>();
  const [visit, setVisit] = useState<VisitView | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [encounter, setEncounter] = useState<EncounterLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clinicianName, setClinicianName] = useState<string | null>(null);
  const [addressLabel, setAddressLabel] = useState<string | null>(null);
  const [admissionStartedAt, setAdmissionStartedAt] = useState<string | null>(null);

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
        client.GET("/api/v1/patients/{id}", {
          params: { path: { id: loaded.patientId } },
        }),
        findLinkedEncounter(client, loaded),
      ]);
      setPatient((patientRes.data ?? null) as PatientSummary | null);
      setEncounter(linked);
      const [staff, addresses, admissions] = await Promise.all([
        (
          client as unknown as {
            GET: (path: string, options: unknown) => Promise<{ data?: unknown }>;
          }
        ).GET("/api/v1/scheduling/staff", {}),
        client.GET("/api/v1/patients/{id}/addresses", {
          params: { path: { id: loaded.patientId } },
        }),
        client.GET("/api/v1/patients/{patientId}/admissions", {
          params: { path: { patientId: loaded.patientId } },
        }),
      ]);
      const clinicians = (Array.isArray(staff.data) ? staff.data : []) as Array<{
        membershipId: string;
        displayName: string;
      }>;
      setClinicianName(
        clinicians.find((item) => item.membershipId === loaded.assignedMembershipId)?.displayName ??
          "Clinician details unavailable",
      );
      const address = (
        (addresses.data?.addresses ?? []) as Array<{
          id: string;
          line1: string;
          line2?: string | null;
          city: string;
          state?: string | null;
          postalCode?: string | null;
        }>
      ).find((item) => item.id === loaded.patientAddressId);
      setAddressLabel(
        address
          ? [address.line1, address.line2, address.city, address.state, address.postalCode]
              .filter(Boolean)
              .join(", ")
          : null,
      );
      const admission = (
        (admissions.data?.items ?? []) as Array<{
          id: string;
          startedAt?: string | null;
          admittedAt?: string | null;
        }>
      ).find((item) => item.id === loaded.admissionId);
      setAdmissionStartedAt(admission?.startedAt ?? admission?.admittedAt ?? null);
    }
    setLoading(false);
  }, [client, visitId]);

  useEffect(() => {
    void load();
  }, [load]);

  const backToSchedule = visit
    ? `/calendar?view=${encodeURIComponent(params.get("view") ?? "day")}&date=${encodeURIComponent(visit.serviceDate)}${params.get("patient") ? `&patient=${encodeURIComponent(params.get("patient")!)}` : ""}&visit=${encodeURIComponent(visit.id)}`
    : "/calendar";
  const header = (
    <PageHeader title="Visit" breadcrumb="Scheduling">
      <NewVisitButton onNewVisit={() => setCreating(true)} />
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
            <div
              style={{
                gridColumn: "1 / -1",
                display: "flex",
                gap: "1rem",
                alignItems: "center",
              }}
            >
              <Link to={backToSchedule}>← Back to schedule</Link>
              <span style={meta}>
                Scheduling / {visit.serviceDate} /{" "}
                {patient ? `${patient.firstName} ${patient.lastName}` : "Patient"} / Visit
              </span>
              {patient ? (
                <Link to={`/patients/${visit.patientId}`}>
                  Back to {patient.firstName} {patient.lastName}
                </Link>
              ) : null}
            </div>
            <section style={section}>
              <div style={sectionHeader}>
                <div>
                  <h2 style={sectionTitle}>
                    {patient ? `${patient.firstName} ${patient.lastName}` : "Scheduled visit"}
                  </h2>
                  <p style={meta}>
                    {patient?.mrn ? `${formatMrn(patient.mrn)} · ` : ""}Hospice admission
                    {admissionStartedAt ? ` · Started ${formatInstant(admissionStartedAt)}` : ""}
                  </p>
                </div>
                <StatusPill
                  label={stateLabel(visit.status)}
                  tone={VISIT_TONE[visit.status] ?? "neutral"}
                />
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
                  {clinicianName ?? "Clinician details unavailable"}
                </FieldValue>
                <FieldValue label="Location">
                  {visit.externalFacilityId
                    ? "Facility details unavailable"
                    : visit.patientAddressId
                      ? (addressLabel ?? "Address details unavailable")
                      : "Not specified"}
                </FieldValue>
                <FieldValue label="Linked Encounter">
                  {encounter ? (
                    <button
                      type="button"
                      style={linkButton}
                      onClick={() =>
                        navigate(`/patients/${encounter.patientId}/encounters/${encounter.id}`)
                      }
                    >
                      {stateLabel(encounter.status)}
                    </button>
                  ) : (
                    "Processing"
                  )}
                </FieldValue>
                {visit.rescheduledIntoVisitId ? (
                  <FieldValue label="Rescheduled into">
                    <button
                      type="button"
                      style={linkButton}
                      onClick={() => navigate(`/scheduling/visits/${visit.rescheduledIntoVisitId}`)}
                    >
                      Open rescheduled visit
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
const meta = {
  margin: "0.25rem 0 0",
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
const linkButton = {
  border: "none",
  padding: 0,
  color: "var(--color-primary)",
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  fontWeight: 650,
} as const;
