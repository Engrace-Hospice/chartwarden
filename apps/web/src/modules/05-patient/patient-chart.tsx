import {
  Button,
  CenteredStatusLayout,
  LoadingSpinner,
  MaskedIdentifier,
  Modal,
  PatientBanner,
  PatientWorkspaceLayout,
  type ReadStatus,
  SealedBlock,
  StatusPill,
  type StatusTone,
  ageYears,
  cardSurface,
  formatDateOnly,
  humanizeIdentifier,
  settleRead,
  useApiClient,
  useReloadFocus,
  useToast,
} from "@chartwarden/ui";

import type { paths } from "@chartwarden/ui";

// apps/web/src/modules/05-patient — Patient Chart (M5, Track A).

// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_PATIENT_CHART.md — "Use Patient Workspace."

// The patient-scoped hub: sticky Patient Banner + a module nav rail + a center summary. This builds

// the M5 FRAME (banner + summary) plus the M5-owned Demographics & Identifiers tab (FB-T06); the

// cross-module tabs (Encounters, Orders, eMAR, …) graft on as those modules land (Track B). Backed by

// GET /api/v1/patients/:id (+ /demographics, /identifiers) via the typed client.

import { useCallback, useEffect, useRef, useState } from "react";

import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import type { FormEvent, JSX, ReactNode } from "react";

import { STATUS_TONE, statusLabel } from "./patient-status";

import { ClinicalRail, ClinicalTab, ReadNotice, useClinicalData } from "./patient-clinical";
import {
  Avatar,
  OverviewRail,
  OverviewTab,
  PatientChartHeader,
  usePatientChartData,
} from "./patient-overview";

import { isCareTeamRole } from "../../shell/care-team-roles";
import { ChartModuleRail, type ChartSection } from "../../shell/chart-module-rail";
import { CareTeamStaffLookupField } from "../../shell/entity-lookups";
import { useOpenPatientConversation } from "../../shell/open-patient-conversation";
import { useSession } from "../../shell/session";

interface PatientSummary {
  id: string;

  organizationId: string;

  mrn: string;

  lastName: string;

  firstName: string;

  dob: string;

  status: string;
}

// Module-nav-rail icons. The P0 frame (chartwarden-P0-foundation.pen `fQjjh`) pairs every rail row with a

// Material-Symbols glyph; the shared @chartwarden/ui Glyph kit is a small curated set without these

// per-module icons, so this is a module-local 24×24 stroke set mirroring the frame's intent. Nav

// chrome only — clinical-state glyphs still come from the canonical kit.

// Module nav rail (spec). Three kinds of row:

//  • `ready: true`  — an M5-owned tab rendered INLINE here via setSection.

//  • `route`        — a cross-module tab whose patient-scoped workspace screen exists on its own route

//                     (M7 Care Plan, M8 Encounters, M11 Orders); the row LINKS there.

//  • neither        — a placeholder greyed until its module's patient surface lands (Track B).

export function PatientChart(): JSX.Element {
  const client = useApiClient();

  const { id } = useParams<{ id: string }>();

  const [searchParams] = useSearchParams();

  const rawView = searchParams.get("view");

  const currentSection: ChartSection =
    rawView === "demographics"
      ? "demographics"
      : rawView === "addresses"
        ? "addresses"
        : rawView === "coverage"
          ? "coverage"
          : rawView === "care-team"
            ? "care-team"
            : rawView === "privacy"
              ? "privacy"
              : rawView === "clinical"
                ? "clinical"
                : "summary";

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "notfound" }
    | { kind: "error" }
    | { kind: "ready"; patient: PatientSummary }
  >({ kind: "loading" });

  const updatePatient = useCallback((patch: Partial<PatientSummary>) => {
    setState((current) =>
      current.kind === "ready"
        ? {
            kind: "ready",
            patient: { ...current.patient, ...patch },
          }
        : current,
    );
  }, []);

  const refreshPatient = useCallback(async (): Promise<void> => {
    if (!id) return;

    const { data, error } = await client.GET("/api/v1/patients/{id}", {
      params: { path: { id } },
    });

    // A background refresh after a successful edit must never replace an
    // already-usable chart with an error state. The edit surface keeps the
    // optimistic values and the next normal chart load can retry.
    if (error || !data) return;

    setState({ kind: "ready", patient: data as PatientSummary });
  }, [client, id]);

  useEffect(() => {
    let active = true;

    (async () => {
      if (!id) return;

      const { data, error, response } = await client.GET("/api/v1/patients/{id}", {
        params: { path: { id } },
      });

      if (!active) return;

      if (response?.status === 404) return setState({ kind: "notfound" });

      if (error || !data) return setState({ kind: "error" });

      setState({ kind: "ready", patient: data as PatientSummary });
    })();

    return () => {
      active = false;
    };
  }, [client, id]);

  if (state.kind === "loading") return <LoadingSpinner />;

  if (state.kind === "notfound") {
    return (
      <CenteredStatusLayout
        headline="Patient not found"
        explanation="This patient does not exist or is outside your access."
      />
    );
  }

  if (state.kind === "error") {
    return (
      <CenteredStatusLayout
        headline="Unavailable"
        explanation="The patient chart could not be loaded."
      />
    );
  }

  return (
    <PatientChartReady
      key={state.patient.id}
      patient={state.patient}
      section={currentSection}
      updatePatient={updatePatient}
      refreshPatient={refreshPatient}
    />
  );
}

/** The loaded chart: redesigned header + tab strip, the Overview (with its right rail) or a record sub-view. */
function PatientChartReady({
  patient: p,
  section,
  updatePatient,
  refreshPatient,
}: {
  patient: PatientSummary;
  section: ChartSection;
  updatePatient: (patch: Partial<PatientSummary>) => void;
  refreshPatient: () => Promise<void>;
}): JSX.Element {
  const [chartRevision, setChartRevision] = useState(0);
  const data = usePatientChartData(p, chartRevision);
  const clinical = useClinicalData(p.id, data, section === "clinical");

  const handleDemographicsSaved = useCallback(
    (next: Demographics) => {
      // Update the banner immediately, then reconcile with the canonical
      // patient read and refresh the shared chart sources in the background.
      updatePatient({
        firstName: next.legalFirstName,
        lastName: next.legalLastName,
        dob: next.dob,
        mrn: next.mrn,
        status: next.status,
      });
      setChartRevision((revision) => revision + 1);
      void refreshPatient();
    },
    [refreshPatient, updatePatient],
  );

  return (
    <PatientWorkspaceLayout
      banner={<PatientChartHeader patient={p} data={data} />}
      rail={
        section === "summary" ? (
          <OverviewRail patientId={p.id} data={data} />
        ) : section === "clinical" ? (
          <ClinicalRail patient={p} data={data} clinical={clinical} />
        ) : undefined
      }
    >
      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <ChartModuleRail patientId={p.id} current={section} />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            padding: "1.125rem 1.5rem 1.5rem",
          }}
        >
          {section === "demographics" ? (
            <DemographicsTab patientId={p.id} onSaved={handleDemographicsSaved} />
          ) : section === "addresses" ? (
            <AddressesTab patientId={p.id} />
          ) : section === "coverage" ? (
            <CoverageTab patientId={p.id} />
          ) : section === "care-team" ? (
            <CareTeamTab patientId={p.id} organizationId={p.organizationId} />
          ) : section === "privacy" ? (
            <PrivacyFlagsTab patientId={p.id} />
          ) : section === "clinical" ? (
            <ClinicalTab patient={p} data={data} clinical={clinical} />
          ) : (
            <OverviewTab patient={p} data={data} />
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

// Whole-years age from a YYYY-MM-DD DOB; null when unparseable or out of a sane range.

// A mono identifier rendered as a tonal pill (§3.1 mono face on a No-Line surface-container chip).

function MonoChip({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      style={{
        fontFamily: "var(--font-mono)",

        fontSize: "0.78rem",

        color: "var(--color-on-surface-variant)",

        background: "var(--color-surface-container)",

        borderRadius: "9999px",

        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}

const MESSAGE_BTN = {
  display: "inline-flex",

  alignItems: "center",

  padding: "0.4rem 0.9rem",

  borderRadius: "9999px",

  background: "var(--color-surface-container)",

  color: "var(--color-on-surface)",

  fontSize: "0.8125rem",

  fontWeight: 600,

  textDecoration: "none",
} as const;

// §6.2 Lantern Card: surface-lowest + radius-xl + shadow-soft (No-Line), Fraunces card title.

function Card({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="wx-patient-card" style={{ ...cardSurface, padding: "1.25rem 1.5rem" }}>
      <h2
        style={{
          margin: "0 0 0.75rem",

          fontFamily: "var(--font-display)",

          fontWeight: 500,

          fontSize: "1rem",

          color: "var(--color-on-surface)",
        }}
      >
        {title}
      </h2>

      {children}
    </section>
  );
}

// Honest empty/placeholder line for a card whose data comes from a not-yet-built module.

function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p
      style={{
        margin: 0,
        color: "var(--color-on-surface-variant)",
        fontSize: "0.85rem",
      }}
    >
      {children}
    </p>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  trailing,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <div style={sectionHeader}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div style={sectionEyebrow}>{eyebrow}</div> : null}
        <h2 style={sectionTitle}>{title}</h2>
        <p style={sectionDescription}>{description}</p>
      </div>
      {trailing ? <div style={sectionHeaderAction}>{trailing}</div> : null}
    </div>
  );
}

function SubsectionHeader({
  title,
  description,
  count,
}: {
  title: string;
  description?: string;
  count?: number;
}): JSX.Element {
  return (
    <div style={subsectionHeader}>
      <div>
        <div style={subsectionTitleRow}>
          <h3 style={subsectionTitle}>{title}</h3>
          {typeof count === "number" ? <span style={countBadge}>{count}</span> : null}
        </div>
        {description ? <p style={subsectionDescription}>{description}</p> : null}
      </div>
    </div>
  );
}

function InfoGrid({ children }: { children: ReactNode }): JSX.Element {
  return <div style={infoGrid}>{children}</div>;
}

function InfoField({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={infoField}>
      <span style={infoFieldLabel}>{label}</span>
      <div
        style={{
          ...infoFieldValue,
          ...(mono ? { fontFamily: "var(--font-mono)" } : {}),
        }}
      >
        {value}
      </div>
      {hint ? <div style={infoFieldHint}>{hint}</div> : null}
    </div>
  );
}

function DetailItem({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={detailItem}>
      <span style={detailItemLabel}>{label}</span>
      <div
        style={{
          ...detailItemValue,
          ...(mono ? { fontFamily: "var(--font-mono)" } : {}),
        }}
      >
        {value}
      </div>
      {hint ? <div style={detailItemHint}>{hint}</div> : null}
    </div>
  );
}

function EmptyPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}): JSX.Element {
  return (
    <div style={emptyPanel}>
      <div style={emptyPanelIcon} aria-hidden="true">
        —
      </div>
      <div>
        <strong style={emptyPanelTitle}>{title}</strong>
        <p style={emptyPanelText}>{description}</p>
      </div>
    </div>
  );
}

function FieldLabel({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives through `children` (every caller passes an <input>/<select>), so the implicit label association holds; the rule cannot see through the slot.
    <label style={fieldGroup}>
      <span style={fieldLabel}>
        {label}
        {optional ? <span style={optionalLabel}>Optional</span> : null}
      </span>
      {children}
    </label>
  );
}

