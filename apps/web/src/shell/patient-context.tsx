import {
  InfoRows,
  Panel,
  PatientBanner,
  StatusPill,
  type StatusTone,
  ageYears,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/shell — the patient identity pieces every chart tab shares (2026-09-25 redesign): the
// banner (avatar · name · status · DOB/sex/MRN/Medicare · actions) and the right-rail "Patient
// Summary" card. They live in the shell, like the tab strip, because the tabs belong to different
// modules (M5 Overview/Clinical, M12 Medications, M7 Care Plans, M11 Orders…) and modules may not
// import each other. Everything reads the M5 patient routes through the typed client.
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TARGET_24 } from "./target-size";

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
  /** Medicaid member-id tail; null when none on file, undefined when the caller did not load it. */
  medicaid?: string | null;
  /** Active allergen names; null when the read failed (unknown, not "none"); undefined when not loaded. */
  allergies?: readonly string[] | null;
  /** The loader is still reading medicaid/allergies itself, so a banner must not fetch them too. */
  extrasPending?: boolean;
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
        // The name and identifiers paint first; coverage and allergies follow and never hold them up.
        setIdentity({
          patient: p.data as ChartPatient,
          sex: sexLabel(
            (demo.data as { sexAssignedAtBirth?: string } | undefined)?.sexAssignedAtBirth,
          ),
          medicare: medicareTail(
            (ids.data as { identifiers?: Identifier[] } | undefined)?.identifiers,
          ),
          extrasPending: true,
        });
        const extras = await loadBannerExtras(client, patientId).catch(() => null);
        if (!active) return;
        // A failed read is unknown (null), never "none": no Medicaid row and no allergy chip.
        setIdentity((prev) =>
          prev
            ? {
                ...prev,
                medicaid: extras ? extras.medicaid : null,
                allergies: extras ? extras.allergies : null,
                extrasPending: false,
              }
            : prev,
        );
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

export interface BannerExtras {
  /** Masked tail of the current Medicaid coverage's member id; null when none is on file. */
  medicaid: string | null;
  /** Allergen names that are not entered-in-error (unverified ones count — missing one is the unsafe failure). */
  allergies: string[] | null;
}

type ApiClient = ReturnType<typeof useApiClient>;

/** The coverage + allergy facts the banner and summary card show; a failed read yields none, never a guess. */
async function loadBannerExtras(client: ApiClient, patientId: string): Promise<BannerExtras> {
  const [payers, allergies] = await Promise.all([
    client.GET("/api/v1/patients/{id}/payers", { params: { path: { id: patientId } } }),
    client.GET("/api/v1/patients/{id}/allergies", { params: { path: { id: patientId } } }),
  ]);
  const payerRows =
    (
      payers.data as
        | { payers?: { coverageKind: string; subscriberId: string; current: boolean }[] }
        | undefined
    )?.payers ?? [];
  const medicaid = payerRows.find((p) => p.coverageKind === "medicaid" && p.current);
  // A response that is not the list shape is a failed read: unknown, never "no allergies".
  const allergyList = (
    allergies.data as
      | { allergies?: { allergenText: string; verificationStatus: string }[] }
      | undefined
  )?.allergies;
  const allergyRows = allergies.error || !Array.isArray(allergyList) ? null : allergyList;
  return {
    medicaid: medicaid ? maskTail(medicaid.subscriberId) : null,
    allergies:
      allergyRows
        ?.filter((a) => a.verificationStatus !== "entered_in_error")
        .map((a) => a.allergenText) ?? null,
  };
}

/** Loads the extras for a banner whose identity did not already carry them (`enabled` = it did not). */
function useBannerExtras(patientId: string, enabled: boolean): BannerExtras {
  const client = useApiClient();
  const [extras, setExtras] = useState<BannerExtras>({ medicaid: null, allergies: null });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadBannerExtras(client, patientId)
      .then((loaded) => {
        if (active) setExtras(loaded);
      })
      .catch(() => {
        // Context, not content: a failed read leaves the banner without these extras.
      });
    return () => {
      active = false;
    };
  }, [client, patientId, enabled]);
  return extras;
}

// ---------- code status (ADR-0104) ----------

type CodeStatusValue = "full_code" | "dnr" | "dnr_dni" | "comfort_measures_only";

export const CODE_STATUS_LABEL: Record<CodeStatusValue, string> = {
  full_code: "Full code",
  dnr: "DNR",
  dnr_dni: "DNR / DNI",
  comfort_measures_only: "Comfort measures only",
};

