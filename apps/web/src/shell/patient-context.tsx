import {
  InfoRows,
  Panel,
  PatientBanner,
  StatusPill,
  type StatusTone,
  ageYears,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/shell — the patient identity pieces every chart tab shares (2026-09-25 redesign): the
// banner (avatar · name · status · DOB/sex/MRN/Medicare · actions) and the right-rail "Patient
// Summary" card. They live in the shell, like the tab strip, because the tabs belong to different
// modules (M5 Overview/Clinical, M12 Medications, M7 Care Plans, M11 Orders…) and modules may not
// import each other. Everything reads the M5 patient routes through the typed client.
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";

export interface ChartPatient {
  id: string;
  organizationId: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export interface ChartIdentity {
  patient: ChartPatient;
  /** "Male" / "Female" / … from M5 demographics; null while loading or unrecorded. */
  sex: string | null;
  /** Medicare MBI tail ("...5234"); null when none on file. */
  medicare: string | null;
}

// ---------- formatting ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-24" / ISO → "Sep 24, 2026" (date-only strings are read as calendar dates, not UTC). */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const d = value.length > 10 ? new Date(value) : null;
  const y = d ? d.getFullYear() : Number(m[1]);
  const mo = d ? d.getMonth() : Number(m[2]) - 1;
  const day = d ? d.getDate() : Number(m[3]);
  return `${MONTHS[mo]} ${day}, ${y}`;
}

/** "...A7AC" — identifiers are shown by their tail only, as in the mockups. */
export function maskTail(value: string | null | undefined, last4?: string | null): string {
  const tail = last4 ?? (value ? value.slice(-4) : null);
  return tail ? `...${tail}` : "—";
}

const SEX_LABEL: Record<string, string> = {
  M: "Male",
  F: "Female",
  male: "Male",
  female: "Female",
};
export function sexLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return SEX_LABEL[code] ?? code.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Patient lifecycle status → §6.6 badge tone (census, chart banner, global search). */
export const PATIENT_STATUS_TONE: Record<string, StatusTone> = {
  prospective: "progress",
  active: "success",
  on_hold: "warning",
  discharged: "neutral",
  deceased: "neutral",
  merged: "neutral",
};

/** Title-case an underscore enum value, e.g. `on_hold` → `On Hold`. */
export function patientStatusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Identifier {
  kind: string;
  value: string | null;
  last4: string | null;
  effectiveTo: string | null;
}

/** The current Medicare MBI tail from an M5 identifier list. */
export function medicareTail(identifiers: Identifier[] | undefined): string | null {
  const list = identifiers ?? [];
  const mbi =
    list.find((i) => i.kind === "mbi" && !i.effectiveTo) ?? list.find((i) => i.kind === "mbi");
  return mbi ? maskTail(mbi.value, mbi.last4) : null;
}

// ---------- data ----------

/** Loads the banner identity for a chart tab that does not already hold the patient record. */
export function useChartIdentity(patientId: string | undefined): ChartIdentity | null {
  const client = useApiClient();
  const [identity, setIdentity] = useState<ChartIdentity | null>(null);
  useEffect(() => {
    if (!patientId) return;
    let active = true;
    setIdentity(null);
    void (async () => {
      try {
        const [p, demo, ids] = await Promise.all([
          client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
          client.GET("/api/v1/patients/{id}/demographics", { params: { path: { id: patientId } } }),
          client.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patientId } } }),
        ]);
        if (!active || p.error || !p.data) return;
        setIdentity({
          patient: p.data as ChartPatient,
          sex: sexLabel(
            (demo.data as { sexAssignedAtBirth?: string } | undefined)?.sexAssignedAtBirth,
          ),
          medicare: medicareTail(
            (ids.data as { identifiers?: Identifier[] } | undefined)?.identifiers,
          ),
        });
      } catch {
        // The banner is context, not content: a failed read leaves the placeholder in place.
      }
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);
  return identity;
}

// ---------- banner ----------

