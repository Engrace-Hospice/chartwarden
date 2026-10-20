import {
  Button,
  CountBadge,
  FlagChip,
  Glyph,
  type GlyphName,
  InfoRows,
  Panel,
  PatientBanner,
  StatusPill,
  type StatusTone,
  ageYears,
  t,
  useApiClient,
  useDisclosureDismiss,
} from "@wardenx/ui";

// apps/web/src/modules/05-patient — the patient chart's header + Overview tab (2026-09-25 redesign,

// mockup "Patient Chart — Overview"). Every panel reads a real M5/M6/M7/M8/M12/M17/M22 endpoint;

// anything the platform does not model yet (code status, allergies, vitals) is left out rather than

// fabricated, and an empty source renders an honest empty line in its panel.

import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Link } from "react-router-dom";

import { isCareTeamRole } from "../../shell/care-team-roles";
import {
  ChartBanner,
  fmtDate,
  maskTail,
  medicareTail,
  sexLabel,
} from "../../shell/patient-context";
import { PatientIntakeSummaries, SHOWS_INTAKE_SUMMARIES } from "../../shell/prospect-summary";
import { useSession } from "../../shell/session";
import { WristbandAction } from "./wristband-action";

// The shared identity helpers now live in the shell (chart tabs span modules); re-exported so this

// module's own screens keep one import site.

export { fmtDate, maskTail, sexLabel };

export interface PatientSummary {
  id: string;

  organizationId: string;

  mrn: string;

  lastName: string;

  firstName: string;

  dob: string;

  status: string;
}

interface Demographics {
  sexAssignedAtBirth: string;

  genderIdentityCode: string | null;

  preferredLanguageCode: string | null;
}

interface Identifier {
  kind: string;

  value: string | null;

  last4: string | null;

  effectiveTo: string | null;
}

interface Address {
  kind: string;

  line1: string;

  line2: string | null;

  city: string;

  state: string | null;

  postalCode: string;

  isPrimary: boolean;

  current: boolean;
}

interface Assignment {
  id: string;

  clinicianUserId: string;

  role: string;

  assignedAt: string;

  current: boolean;

  // Resolved server-side, so a viewer without member.manage (no staff roster) still sees a name.
  displayName?: string | null;
}

interface EmergencyContact {
  id: string;

  name: string;

  relationship: string;

  phone: string;

  priority: number;
}

interface Member {
  membershipId: string;

  userId: string;

  displayName: string | null;

  email: string | null;
}

interface Problem {
  id: string;

  icd10Code: string | null;

  description: string;

  kind: string;

  status: string;

  onsetAt: string | null;
}

interface Period {
  id: string;

  sequenceNumber: number;

  effectiveAt: string | null;

  scheduledEndAt: string | null;

  status: string;
}

interface ComplianceWindow {
  id: string;

  windowKind: string;

  severity: string;

  status: string;

  mustCompleteBy: string;
}

interface Election {
  admission: { id: string; state: string; admissionAt: string | null } | null;

  periods: Period[];

  complianceWindows: ComplianceWindow[];
}

interface Encounter {
  id: string;

  encounterType: string | null;

  discipline: string | null;

  serviceDate: string;

  status: string | null;

  authoredByUserId: string;

  signedAt: string | null;
}

interface Visit {
  id: string;

  assignedMembershipId: string;

  visitPurpose: string | null;

  scheduledStartedAt: string;

  status: string | null;
}

interface DocumentItem {
  id: string;

  title: string;

  aggregateType: string;

  metadata: Record<string, unknown> | null;

  createdAt: string;
}

interface MedicationOrder {
  id: string;

  drugName: string;

  strength: string;

  route: string;

  status: string | null;
}

interface PrivacyFlags {
  flags: string[];

  sudRestricted: boolean;
}

/** Everything the chart header, Overview and Clinical tabs read. `undefined` = still loading/failed. */

export interface PatientChartData {
  demographics?: Demographics | null;

  identifiers?: Identifier[];

  addresses?: Address[];

  careTeam?: {
    assignments: Assignment[];

    emergencyContacts: EmergencyContact[];
  };

  members?: Map<string, Member>;

  problems?: Problem[];

  election?: Election | null;

  encounters?: Encounter[];

  visits?: Visit[];

  documents?: DocumentItem[];

  medications?: MedicationOrder[];

  privacy?: PrivacyFlags | null;
}

type Client = ReturnType<typeof useApiClient>;