const CODE_STATUS_TONE: Record<CodeStatusValue, StatusTone> = {
  full_code: "neutral",
  dnr: "critical",
  dnr_dni: "critical",
  comfort_measures_only: "critical",
};

/** `unknown` = the read failed (no chip, never a guess); `none` = nothing recorded (NOT Full code). */
type KnownCodeStatus =
  | { kind: "none" }
  | { kind: "set"; value: CodeStatusValue; recordedAt: string };

type CodeStatusState =
  | { kind: "unknown" } // not read yet (loading): no chip
  | { kind: "unavailable" } // the first read failed or was unusable: say so, never imply a status
  | KnownCodeStatus
  // A re-read failed after a value was known: keep showing it, but marked, since a write may have changed it.
  | { kind: "stale"; last: KnownCodeStatus };

const codeStatusListeners = new Set<(patientId: string) => void>();

/** The setter calls this after a set / retraction so every mounted banner re-reads (no stale DNR / Full code). */
export function notifyCodeStatusChanged(patientId: string): void {
  for (const listener of codeStatusListeners) listener(patientId);
}

async function loadCodeStatus(client: ApiClient, patientId: string): Promise<CodeStatusState> {
  const res = await client.GET("/api/v1/patients/{id}/code-status", {
    params: { path: { id: patientId } },
  });
  const current = (res.data as { current?: unknown } | undefined)?.current;
  if (res.error || current === undefined) return { kind: "unavailable" };
  if (current === null) return { kind: "none" };
  const { codeStatus, recordedAt } = current as { codeStatus?: string; recordedAt?: string };
  if (!codeStatus || !(codeStatus in CODE_STATUS_LABEL)) return { kind: "unavailable" };
  return { kind: "set", value: codeStatus as CodeStatusValue, recordedAt: recordedAt ?? "" };
}

function useCodeStatus(patientId: string): CodeStatusState {
  const client = useApiClient();
  // The state is stamped with its patient and ignored for any other, so a reused banner never shows
  // the previous patient's status, not even for the render before an effect could reset it.
  const [entry, setEntry] = useState<{ patientId: string; state: CodeStatusState } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const listener = (changed: string) => {
      if (changed === patientId) setRefreshKey((k) => k + 1);
    };
    codeStatusListeners.add(listener);
    return () => {
      codeStatusListeners.delete(listener);
    };
  }, [patientId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the re-read trigger
  useEffect(() => {
    let active = true;
    loadCodeStatus(client, patientId)
      .catch((): CodeStatusState => ({ kind: "unavailable" }))
      .then((next) => {
        if (!active) return;
        setEntry((prev) => {
          if (next.kind !== "unavailable" || prev?.patientId !== patientId) {
            return { patientId, state: next };
          }
          const known = prev.state.kind === "stale" ? prev.state.last : prev.state;
          return known.kind === "set" || known.kind === "none"
            ? { patientId, state: { kind: "stale", last: known } }
            : { patientId, state: next };
        });
      });
    return () => {
      active = false;
    };
  }, [client, patientId, refreshKey]);
  return entry?.patientId === patientId ? entry.state : { kind: "unknown" };
}

function CodeStatusChip({
  state,
  patientId,
}: {
  state: CodeStatusState;
  patientId: string;
}): JSX.Element | null {
  if (state.kind === "unknown") return null;
  const stale = state.kind === "stale";
  const known = state.kind === "stale" ? state.last : state;
  const recorded = known.kind === "set" && known.recordedAt;
  const hint = [
    recorded ? `Code status recorded ${fmtDate(known.recordedAt)}` : "Open code status",
    stale ? "could not be refreshed, may be out of date" : null,
  ]
    .filter(Boolean)
    .join(" — ");
  // A value that could not be re-read is shown, but plainly marked: a write may have changed it since.
  const suffix = stale ? " (not refreshed)" : "";
  let pill: JSX.Element;
  let name: string;
  if (known.kind === "unavailable") {
    name = "Code status unavailable";
    pill = <StatusPill label={name} tone="neutral" />;
  } else if (known.kind === "none") {
    name = `Code status not recorded${suffix}`;
    pill = <StatusPill label={name} tone="warning" />;
  } else {
    name = `Code status: ${CODE_STATUS_LABEL[known.value]}${suffix}`;
    pill = (
      <StatusPill
        label={`${CODE_STATUS_LABEL[known.value]}${suffix}`}
        tone={CODE_STATUS_TONE[known.value]}
      />
    );
  }
  return (
    <Link
      to={`/patients/${patientId}?view=code-status`}
      title={hint}
      aria-label={`${name}. Open code status`}
      style={{ textDecoration: "none" }}
    >
      {pill}
    </Link>
  );
}