function maskIdentifierTail(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "Not recorded";
  if (normalized === "^" || normalized === "+" || normalized === "N") return normalized;
  if (normalized.length <= 4) return normalized;
  return `••••${normalized.slice(-4)}`;
}

function dateOnly(value: string | null | undefined): string {
  return value?.slice(0, 10) || "—";
}

// SOGI/race/ethnicity/marital are USCDI codes resolved to display labels via M38 value-sets — shown

// here as the raw codes until the M38 label join is wired (codes are honest live data, not fabricated).

interface Demographics {
  id: string;

  mrn: string;

  legalFirstName: string;

  legalMiddleName: string | null;

  legalLastName: string;

  legalNameSuffix: string | null;

  dob: string;

  status: string;

  sexAssignedAtBirth: string;

  genderIdentityCode: string | null;

  sexualOrientationCode: string | null;

  pronounsCode: string | null;

  maritalStatusCode: string | null;

  raceCodes: string[];

  ethnicityCodes: string[];

  preferredLanguageCode: string | null;

  aliases: {
    kind: string;

    fullName: string | null;

    firstName: string | null;

    middleName: string | null;

    lastName: string | null;
  }[];
}

interface Identifier {
  id: string;

  kind: string;

  value: string | null;

  last4: string | null;

  sensitive: boolean;

  issuer: string | null;

  effectiveFrom: string;

  effectiveTo: string | null;
}