async function settle<T>(p: Promise<{ data?: unknown; error?: unknown }>): Promise<T | undefined> {
  try {
    const r = await p;

    return r.error ? undefined : (r.data as T);
  } catch {
    return undefined;
  }
}

/** Fetch every chart source in parallel; each lands independently so one failure never blanks the page. */

export function usePatientChartData(patient: PatientSummary, refreshKey = 0): PatientChartData {
  const client: Client = useApiClient();

  // The staff roster read is gated by `member.manage`; without it the request only 403s.
  const canListMembers = useSession()?.permissions?.includes("member.manage") ?? false;

  const [data, setData] = useState<PatientChartData>({});

  const alive = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey re-runs the load after a write; it is a trigger, not read in the body.
  useEffect(() => {
    alive.current = true;

    const id = patient.id;

    const merge = (patch: PatientChartData): void => {
      if (alive.current) setData((d) => ({ ...d, ...patch }));
    };

    const today = new Date().toISOString().slice(0, 10);

    void settle<Demographics>(
      client.GET("/api/v1/patients/{id}/demographics", {
        params: { path: { id } },
      }),
    ).then((demographics) => merge({ demographics: demographics ?? null }));

    void settle<{ identifiers: Identifier[] }>(
      client.GET("/api/v1/patients/{id}/identifiers", {
        params: { path: { id } },
      }),
    ).then((r) => merge({ identifiers: r?.identifiers ?? [] }));

    void settle<{ addresses: Address[] }>(
      client.GET("/api/v1/patients/{id}/addresses", {
        params: { path: { id } },
      }),
    ).then((r) => merge({ addresses: r?.addresses ?? [] }));

    void settle<{
      assignments: Assignment[];

      emergencyContacts: EmergencyContact[];
    }>(
      client.GET("/api/v1/patients/{id}/care-team", {
        params: { path: { id } },
      }),
    ).then((r) =>
      merge({
        careTeam: {
          assignments: (r?.assignments ?? []).filter((a) => a.current && isCareTeamRole(a.role)),

          emergencyContacts: r?.emergencyContacts ?? [],
        },
      }),
    );

    if (canListMembers) {
      void settle<{ members: Member[] }>(
        client.GET("/api/v1/orgs/{id}/members", {
          params: { path: { id: patient.organizationId }, query: {} },
        }),
      ).then((r) => {
        const map = new Map<string, Member>();

        for (const m of r?.members ?? []) {
          map.set(m.userId, m);

          map.set(m.membershipId, m);
        }

        merge({ members: map });
      });
    }

    void settle<{ problems?: Problem[] }>(
      client.GET("/api/v1/patients/{patientId}/care-plan", {
        params: { path: { patientId: id } },
      }),
    ).then((r) =>
      merge({
        problems: (r?.problems ?? []).filter((p) => p.status === "active"),
      }),
    );

    void settle<Election>(
      client.GET("/api/v1/patients/{patientId}/election-certification", {
        params: { path: { patientId: id } },
      }),
    ).then((r) => merge({ election: r ?? null }));

    void settle<{ encounters: Encounter[] }>(
      client.GET("/api/v1/encounters", {
        params: { query: { patientId: id, limit: 6 } },
      }),
    ).then((r) => merge({ encounters: r?.encounters ?? [] }));

    void settle<Visit[]>(
      client.GET("/api/v1/visits", {
        params: { query: { patient: id, from: today } },
      }),
    ).then((r) =>
      merge({
        visits: (Array.isArray(r) ? r : [])

          .filter((v) => v.status !== "cancelled")

          .sort((a, b) => a.scheduledStartedAt.localeCompare(b.scheduledStartedAt))

          .slice(0, 4),
      }),
    );

    void settle<{ items: DocumentItem[] }>(
      client.GET("/api/v1/documents", {
        params: { query: { patientId: id, limit: 5 } },
      }),
    ).then((r) => merge({ documents: r?.items ?? [] }));

    void settle<{ orders: MedicationOrder[] }>(
      client.GET("/api/v1/patients/{patientId}/medications/active", {
        params: { path: { patientId: id } },
      }),
    ).then((r) => merge({ medications: r?.orders ?? [] }));

    void settle<PrivacyFlags>(
      client.GET("/api/v1/patients/{id}/privacy-flags", {
        params: { path: { id } },
      }),
    ).then((r) => merge({ privacy: r ?? null }));

    return () => {
      alive.current = false;
    };
  }, [client, patient.id, patient.organizationId, refreshKey, canListMembers]);

  return data;
}

// ---------- formatting ----------