export function ChartBanner({
  identity,
  actions,
}: {
  identity: ChartIdentity;
  actions?: ReactNode;
}): JSX.Element {
  const { patient, sex, medicare } = identity;
  const age = ageYears(patient.dob);
  const meta = [
    `DOB ${fmtDate(patient.dob)}${age != null ? ` (${age}y)` : ""}`,
    sex,
    `MRN: ${maskTail(patient.mrn)}`,
    medicare ? `Medicare: ${medicare}` : null,
  ].filter((m): m is string => Boolean(m));
  return (
    <PatientBanner
      name={
        <Link to={`/patients/${patient.id}`} style={{ color: "inherit", textDecoration: "none" }}>
          {patient.firstName} {patient.lastName}
        </Link>
      }
      chips={
        <StatusPill
          label={patientStatusLabel(patient.status)}
          tone={PATIENT_STATUS_TONE[patient.status] ?? "neutral"}
        />
      }
      meta={
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {meta.map((m, i) => (
            <span key={m} style={{ display: "inline-flex", gap: "0.5rem" }}>
              {i > 0 ? <span aria-hidden>•</span> : null}
              <span className="wx-nums">{m}</span>
            </span>
          ))}
        </span>
      }
      actions={actions}
    />
  );
}

/** Self-loading banner for module-owned chart tabs; a same-height placeholder while it loads. */
export function ChartPatientBanner({
  patientId,
  actions,
}: {
  patientId: string | undefined;
  actions?: ReactNode;
}): JSX.Element {
  const identity = useChartIdentity(patientId);
  if (!identity) {
    return (
      <div
        className="wx-patient-banner"
        aria-busy="true"
        style={{ minHeight: "6.25rem", background: t.surfaceLowest }}
      />
    );
  }
  return <ChartBanner identity={identity} actions={actions} />;
}

// ---------- rail ----------

/** Compact identity card at the top of a chart tab's right rail (mockup "Patient Summary"). */
export function PatientSummaryPanel({ identity }: { identity: ChartIdentity | null }): JSX.Element {
  const p = identity?.patient;
  const age = p ? ageYears(p.dob) : null;
  return (
    <Panel
      title="Patient Summary"
      icon="users"
      action={
        p ? (
          <Link to={`/patients/${p.id}?view=demographics`} style={{ fontWeight: 500 }}>
            Edit
          </Link>
        ) : null
      }
    >
      {p ? (
        <>
          <div
            style={{
              fontWeight: 700,
              fontSize: "0.875rem",
              marginBottom: "0.5rem",
              color: t.onSurface,
            }}
          >
            {p.firstName} {p.lastName}
          </div>
          <InfoRows
            labelWidth="5rem"
            rows={[
              { label: "DOB", value: `${fmtDate(p.dob)}${age != null ? ` (${age}y)` : ""}` },
              { label: "Sex", value: identity?.sex ?? "—" },
              { label: "MRN", value: maskTail(p.mrn) },
              { label: "Medicare", value: identity?.medicare ?? "—" },
            ]}
          />
        </>
      ) : (
        <p style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem", margin: 0 }}>Loading…</p>
      )}
    </Panel>
  );
}

interface ActiveProblem {
  id: string;
  icd10Code: string | null;
  description: string;
  kind: string;
  status: string;
}

/**
 * Rail card listing the patient's active plan-of-care problems (mockup "Active Diagnoses"), terminal
 * diagnosis first. A patient without a plan of care yet reads "None recorded", not an error.
 */
export function ActiveDiagnosesPanel({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [problems, setProblems] = useState<ActiveProblem[] | null>(null);
  useEffect(() => {
    let active = true;
    setProblems(null);
    void client
      .GET("/api/v1/patients/{patientId}/care-plan", { params: { path: { patientId } } })
      .then((r) => {
        if (!active) return;
        const all = ((r.data as { problems?: ActiveProblem[] } | undefined)?.problems ?? []).filter(
          (p) => p.status === "active",
        );
        setProblems(
          all.sort((a, b) => Number(b.kind === "terminal") - Number(a.kind === "terminal")),
        );
      })
      .catch(() => {
        if (active) setProblems([]);
      });
    return () => {
      active = false;
    };
  }, [client, patientId]);
  return (
    <Panel
      title={`Active Diagnoses${problems ? ` (${problems.length})` : ""}`}
      icon="shield-check"
      action={
        problems && problems.length > 0 ? (
          <Link to={`/patients/${patientId}/care-plan`} style={{ fontWeight: 500 }}>
            View all
          </Link>
        ) : null
      }
    >
      {problems === null ? (
        <p style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem", margin: 0 }}>Loading…</p>
      ) : problems.length === 0 ? (
        <p style={{ color: t.onSurfaceVariant, fontSize: "0.8125rem", margin: 0 }}>
          None recorded.
        </p>
      ) : (
        <ul className="wx-dx-list">
          {problems.slice(0, 6).map((p) => (
            <li key={p.id} style={{ gridTemplateColumns: "4rem minmax(0, 1fr)" }}>
              <span className="wx-dx-code">{p.icd10Code ?? "—"}</span>
              <span className="wx-dx-desc" title={p.description}>
                {p.description}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