/** Medicare / Medicaid rows for whichever the patient has; a single "Coverage —" row when neither. */
function coverageRows(
  medicare: string | null | undefined,
  medicaid: string | null | undefined,
): { label: string; value: string }[] {
  const rows = [
    medicare ? { label: "Medicare", value: medicare } : null,
    medicaid ? { label: "Medicaid", value: medicaid } : null,
  ].filter((r): r is { label: string; value: string } => r !== null);
  return rows.length > 0 ? rows : [{ label: "Coverage", value: "—" }];
}

/** "Allergy: Penicillin" for one, "Allergies: Penicillin, Latex" for two, "Allergies: 3" beyond that. */
function allergyLabel(allergies: readonly string[]): string {
  if (allergies.length === 1) return `Allergy: ${allergies[0]}`;
  if (allergies.length === 2) return `Allergies: ${allergies.join(", ")}`;
  return `Allergies: ${allergies.length}`;
}

export function ChartBanner({
  identity,
  actions,
  nameAsHeading,
}: {
  identity: ChartIdentity;
  actions?: ReactNode;
  /** The page has no other `<h1>`, so the patient name is it. */
  nameAsHeading?: boolean;
}): JSX.Element {
  const { patient, sex, medicare } = identity;
  const age = ageYears(patient.dob);
  const loaded = useBannerExtras(
    patient.id,
    identity.medicaid === undefined && !identity.extrasPending,
  );
  const codeStatus = useCodeStatus(patient.id);
  const extras = {
    medicaid: identity.medicaid === undefined ? loaded.medicaid : identity.medicaid,
    allergies: identity.allergies === undefined ? loaded.allergies : identity.allergies,
  };
  const meta = [
    `DOB ${fmtDate(patient.dob)}${age != null ? ` (${age}y)` : ""}`,
    sex,
    `MRN: ${maskTail(patient.mrn)}`,
    // Only the coverage the patient actually has: Medicare, Medicaid, or both.
    medicare ? `Medicare: ${medicare}` : null,
    extras.medicaid ? `Medicaid: ${extras.medicaid}` : null,
  ].filter((m): m is string => Boolean(m));
  return (
    <PatientBanner
      name={
        <Link to={`/patients/${patient.id}`} style={{ color: "inherit", textDecoration: "none" }}>
          {patient.firstName} {patient.lastName}
        </Link>
      }
      chips={
        <>
          <StatusPill
            label={patientStatusLabel(patient.status)}
            tone={PATIENT_STATUS_TONE[patient.status] ?? "neutral"}
          />
          <CodeStatusChip state={codeStatus} patientId={patient.id} />
          {extras.allergies === null ? null : extras.allergies.length > 0 ? (
            <span title={extras.allergies.join(", ")}>
              <StatusPill label={allergyLabel(extras.allergies)} tone="critical" />
            </span>
          ) : (
            <StatusPill label="No allergies recorded" tone="neutral" />
          )}
        </>
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
      nameAsHeading={nameAsHeading}
    />
  );
}

/** Self-loading banner for module-owned chart tabs; a same-height placeholder while it loads. */
export function ChartPatientBanner({
  patientId,
  actions,
  nameAsHeading,
  identity: provided,
}: {
  patientId: string | undefined;
  actions?: ReactNode;
  nameAsHeading?: boolean;
  /** An identity the screen already loaded (for its rail); skips this banner's own load. */
  identity?: ChartIdentity | null;
}): JSX.Element {
  const loadedIdentity = useChartIdentity(provided === undefined ? patientId : undefined);
  const identity = provided === undefined ? loadedIdentity : provided;
  if (!identity) {
    return (
      <div
        className="wx-patient-banner"
        aria-busy="true"
        style={{ minHeight: "6.25rem", background: t.surfaceLowest }}
      />
    );
  }
  return <ChartBanner identity={identity} actions={actions} nameAsHeading={nameAsHeading} />;
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
              ...coverageRows(identity?.medicare, identity?.medicaid),
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
          <Link to={`/patients/${patientId}/care-plan`} style={{ ...TARGET_24, fontWeight: 500 }}>
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
