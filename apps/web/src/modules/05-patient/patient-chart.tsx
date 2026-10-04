import {
  CenteredStatusLayout,
  LoadingSpinner,
  MaskedIdentifier,
  PatientBanner,
  PatientWorkspaceLayout,
  SealedBlock,
  StatusPill,
  type StatusTone,
  ageYears,
  cardSurface,
  useApiClient,
  useToast,
} from "@wardenx/ui";

import type { paths } from "@wardenx/ui";

// apps/web/src/modules/05-patient — Patient Chart (M5, Track A).

// Spec: docs/design/screens/clinical/WARDENX_UI_PATIENT_CHART.md — "Use Patient Workspace."

// The patient-scoped hub: sticky Patient Banner + a module nav rail + a center summary. This builds

// the M5 FRAME (banner + summary) plus the M5-owned Demographics & Identifiers tab (FB-T06); the

// cross-module tabs (Encounters, Orders, eMAR, …) graft on as those modules land (Track B). Backed by

// GET /api/v1/patients/:id (+ /demographics, /identifiers) via the typed client.

import { useCallback, useEffect, useState } from "react";

import { Link, useParams, useSearchParams } from "react-router-dom";

import type { FormEvent, JSX, ReactNode } from "react";

import { STATUS_TONE, statusLabel } from "./patient-status";

import { ClinicalRail, ClinicalTab, useClinicalData } from "./patient-clinical";
import {
  OverviewRail,
  OverviewTab,
  PatientChartHeader,
  usePatientChartData,
} from "./patient-overview";

import { ChartModuleRail, type ChartSection } from "../../shell/chart-module-rail";
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

// Module-nav-rail icons. The P0 frame (wardenx-P0-foundation.pen `fQjjh`) pairs every rail row with a

// Material-Symbols glyph; the shared @wardenx/ui Glyph kit is a small curated set without these

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

  return <PatientChartReady patient={state.patient} section={currentSection} />;
}