export function fmtTime(iso: string): string {
  const d = new Date(iso);

  let h = d.getHours();

  const ampm = h >= 12 ? "PM" : "AM";

  h = h % 12 || 12;

  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ROLE_LABELS: Record<string, string> = {
  primary_rn: "Primary Nurse",

  attending_clinician: "Attending Physician",

  case_manager_msw: "Social Worker",

  chaplain: "Chaplain",

  aide: "Hospice Aide",

  np: "Nurse Practitioner",

  md: "Medical Director",

  volunteer: "Volunteer",

  bereavement: "Bereavement Coordinator",
};

export const roleLabel = (r: string): string => ROLE_LABELS[r] ?? titleCase(r);

function initialsOf(name: string): string {
  const parts = name.split(/[\s,._@-]+/).filter(Boolean);

  if (parts.length === 0) return "?";

  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();

  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

// Deterministic avatar tint per person — the mockups give each care-team member a soft color.

const AVATAR_TINTS = [
  "var(--color-viz-green)",

  "var(--color-viz-blue)",

  "var(--color-viz-violet)",

  "var(--color-viz-amber)",

  "var(--color-viz-cyan)",

  "var(--color-viz-pink)",
];

function avatarTint(seed: string): string {
  let h = 0;

  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;

  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}

export function Avatar({
  name,

  size = 2.25,
}: {
  name: string;

  size?: number;
}): JSX.Element {
  const c = avatarTint(name);

  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",

        alignItems: "center",

        justifyContent: "center",

        flexShrink: 0,

        width: `${size}rem`,

        height: `${size}rem`,

        borderRadius: "9999px",

        background: `color-mix(in srgb, ${c} 14%, ${t.surfaceLowest})`,

        color: c,

        fontSize: `${size * 0.36}rem`,

        fontWeight: 700,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function memberName(data: PatientChartData, id: string): string | null {
  const m = data.members?.get(id);

  const assigned = data.careTeam?.assignments.find((a) => a.clinicianUserId === id)?.displayName;

  return m?.displayName ?? assigned ?? m?.email ?? null;
}

function currentAddress(addresses: Address[] | undefined): Address | null {
  const list = (addresses ?? []).filter((a) => a.current);

  return list.find((a) => a.isPrimary) ?? list.find((a) => a.kind === "home") ?? list[0] ?? null;
}

function mbi(identifiers: Identifier[] | undefined): Identifier | null {
  return (
    (identifiers ?? []).find((i) => i.kind === "mbi" && !i.effectiveTo) ??
    (identifiers ?? []).find((i) => i.kind === "mbi") ??
    null
  );
}

export function activePeriod(election: Election | null | undefined): Period | null {
  const periods = election?.periods ?? [];

  return (
    periods.find((p) => p.status === "active") ??
    [...periods].sort((a, b) => b.sequenceNumber - a.sequenceNumber)[0] ??
    null
  );
}

function periodDay(p: Period): string | null {
  if (!p.effectiveAt) return null;

  const start = new Date(p.effectiveAt).getTime();

  const end = p.scheduledEndAt ? new Date(p.scheduledEndAt).getTime() : null;

  const day = Math.floor((Date.now() - start) / 86_400_000) + 1;

  if (day < 1) return null;

  const total = end ? Math.round((end - start) / 86_400_000) : null;

  return total ? `Day ${Math.min(day, total)} of ${total}` : `Day ${day}`;
}

// ---------- shared bits ----------

const muted = { color: t.onSurfaceVariant, fontSize: "0.8125rem" } as const;

export function EmptyLine({ children }: { children: ReactNode }): JSX.Element {
  return <p style={{ ...muted, margin: "0.25rem 0 0.5rem" }}>{children}</p>;
}

export function Loading(): JSX.Element {
  return <EmptyLine>Loading…</EmptyLine>;
}

export function PanelLink({
  to,

  children,

  arrow = false,
}: {
  to: string;

  children: ReactNode;

  arrow?: boolean;
}): JSX.Element {
  return (
    <Link
      to={to}
      style={{
        display: "inline-flex",

        alignItems: "center",

        gap: "0.3rem",

        fontWeight: 500,
      }}
    >
      {children}

      {arrow ? <Glyph name="arrow-right" size={14} /> : null}
    </Link>
  );
}

// ---------- header ----------

export function PatientChartHeader({
  patient,

  data,
}: {
  patient: PatientSummary;

  data: PatientChartData;
}): JSX.Element {
  return (
    <ChartBanner
      identity={{
        patient,

        sex: sexLabel(data.demographics?.sexAssignedAtBirth),

        medicare: medicareTail(data.identifiers),
      }}
      actions={
        <>
          <WristbandAction patientId={patient.id} />
          <ChartActions patientId={patient.id} admission={data.election?.admission ?? null} />
        </>
      }
    />
  );
}

/** "Actions ▾" menu + the primary "Start Visit" (opens the patient's visit documentation). */

function ChartActions({
  patientId,

  admission,
}: {
  patientId: string;

  admission: Election["admission"];
}): JSX.Element {
  const [open, setOpen] = useState(false);

  const ref = useRef<HTMLDivElement>(null);

  // The kit Button does not forward a ref, so Escape finds the trigger inside the container to hand focus back to it.
  const triggerRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return ref.current?.querySelector("button") ?? null;
      },
    }),
    [],
  );

  useDisclosureDismiss(open, () => setOpen(false), ref, triggerRef);

  const hopeAvailable = admission?.state === "active";

  const items: {
    label: string;

    to: string;

    disabled?: boolean;

    hint?: string;
  }[] = [
    ...(admission
      ? [
          {
            label: "View admission",

            to: `/admissions/${admission.id}`,
          },

          {
            label: "HOPE",

            to: `/admissions/${admission.id}/hope`,

            disabled: !hopeAvailable,

            hint: "Activate this patient's admission before accessing HOPE.",
          },
        ]
      : []),

    {
      label: "Demographics & identifiers",

      to: `/patients/${patientId}?view=demographics`,
    },

    { label: "Addresses", to: `/patients/${patientId}?view=addresses` },

    { label: "Coverage / payers", to: `/patients/${patientId}?view=coverage` },

    {
      label: "Care team & assignments",

      to: `/patients/${patientId}?view=care-team`,
    },

    { label: "Privacy flags", to: `/patients/${patientId}?view=privacy` },

    {
      label: "Election & certification",

      to: `/patients/${patientId}/election-certification`,
    },

    {
      label: "HOPE assessments",

      to: `/patients/${patientId}/hope`,

      disabled: !hopeAvailable,

      hint: "Activate this patient's admission before accessing HOPE.",
    },

    {
      label: "Discipline plans",

      to: `/patients/${patientId}/discipline-plans`,
    },

    { label: "Message care team", to: "/messaging" },
  ];

  return (
    <>
      <div ref={ref} style={{ position: "relative" }}>
        <Button tone="secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Actions
          <Glyph name="chevron-down" size={16} />
        </Button>

        {open ? (
          <div className="wx-actor-menu" style={{ minWidth: "15rem" }}>
            {items.map((it) =>
              it.disabled ? (
                <span
                  key={it.to}
                  aria-disabled="true"
                  className="wx-actor-menu-item"
                  title={it.hint}
                  style={{ opacity: 0.5, cursor: "not-allowed" }}
                >
                  {it.label} — {it.hint}
                </span>
              ) : (
                <Link
                  key={it.to}
                  to={it.to}
                  className="wx-actor-menu-item"
                  onClick={() => setOpen(false)}
                >
                  {it.label}
                </Link>
              ),
            )}
          </div>
        ) : null}
      </div>

      <Link to={`/patients/${patientId}/encounters`} className="wx-btn-primary">
        Start Visit
      </Link>
    </>
  );
}