function DemographicsTab({
  patientId,
  onSaved,
}: {
  patientId: string;
  onSaved: (demographics: Demographics) => void;
}): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [demographics, setDemographics] = useState<Demographics | null>(null);
  const [identifiers, setIdentifiers] = useState<Identifier[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    (async () => {
      setStatus("loading");
      const [demo, ids] = await Promise.all([
        client.GET("/api/v1/patients/{id}/demographics", {
          params: { path: { id: patientId } },
        }),
        client.GET("/api/v1/patients/{id}/identifiers", {
          params: { path: { id: patientId } },
        }),
      ]);

      if (!active) return;
      if (demo.error || !demo.data || ids.error || !ids.data) {
        setStatus("error");
        return;
      }

      setDemographics(demo.data as Demographics);
      setIdentifiers((ids.data as { identifiers: Identifier[] }).identifiers);
      setStatus("ready");
    })();

    return () => {
      active = false;
    };
  }, [client, patientId]);

  if (status === "loading") return <LoadingSpinner />;

  if (status === "error" || !demographics || !identifiers) {
    return (
      <EmptyPanel
        title="Demographics unavailable"
        description="The patient demographics and identifiers could not be loaded."
      />
    );
  }

  const d = demographics;
  const sexLabel = (value: string) =>
    ({ M: "Male", F: "Female", U: "Unknown", O: "Other", UNK: "Not recorded" })[value] ?? value;
  const displayValue = (value: string | null | undefined): ReactNode =>
    value?.trim() ? value : <span style={missingValue}>Not recorded</span>;
  const displayCodes = (values: string[]): ReactNode =>
    values.length ? values.join(", ") : <span style={missingValue}>Not recorded</span>;
  const formatDisplayDate = (value: string | null | undefined): string =>
    value ? formatDateOnly(value.slice(0, 10)) : "Not recorded";
  const legalName = [d.legalFirstName, d.legalMiddleName, d.legalLastName, d.legalNameSuffix]
    .filter(Boolean)
    .join(" ");
  const aliases = d.aliases
    .map((alias) => {
      const name =
        alias.fullName ??
        [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(" ");
      return name ? `${name} · ${titleCase(alias.kind)}` : titleCase(alias.kind);
    })
    .filter(Boolean);
  const age = ageYears(d.dob);
  const activeIdentifiers = identifiers.filter((item) => !item.effectiveTo);
  const historicalIdentifiers = identifiers.filter((item) => Boolean(item.effectiveTo));

  async function submitDemographics(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);

    const form = new FormData(event.currentTarget);
    const nullable = (name: string) => String(form.get(name) ?? "").trim() || null;
    const list = (name: string) =>
      String(form.get(name) ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

    try {
      const res = await (
        client as unknown as {
          PUT: (
            path: string,
            options: unknown,
          ) => Promise<{ data?: Demographics; error?: unknown }>;
        }
      ).PUT("/api/v1/patients/{id}/demographics", {
        params: { path: { id: patientId } },
        body: {
          legalFirstName: String(form.get("legalFirstName") ?? "").trim(),
          legalMiddleName: nullable("legalMiddleName"),
          legalLastName: String(form.get("legalLastName") ?? "").trim(),
          legalNameSuffix: nullable("legalNameSuffix"),
          dob: String(form.get("dob") ?? ""),
          sexAssignedAtBirth: String(form.get("sexAssignedAtBirth") ?? "U"),
          genderIdentityCode: nullable("genderIdentityCode"),
          sexualOrientationCode: nullable("sexualOrientationCode"),
          pronounsCode: nullable("pronounsCode"),
          maritalStatusCode: nullable("maritalStatusCode"),
          preferredLanguageCode: nullable("preferredLanguageCode"),
          raceCodes: list("raceCodes"),
          ethnicityCodes: list("ethnicityCodes"),
        },
      });

      if (res.error || !res.data) {
        setSaveError("Could not save demographics. Please review the fields and try again.");
        return;
      }

      // Update this tab immediately and notify the chart shell so the banner
      // and shared chart data reconcile without requiring a page reload.
      setDemographics(res.data);
      onSaved(res.data);
      setEditing(false);
      toast.show("Demographics updated.", { tone: "success" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={tabPage}>
      <SectionHeader
        eyebrow="Patient identity"
        title="Demographics & Identifiers"
        description="Core identity, demographic attributes and identifiers used across the patient chart."
        trailing={
          <Button
            tone="secondary"
            onClick={() => {
              setSaveError(null);
              setEditing(true);
            }}
          >
            Edit demographics
          </Button>
        }
      />

      <section style={identityHero} aria-label="Patient identity summary">
        <div style={identityHeroMain}>
          <div style={identityMonogram} aria-hidden="true">
            {`${d.legalFirstName[0] ?? ""}${d.legalLastName[0] ?? ""}`.toUpperCase() || "?"}
          </div>
          <div style={{ minWidth: 0 }}>
            <h3 style={identityName}>{legalName || "Name not recorded"}</h3>
            <div style={identityMeta}>
              <span>{sexLabel(d.sexAssignedAtBirth)}</span>
              <span aria-hidden="true">·</span>
              <span>
                Born {formatDisplayDate(d.dob)}
                {age != null ? ` · ${age}y` : ""}
              </span>
            </div>
          </div>
        </div>

        <div style={identityMrn}>
          <span style={detailItemLabel}>Medical record number</span>
          <code style={identityMrnValue}>{d.mrn}</code>
        </div>
      </section>

      <div style={twoColumnGrid}>
        <Card title="Identity details">
          <div style={detailGrid}>
            <DetailItem
              label="Date of birth"
              value={formatDisplayDate(d.dob)}
              hint={age != null ? `${age} years old` : undefined}
            />
            <DetailItem
              label="Aliases"
              value={
                aliases.length ? (
                  aliases.join("; ")
                ) : (
                  <span style={missingValue}>None recorded</span>
                )
              }
            />
          </div>
        </Card>

        <Card title="Personal & demographic details">
          <div style={detailGrid}>
            <DetailItem label="Sex assigned at birth" value={sexLabel(d.sexAssignedAtBirth)} />
            <DetailItem label="Gender identity" value={displayValue(d.genderIdentityCode)} />
            <DetailItem label="Pronouns" value={displayValue(d.pronounsCode)} />
            <DetailItem label="Sexual orientation" value={displayValue(d.sexualOrientationCode)} />
            <DetailItem label="Marital status" value={displayValue(d.maritalStatusCode)} />
            <DetailItem label="Preferred language" value={displayValue(d.preferredLanguageCode)} />
          </div>

          <div style={sectionDivider} />

          <SubsectionHeader
            title="Race & ethnicity"
            description="Values are shown as stored codes until M38 display-label resolution is connected."
          />
          <div style={detailGrid}>
            <DetailItem label="Race" value={displayCodes(d.raceCodes)} />
            <DetailItem label="Ethnicity" value={displayCodes(d.ethnicityCodes)} />
          </div>
        </Card>
      </div>

      <Card title="Identifiers">
        <SubsectionHeader
          title="Current identifiers"
          description="Identifiers currently active for this patient."
          count={activeIdentifiers.length}
        />

        {activeIdentifiers.length === 0 ? (
          <EmptyPanel
            title="No current identifiers"
            description="No active patient identifiers are available."
          />
        ) : (
          <div style={recordList}>
            {activeIdentifiers.map((identifier) => (
              <div key={identifier.id} style={identifierRow}>
                <div style={recordRowMain}>
                  <div style={recordTitleRow}>
                    <strong style={recordTitle}>{identifier.kind.toUpperCase()}</strong>
                    {identifier.kind === "mrn" ? (
                      <span style={badge("neutral")}>immutable</span>
                    ) : null}
                    {identifier.sensitive ? <span style={badge("warning")}>sensitive</span> : null}
                  </div>

                  <div style={identifierValue}>
                    {identifier.sensitive ? (
                      <MaskedIdentifier
                        value=""
                        masked={`xxx-xx-${identifier.last4 ?? "####"}`}
                        label={`${identifier.kind.toUpperCase()} (masked)`}
                      />
                    ) : (
                      displayValue(identifier.value)
                    )}
                  </div>
                </div>

                <div style={identifierMetaColumn}>
                  <span>
                    {identifier.issuer ? `Issuer: ${identifier.issuer}` : "No issuer recorded"}
                  </span>
                  <span>Active since {dateOnly(identifier.effectiveFrom)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {historicalIdentifiers.length > 0 ? (
          <details style={detailsBlock}>
            <summary style={detailsSummary}>
              Historical identifiers ({historicalIdentifiers.length})
            </summary>
            <div style={{ ...recordList, marginTop: "0.75rem" }}>
              {historicalIdentifiers.map((identifier) => (
                <div key={identifier.id} style={recordRowMuted}>
                  <div>
                    <strong>{identifier.kind.toUpperCase()}</strong>
                    <div style={recordMeta}>
                      {dateOnly(identifier.effectiveFrom)} → {dateOnly(identifier.effectiveTo)}
                    </div>
                  </div>
                  <div style={{ color: "var(--color-on-surface-variant)" }}>
                    {identifier.sensitive
                      ? `••••${identifier.last4 ?? "####"}`
                      : displayValue(identifier.value)}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <p style={helperNote}>
          Sensitive identifiers remain masked in this chart. Full SSN reveal requires the
          <code style={{ margin: "0 0.25rem" }}>phi.read_ssn</code> permission.
        </p>
      </Card>

      <Modal
        open={editing}
        onClose={saving ? undefined : () => setEditing(false)}
        ariaLabel="Edit patient demographics"
        width="54rem"
      >
        <form style={modalForm} onSubmit={submitDemographics}>
          <header style={modalHeader}>
            <div>
              <h2 style={modalTitle}>Edit demographics</h2>
              <p style={modalLead}>
                Update identity and demographic information. MRN and protected identifiers are
                managed separately to preserve identity and audit history.
              </p>
            </div>
          </header>

          <div style={modalBody}>
            <section style={modalSection}>
              <div>
                <h3 style={modalSectionTitle}>Legal identity</h3>
                <p style={modalSectionDescription}>
                  Use the patient&apos;s legal name exactly as it should appear in the chart.
                </p>
              </div>

              <div style={modalFormGridTwo}>
                <FieldLabel label="First name">
                  <input
                    name="legalFirstName"
                    defaultValue={d.legalFirstName}
                    placeholder="e.g. Benjamin"
                    autoComplete="given-name"
                    required
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Last name">
                  <input
                    name="legalLastName"
                    defaultValue={d.legalLastName}
                    placeholder="e.g. Davies"
                    autoComplete="family-name"
                    required
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Middle name" optional>
                  <input
                    name="legalMiddleName"
                    defaultValue={d.legalMiddleName ?? ""}
                    placeholder="e.g. James"
                    autoComplete="additional-name"
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Suffix" optional>
                  <input
                    name="legalNameSuffix"
                    defaultValue={d.legalNameSuffix ?? ""}
                    placeholder="e.g. Jr."
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Date of birth">
                  <input
                    name="dob"
                    type="date"
                    defaultValue={dateOnly(d.dob)}
                    required
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Sex assigned at birth">
                  <select
                    name="sexAssignedAtBirth"
                    defaultValue={d.sexAssignedAtBirth}
                    style={input}
                  >
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                    <option value="U">Unknown</option>
                    <option value="O">Other</option>
                  </select>
                </FieldLabel>
              </div>
            </section>

            <section style={modalSection}>
              <div>
                <h3 style={modalSectionTitle}>Personal details</h3>
                <p style={modalSectionDescription}>
                  Leave optional values blank when they have not been recorded.
                </p>
              </div>

              <div style={modalFormGridTwo}>
                <FieldLabel label="Gender identity" optional>
                  <input
                    name="genderIdentityCode"
                    defaultValue={d.genderIdentityCode ?? ""}
                    placeholder="Enter gender identity code"
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Pronouns" optional>
                  <input
                    name="pronounsCode"
                    defaultValue={d.pronounsCode ?? ""}
                    placeholder="Enter pronouns code"
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Sexual orientation" optional>
                  <input
                    name="sexualOrientationCode"
                    defaultValue={d.sexualOrientationCode ?? ""}
                    placeholder="Enter sexual orientation code"
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Marital status" optional>
                  <input
                    name="maritalStatusCode"
                    defaultValue={d.maritalStatusCode ?? ""}
                    placeholder="Enter marital status code"
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Preferred language" optional>
                  <input
                    name="preferredLanguageCode"
                    defaultValue={d.preferredLanguageCode ?? ""}
                    placeholder="Enter language code"
                    style={input}
                  />
                </FieldLabel>
              </div>
            </section>

            <section style={modalSection}>
              <div>
                <h3 style={modalSectionTitle}>Race & ethnicity coding</h3>
                <p style={modalSectionDescription}>
                  Enter multiple values as comma-separated codes. Display-label resolution remains
                  handled by M38.
                </p>
              </div>

              <div style={modalFormGridTwo}>
                <FieldLabel label="Race codes" optional>
                  <input
                    name="raceCodes"
                    defaultValue={d.raceCodes.join(", ")}
                    placeholder="Comma-separated race codes"
                    style={input}
                  />
                </FieldLabel>
                <FieldLabel label="Ethnicity codes" optional>
                  <input
                    name="ethnicityCodes"
                    defaultValue={d.ethnicityCodes.join(", ")}
                    placeholder="Comma-separated ethnicity codes"
                    style={input}
                  />
                </FieldLabel>
              </div>
            </section>

            {saveError ? (
              <div role="alert" style={errorNote}>
                {saveError}
              </div>
            ) : null}
          </div>

          <footer style={modalFooter}>
            <Button
              type="button"
              tone="tertiary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </footer>
        </form>
      </Modal>
    </div>
  );
}

// D5 append-only address history: a primary change inserts a new row and closes the prior (effectiveTo).

// `current` = the live row (effectiveTo null); at most one current primary per patient. geocodeLat/Lng

// are filled asynchronously by the M5 geocode job, so a freshly-added row shows "geocoding…".

interface Address {
  id: string;

  kind: string;

  line1: string;

  line2: string | null;

  city: string;

  state: string | null;

  postalCode: string;

  country: string;

  county: string | null;

  isPrimary: boolean;

  current: boolean;

  effectiveFrom: string;

  effectiveTo: string | null;

  geocodeLat: string | null;

  geocodeLng: string | null;
}

const ADDRESS_KINDS = ["home", "facility", "mailing", "temporary", "prior"] as const;

function AddressLine({ a }: { a: Address }): JSX.Element {
  return (
    <>
      {a.line1}
      {a.line2 ? `, ${a.line2}` : ""}, {a.city}
      {a.state ? `, ${a.state}` : ""} {a.postalCode}
      {a.country && a.country !== "US" ? ` · ${a.country}` : ""}
    </>
  );
}

function AddressesTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [form, setForm] = useState({
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    kind: "home",
    isPrimary: false,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(
    async (active = { v: true }) => {
      setStatus("loading");
      const res = await client.GET("/api/v1/patients/{id}/addresses", {
        params: { path: { id: patientId } },
      });

      if (!active.v) return;
      if (res.error || !res.data) {
        setStatus("error");
        return;
      }

      setAddresses((res.data as { addresses: Address[] }).addresses);
      setStatus("ready");
    },
    [client, patientId],
  );

  useEffect(() => {
    const active = { v: true };
    void load(active);
    return () => {
      active.v = false;
    };
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);

    type AddressBody = NonNullable<
      paths["/api/v1/patients/{id}/addresses"]["post"]["requestBody"]
    >["content"]["application/json"];

    const body: AddressBody = {
      line1: form.line1,
      city: form.city,
      postalCode: form.postalCode,
      kind: form.kind as AddressBody["kind"],
      isPrimary: form.isPrimary,
    };

    if (form.line2) body.line2 = form.line2;
    if (form.state) body.state = form.state.toUpperCase();

    const res = await client.POST("/api/v1/patients/{id}/addresses", {
      params: { path: { id: patientId } },
      body,
    });

    setSaving(false);

    if (res.error) {
      setSaveError("Could not save the address. Check the fields and try again.");
      return;
    }

    toast.show("Address saved.", { tone: "success" });
    setForm({
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      kind: "home",
      isPrimary: false,
    });
    await load();
  }

  if (status === "loading" && addresses === null) return <LoadingSpinner />;

  if (status === "error" || addresses === null) {
    return (
      <EmptyPanel
        title="Addresses unavailable"
        description="The patient's address record could not be loaded."
      />
    );
  }

  const current = addresses
    .filter((address) => address.current)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const history = addresses.filter((address) => !address.current);
  const primary = current.find((address) => address.isPrimary);

  return (
    <div style={tabPage}>
      <SectionHeader
        eyebrow="Residence & contact"
        title="Addresses"
        description="Current service-location and contact addresses, with append-only history."
        trailing={
          primary ? <span style={badge("primary")}>Primary address on file</span> : undefined
        }
      />

      <div style={addressLayout}>
        <div style={stack}>
          <Card title="Current addresses">
            <SubsectionHeader
              title="Active addresses"
              description="The primary address is used first where patient residence is required."
              count={current.length}
            />

            {current.length === 0 ? (
              <EmptyPanel
                title="No current address"
                description="Add a current address to complete the patient's residence profile."
              />
            ) : (
              <div style={recordList}>
                {current.map((address) => (
                  <div
                    key={address.id}
                    style={{
                      ...addressRecordCard,
                      ...(address.isPrimary ? addressRecordPrimary : {}),
                    }}
                  >
                    <div style={recordTitleRow}>
                      <strong>{humanizeIdentifier(address.kind)}</strong>
                      {address.isPrimary ? <span style={badge("primary")}>primary</span> : null}
                      {address.geocodeLat && address.geocodeLng ? (
                        <span
                          style={badge("success")}
                          title={`${address.geocodeLat}, ${address.geocodeLng}`}
                        >
                          geocoded
                        </span>
                      ) : (
                        <span style={badge("neutral")}>geocoding</span>
                      )}
                    </div>

                    <div style={addressText}>
                      <AddressLine a={address} />
                    </div>

                    <div style={recordMeta}>
                      Active since {dateOnly(address.effectiveFrom)}
                      {address.county ? ` · ${address.county} County` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {history.length > 0 ? (
            <Card title="Address history">
              <SubsectionHeader
                title="Previous addresses"
                description="Prior records are retained instead of overwritten."
                count={history.length}
              />

              <div style={recordList}>
                {history.map((address) => (
                  <div key={address.id} style={recordRowMuted}>
                    <div>
                      <div style={recordTitleRow}>
                        <strong>{humanizeIdentifier(address.kind)}</strong>
                        {address.isPrimary ? (
                          <span style={badge("neutral")}>was primary</span>
                        ) : null}
                      </div>
                      <div style={recordValue}>
                        <AddressLine a={address} />
                      </div>
                    </div>
                    <div style={recordMeta}>
                      {dateOnly(address.effectiveFrom)} → {dateOnly(address.effectiveTo)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>

        <Card title="Add address">
          <p style={cardIntro}>
            Add a new address record. Setting it as primary will close the current primary record
            and preserve it in history.
          </p>

          <form onSubmit={submit} style={addressForm}>
            <FieldLabel label="Street address">
              <input
                required
                placeholder="123 Main Street"
                value={form.line1}
                onChange={(e) => setForm({ ...form, line1: e.target.value })}
                style={input}
              />
            </FieldLabel>

            <FieldLabel label="Apartment / suite" optional>
              <input
                placeholder="Apt 4B"
                value={form.line2}
                onChange={(e) => setForm({ ...form, line2: e.target.value })}
                style={input}
              />
            </FieldLabel>

            <div style={formGridThree}>
              <FieldLabel label="City">
                <input
                  required
                  placeholder="City"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  style={input}
                />
              </FieldLabel>

              <FieldLabel label="State" optional>
                <input
                  placeholder="ST"
                  maxLength={2}
                  value={form.state}
                  onChange={(e) => setForm({ ...form, state: e.target.value })}
                  style={input}
                />
              </FieldLabel>

              <FieldLabel label="ZIP code">
                <input
                  required
                  placeholder="ZIP"
                  value={form.postalCode}
                  onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                  style={input}
                />
              </FieldLabel>
            </div>

            <div style={formGridTwo}>
              <FieldLabel label="Address type">
                <select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  style={input}
                >
                  {ADDRESS_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {titleCase(kind)}
                    </option>
                  ))}
                </select>
              </FieldLabel>

              <label style={primaryToggle}>
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
                />
                <span>
                  <strong style={{ display: "block" }}>Set as primary</strong>
                  <small style={{ color: "var(--color-muted)" }}>
                    Use as the patient's main residence.
                  </small>
                </span>
              </label>
            </div>

            {form.isPrimary && current.some((address) => address.isPrimary) ? (
              <div style={warningNote}>
                The current primary address will move to history when this address is saved.
              </div>
            ) : null}

            {saveError ? (
              <div role="alert" style={errorNote}>
                {saveError}
              </div>
            ) : null}

            <button type="submit" disabled={saving} style={primaryButton}>
              {saving ? "Saving…" : "Add address"}
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
}

// §3.4 Coverage / Payers. The M5 route returns `patient_payer` rows (ranked coverages); `payerId`

// names an M40 canonical Payer whose DISPLAY NAME is resolved here via the M40 MDM client

// (GET /api/v1/mdm/payer/:id) — cross-module read stays at the client edge, no backend coupling. A

// payer that can't be resolved (e.g. the viewer lacks mdm.payer.read) falls back to its raw id, never

// fabricated. `rank` 1 = primary; `current` (effectiveTo null) coverages render above closed ones.

interface PatientPayer {
  id: string;

  payerId: string;

  rank: number;

  coverageKind: string;

  subscriberId: string;

  groupNumber: string | null;

  binPcn: string | null;

  current: boolean;

  effectiveFrom: string;

  effectiveTo: string | null;
}

interface HopeAssessmentSummary {
  id: string;
  admissionId?: string;
  rfaKind: string;
  status: string;
  targetDate?: string | null;
  signedAt?: string | null;
  createdAt?: string | null;
  supersededByAssessmentId: string | null;
}

interface HopeWorkspaceItem {
  itemCode: string;
  label: string;
  value: unknown;
  source?: string | null;
  options: { valueCode: string; label: string; sortOrder: number }[];
}

interface HopeWorkspaceSection {
  code: string;
  items: HopeWorkspaceItem[];
}

interface HopeWorkspace {
  sections: HopeWorkspaceSection[];
}

interface HopeCoverageSnapshot {
  assessment: HopeAssessmentSummary;
  payerItems: HopeWorkspaceItem[];
  medicareNumber: HopeWorkspaceItem | null;
  medicaidNumber: HopeWorkspaceItem | null;
}

function hopeAssessmentDate(assessment: HopeAssessmentSummary): number {
  const raw = assessment.signedAt ?? assessment.targetDate ?? assessment.createdAt;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectHopeAdmissionAssessment(
  assessments: HopeAssessmentSummary[],
): HopeAssessmentSummary | null {
  const candidates = assessments
    .filter(
      (assessment) => assessment.rfaKind === "01_admission" && !assessment.supersededByAssessmentId,
    )
    .sort((a, b) => {
      if (a.status === "signed" && b.status !== "signed") return -1;
      if (b.status === "signed" && a.status !== "signed") return 1;
      return hopeAssessmentDate(b) - hopeAssessmentDate(a);
    });

  return candidates[0] ?? null;
}

function hopeStatusTone(status: string): StatusTone {
  if (status === "signed") return "success";
  if (status === "draft") return "progress";
  if (status === "inactive" || status === "inactivated") return "neutral";
  return "neutral";
}

function CoverageTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [payers, setPayers] = useState<PatientPayer[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [hopeSnapshot, setHopeSnapshot] = useState<HopeCoverageSnapshot | null>(null);
  const [hopeStatus, setHopeStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let active = true;

    (async () => {
      setStatus("loading");
      setHopeStatus("loading");
      setHopeSnapshot(null);

      const [payerRes, hopeRes] = await Promise.all([
        client.GET("/api/v1/patients/{id}/payers", {
          params: { path: { id: patientId } },
        }),
        client.GET("/api/v1/patients/{patientId}/hope/assessments", {
          params: { path: { patientId } },
        }),
      ]);

      if (!active) return;

      if (payerRes.error || !payerRes.data) {
        setStatus("error");
        return;
      }

      const rows = (payerRes.data as { payers: PatientPayer[] }).payers;
      setPayers(rows);
      setStatus("ready");

      const ids = [...new Set(rows.map((row) => row.payerId))];
      const resolved = await Promise.all(
        ids.map(async (payerId) => {
          const result = await client.GET("/api/v1/mdm/{kind}/{id}", {
            params: { path: { kind: "payer", id: payerId } },
          });
          const name = (result.data as { canonical?: { displayName?: string } } | undefined)
            ?.canonical?.displayName;
          return [payerId, name ?? ""] as const;
        }),
      );

      if (!active) return;
      setNames(Object.fromEntries(resolved.filter(([, name]) => name)));

      if (hopeRes.error || !hopeRes.data) {
        setHopeStatus("unavailable");
        return;
      }

      const assessments = (hopeRes.data as { assessments: HopeAssessmentSummary[] }).assessments;
      const admissionAssessment = selectHopeAdmissionAssessment(assessments);

      if (!admissionAssessment) {
        setHopeStatus("ready");
        return;
      }

      const workspaceRes = await client.GET("/api/v1/hope/assessments/{id}/workspace", {
        params: { path: { id: admissionAssessment.id } },
      });

      if (!active) return;

      if (workspaceRes.error || !workspaceRes.data) {
        setHopeStatus("unavailable");
        return;
      }

      const workspace = workspaceRes.data as HopeWorkspace;
      const sectionA = workspace.sections.find((section) => section.code === "A");

      if (!sectionA) {
        setHopeStatus("unavailable");
        return;
      }

      setHopeSnapshot({
        assessment: admissionAssessment,
        payerItems: sectionA.items.filter((item) => item.itemCode.startsWith("A1400")),
        medicareNumber: sectionA.items.find((item) => item.itemCode === "A0600B") ?? null,
        medicaidNumber: sectionA.items.find((item) => item.itemCode === "A0700") ?? null,
      });
      setHopeStatus("ready");
    })();

    return () => {
      active = false;
    };
  }, [client, patientId]);

  if (status === "loading") return <LoadingSpinner />;

  if (status === "error" || payers === null) {
    return (
      <EmptyPanel
        title="Coverage unavailable"
        description="The patient's coverage and payer information could not be loaded."
      />
    );
  }

  const current = [...payers].filter((payer) => payer.current).sort((a, b) => a.rank - b.rank);
  const history = payers.filter((payer) => !payer.current);

  const payerName = (payer: PatientPayer): ReactNode =>
    names[payer.payerId] ?? (
      <span style={{ color: "var(--color-muted)" }} title={`M40 payer ${payer.payerId}`}>
        {payer.payerId.slice(0, 8)}…
      </span>
    );

  const selectedHopePayers =
    hopeSnapshot?.payerItems.filter((item) => String(item.value ?? "") === "1") ?? [];

  const hasMedicare =
    hopeSnapshot?.payerItems.some(
      (item) =>
        (item.itemCode === "A1400A" || item.itemCode === "A1400B") &&
        String(item.value ?? "") === "1",
    ) ?? false;

  const hasMedicaid =
    hopeSnapshot?.payerItems.some(
      (item) =>
        (item.itemCode === "A1400C" || item.itemCode === "A1400D") &&
        String(item.value ?? "") === "1",
    ) ?? false;

  return (
    <div style={tabPage}>
      <SectionHeader
        eyebrow="Financial coverage"
        title="Coverage / Payers"
        description="Current payer records and the coverage snapshot captured in the patient's HOPE admission assessment."
        trailing={
          current.length > 0 ? (
            <span style={badge("success")}>{current.length} active</span>
          ) : undefined
        }
      />

      <div style={overviewStrip}>
        <InfoField label="Active coverages" value={current.length} />
        <InfoField
          label="Primary payer"
          value={
            current.find((payer) => payer.rank === 1)
              ? payerName(current.find((payer) => payer.rank === 1)!)
              : "—"
          }
        />
        <InfoField
          label="HOPE snapshot"
          value={
            hopeStatus === "loading"
              ? "Loading…"
              : hopeSnapshot
                ? titleCase(hopeSnapshot.assessment.status)
                : hopeStatus === "unavailable"
                  ? "Unavailable"
                  : "Not recorded"
          }
        />
      </div>

      <Card title="Active coverage">
        <SubsectionHeader
          title="Current payer records"
          description="Ranked coverage currently active on the patient chart."
          count={current.length}
        />

        {current.length === 0 ? (
          <EmptyPanel
            title="No active coverage"
            description="No current payer coverage is recorded for this patient."
          />
        ) : (
          <div style={coverageGrid}>
            {current.map((payer) => (
              <div
                key={payer.id}
                style={{
                  ...coverageCard,
                  ...(payer.rank === 1 ? coverageCardPrimary : {}),
                }}
              >
                <div style={recordTitleRow}>
                  <strong style={coverageCardTitle}>{payerName(payer)}</strong>
                  {payer.rank === 1 ? (
                    <span style={badge("primary")}>primary</span>
                  ) : (
                    <span style={badge("neutral")}>rank {payer.rank}</span>
                  )}
                  <span style={badge("success")}>{titleCase(payer.coverageKind)}</span>
                </div>

                <div style={coverageFacts}>
                  <InfoField
                    label="Member ID"
                    value={maskIdentifierTail(payer.subscriberId)}
                    mono
                  />
                  <InfoField label="Group" value={payer.groupNumber || "—"} mono />
                  <InfoField label="BIN / PCN" value={payer.binPcn || "—"} mono />
                  <InfoField label="Effective" value={dateOnly(payer.effectiveFrom)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="HOPE coverage snapshot">
        {hopeStatus === "loading" ? (
          <div style={inlineLoading}>
            <LoadingSpinner />
            <span>Loading HOPE admission coverage…</span>
          </div>
        ) : hopeStatus === "unavailable" ? (
          <EmptyPanel
            title="HOPE snapshot unavailable"
            description="The patient coverage is available, but the HOPE admission snapshot could not be loaded with the current access."
          />
        ) : !hopeSnapshot ? (
          <EmptyPanel
            title="No HOPE admission snapshot"
            description="No current Admission HOPE assessment is available for this patient."
          />
        ) : (
          <>
            <div style={snapshotHeader}>
              <div>
                <div style={recordTitleRow}>
                  <strong style={coverageCardTitle}>Admission HOPE</strong>
                  <StatusPill
                    label={titleCase(hopeSnapshot.assessment.status)}
                    tone={hopeStatusTone(hopeSnapshot.assessment.status)}
                  />
                </div>
                <p style={cardIntro}>
                  Regulatory snapshot from the selected non-superseded Admission HOPE record.
                </p>
              </div>

              <Link
                to={`/hope/assessments/${hopeSnapshot.assessment.id}`}
                style={secondaryLinkButton}
              >
                View HOPE assessment
              </Link>
            </div>

            {selectedHopePayers.length === 0 ? (
              <EmptyPanel
                title="No payer source selected"
                description="This HOPE Admission assessment does not currently contain a selected A1400 payer source."
              />
            ) : (
              <div style={recordList}>
                {selectedHopePayers.map((item) => (
                  <div key={item.itemCode} style={recordRow}>
                    <div style={recordRowMain}>
                      <div style={recordTitleRow}>
                        <span style={successDot} aria-hidden="true">
                          ✓
                        </span>
                        <strong style={recordTitle}>{item.label}</strong>
                      </div>
                      <div style={recordMeta}>
                        {item.source === "patient_prefill"
                          ? "From patient coverage"
                          : item.source === "admission_prefill"
                            ? "From admission"
                            : item.source === "user"
                              ? "Confirmed in HOPE"
                              : "HOPE assessment value"}
                      </div>
                    </div>
                    <code style={codeChip}>{item.itemCode}</code>
                  </div>
                ))}
              </div>
            )}

            {hasMedicare || hasMedicaid ? (
              <div style={{ ...twoColumnGrid, marginTop: "0.85rem" }}>
                {hasMedicare ? (
                  <div style={identifierSummaryCard}>
                    <span style={infoFieldLabel}>Medicare number</span>
                    <strong style={identifierSummaryValue}>
                      {maskIdentifierTail(
                        hopeSnapshot.medicareNumber?.value == null
                          ? null
                          : String(hopeSnapshot.medicareNumber.value),
                      )}
                    </strong>
                    <code style={codeChip}>A0600B</code>
                  </div>
                ) : null}

                {hasMedicaid ? (
                  <div style={identifierSummaryCard}>
                    <span style={infoFieldLabel}>Medicaid number</span>
                    <strong style={identifierSummaryValue}>
                      {maskIdentifierTail(
                        hopeSnapshot.medicaidNumber?.value == null
                          ? null
                          : String(hopeSnapshot.medicaidNumber.value),
                      )}
                    </strong>
                    <code style={codeChip}>A0700</code>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Card>

      {history.length > 0 ? (
        <Card title="Coverage history">
          <SubsectionHeader
            title="Closed payer records"
            description="Historical coverage retained for continuity and audit."
            count={history.length}
          />

          <div style={recordList}>
            {history.map((payer) => (
              <div key={payer.id} style={recordRowMuted}>
                <div>
                  <strong>{payerName(payer)}</strong>
                  <div style={recordMeta}>
                    {titleCase(payer.coverageKind)} · Member{" "}
                    {maskIdentifierTail(payer.subscriberId)}
                  </div>
                </div>
                <div style={recordMeta}>
                  {dateOnly(payer.effectiveFrom)} → {dateOnly(payer.effectiveTo)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <p style={helperNote}>
        Current payer records and HOPE coverage are intentionally shown separately: the HOPE card is
        a regulatory snapshot, not a replacement for the patient's live coverage.
      </p>
    </div>
  );
}

// §3.4/§3.5 Care Team & Assignments. The M5 route returns three M5-owned lists: the clinical

// `assignments` (a clinician user id + care-team role), the `caregivers` (relationship + primary /

// legal-representative authority), and the `emergencyContacts` (priority-ordered). A clinician's

// DISPLAY NAME crosses into M2. When the current viewer can read the organization roster, this

// surface resolves the clinician user id to a staff name/email; otherwise it falls back to the short

// clinician id rather than fabricating identity. `current` (open) rows render above closed ones.

interface Assignment {
  id: string;

  clinicianUserId: string;

  /** Resolved server-side from the member directory; null when the member is no longer listed. */
  displayName?: string | null;

  role: string;

  assignedAt: string;

  unassignedAt: string | null;

  current: boolean;
}

interface CaregiverLink {
  id: string;

  caregiverId: string;

  firstName: string;

  lastName: string;

  relationship: string;

  isPrimary: boolean;

  isLegalRepresentative: boolean;

  lrAuthority: string;

  phone: string | null;

  email: string | null;

  current: boolean;
}

interface EmergencyContact {
  id: string;

  name: string;

  relationship: string;

  phone: string;

  email: string | null;

  priority: number;
}

interface CareTeam {
  assignments: Assignment[];

  caregivers: CaregiverLink[];

  emergencyContacts: EmergencyContact[];
}

const ROLE_LABELS: Record<string, string> = {
  primary_rn: "Primary RN",

  rn: "RN",

  attending_clinician: "Attending clinician",

  case_manager_msw: "Case manager (MSW)",

  chaplain: "Chaplain",

  aide: "Aide",

  np: "NP",

  md: "MD",

  volunteer: "Volunteer",

  bereavement: "Bereavement",

  admitting_staff: "Admitting staff",
};

/** Shown when the care-team response carries no name for a clinician (e.g. a departed member). */
const UNRESOLVED_STAFF_LABEL = "Staff member";

const ASSIGNABLE_ROLES = [
  "primary_rn",
  "rn",
  "attending_clinician",
  "case_manager_msw",
  "chaplain",
  "aide",
  "np",
  "md",
] as const;

type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const roleLabel = (r: string) => ROLE_LABELS[r] ?? r;

function assignmentApiError(error: unknown): { title: string; message: string } {
  const detail =
    error && typeof error === "object" && "error" in error
      ? (error as { error?: unknown }).error
      : error;
  const code =
    detail && typeof detail === "object" && "code" in detail
      ? (detail as { code?: unknown }).code
      : undefined;
  const message =
    detail && typeof detail === "object" && "message" in detail
      ? (detail as { message?: unknown }).message
      : undefined;
  return {
    title:
      code === "ACTIVE_ASSIGNMENT_EXISTS"
        ? "Assignment already exists"
        : "Could not assign clinician",
    message:
      typeof message === "string" && message.trim()
        ? message
        : "We couldn't assign this clinician. Please review the selection and try again.",
  };
}

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function CareTeamRolePicker({
  value,
  onChange,
  disabled,
}: {
  value: AssignableRole;
  onChange: (value: AssignableRole) => void;
  disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} style={rolePickerRoot}>
      <span style={fieldLabel}>
        Care team role
        <span style={requiredLabel}>Required</span>
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        style={{
          ...rolePickerButton,
          ...(open ? rolePickerButtonOpen : {}),
          ...(disabled ? { opacity: 0.6, cursor: "not-allowed" } : {}),
        }}
      >
        <span>{roleLabel(value)}</span>
        <span aria-hidden="true" style={rolePickerChevron}>
          {open ? "⌃" : "⌄"}
        </span>
      </button>

      {open ? (
        // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the trigger button and moves to the option buttons below
        // biome-ignore lint/a11y/useSemanticElements: a native <select> cannot render the styled, hover-highlighted role rows this picker shows
        <div role="listbox" aria-label="Care team role" style={rolePickerMenu}>
          {ASSIGNABLE_ROLES.map((role) => {
            const selected = role === value;
            const highlighted = role === hovered;
            return (
              <button
                key={role}
                // biome-ignore lint/a11y/useSemanticElements: an <option> element cannot carry this row's styling or click behaviour
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setHovered(role)}
                onMouseLeave={() => setHovered(null)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(role);
                  setOpen(false);
                }}
                style={{
                  ...rolePickerOption,
                  ...(selected ? rolePickerOptionSelected : {}),
                  ...(highlighted ? rolePickerOptionHovered : {}),
                }}
              >
                <span>{roleLabel(role)}</span>
                {selected ? (
                  <span aria-hidden="true" style={rolePickerCheck}>
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <span style={formHint}>
        The role controls how this clinician appears on the patient care team.
      </span>
    </div>
  );
}

export function CareTeamTab({
  patientId,
  organizationId,
}: {
  patientId: string;
  organizationId: string;
}): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [team, setTeam] = useState<CareTeam | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [assignOpen, setAssignOpen] = useState(false);
  const [clinicianUserId, setClinicianUserId] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [membershipLabel, setMembershipLabel] = useState("");
  const [assignmentRole, setAssignmentRole] = useState<AssignableRole>("primary_rn");
  const [assigning, setAssigning] = useState(false);
  const [assignmentError, setAssignmentError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const { open: openCareTeamConversation, opening: openingConversation } =
    useOpenPatientConversation(patientId);

  // Latest-wins: a reload only commits if no newer reload, patient switch or unmount happened since.
  const reloadRequest = useRef(0);
  const reload = useCallback(
    async (showLoading = false) => {
      const request = ++reloadRequest.current;
      if (showLoading) setStatus("loading");
      try {
        const teamResult = await client.GET("/api/v1/patients/{id}/care-team", {
          params: { path: { id: patientId } },
        });
        if (request !== reloadRequest.current) return;
        if (teamResult.error || !teamResult.data) {
          setStatus("error");
          return;
        }
        setTeam(teamResult.data as CareTeam);
        setStatus("ready");
      } catch {
        if (request === reloadRequest.current) setStatus("error");
      }
    },
    [client, patientId],
  );

  useEffect(() => {
    setTeam(null);
    void reload(true);
    return () => {
      reloadRequest.current += 1;
    };
  }, [reload]);

  if (status === "loading" && team === null) return <LoadingSpinner />;

  if (status === "error" || team === null) {
    return (
      <EmptyPanel
        title="Care team unavailable"
        description="Care team assignments and caregiver information could not be loaded."
      />
    );
  }

  const assignments = team.assignments
    .filter((assignment) => isCareTeamRole(assignment.role))
    .sort((a, b) => Number(b.current) - Number(a.current));
  const activeAssignments = assignments.filter((assignment) => assignment.current);
  const pastAssignments = assignments.filter((assignment) => !assignment.current);
  const caregivers = team.caregivers.filter((caregiver) => caregiver.current);
  const pastCaregivers = team.caregivers.filter((caregiver) => !caregiver.current);
  const emergencyContacts = [...team.emergencyContacts].sort((a, b) => a.priority - b.priority);
  const primaryRn = activeAssignments.find((assignment) => assignment.role === "primary_rn");
  const primaryCaregiver = caregivers.find((caregiver) => caregiver.isPrimary);

  const clinicianName = (assignment: Assignment): string => {
    return assignment.displayName ?? UNRESOLVED_STAFF_LABEL;
  };

  return (
    <div style={tabPage}>
      <SectionHeader
        eyebrow="People involved in care"
        title="Care Team & Assignments"
        description="Clinical assignments, caregivers, legal representatives and emergency contacts in one place."
        trailing={
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <Button
              tone="secondary"
              disabled={openingConversation}
              onClick={() => void openCareTeamConversation()}
            >
              {openingConversation ? "Opening…" : "Open care team conversation"}
            </Button>
            <Button
              onClick={() => {
                setAssignmentError(null);
                setAssignOpen(true);
              }}
            >
              Assign care team member
            </Button>
          </div>
        }
      />

      <div style={overviewStrip}>
        <InfoField
          label="Primary RN"
          value={primaryRn ? clinicianName(primaryRn) : "Not assigned"}
          hint={primaryRn ? roleLabel(primaryRn.role) : undefined}
        />
        <InfoField label="Active clinicians" value={activeAssignments.length} />
        <InfoField
          label="Primary caregiver"
          value={
            primaryCaregiver
              ? `${primaryCaregiver.firstName} ${primaryCaregiver.lastName}`
              : "Not recorded"
          }
        />
        <InfoField label="Emergency contacts" value={emergencyContacts.length} />
      </div>

      <div className="wx-care-team-layout">
        <div className="wx-care-team-main">
          <Card title="Clinical assignments">
            <SubsectionHeader
              title="Active care team"
              description="Current clinicians and roles assigned to this patient."
              count={activeAssignments.length}
            />

            {activeAssignments.length === 0 ? (
              <EmptyPanel
                title="No care team members assigned yet"
                description="Assign clinicians so they can participate in care and be scheduled for eligible visits."
              />
            ) : (
              <div style={recordList}>
                {activeAssignments.map((assignment) => {
                  const name = clinicianName(assignment);
                  return (
                    <div
                      key={assignment.id}
                      style={{
                        ...assignmentRow,
                        ...(assignment.role === "primary_rn" ? highlightedRow : {}),
                      }}
                    >
                      <div style={assignmentPerson}>
                        <Avatar name={name} size={2.5} />
                        <div style={{ minWidth: 0 }}>
                          <div style={recordTitleRow}>
                            <strong style={assignmentName}>{name}</strong>
                            {assignment.role === "primary_rn" ? (
                              <span style={badge("primary")}>Primary</span>
                            ) : null}
                          </div>
                          <div style={assignmentRoleText}>{roleLabel(assignment.role)}</div>
                        </div>
                      </div>

                      <div style={assignmentMeta}>
                        <span>Assigned {dateOnly(assignment.assignedAt)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {pastAssignments.length > 0 || pastCaregivers.length > 0 ? (
            <Card title="Past involvement">
              <details style={detailsBlock}>
                <summary style={detailsSummary}>
                  Show previous clinicians and caregivers (
                  {pastAssignments.length + pastCaregivers.length})
                </summary>
                <div style={{ ...recordList, marginTop: "0.75rem" }}>
                  {pastAssignments.map((assignment) => (
                    <div key={assignment.id} style={recordRowMuted}>
                      <div>
                        <strong>{clinicianName(assignment)}</strong>
                        <div style={recordMeta}>{roleLabel(assignment.role)}</div>
                      </div>
                      <div style={recordMeta}>
                        {dateOnly(assignment.assignedAt)} → {dateOnly(assignment.unassignedAt)}
                      </div>
                    </div>
                  ))}

                  {pastCaregivers.map((caregiver) => (
                    <div key={caregiver.id} style={recordRowMuted}>
                      <div>
                        <strong>
                          {caregiver.firstName} {caregiver.lastName}
                        </strong>
                        <div style={recordMeta}>{titleCase(caregiver.relationship)}</div>
                      </div>
                      <span style={badge("neutral")}>ended</span>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          ) : null}
        </div>

        <aside className="wx-care-team-rail" aria-label="Care team context">
          <div className="wx-care-team-rail-cards">
            <Card title="Caregivers & representatives">
              <SubsectionHeader
                title="Current caregivers"
                description="People supporting the patient outside the clinical team."
                count={caregivers.length}
              />

              {caregivers.length === 0 ? (
                <EmptyPanel
                  title="No current caregivers"
                  description="No caregiver relationship is currently recorded."
                />
              ) : (
                <div style={recordList}>
                  {caregivers.map((caregiver) => {
                    const name = `${caregiver.firstName} ${caregiver.lastName}`;
                    return (
                      <div
                        key={caregiver.id}
                        style={{
                          ...caregiverRow,
                          ...(caregiver.isPrimary ? highlightedRow : {}),
                        }}
                      >
                        <Avatar name={name} size={2.25} />
                        <div style={recordRowMain}>
                          <div style={recordTitleRow}>
                            <strong style={recordTitle}>{name}</strong>
                            {caregiver.isPrimary ? (
                              <span style={badge("primary")}>primary</span>
                            ) : null}
                            {caregiver.isLegalRepresentative ? (
                              <span style={badge("warning")}>legal representative</span>
                            ) : null}
                          </div>
                          <div style={assignmentRoleText}>{titleCase(caregiver.relationship)}</div>

                          {caregiver.phone || caregiver.email ? (
                            <div style={contactLine}>
                              {caregiver.phone ? <span>{caregiver.phone}</span> : null}
                              {caregiver.email ? <span>{caregiver.email}</span> : null}
                            </div>
                          ) : (
                            <div style={recordMeta}>No contact details recorded</div>
                          )}

                          {caregiver.isLegalRepresentative ? (
                            <div style={recordMeta}>
                              Authority: {titleCase(caregiver.lrAuthority)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Emergency contacts">
              <SubsectionHeader
                title="Contact priority"
                description="Ordered by the sequence clinicians should use."
                count={emergencyContacts.length}
              />

              {emergencyContacts.length === 0 ? (
                <EmptyPanel
                  title="No emergency contacts"
                  description="No emergency contact has been recorded for this patient."
                />
              ) : (
                <div style={recordList}>
                  {emergencyContacts.map((contact) => (
                    <div key={contact.id} style={contactCard}>
                      <span style={contactPriority}>#{contact.priority}</span>
                      <div style={{ minWidth: 0 }}>
                        <strong style={recordTitle}>{contact.name}</strong>
                        <div style={recordMeta}>{titleCase(contact.relationship)}</div>
                        <div style={contactLine}>
                          <span>{contact.phone}</span>
                          {contact.email ? <span>{contact.email}</span> : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </aside>
      </div>

      <p style={helperNote}>
        Staff names are resolved from the organization roster when available; the clinician
        identifier remains the fallback when roster access is not available.
      </p>

      <Modal
        open={assignOpen}
        onClose={assigning ? undefined : () => setAssignOpen(false)}
        ariaLabel="Assign care team member"
        width="36rem"
      >
        <div style={assignmentModal}>
          <header style={modalHeader}>
            <div>
              <h2 style={modalTitle}>Assign care team member</h2>
              <p style={modalLead}>
                Choose an active staff member and the role they will hold for this patient.
              </p>
            </div>
          </header>

          <div style={assignmentModalBody}>
            <CareTeamStaffLookupField
              label="Clinician"
              value={membershipId}
              valueLabel={membershipLabel}
              appearance="modal"
              placeholder="Search staff by name..."
              hint="Only active members of this organization are available. Search by name. Up to 25 shown."
              onChange={(value, option) => {
                setMembershipId(value);
                setClinicianUserId(option?.metadata?.userId ?? "");
                setMembershipLabel(option?.searchLabel ?? "");
                setAssignmentError(null);
              }}
              required
            />

            <CareTeamRolePicker
              value={assignmentRole}
              onChange={(role) => {
                setAssignmentRole(role);
                setAssignmentError(null);
              }}
              disabled={assigning}
            />

            {assignmentError ? (
              <div role="alert" style={errorNote}>
                <strong style={{ display: "block", marginBottom: "0.2rem" }}>
                  {assignmentError.title}
                </strong>
                <span>{assignmentError.message}</span>
              </div>
            ) : null}
          </div>

          <footer style={modalFooter}>
            <Button tone="tertiary" onClick={() => setAssignOpen(false)} disabled={assigning}>
              Cancel
            </Button>
            <Button
              disabled={!membershipId || !clinicianUserId || assigning}
              onClick={() =>
                void (async () => {
                  setAssigning(true);
                  setAssignmentError(null);
                  try {
                    const res = await client.POST("/api/v1/patients/{id}/assignments", {
                      params: { path: { id: patientId } },
                      body: {
                        clinicianUserId,
                        role: assignmentRole,
                      },
                    });

                    if (res.error) {
                      setAssignmentError(assignmentApiError(res.error));
                      return;
                    }

                    setAssignOpen(false);
                    setMembershipId("");
                    setClinicianUserId("");
                    setMembershipLabel("");
                    setAssignmentRole("primary_rn");
                    toast.show("Care team member assigned.", { tone: "success" });
                    await reload(false);
                  } catch {
                    setAssignmentError({
                      title: "Could not assign clinician",
                      message: "The request did not complete. Check your connection and try again.",
                    });
                  } finally {
                    setAssigning(false);
                  }
                })()
              }
            >
              {assigning ? "Assigning…" : "Assign clinician"}
            </Button>
          </footer>
        </div>
      </Modal>
    </div>
  );
}

// §3.5 / D10 Privacy Flags tab (consent-gated). Two M5-owned reads compose here: the

// `patient_privacy_flag_snapshot` (active privacy RESTRICTIONS — a flag present = restricted, e.g.

// `sud` = 42 CFR Part 2) via GET /privacy-flags, and the patient's active consents (M39, FB-T03 live)

// via GET /patients/:id/consents. §7.6 fail-closed: when the patient is SUD-restricted and the server

// reports the records non-disclosable (`sudDisclosable: false`), the Part-2 surface renders a redacted

// notice instead of detail — the client never fabricates disclosability the server didn't grant.

interface PrivacyFlags {
  flags: string[];

  capturedAt: string | null;

  sudRestricted: boolean;

  sudDisclosable: boolean;
}

// One active consent row (M39 ConsentRecordView; the /consents route is unenriched so it's read loosely).

interface ConsentRecord {
  id: string;

  typeKey: string;

  status: string;

  grantorKind?: string;

  effectiveAt: string | null;

  expiresAt: string | null;

  signedAt: string | null;
}

const FLAG_LABELS: Record<string, string> = {
  sud: "Substance use (42 CFR Part 2)",

  hiv: "HIV / AIDS",

  mental_health: "Mental health",

  genetic: "Genetic",

  minor_restricted: "Minor — restricted",

  abuse_victim: "Abuse victim",
};

const flagLabel = (f: string) => FLAG_LABELS[f] ?? titleCase(f);

// Consent lifecycle → §6.6 status taxonomy tone.

function consentTone(s: string): StatusTone {
  switch (s) {
    case "active":
      return "success";

    case "pending":

    case "proposed":
      return "progress";

    case "revoked":

    case "rejected":
      return "error";

    default: // expired / superseded / withdrawn
      return "neutral";
  }
}

function PrivacyFlagsTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const canAdministerPrivacy = useSession()?.permissions?.includes("privacy.admin") ?? false;
  const [flags, setFlags] = useState<PrivacyFlags | null>(null);
  const [consents, setConsents] = useState<ConsentRecord[] | null>(null);
  const [consentsRead, setConsentsRead] = useState<ReadStatus>("ok");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  // The patient the shown data belongs to: a Retry reload keeps the layout (and the keyboard focus), a
  // different patient never shows the previous patient's flags.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const focusRef = useReloadFocus<HTMLDivElement>(status === "loading");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the fetch on Retry.
  useEffect(() => {
    let active = true;

    (async () => {
      setStatus("loading");
      // settleRead: a rejected request (network/timeout) is a failed read, not a stuck spinner.
      const [privacyRead, consentRead] = await Promise.all([
        settleRead(
          client.GET("/api/v1/patients/{id}/privacy-flags", {
            params: { path: { id: patientId } },
          }),
        ),
        // Consents are ABAC-guarded and answer 404 (not 403) when denied, so 404 is "denied" here.
        settleRead(
          client.GET("/api/v1/patients/{patientId}/consents", {
            params: { path: { patientId } },
          }),
          "denied",
        ),
      ]);

      if (!active) return;

      const privacyResult = privacyRead.res;
      if (!privacyResult?.data) {
        setStatus("error");
        return;
      }

      setFlags(privacyResult.data as PrivacyFlags);
      setConsentsRead(consentRead.status);
      setConsents(
        consentRead.status === "ok"
          ? ((consentRead.res?.data as { data: ConsentRecord[] } | undefined)?.data ?? [])
          : [],
      );
      setLoadedFor(patientId);
      setStatus("ready");
    })();

    return () => {
      active = false;
    };
  }, [client, patientId, attempt]);

  if (status === "loading" && loadedFor !== patientId) return <LoadingSpinner />;

  if (status === "error" || flags === null) {
    return (
      <EmptyPanel
        title="Privacy information unavailable"
        description="Privacy restrictions could not be loaded. Protected details are not shown when this state is unknown."
      />
    );
  }

  const nonSud = flags.flags.filter((flag) => flag !== "sud");
  const activeConsents = consents?.filter((consent) => consent.status === "active") ?? [];
  const otherConsents = consents?.filter((consent) => consent.status !== "active") ?? [];

  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      aria-busy={status === "loading"}
      style={{ ...tabPage, outline: "none" }}
    >
      <SectionHeader
        eyebrow="Consent & restrictions"
        title="Privacy Flags"
        description="Restrictions and consent state that control how sensitive patient information may be disclosed."
        trailing={
          flags.flags.length === 0 ? (
            <span style={badge("success")}>No active restrictions</span>
          ) : (
            <span style={badge("warning")}>
              {flags.flags.length} active restriction
              {flags.flags.length === 1 ? "" : "s"}
            </span>
          )
        }
      />

      <div style={overviewStrip}>
        <InfoField label="Active restrictions" value={flags.flags.length} />
        <InfoField
          label="Active consents"
          value={consentsRead === "ok" ? activeConsents.length : "Unavailable"}
        />
        <InfoField
          label="Part 2 status"
          value={
            flags.sudRestricted
              ? flags.sudDisclosable
                ? "Disclosure permitted"
                : "Restricted"
              : "Not flagged"
          }
        />
        <InfoField label="Snapshot date" value={dateOnly(flags.capturedAt)} />
      </div>

      <Card title="Active restrictions">
        {flags.flags.length === 0 ? (
          <div style={positiveState}>
            <span style={positiveStateIcon} aria-hidden="true">
              ✓
            </span>
            <div>
              <strong style={recordTitle}>No active privacy restrictions</strong>
              <p style={emptyPanelText}>
                No patient privacy flag currently limits disclosure on this chart.
              </p>
            </div>
          </div>
        ) : (
          <div style={restrictionGrid}>
            {flags.sudRestricted ? (
              <div style={restrictionCardDanger}>
                <div style={recordTitleRow}>
                  <span style={badge("danger")}>restricted</span>
                  <strong style={recordTitle}>{flagLabel("sud")}</strong>
                </div>
                <p style={cardIntro}>42 CFR Part 2 protections apply to substance-use records.</p>
              </div>
            ) : null}

            {nonSud.map((flag) => (
              <div key={flag} style={restrictionCardWarning}>
                <div style={recordTitleRow}>
                  <span style={badge("warning")}>restricted</span>
                  <strong style={recordTitle}>{flagLabel(flag)}</strong>
                </div>
              </div>
            ))}
          </div>
        )}

        {flags.capturedAt ? (
          <p style={helperNote}>
            Restriction snapshot captured {dateOnly(flags.capturedAt)} and recomputed from consent
            state.
          </p>
        ) : null}
      </Card>

      {flags.sudRestricted ? (
        <Card title="Substance use · 42 CFR Part 2">
          {flags.sudDisclosable ? (
            <div style={positiveState}>
              <span style={positiveStateIcon} aria-hidden="true">
                ✓
              </span>
              <div>
                <strong style={recordTitle}>Disclosure is permitted for authorized care</strong>
                <p style={emptyPanelText}>
                  A qualifying Part 2 consent is on file for this patient.
                </p>
              </div>
            </div>
          ) : (
            <SealedBlock message="Substance-use (42 CFR Part 2) records are restricted. Disclosure requires a §2.31 Part 2 consent on file; none is active for this patient." />
          )}
        </Card>
      ) : null}

      <Card title="Consents">
        {consentsRead !== "ok" ? (
          <ReadNotice
            status={consentsRead}
            subject="consent records"
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <>
            <SubsectionHeader
              title="Active consents"
              description="Consent records currently in force."
              count={activeConsents.length}
            />

            {activeConsents.length === 0 ? (
              <EmptyPanel
                title="No active consents"
                description="No active consent record is currently available."
              />
            ) : (
              <div style={recordList}>
                {activeConsents.map((consent) => (
                  <div key={consent.id} style={recordRow}>
                    <div style={recordRowMain}>
                      <div style={recordTitleRow}>
                        <strong style={recordTitle}>{titleCase(consent.typeKey)}</strong>
                        <StatusPill
                          label={titleCase(consent.status)}
                          tone={consentTone(consent.status)}
                        />
                      </div>
                      <div style={recordMeta}>
                        Effective {dateOnly(consent.effectiveAt)}
                        {consent.expiresAt
                          ? ` · expires ${dateOnly(consent.expiresAt)}`
                          : " · no expiry"}
                        {consent.grantorKind ? ` · ${titleCase(consent.grantorKind)}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {otherConsents.length > 0 ? (
              <details style={{ ...detailsBlock, marginTop: "1rem" }}>
                <summary style={detailsSummary}>
                  Other consent records ({otherConsents.length})
                </summary>
                <div style={{ ...recordList, marginTop: "0.75rem" }}>
                  {otherConsents.map((consent) => (
                    <div key={consent.id} style={recordRowMuted}>
                      <div>
                        <strong>{titleCase(consent.typeKey)}</strong>
                        <div style={recordMeta}>
                          Effective {dateOnly(consent.effectiveAt)}
                          {consent.expiresAt ? ` · expires ${dateOnly(consent.expiresAt)}` : ""}
                        </div>
                      </div>
                      <StatusPill
                        label={titleCase(consent.status)}
                        tone={consentTone(consent.status)}
                      />
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </>
        )}
      </Card>

      {canAdministerPrivacy ? (
        <p style={helperNote}>
          <Link to={`/patients/${patientId}/privacy`}>Open the privacy officer view</Link> — where
          each restriction came from, the WardenLens detections behind it, and re-sync from
          consents.
        </p>
      ) : null}

      <p style={helperNote}>
        Privacy detail fails closed: when disclosure authority is absent or unknown, protected
        information remains sealed rather than appearing blank.
      </p>
    </div>
  );
}

const identityHero = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1.25rem",
  marginBottom: "1rem",
  padding: "1.15rem 1.25rem",
  border: "1px solid color-mix(in srgb, var(--color-primary) 24%, var(--color-outline-variant))",
  borderRadius: "var(--radius-xl, 1rem)",
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 8%, var(--color-surface)) 0%, var(--color-surface) 72%)",
} as const;

const identityHeroMain = {
  display: "flex",
  alignItems: "center",
  gap: "0.9rem",
  minWidth: 0,
} as const;

const identityMonogram = {
  display: "grid",
  width: "3.25rem",
  height: "3.25rem",
  flex: "0 0 auto",
  placeItems: "center",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  fontSize: "1rem",
  fontWeight: 750,
  letterSpacing: "0.04em",
} as const;

const identityName = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-display)",
  fontSize: "1.15rem",
  fontWeight: 650,
  lineHeight: 1.25,
} as const;

const identityMeta = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.35rem",
  marginTop: "0.3rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
  lineHeight: 1.45,
} as const;

const identityMrn = {
  display: "flex",
  flex: "0 0 auto",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "0.25rem",
  paddingLeft: "1rem",
  borderLeft: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
} as const;

const identityMrnValue = {
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.9rem",
  fontWeight: 700,
} as const;

const detailGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  gap: "0 1.25rem",
} as const;

const detailItem = {
  minWidth: 0,
  padding: "0.65rem 0",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 38%, transparent)",
} as const;

const detailItemLabel = {
  display: "block",
  marginBottom: "0.25rem",
  color: "var(--color-muted)",
  fontSize: "0.68rem",
  fontWeight: 700,
} as const;

const detailItemValue = {
  color: "var(--color-on-surface)",
  fontSize: "0.88rem",
  fontWeight: 620,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
} as const;

const detailItemHint = {
  marginTop: "0.18rem",
  color: "var(--color-muted)",
  fontSize: "0.72rem",
  lineHeight: 1.4,
} as const;

const missingValue = {
  color: "var(--color-muted)",
  fontWeight: 500,
  fontStyle: "italic",
} as const;

const sectionDivider = {
  height: "1px",
  margin: "1rem 0",
  background: "color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
} as const;

const identifierRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  minWidth: 0,
  padding: "0.85rem 0.9rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const identifierValue = {
  marginTop: "0.38rem",
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.88rem",
  fontWeight: 650,
} as const;

const identifierMetaColumn = {
  display: "flex",
  flex: "0 0 auto",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "0.2rem",
  color: "var(--color-muted)",
  fontSize: "0.72rem",
  lineHeight: 1.4,
  textAlign: "right",
} as const;

const modalForm = {
  display: "flex",
  maxHeight: "min(82vh, 760px)",
  flexDirection: "column",
  overflow: "hidden",
} as const;

const modalHeader = {
  flex: "0 0 auto",
  padding: "1.25rem 1.35rem 1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
} as const;

const modalTitle = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-display)",
  fontSize: "1.2rem",
  fontWeight: 650,
} as const;

const modalLead = {
  maxWidth: "44rem",
  margin: "0.35rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
  lineHeight: 1.5,
} as const;

const modalBody = {
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  gap: "1.1rem",
  minHeight: 0,
  padding: "1rem 1.35rem 1.25rem",
  overflowY: "auto",
} as const;

const modalSection = {
  display: "flex",
  flexDirection: "column",
  gap: "0.85rem",
  padding: "1rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-container-low, var(--color-surface-container))",
} as const;

const modalSectionTitle = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  fontWeight: 700,
} as const;

const modalSectionDescription = {
  margin: "0.2rem 0 0",
  color: "var(--color-muted)",
  fontSize: "0.74rem",
  lineHeight: 1.45,
} as const;

const modalFormGridTwo = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: "0.8rem",
} as const;

const modalFooter = {
  display: "flex",
  flex: "0 0 auto",
  justifyContent: "flex-end",
  gap: "0.55rem",
  padding: "0.9rem 1.35rem 1.05rem",
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  background: "var(--color-surface)",
} as const;

const formHint = {
  color: "var(--color-muted)",
  fontSize: "0.72rem",
  lineHeight: 1.4,
} as const;

const requiredLabel = {
  color: "var(--color-primary)",
  fontSize: "0.68rem",
  fontWeight: 650,
} as const;

const assignmentRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  minWidth: 0,
  padding: "0.85rem 0.9rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const assignmentPerson = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  minWidth: 0,
} as const;

const assignmentName = {
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  fontWeight: 700,
  overflowWrap: "anywhere",
} as const;

const assignmentRoleText = {
  marginTop: "0.18rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
  lineHeight: 1.4,
} as const;

const assignmentMeta = {
  display: "flex",
  flex: "0 0 auto",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "0.3rem",
  color: "var(--color-muted)",
  fontSize: "0.72rem",
  textAlign: "right",
} as const;

const caregiverRow = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  minWidth: 0,
  padding: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const assignmentModal = {
  display: "flex",
  maxHeight: "min(78vh, 640px)",
  flexDirection: "column",
  overflow: "visible",
} as const;

const assignmentModalBody = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1.15rem 1.35rem 1.3rem",
  overflow: "visible",
} as const;

const rolePickerRoot = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  minWidth: 0,
} as const;

const rolePickerButton = {
  display: "flex",
  width: "100%",
  minHeight: "2.75rem",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.6rem 0.75rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 75%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  cursor: "pointer",
  font: "inherit",
  fontSize: "0.85rem",
  fontWeight: 600,
  textAlign: "left",
} as const;

const rolePickerButtonOpen = {
  borderColor: "var(--color-primary)",
  boxShadow: "0 0 0 3px color-mix(in srgb, var(--color-primary) 13%, transparent)",
} as const;

const rolePickerChevron = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
} as const;

const rolePickerMenu = {
  position: "absolute",
  zIndex: 120,
  top: "4.35rem",
  left: 0,
  right: 0,
  display: "flex",
  maxHeight: "17rem",
  flexDirection: "column",
  overflowY: "auto",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 70%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
  boxShadow: "var(--shadow-float)",
} as const;

const rolePickerOption = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.7rem 0.8rem",
  border: "none",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 38%, transparent)",
  background: "transparent",
  color: "var(--color-on-surface)",
  cursor: "pointer",
  font: "inherit",
  fontSize: "0.82rem",
  fontWeight: 600,
  textAlign: "left",
} as const;

const rolePickerOptionSelected = {
  background: "color-mix(in srgb, var(--color-primary) 10%, var(--color-surface))",
  color: "var(--color-primary)",
} as const;

const rolePickerOptionHovered = {
  background: "var(--color-surface-container)",
} as const;

const rolePickerCheck = {
  color: "var(--color-primary)",
  fontWeight: 800,
} as const;

const tabPage = {
  width: "100%",
  maxWidth: "1180px",
  margin: "0 auto",
  paddingBottom: "2rem",
} as const;

const sectionHeader = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  marginBottom: "1.25rem",
} as const;

const sectionHeaderAction = {
  flex: "0 0 auto",
  paddingTop: "0.2rem",
} as const;

const sectionEyebrow = {
  marginBottom: "0.3rem",
  color: "var(--color-primary)",
  fontSize: "0.72rem",
  fontWeight: 700,
} as const;

const sectionTitle = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-display)",
  fontSize: "1.35rem",
  fontWeight: 600,
  lineHeight: 1.2,
} as const;

const sectionDescription = {
  maxWidth: "760px",
  margin: "0.4rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.88rem",
  lineHeight: 1.55,
} as const;

const subsectionHeader = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "0.75rem",
  marginBottom: "0.85rem",
} as const;

const subsectionTitleRow = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
} as const;

const subsectionTitle = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  fontWeight: 650,
} as const;

const subsectionDescription = {
  margin: "0.2rem 0 0",
  color: "var(--color-muted)",
  fontSize: "0.78rem",
  lineHeight: 1.45,
} as const;

const countBadge = {
  display: "inline-grid",
  minWidth: "1.45rem",
  height: "1.45rem",
  placeItems: "center",
  padding: "0 0.35rem",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.72rem",
  fontWeight: 700,
} as const;

const overviewStrip = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: "0.75rem",
  marginBottom: "1rem",
} as const;

const infoGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "0.8rem",
} as const;

const infoField = {
  minWidth: 0,
  padding: "0.75rem 0.8rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container-low, var(--color-surface-container))",
} as const;

const infoFieldLabel = {
  display: "block",
  marginBottom: "0.25rem",
  color: "var(--color-muted)",
  fontSize: "0.7rem",
  fontWeight: 650,
} as const;

const infoFieldValue = {
  color: "var(--color-on-surface)",
  fontSize: "0.88rem",
  fontWeight: 650,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
} as const;

const infoFieldHint = {
  marginTop: "0.2rem",
  color: "var(--color-muted)",
  fontSize: "0.72rem",
  lineHeight: 1.35,
} as const;

const twoColumnGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 24rem), 1fr))",
  gap: "1rem",
  alignItems: "start",
  marginBottom: "1rem",
} as const;

const stack = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  minWidth: 0,
} as const;

const recordList = {
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
} as const;

const recordRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  minWidth: 0,
  padding: "0.75rem 0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const recordRowMuted = {
  ...recordRow,
  background: "var(--color-surface-container-low, var(--color-surface-container))",
  color: "var(--color-on-surface-variant)",
} as const;

const highlightedRow = {
  borderColor: "color-mix(in srgb, var(--color-primary) 40%, var(--color-outline-variant))",
  background: "color-mix(in srgb, var(--color-primary) 5%, var(--color-surface))",
} as const;

const recordRowMain = {
  minWidth: 0,
  flex: 1,
} as const;

const recordTitleRow = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.4rem",
  minWidth: 0,
} as const;

const recordTitle = {
  color: "var(--color-on-surface)",
  fontSize: "0.87rem",
  fontWeight: 650,
} as const;

const recordValue = {
  marginTop: "0.3rem",
  color: "var(--color-on-surface)",
  fontSize: "0.84rem",
  lineHeight: 1.45,
} as const;

const recordMeta = {
  marginTop: "0.25rem",
  color: "var(--color-muted)",
  fontSize: "0.74rem",
  lineHeight: 1.4,
} as const;

const emptyPanel = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.85rem",
  border: "1px dashed color-mix(in srgb, var(--color-outline-variant) 70%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container-low, var(--color-surface-container))",
} as const;

const emptyPanelIcon = {
  display: "grid",
  flex: "0 0 auto",
  width: "1.75rem",
  height: "1.75rem",
  placeItems: "center",
  borderRadius: "9999px",
  background: "var(--color-surface-container)",
  color: "var(--color-muted)",
  fontWeight: 700,
} as const;

const emptyPanelTitle = {
  display: "block",
  color: "var(--color-on-surface)",
  fontSize: "0.84rem",
  fontWeight: 650,
} as const;

const emptyPanelText = {
  margin: "0.2rem 0 0",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.78rem",
  lineHeight: 1.45,
} as const;

const helperNote = {
  margin: "0.75rem 0 0",
  color: "var(--color-muted)",
  fontSize: "0.75rem",
  lineHeight: 1.5,
} as const;

const cardIntro = {
  margin: "0 0 0.85rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
  lineHeight: 1.5,
} as const;

const detailsBlock = {
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  marginTop: "0.9rem",
  paddingTop: "0.75rem",
} as const;

const detailsSummary = {
  cursor: "pointer",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
  fontWeight: 600,
} as const;

const addressLayout = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.3fr) minmax(300px, 0.7fr)",
  gap: "1rem",
  alignItems: "start",
} as const;

const addressRecordCard = {
  padding: "0.85rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const addressRecordPrimary = {
  borderColor: "color-mix(in srgb, var(--color-primary) 45%, var(--color-outline-variant))",
  background: "color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))",
} as const;

const addressText = {
  marginTop: "0.45rem",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  fontWeight: 600,
  lineHeight: 1.45,
} as const;

const addressForm = {
  display: "flex",
  flexDirection: "column",
  gap: "0.8rem",
  fontSize: "0.85rem",
} as const;

const fieldGroup = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
  minWidth: 0,
} as const;

const fieldLabel = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.76rem",
  fontWeight: 650,
} as const;

const optionalLabel = {
  color: "var(--color-muted)",
  fontSize: "0.68rem",
  fontWeight: 500,
} as const;

const input = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.62rem 0.7rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 70%, transparent)",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  outline: "none",
} as const;

const formGridTwo = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0.7rem",
} as const;

const formGridThree = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 2fr) minmax(80px, 0.7fr) minmax(110px, 1fr)",
  gap: "0.7rem",
} as const;

const primaryToggle = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  minHeight: "42px",
  padding: "0.55rem 0.65rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container-low, var(--color-surface-container))",
  color: "var(--color-on-surface)",
  cursor: "pointer",
} as const;

const warningNote = {
  padding: "0.65rem 0.75rem",
  border: "1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-warning) 8%, var(--color-surface))",
  color: "var(--color-on-surface)",
  fontSize: "0.78rem",
  lineHeight: 1.45,
} as const;

const errorNote = {
  padding: "0.65rem 0.75rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 40%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  color: "var(--color-error)",
  fontSize: "0.78rem",
  lineHeight: 1.45,
} as const;

const primaryButton = {
  alignSelf: "flex-start",
  padding: "0.55rem 0.95rem",
  border: "none",
  borderRadius: "9999px",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  cursor: "pointer",
  fontSize: "0.82rem",
  fontWeight: 650,
} as const;

const secondaryLinkButton = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  padding: "0.5rem 0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
  borderRadius: "9999px",
  background: "var(--color-surface)",
  color: "var(--color-on-surface)",
  textDecoration: "none",
  fontSize: "0.78rem",
  fontWeight: 650,
} as const;

const coverageGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
  gap: "0.75rem",
} as const;

const coverageCard = {
  padding: "0.85rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const coverageCardPrimary = {
  borderColor: "color-mix(in srgb, var(--color-primary) 45%, var(--color-outline-variant))",
  background: "color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))",
} as const;

const coverageCardTitle = {
  color: "var(--color-on-surface)",
  fontSize: "0.92rem",
  fontWeight: 700,
} as const;

const coverageFacts = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "0.55rem",
  marginTop: "0.75rem",
} as const;

const snapshotHeader = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  marginBottom: "0.85rem",
} as const;

const inlineLoading = {
  display: "flex",
  alignItems: "center",
  gap: "0.7rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.82rem",
} as const;

const successDot = {
  display: "grid",
  width: "1.45rem",
  height: "1.45rem",
  flex: "0 0 auto",
  placeItems: "center",
  borderRadius: "9999px",
  background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
  color: "var(--color-success)",
  fontSize: "0.72rem",
  fontWeight: 800,
} as const;

const codeChip = {
  padding: "0.15rem 0.35rem",
  borderRadius: "0.35rem",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
} as const;

const identifierSummaryCard = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "0.35rem 0.75rem",
  alignItems: "center",
  padding: "0.75rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container-low, var(--color-surface-container))",
} as const;

const identifierSummaryValue = {
  color: "var(--color-on-surface)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.9rem",
  fontWeight: 700,
} as const;

const contactLine = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem 0.8rem",
  marginTop: "0.35rem",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8rem",
} as const;

const contactCard = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.85rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface)",
} as const;

const contactPriority = {
  display: "grid",
  width: "1.75rem",
  height: "1.75rem",
  flex: "0 0 auto",
  placeItems: "center",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  fontSize: "0.72rem",
  fontWeight: 750,
} as const;

const inlineCode = {
  padding: "0.1rem 0.25rem",
  borderRadius: "0.25rem",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.78rem",
} as const;

const restrictionGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
  gap: "0.75rem",
} as const;

const restrictionCardWarning = {
  padding: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-warning) 6%, var(--color-surface))",
} as const;

const restrictionCardDanger = {
  padding: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 6%, var(--color-surface))",
} as const;

const positiveState = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.85rem",
  border: "1px solid color-mix(in srgb, var(--color-success) 35%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-success) 6%, var(--color-surface))",
} as const;

const positiveStateIcon = {
  display: "grid",
  width: "1.8rem",
  height: "1.8rem",
  flex: "0 0 auto",
  placeItems: "center",
  borderRadius: "9999px",
  background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
  color: "var(--color-success)",
  fontWeight: 800,
} as const;

// Category chip (No-Line, theme-reactive): a semantic tone → tonal background + on-tone text.
type ChipTone = "primary" | "success" | "warning" | "danger" | "neutral";

const CHIP_BG: Record<ChipTone, string> = {
  primary: "var(--color-primary-tint)",
  success: "color-mix(in srgb, var(--color-success) 12%, transparent)",
  warning: "color-mix(in srgb, var(--color-warning) 14%, transparent)",
  danger: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  neutral: "var(--color-surface-container)",
};

const CHIP_FG: Record<ChipTone, string> = {
  primary: "var(--color-primary)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-error)",
  neutral: "var(--color-on-surface-variant)",
};

const badge = (tone: ChipTone) =>
  ({
    background: CHIP_BG[tone],
    color: CHIP_FG[tone],
    borderRadius: "9999px",
    padding: "0.1rem 0.5rem",
    fontSize: "0.7rem",
    fontWeight: 650,
    whiteSpace: "nowrap",
  }) as const;

const cardGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
  gap: "1rem",
  alignItems: "start",
  marginBottom: "1rem",
} as const;

const dt = { color: "var(--color-on-surface-variant)", margin: 0 } as const;
const dd = { margin: 0 } as const;
const grid = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "0.4rem 1rem",
  fontSize: "0.9rem",
  margin: "0.25rem 0 0",
} as const;
const h3 = {
  fontSize: "0.92rem",
  margin: "1.25rem 0 0.4rem",
  color: "var(--color-on-surface)",
} as const;
const th = { padding: "0.3rem 0.5rem", fontWeight: 500 } as const;
const td = { padding: "0.3rem 0.5rem" } as const;