/** The loaded chart: redesigned header + tab strip, the Overview (with its right rail) or a record sub-view. */
function PatientChartReady({
  patient: p,
  section,
}: {
  patient: PatientSummary;
  section: ChartSection;
}): JSX.Element {
  const data = usePatientChartData(p);
  const clinical = useClinicalData(p.id, data, section === "clinical");
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
            <DemographicsTab patientId={p.id} />
          ) : section === "addresses" ? (
            <AddressesTab patientId={p.id} />
          ) : section === "coverage" ? (
            <CoverageTab patientId={p.id} />
          ) : section === "care-team" ? (
            <CareTeamTab patientId={p.id} />
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

function DemographicsTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [demographics, setDemographics] = useState<Demographics | null>(null);
  const [identifiers, setIdentifiers] = useState<Identifier[] | null>(null);
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
  const orDash = (value: string | null) => (value?.trim() ? value : "—");
  const codeList = (values: string[]) => (values.length ? values.join(", ") : "—");
  const legalName = [d.legalFirstName, d.legalMiddleName, d.legalLastName, d.legalNameSuffix]
    .filter(Boolean)
    .join(" ");
  const activeIdentifiers = identifiers.filter((item) => !item.effectiveTo);
  const historicalIdentifiers = identifiers.filter((item) => Boolean(item.effectiveTo));

  return (
    <div style={tabPage}>
      <SectionHeader
        eyebrow="Patient identity"
        title="Demographics & Identifiers"
        description="Core identity, demographic attributes and identifiers used across the patient chart."
      />

      <div style={overviewStrip}>
        <InfoField label="Legal name" value={legalName || "—"} />
        <InfoField label="Date of birth" value={dateOnly(d.dob)} />
        <InfoField label="Preferred language" value={orDash(d.preferredLanguageCode)} />
        <InfoField label="MRN" value={d.mrn} mono />
      </div>

      <div style={twoColumnGrid}>
        <Card title="Identity">
          <InfoGrid>
            <InfoField label="Legal name" value={legalName || "—"} />
            <InfoField
              label="Aliases"
              value={
                d.aliases.length === 0
                  ? "None recorded"
                  : d.aliases
                      .map(
                        (alias) =>
                          `${alias.fullName ?? [alias.firstName, alias.lastName].filter(Boolean).join(" ")} · ${titleCase(alias.kind)}`,
                      )
                      .join("; ")
              }
            />
          </InfoGrid>
        </Card>

        <Card title="Demographic profile">
          <InfoGrid>
            <InfoField label="Sex assigned at birth" value={orDash(d.sexAssignedAtBirth)} />
            <InfoField label="Gender identity" value={orDash(d.genderIdentityCode)} />
            <InfoField label="Sexual orientation" value={orDash(d.sexualOrientationCode)} />
            <InfoField label="Pronouns" value={orDash(d.pronounsCode)} />
            <InfoField label="Marital status" value={orDash(d.maritalStatusCode)} />
            <InfoField label="Preferred language" value={orDash(d.preferredLanguageCode)} />
            <InfoField label="Race" value={codeList(d.raceCodes)} />
            <InfoField label="Ethnicity" value={codeList(d.ethnicityCodes)} />
          </InfoGrid>

          <p style={helperNote}>
            SOGI, race and ethnicity values are stored as USCDI codes until M38 display-label
            resolution is connected.
          </p>
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
              <div key={identifier.id} style={recordRow}>
                <div style={recordRowMain}>
                  <div style={recordTitleRow}>
                    <strong style={recordTitle}>{identifier.kind.toUpperCase()}</strong>
                    {identifier.kind === "mrn" ? (
                      <span style={badge("neutral")}>immutable</span>
                    ) : null}
                    {identifier.sensitive ? <span style={badge("warning")}>sensitive</span> : null}
                  </div>

                  <div style={recordValue}>
                    {identifier.sensitive ? (
                      <MaskedIdentifier
                        value=""
                        masked={`xxx-xx-${identifier.last4 ?? "####"}`}
                        label={`${identifier.kind.toUpperCase()} (masked)`}
                      />
                    ) : (
                      orDash(identifier.value)
                    )}
                  </div>

                  <div style={recordMeta}>
                    {identifier.issuer ? `Issuer: ${identifier.issuer}` : "No issuer recorded"} ·
                    active since {dateOnly(identifier.effectiveFrom)}
                  </div>
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
                      : orDash(identifier.value)}
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
                      <strong style={{ textTransform: "capitalize" }}>{address.kind}</strong>
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
                        <strong style={{ textTransform: "capitalize" }}>{address.kind}</strong>
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

// DISPLAY NAME crosses into M2 — the M2 roster does not yet expose user names (FB-T12 / M34), so an

// assignment shows its role + the short user id honestly rather than a fabricated name. `current`

// (open) rows render above closed ones.

interface Assignment {
  id: string;

  clinicianUserId: string;

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

  attending_clinician: "Attending clinician",

  case_manager_msw: "Case manager (MSW)",

  chaplain: "Chaplain",

  aide: "Aide",

  np: "NP",

  md: "MD",

  volunteer: "Volunteer",

  bereavement: "Bereavement",
};

const roleLabel = (r: string) => ROLE_LABELS[r] ?? r;

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function CareTeamTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [team, setTeam] = useState<CareTeam | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    (async () => {
      setStatus("loading");
      const res = await client.GET("/api/v1/patients/{id}/care-team", {
        params: { path: { id: patientId } },
      });

      if (!active) return;

      if (res.error || !res.data) {
        setStatus("error");
        return;
      }

      setTeam(res.data as CareTeam);
      setStatus("ready");
    })();

    return () => {
      active = false;
    };
  }, [client, patientId]);

  if (status === "loading") return <LoadingSpinner />;

  if (status === "error" || team === null) {
    return (
      <EmptyPanel
        title="Care team unavailable"
        description="Care team assignments and caregiver information could not be loaded."
      />
    );
  }

  const assignments = [...team.assignments].sort((a, b) => Number(b.current) - Number(a.current));
  const activeAssignments = assignments.filter((assignment) => assignment.current);
  const pastAssignments = assignments.filter((assignment) => !assignment.current);
  const caregivers = team.caregivers.filter((caregiver) => caregiver.current);
  const pastCaregivers = team.caregivers.filter((caregiver) => !caregiver.current);
  const emergencyContacts = [...team.emergencyContacts].sort((a, b) => a.priority - b.priority);
  const primaryRn = activeAssignments.find((assignment) => assignment.role === "primary_rn");
  const primaryCaregiver = caregivers.find((caregiver) => caregiver.isPrimary);

  return (
    <div style={tabPage}>
      <SectionHeader
        eyebrow="People involved in care"
        title="Care Team & Assignments"
        description="Clinical assignments, caregivers, legal representatives and emergency contacts in one place."
      />

      <div style={overviewStrip}>
        <InfoField
          label="Primary RN"
          value={primaryRn ? roleLabel(primaryRn.role) : "Not assigned"}
          hint={primaryRn ? `Clinician ${primaryRn.clinicianUserId.slice(0, 8)}…` : undefined}
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

      <div style={twoColumnGrid}>
        <Card title="Clinical assignments">
          <SubsectionHeader
            title="Active care team"
            description="Current clinical roles assigned to this patient."
            count={activeAssignments.length}
          />

          {activeAssignments.length === 0 ? (
            <EmptyPanel
              title="No active assignments"
              description="No clinicians are currently assigned to this patient."
            />
          ) : (
            <div style={recordList}>
              {activeAssignments.map((assignment) => (
                <div
                  key={assignment.id}
                  style={{
                    ...recordRow,
                    ...(assignment.role === "primary_rn" ? highlightedRow : {}),
                  }}
                >
                  <div style={recordRowMain}>
                    <div style={recordTitleRow}>
                      <strong style={recordTitle}>{roleLabel(assignment.role)}</strong>
                      {assignment.role === "primary_rn" ? (
                        <span style={badge("primary")}>primary RN</span>
                      ) : null}
                    </div>
                    <div style={recordValue} title={`M2 user ${assignment.clinicianUserId}`}>
                      Clinician{" "}
                      <code style={inlineCode}>{assignment.clinicianUserId.slice(0, 8)}…</code>
                    </div>
                    <div style={recordMeta}>Assigned {dateOnly(assignment.assignedAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

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
              {caregivers.map((caregiver) => (
                <div
                  key={caregiver.id}
                  style={{
                    ...recordRow,
                    ...(caregiver.isPrimary ? highlightedRow : {}),
                  }}
                >
                  <div style={recordRowMain}>
                    <div style={recordTitleRow}>
                      <strong style={recordTitle}>
                        {caregiver.firstName} {caregiver.lastName}
                      </strong>
                      <span style={badge("success")}>{titleCase(caregiver.relationship)}</span>
                      {caregiver.isPrimary ? <span style={badge("primary")}>primary</span> : null}
                      {caregiver.isLegalRepresentative ? (
                        <span style={badge("warning")}>legal representative</span>
                      ) : null}
                    </div>

                    {caregiver.phone || caregiver.email ? (
                      <div style={contactLine}>
                        {caregiver.phone ? <span>Phone · {caregiver.phone}</span> : null}
                        {caregiver.email ? <span>Email · {caregiver.email}</span> : null}
                      </div>
                    ) : (
                      <div style={recordMeta}>No contact details recorded</div>
                    )}

                    {caregiver.isLegalRepresentative ? (
                      <div style={recordMeta}>Authority: {titleCase(caregiver.lrAuthority)}</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="Emergency contacts">
        <SubsectionHeader
          title="Contact priority"
          description="Contacts are ordered by the sequence clinicians should use."
          count={emergencyContacts.length}
        />

        {emergencyContacts.length === 0 ? (
          <EmptyPanel
            title="No emergency contacts"
            description="No emergency contact has been recorded for this patient."
          />
        ) : (
          <div style={coverageGrid}>
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
                    <strong>{roleLabel(assignment.role)}</strong>
                    <div style={recordMeta}>
                      Clinician {assignment.clinicianUserId.slice(0, 8)}…
                    </div>
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

      <p style={helperNote}>
        Clinician display names remain represented by their care-team role and clinician ID until
        the M2/M34 roster exposes staff names to this surface.
      </p>
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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;

    (async () => {
      setStatus("loading");
      const [privacyResult, consentResult] = await Promise.all([
        client.GET("/api/v1/patients/{id}/privacy-flags", {
          params: { path: { id: patientId } },
        }),
        client.GET("/api/v1/patients/{patientId}/consents", {
          params: { path: { patientId } },
        }),
      ]);

      if (!active) return;

      if (privacyResult.error || !privacyResult.data) {
        setStatus("error");
        return;
      }

      setFlags(privacyResult.data as PrivacyFlags);
      setConsents(
        consentResult.error || !consentResult.data
          ? []
          : ((consentResult.data as { data: ConsentRecord[] }).data ?? []),
      );
      setStatus("ready");
    })();

    return () => {
      active = false;
    };
  }, [client, patientId]);

  if (status === "loading") return <LoadingSpinner />;

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
    <div style={tabPage}>
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
        <InfoField label="Active consents" value={activeConsents.length} />
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
            <summary style={detailsSummary}>Other consent records ({otherConsents.length})</summary>
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
  letterSpacing: "0.08em",
  textTransform: "uppercase",
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
  letterSpacing: "0.02em",
  textTransform: "uppercase",
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