// ---------- Overview tab ----------

export function OverviewTab({
  patient,

  data,
}: {
  patient: PatientSummary;

  data: PatientChartData;
}): JSX.Element {
  return (
    // A 24-column grid so the three rows keep the mockup's unequal splits (9/8/7 · 13/11 · 13/11).

    <div className="wx-overview-grid">
      <PatientInfoPanel patient={patient} data={data} className="wx-c9" />

      <ClinicalSnapshotPanel data={data} className="wx-c8" />

      <CareTeamPanel patientId={patient.id} data={data} className="wx-c7" />

      <DiagnosesPanel patientId={patient.id} data={data} className="wx-c13" />

      <RecentActivityPanel patientId={patient.id} data={data} className="wx-c11" />

      <UpcomingVisitsPanel patientId={patient.id} data={data} className="wx-c13" />

      <DocumentsPanel patientId={patient.id} data={data} className="wx-c11" />
      {SHOWS_INTAKE_SUMMARIES.has(patient.status) ? (
        <PatientIntakeSummaries patientId={patient.id} className="wx-c24" />
      ) : null}
    </div>
  );
}

function PatientInfoPanel({
  patient,

  data,

  className,
}: {
  patient: PatientSummary;

  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const age = ageYears(patient.dob);

  const addr = currentAddress(data.addresses);

  const medicare = mbi(data.identifiers);

  const phone = data.careTeam?.emergencyContacts
    ? [...data.careTeam.emergencyContacts].sort((a, b) => a.priority - b.priority)[0]
    : undefined;

  return (
    <Panel
      title="Patient Information"
      icon="user"
      className={className}
      action={
        <PanelLink to={`/patients/${patient.id}?view=demographics`}>
          Edit <Glyph name="pencil" size={13} />
        </PanelLink>
      }
    >
      <InfoRows
        labelWidth="8.5rem"
        rows={[
          {
            label: "Full name",

            value: `${patient.firstName} ${patient.lastName}`,
          },

          {
            label: "Date of birth",

            value: `${fmtDate(patient.dob)}${age != null ? ` (${age}y)` : ""}`,
          },

          {
            label: "Gender",

            value:
              data.demographics === undefined
                ? "…"
                : (sexLabel(data.demographics?.sexAssignedAtBirth) ?? "—"),
          },

          {
            label: "MRN",

            value: <span className="wx-nums">{maskTail(patient.mrn)}</span>,
          },

          {
            label: "Medicare #",

            value: (
              <span className="wx-nums">
                {medicare ? maskTail(medicare.value, medicare.last4) : "—"}
              </span>
            ),
          },

          {
            label: "Emergency contact",

            value: phone ? (
              <>
                {phone.name}

                <div style={muted}>
                  {titleCase(phone.relationship)} · {phone.phone}
                </div>
              </>
            ) : (
              "—"
            ),
          },

          {
            label: "Address",

            value: addr ? (
              <>
                {addr.line1}
                {addr.line2 ? `, ${addr.line2}` : ""},
                <br />
                {addr.city}
                {addr.state ? `, ${addr.state}` : ""} {addr.postalCode}
              </>
            ) : (
              "—"
            ),
          },
        ]}
      />
    </Panel>
  );
}

function ClinicalSnapshotPanel({
  data,

  className,
}: {
  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const terminal = data.problems?.find((p) => p.kind === "terminal") ?? data.problems?.[0] ?? null;

  const period = activePeriod(data.election);

  const attending = data.careTeam?.assignments.find((a) => a.role === "attending_clinician");

  const md = data.careTeam?.assignments.find((a) => a.role === "md");

  const flags = data.privacy?.flags ?? [];

  return (
    <Panel title="Clinical Snapshot" icon="clipboard-check" className={className}>
      <div
        style={{
          display: "flex",

          flexWrap: "wrap",

          gap: "0.5rem",

          margin: "0.125rem 0 0.875rem",
        }}
      >
        {period ? (
          <FlagChip
            tone={period.status === "active" ? "success" : "neutral"}
            label={`Benefit period ${period.sequenceNumber}`}
          />
        ) : null}

        {data.privacy?.sudRestricted ? (
          <FlagChip tone="danger" icon="lock" label="42 CFR Part 2" />
        ) : null}

        {flags.length > 0 ? (
          <FlagChip
            tone="warning"
            icon="shield"
            label={`${flags.length} privacy flag${flags.length === 1 ? "" : "s"}`}
          />
        ) : null}

        {data.privacy && flags.length === 0 && !period ? (
          <FlagChip label="No privacy restrictions" />
        ) : null}
      </div>

      <InfoRows
        labelWidth="9rem"
        rows={[
          {
            label: "Primary diagnosis",

            value: terminal ? (terminal.icd10Code ?? "—") : data.problems ? "Not recorded" : "…",

            hint: terminal?.description,
          },

          {
            label: "Admission date",

            value: fmtDate(data.election?.admission?.admissionAt ?? null),
          },

          {
            label: "Benefit period",

            value: period
              ? `${period.sequenceNumber}${periodDay(period) ? ` (${periodDay(period)})` : ""}`
              : "—",
          },

          {
            label: "Admission status",

            value: data.election?.admission ? (
              <Link
                to={`/admissions/${data.election.admission.id}`}
                style={{
                  color: "var(--color-primary)",

                  fontWeight: 650,

                  textDecoration: "none",
                }}
              >
                {titleCase(data.election.admission.state)} →
              </Link>
            ) : (
              "—"
            ),
          },

          {
            label: "Attending physician",

            value: attending ? (memberName(data, attending.clinicianUserId) ?? "Assigned") : "—",
          },

          {
            label: "Medical director",

            value: md ? (memberName(data, md.clinicianUserId) ?? "Assigned") : "—",
          },
        ]}
      />
    </Panel>
  );
}

function CareTeamPanel({
  patientId,

  data,

  className,
}: {
  patientId: string;

  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const team = data.careTeam?.assignments;

  return (
    <Panel
      title="Care Team"
      icon="users"
      className={className}
      action={<PanelLink to={`/patients/${patientId}?view=care-team`}>Manage</PanelLink>}
    >
      {team === undefined ? (
        <Loading />
      ) : team.length === 0 ? (
        <EmptyLine>No clinicians assigned yet.</EmptyLine>
      ) : (
        <ul
          style={{
            listStyle: "none",

            margin: 0,

            padding: 0,

            display: "flex",

            flexDirection: "column",

            gap: "0.75rem",
          }}
        >
          {team.map((a) => {
            const m = data.members?.get(a.clinicianUserId);

            // The staff roster needs member.manage, which most clinicians lack — without a name the

            // row leads with the role and says when it was assigned, never a placeholder name.

            const name = m?.displayName ?? a.displayName ?? m?.email ?? null;

            return (
              <li
                key={a.id}
                style={{
                  display: "flex",

                  alignItems: "center",

                  gap: "0.75rem",
                }}
              >
                <Avatar name={name ?? roleLabel(a.role)} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "0.875rem",

                      fontWeight: 600,

                      color: t.onSurface,
                    }}
                  >
                    {name ?? roleLabel(a.role)}
                  </div>

                  <div style={muted}>
                    {name ? roleLabel(a.role) : `Assigned ${fmtDate(a.assignedAt)}`}
                  </div>
                </div>

                <span style={{ display: "flex", gap: "0.625rem", color: t.primary }}>
                  {m?.email ? (
                    <a href={`mailto:${m.email}`} aria-label={`Email ${name ?? roleLabel(a.role)}`}>
                      <Glyph name="mail" size={16} strokeWidth={1.75} />
                    </a>
                  ) : null}

                  <Link to="/messaging" aria-label={`Message ${name ?? roleLabel(a.role)}`}>
                    <Glyph name="message-square" size={16} strokeWidth={1.75} />
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function DiagnosesPanel({
  patientId,

  data,

  className,
}: {
  patientId: string;

  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const problems = data.problems;

  return (
    <Panel
      title="Active Diagnoses"
      icon="stethoscope"
      flush
      className={className}
      action={
        <PanelLink to={`/patients/${patientId}/care-plan`} arrow>
          View all
        </PanelLink>
      }
    >
      {problems === undefined ? (
        <div style={{ padding: "0 1.125rem" }}>
          <Loading />
        </div>
      ) : problems.length === 0 ? (
        <div style={{ padding: "0 1.125rem 0.75rem" }}>
          <EmptyLine>No active diagnoses on the plan of care.</EmptyLine>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>

              <th>Description</th>

              <th>Type</th>

              <th>Onset</th>

              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            {problems.slice(0, 5).map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 600 }}>{p.icd10Code ?? "—"}</td>

                <td>{p.description}</td>

                <td>
                  <span
                    style={{
                      display: "inline-flex",

                      alignItems: "center",

                      gap: "0.4rem",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 7,

                        height: 7,

                        borderRadius: 9999,

                        background:
                          p.kind === "terminal"
                            ? t.success
                            : p.kind === "related"
                              ? t.accent
                              : t.outline,
                      }}
                    />

                    {p.kind === "terminal" ? "Primary" : titleCase(p.kind)}
                  </span>
                </td>

                <td className="wx-nums">{p.onsetAt ? p.onsetAt.slice(0, 10) : "—"}</td>

                <td>
                  <StatusPill label="Active" tone="success" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

const ENCOUNTER_ICON: Record<string, GlyphName> = {
  routine: "stethoscope",

  admission: "user-plus",

  prn: "zap",

  recert: "file-check",

  idg: "grid-circles",
};

function RecentActivityPanel({
  patientId,

  data,

  className,
}: {
  patientId: string;

  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const list = data.encounters
    ? [...data.encounters]

        .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate))

        .slice(0, 5)
    : undefined;

  return (
    <Panel
      title="Recent Activity"
      icon="file-text"
      className={className}
      action={<PanelLink to={`/patients/${patientId}/encounters`}>View all</PanelLink>}
    >
      {list === undefined ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyLine>No documented visits yet.</EmptyLine>
      ) : (
        <ol className="wx-timeline">
          {list.map((e) => {
            const who = memberName(data, e.authoredByUserId);

            const what = [
              e.discipline?.toUpperCase(),

              e.encounterType ? titleCase(e.encounterType) : "Visit",
            ]

              .filter(Boolean)

              .join(" ");

            return (
              <li key={e.id}>
                <span className="wx-timeline-date wx-nums">{fmtDate(e.serviceDate)}</span>

                <span className="wx-timeline-icon">
                  <Glyph name={ENCOUNTER_ICON[e.encounterType ?? ""] ?? "file-text"} size={15} />
                </span>

                <Link to={`/patients/${patientId}/encounters/${e.id}`} className="wx-timeline-text">
                  {what} {e.signedAt ? "signed" : "documented"}
                  {who ? <span style={muted}> by {who}</span> : null}
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function visitTone(status: string | null): StatusTone {
  if (status === "completed") return "success";

  if (status === "in_progress" || status === "arrived") return "progress";

  if (status === "no_show" || status === "missed") return "error";

  if (status === "scheduled" || status === "confirmed") return "progress";

  return "neutral";
}

function UpcomingVisitsPanel({
  patientId,

  data,

  className,
}: {
  patientId: string;

  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const visits = data.visits;

  return (
    <Panel
      title="Upcoming Visits"
      icon="calendar"
      flush
      className={className}
      action={
        <Link
          to={`/calendar?patient=${encodeURIComponent(patientId)}&newVisit=1`}
          className="wx-btn-primary wx-btn-sm"
        >
          <Glyph name="plus" size={14} /> Schedule Visit
        </Link>
      }
    >
      {visits === undefined ? (
        <div style={{ padding: "0 1.125rem" }}>
          <Loading />
        </div>
      ) : visits.length === 0 ? (
        <div style={{ padding: "0 1.125rem 0.75rem" }}>
          <EmptyLine>No visits scheduled from today.</EmptyLine>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>

              <th>Time</th>

              <th>Type</th>

              <th>Staff</th>

              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            {visits.map((v) => (
              <tr key={v.id}>
                <td className="wx-nums">{fmtDate(v.scheduledStartedAt)}</td>

                <td className="wx-nums">{fmtTime(v.scheduledStartedAt)}</td>

                <td>{v.visitPurpose ? titleCase(v.visitPurpose) : "Visit"}</td>

                <td>{memberName(data, v.assignedMembershipId) ?? "Unassigned"}</td>

                <td>
                  <StatusPill
                    label={titleCase(v.status ?? "scheduled")}
                    tone={visitTone(v.status)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function DocumentsPanel({
  patientId,

  data,

  className,
}: {
  patientId: string;

  data: PatientChartData;

  className?: string;
}): JSX.Element {
  const docs = data.documents;

  return (
    <Panel
      title="Documents"
      icon="file-text"
      flush
      className={className}
      action={<PanelLink to={`/patients/${patientId}/documents`}>View all</PanelLink>}
    >
      {docs === undefined ? (
        <div style={{ padding: "0 1.125rem" }}>
          <Loading />
        </div>
      ) : docs.length === 0 ? (
        <div style={{ padding: "0 1.125rem 0.75rem" }}>
          <EmptyLine>No documents filed for this patient.</EmptyLine>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>

              <th>Category</th>

              <th>Date</th>
            </tr>
          </thead>

          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  <span
                    style={{
                      display: "inline-flex",

                      alignItems: "center",

                      gap: "0.5rem",
                    }}
                  >
                    <span style={{ color: t.error }}>
                      <Glyph name="file-text" size={15} />
                    </span>

                    {d.title}
                  </span>
                </td>

                <td>{titleCase(d.aggregateType)}</td>

                <td className="wx-nums">{fmtDate(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------- right rail ----------

const WINDOW_LABEL: Record<string, string> = {
  noe: "Notice of Election",

  notr: "Notice of Termination/Revocation",

  f2f: "Face-to-face encounter",

  cti: "Certification of terminal illness",

  hope: "HOPE assessment",

  recert: "Recertification",
};

export function OverviewRail({
  patientId,

  data,
}: {
  patientId: string;

  data: PatientChartData;
}): JSX.Element {
  const windows = (data.election?.complianceWindows ?? []).filter((w) => w.status === "open");

  const flags = data.privacy?.flags ?? [];

  const alertCount = windows.length + (data.privacy?.sudRestricted ? 1 : 0);
  // A privacy officer (`privacy.admin`, M5 §5.1) lands on the officer view; everyone else on the chart tab.
  const session = useSession();
  const privacyTo = session?.permissions?.includes("privacy.admin")
    ? `/patients/${patientId}/privacy`
    : `/patients/${patientId}?view=privacy`;
  const links: { label: string; icon: GlyphName; to: string }[] = [
    {
      label: "Election & Certification",

      icon: "file-check",

      to: `/patients/${patientId}/election-certification`,
    },

    {
      label: "Schedule Visit",

      icon: "calendar",

      to: `/calendar?patient=${encodeURIComponent(patientId)}&newVisit=1`,
    },

    {
      label: "Create Order",

      icon: "clipboard-list",

      to: `/patients/${patientId}/orders`,
    },

    {
      label: "Medication Reconciliation",

      icon: "pill",

      to: `/patients/${patientId}/medications`,
    },

    {
      label: "View Plan of Care",

      icon: "users",

      to: `/patients/${patientId}/care-plan`,
    },

    {
      label: "Upload Document",

      icon: "upload",

      to: `/patients/${patientId}/documents`,
    },

    { label: "Send Message", icon: "message-square", to: "/messaging" },

    {
      label: "Coverage / Payers",

      icon: "shield-check",

      to: `/patients/${patientId}?view=coverage`,
    },
  ];

  return (
    <>
      <Panel
        title={
          <span
            style={{
              display: "inline-flex",

              alignItems: "center",

              gap: "0.5rem",
            }}
          >
            Alerts & Safety {alertCount > 0 ? <CountBadge count={alertCount} /> : null}
          </span>
        }
        icon="alert"
        tone={alertCount > 0 ? "danger" : "default"}
        flush
      >
        {data.election === undefined || data.privacy === undefined ? (
          <div style={{ padding: "0 1.125rem" }}>
            <Loading />
          </div>
        ) : alertCount === 0 && flags.length === 0 ? (
          <div style={{ padding: "0 1.125rem 0.75rem" }}>
            <EmptyLine>No open compliance deadlines or safety flags.</EmptyLine>
          </div>
        ) : (
          <ul className="wx-rail-list">
            {windows.map((w) => (
              <li key={w.id}>
                <RailAlert
                  tone={w.severity === "critical" || w.severity === "high" ? "danger" : "warning"}
                  title={WINDOW_LABEL[w.windowKind] ?? titleCase(w.windowKind)}
                  detail={`Due ${fmtDate(w.mustCompleteBy)}`}
                  to={`/patients/${patientId}/election-certification`}
                />
              </li>
            ))}

            {data.privacy?.sudRestricted ? (
              <li>
                <RailAlert
                  tone="danger"
                  title="42 CFR Part 2 restricted"
                  detail="Substance-use records need consent to disclose"
                  to={privacyTo}
                />
              </li>
            ) : null}

            {flags.length > 0 ? (
              <li>
                <RailAlert
                  tone="neutral"
                  title={`${flags.length} privacy flag${flags.length === 1 ? "" : "s"}`}
                  detail="Sensitive categories on file"
                  to={privacyTo}
                />
              </li>
            ) : null}
          </ul>
        )}
      </Panel>

      <Panel title="Quick Links" icon="link" flush>
        <ul className="wx-rail-links">
          {links.map((l) => (
            <li key={l.label}>
              <Link to={l.to}>
                <span style={{ color: t.primary }}>
                  <Glyph name={l.icon} size={17} strokeWidth={1.75} />
                </span>

                <span style={{ flex: 1 }}>{l.label}</span>

                <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

export function RailAlert({
  tone,

  title,

  detail,

  to,
}: {
  tone: "danger" | "warning" | "neutral";

  title: string;

  detail: string;

  to: string;
}): JSX.Element {
  const color = tone === "danger" ? t.error : tone === "warning" ? t.warning : t.onSurfaceVariant;

  return (
    <Link to={to} className="wx-rail-alert">
      <span
        aria-hidden
        style={{
          display: "inline-flex",

          alignItems: "center",

          justifyContent: "center",

          width: "2rem",

          height: "2rem",

          borderRadius: "9999px",

          background: `color-mix(in srgb, ${color} 14%, ${t.surfaceLowest})`,

          color,

          flexShrink: 0,
        }}
      >
        <Glyph name={tone === "neutral" ? "shield" : "alert-circle"} size={16} />
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",

            fontWeight: 600,

            fontSize: "0.875rem",

            color: tone === "neutral" ? t.onSurface : color,
          }}
        >
          {title}
        </span>

        <span style={{ display: "block", ...muted }}>{detail}</span>
      </span>

      <Glyph name="chevron-right" size={16} strokeWidth={1.75} />
    </Link>
  );
}
