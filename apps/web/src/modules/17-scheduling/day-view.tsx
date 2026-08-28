import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  TextField,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Day View (M17 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The scheduler's per-clinician day grid: one row per visit for the
// selected service date with its lifecycle chip + scheduled window. The drag-drop reschedule / publish-all
// write surfaces fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + the §4.7 pre-
// schedule ABAC (ADR-0030 — no frontend authz; out-of-scope resources 404, never 403). The clinician is taken
// from `?membership=`, the date from `?date=` (defaults to today). Reads GET /api/v1/day-view via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  type MembershipOption,
  type PatientAddressOption,
  loadMemberships,
  loadPatientAddresses,
  loadPatientAdmissions,
  searchPatients,
} from "./scheduling-api";
import { ScheduleVisitModal } from "./visit-modals";
import { type VisitRow, VisitRows } from "./visit-table";

export function SchedulingDay(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = params.get("membership") ?? undefined;
  const date = params.get("date") ?? new Date().toISOString().slice(0, 10);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [patientQuery, setPatientQuery] = useState("");
  const [patientHits, setPatientHits] = useState<{ id: string; label: string }[]>([]);
  const [target, setTarget] = useState<{ patientId: string; admissionId: string } | null>(null);
  const [addresses, setAddresses] = useState<PatientAddressOption[]>([]);
  const [memberships, setMemberships] = useState<MembershipOption[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const session = useSession();

  // The assignee roster. NOT an eligibility list — the §4.7 D8 gate is the server's (see visit-modals).
  useEffect(() => {
    const orgId = session?.organizationId;
    if (!orgId) return;
    void loadMemberships(client, orgId).then(setMemberships);
  }, [client, session]);

  /**
   * Choosing the patient resolves the two things `POST /visits` needs and a day view does not have: the
   * open ADMISSION the visit is filed under (F-065 — nothing could resolve one for a patient until that
   * read landed, see #161) and the patient's ADDRESSES, since a home visit with no address is a visit
   * nobody can travel to. If either is missing the form is not opened and the reason is said out loud.
   */
  async function choosePatient(patientId: string): Promise<void> {
    setPickError(null);
    const [admissions, addr] = await Promise.all([
      loadPatientAdmissions(client, patientId),
      loadPatientAddresses(client, patientId),
    ]);
    const openAdmission = admissions.find((a) => a.dischargedAt == null);
    if (!openAdmission) {
      setPickError("That patient has no open admission, so a visit cannot be scheduled for them.");
      return;
    }
    setAddresses(addr);
    setTarget({ patientId, admissionId: openAdmission.id });
    setPatientHits([]);
    setScheduling(true);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/day-view", {
      params: { query: { date, ...(membership ? { membership } : {}) } },
    });
    if (err) {
      setError("Could not load the day view.");
      setLoading(false);
      return;
    }
    setVisits(((data?.visits ?? []) as VisitRow[]) ?? []);
    setLoading(false);
  }, [client, date, membership]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () =>
      [...visits].sort(
        (a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt),
      ),
    [visits],
  );
  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Day View" breadcrumb="Scheduling">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Scheduled visits for {date}
            {membership ? `, scoped to clinician ${membership.slice(0, 8)}` : ""}.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {/* #91 — scheduling starts here. A day view has no patient context, so the patient is
              searched for, and choosing one resolves the admission and addresses the create needs. */}
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <div style={{ flex: 1, maxWidth: "22rem" }}>
              <TextField
                label="Schedule a visit — find a patient"
                value={patientQuery}
                onChange={(e) => setPatientQuery(e.target.value)}
              />
            </div>
            <Button
              tone="tertiary"
              disabled={patientQuery.trim().length < 2}
              onClick={() => void searchPatients(client, patientQuery).then(setPatientHits)}
            >
              Search
            </Button>
          </div>
          {patientHits.length > 0 ? (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {patientHits.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    style={{
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                      padding: "0.35rem 0",
                      fontSize: "0.85rem",
                      color: "var(--color-on-surface)",
                    }}
                    onClick={() => void choosePatient(p.id)}
                  >
                    {p.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {pickError ? (
            <p role="alert" style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-error)" }}>
              {pickError}
            </p>
          ) : null}
          <div style={infoBannerStyle}>
            Reads are server-scoped by date and optional membership query parameters. Drag/drop
            rescheduling is not built; a visit is moved from its detail page.
          </div>
          {target ? (
            <ScheduleVisitModal
              open={scheduling}
              patientId={target.patientId}
              admissionId={target.admissionId}
              addresses={addresses}
              memberships={memberships}
              onClose={() => setScheduling(false)}
              onScheduled={() => void load()}
            />
          ) : null}
        </div>
      }
      table={
        error ? (
          <div style={emptyShellStyle}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && visits.length === 0 ? (
          <div style={loadingShellStyle}>
            <LoadingSpinner />
          </div>
        ) : sorted.length === 0 ? (
          <div style={emptyShellStyle}>
            <EmptyState title="No visits" description="No visits are scheduled for this day." />
          </div>
        ) : (
          <div style={tableShellStyle}>
            <VisitRows visits={sorted} onSelect={(id) => navigate(`/scheduling/visits/${id}`)} />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const loadingShellStyle: CSSProperties = {
  padding: "2.5rem 1.5rem",
  textAlign: "center",
};

const infoBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  background: "var(--color-primary-tint)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
