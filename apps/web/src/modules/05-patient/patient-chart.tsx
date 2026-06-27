import {
  CenteredStatusLayout,
  LeftNavRail,
  LoadingSpinner,
  MaskedIdentifier,
  PatientBanner,
  PatientWorkspaceLayout,
  SealedBlock,
  StatusPill,
  type StatusTone,
  cardSurface,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/05-patient — Patient Chart (M5, Track A).
// Spec: docs/design/screens/clinical/WARDENX_UI_PATIENT_CHART.md — "Use Patient Workspace."
// The patient-scoped hub: sticky Patient Banner + a module nav rail + a center summary. This builds
// the M5 FRAME (banner + summary) plus the M5-owned Demographics & Identifiers tab (FB-T06); the
// cross-module tabs (Encounters, Orders, eMAR, …) graft on as those modules land (Track B). Backed by
// GET /api/v1/patients/:id (+ /demographics, /identifiers) via the typed client.
import { useEffect, useState } from "react";
import type { FormEvent, JSX, ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { STATUS_TONE, statusLabel } from "./patient-status";

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
type NavIconName =
  | "summary"
  | "person"
  | "pin"
  | "shield"
  | "groups"
  | "lock"
  | "carePlan"
  | "stethoscope"
  | "checklist"
  | "orders"
  | "pill"
  | "folder"
  | "cert"
  | "idg";

const NAV_ICON_PATHS: Record<NavIconName, string> = {
  summary: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20c0-4 4-6 8-6s8 2 8 6",
  pin: "M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  shield: "M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z",
  groups:
    "M8 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M2 20c0-3 2.7-5 6-5 M16 13a3 3 0 1 0 0-6 M14 15c3.3 0 6 2 6 5",
  lock: "M6 10V8a6 6 0 0 1 12 0v2 M5 10h14v10H5z",
  carePlan: "M9 4h6v3H9z M7 5H5v15h14V5h-2 M9 11h6 M9 15h4",
  stethoscope:
    "M6 4v5a4 4 0 0 0 8 0V4 M10 16a4 4 0 0 0 8 0v-2 M18 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  checklist: "M4 6h9 M4 12h9 M4 18h9 M17 5l1.5 1.5L21 4 M17 11l1.5 1.5L21 10",
  orders: "M7 3h7l4 4v14H7z M14 3v4h4 M10 13h5 M10 17h5",
  pill: "M5 13l8-8a4 4 0 0 1 6 6l-8 8a4 4 0 0 1-6-6z M9 9l6 6",
  folder: "M3 6h6l2 2h10v11H3z",
  cert: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M8.5 12l2.5 2.5 4.5-5",
  idg: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 19c0-3 2.7-5 6-5s6 2 6 5 M16 11a3 3 0 0 0 0-6 M15 14c3 .2 5 2.2 5 5",
};

function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path d={NAV_ICON_PATHS[name]} />
    </svg>
  );
}

// Module nav rail (spec). Only sections whose module is built are active now; the rest are
// placeholders that light up in Track B as their module lands.
const NAV_SECTIONS: { label: string; ready: boolean; icon: NavIconName }[] = [
  { label: "Summary", ready: true, icon: "summary" },
  { label: "Demographics & Identifiers", ready: true, icon: "person" },
  { label: "Addresses", ready: true, icon: "pin" },
  { label: "Coverage / Payers", ready: true, icon: "shield" },
  { label: "Care Team & Assignments", ready: true, icon: "groups" },
  { label: "Privacy Flags", ready: true, icon: "lock" },
  { label: "Care Plan", ready: false, icon: "carePlan" },
  { label: "Encounters / Visits", ready: false, icon: "stethoscope" },
  { label: "Assessments", ready: false, icon: "checklist" },
  { label: "Orders", ready: false, icon: "orders" },
  { label: "Medications / eMAR", ready: false, icon: "pill" },
  { label: "Documents", ready: false, icon: "folder" },
  { label: "Election & Certification", ready: false, icon: "cert" },
  { label: "IDG History", ready: false, icon: "idg" },
];

export function PatientChart(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [section, setSection] = useState("Summary");
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

  const p = state.patient;
  const age = ageYears(p.dob);
  return (
    <PatientWorkspaceLayout
      banner={
        <PatientBanner
          name={`${p.firstName} ${p.lastName}`}
          meta={`DOB ${p.dob}${age != null ? ` · ${age}y` : ""}`}
          chips={
            <>
              {/* Identifier in the mono face (§3.1) + the lifecycle status as a §6.6 pill. The frame's
                  clinical flags (allergies, code status, benefit period) graft on as their modules land —
                  shown honestly, never fabricated. */}
              <MonoChip title="Medical record number">{p.mrn}</MonoChip>
              <StatusPill label={statusLabel(p.status)} tone={STATUS_TONE[p.status] ?? "neutral"} />
            </>
          }
          actions={
            <Link to="/messaging" style={MESSAGE_BTN}>
              Message
            </Link>
          }
        />
      }
    >
      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <LeftNavRail ariaLabel="Patient modules">
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.25rem",
            }}
          >
            {NAV_SECTIONS.map((s) => (
              <li
                key={s.label}
                role={s.ready ? "button" : undefined}
                tabIndex={s.ready ? 0 : undefined}
                onClick={s.ready ? () => setSection(s.label) : undefined}
                onKeyDown={
                  s.ready
                    ? (ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setSection(s.label);
                        }
                      }
                    : undefined
                }
                aria-current={s.ready && s.label === section ? "page" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.625rem",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "0.5rem",
                  fontSize: "0.8125rem",
                  color:
                    s.ready && s.label === section
                      ? "var(--color-primary)"
                      : s.ready
                        ? "var(--color-on-surface-variant)"
                        : "var(--color-muted)",
                  cursor: s.ready ? "pointer" : "default",
                  background:
                    s.ready && s.label === section ? "var(--color-primary-tint)" : "transparent",
                  fontWeight: s.ready && s.label === section ? 600 : 500,
                }}
                title={s.ready ? undefined : "Available when this module ships"}
              >
                <NavIcon name={s.icon} />
                {s.label}
              </li>
            ))}
          </ul>
        </LeftNavRail>
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          {section === "Demographics & Identifiers" ? (
            <DemographicsTab patientId={p.id} />
          ) : section === "Addresses" ? (
            <AddressesTab patientId={p.id} />
          ) : section === "Coverage / Payers" ? (
            <CoverageTab patientId={p.id} />
          ) : section === "Care Team & Assignments" ? (
            <CareTeamTab patientId={p.id} />
          ) : section === "Privacy Flags" ? (
            <PrivacyFlagsTab patientId={p.id} />
          ) : (
            <SummaryTab patient={p} />
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

// Summary view — reconciled to the P0 frame (wardenx-P0-foundation.pen `fQjjh`): a main column of
// Lantern §6.2 cards (At a glance · Active problems · Benefit period) beside a right rail of
// Alerts / Open tasks cards. The frame's clinical cards are populated by modules not yet built, so
// they render honest "arrives with module X" states rather than fabricated clinical content — the
// layout matches the design while the data stays truthful.
function SummaryTab({ patient }: { patient: PatientSummary }): JSX.Element {
  const age = ageYears(patient.dob);
  return (
    <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div
        style={{
          flex: "1 1 24rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          minWidth: 0,
        }}
      >
        <Card title="At a glance">
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "max-content 1fr",
              gap: "0.5rem 1.25rem",
              fontSize: "0.875rem",
              margin: 0,
            }}
          >
            <dt style={dt}>Status</dt>
            <dd style={dd}>
              <StatusPill
                label={statusLabel(patient.status)}
                tone={STATUS_TONE[patient.status] ?? "neutral"}
              />
            </dd>
            <dt style={dt}>MRN</dt>
            <dd style={{ ...dd, fontFamily: "var(--font-mono)" }}>{patient.mrn}</dd>
            <dt style={dt}>Date of birth</dt>
            <dd style={dd}>
              {patient.dob}
              {age != null ? ` · ${age}y` : ""}
            </dd>
          </dl>
        </Card>
        <Card title="Active problems">
          <EmptyNote>The problem list populates with the Care Plan module.</EmptyNote>
        </Card>
        <Card title="Benefit period &amp; deadlines">
          <EmptyNote>
            Certification windows and deadlines populate with the Admission module.
          </EmptyNote>
        </Card>
      </div>

      <aside
        style={{
          flex: "0 0 19rem",
          width: "19rem",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <Card title="Alerts">
          <EmptyNote>Clinical alerts surface here as their modules ship.</EmptyNote>
        </Card>
        <Card title="Open tasks">
          <EmptyNote>Task routing arrives with the Tasks module.</EmptyNote>
        </Card>
      </aside>
    </div>
  );
}

// Whole-years age from a YYYY-MM-DD DOB; null when unparseable or out of a sane range.
function ageYears(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}

// A mono identifier rendered as a tonal pill (§3.1 mono face on a No-Line surface-container chip).
function MonoChip({ children, title }: { children: ReactNode; title?: string }): JSX.Element {
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
function Card({ title, children }: { title: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section style={{ ...cardSurface, padding: "1.25rem 1.5rem" }}>
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
    <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
      {children}
    </p>
  );
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
        client.GET("/api/v1/patients/{id}/demographics", { params: { path: { id: patientId } } }),
        client.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patientId } } }),
      ]);
      if (!active) return;
      if (demo.error || !demo.data || ids.error || !ids.data) return setStatus("error");
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
      <p style={{ color: "var(--color-error)", fontSize: "0.9rem" }}>
        Demographics could not be loaded.
      </p>
    );
  }

  const d = demographics;
  const codes = (arr: string[]) => (arr.length ? arr.join(", ") : "—");
  const orDash = (v: string | null) => (v?.length ? v : "—");

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Demographics &amp; Identifiers</h2>

      <h3 style={h3}>Name</h3>
      <dl style={grid}>
        <dt style={dt}>Legal name</dt>
        <dd style={dd}>
          {[d.legalLastName, [d.legalFirstName, d.legalMiddleName].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(", ")}
          {d.legalNameSuffix ? ` ${d.legalNameSuffix}` : ""}
        </dd>
        <dt style={dt}>Aliases</dt>
        <dd style={dd}>
          {d.aliases.length === 0
            ? "—"
            : d.aliases
                .map(
                  (a) =>
                    `${a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(" ")} (${a.kind})`,
                )
                .join("; ")}
        </dd>
      </dl>

      <h3 style={h3}>Demographics</h3>
      <dl style={grid}>
        <dt style={dt}>Date of birth</dt>
        <dd style={dd}>{d.dob}</dd>
        <dt style={dt}>Sex assigned at birth</dt>
        <dd style={dd}>{orDash(d.sexAssignedAtBirth)}</dd>
        <dt style={dt}>Gender identity</dt>
        <dd style={dd}>{orDash(d.genderIdentityCode)}</dd>
        <dt style={dt}>Sexual orientation</dt>
        <dd style={dd}>{orDash(d.sexualOrientationCode)}</dd>
        <dt style={dt}>Pronouns</dt>
        <dd style={dd}>{orDash(d.pronounsCode)}</dd>
        <dt style={dt}>Marital status</dt>
        <dd style={dd}>{orDash(d.maritalStatusCode)}</dd>
        <dt style={dt}>Race</dt>
        <dd style={dd}>{codes(d.raceCodes)}</dd>
        <dt style={dt}>Ethnicity</dt>
        <dd style={dd}>{codes(d.ethnicityCodes)}</dd>
        <dt style={dt}>Preferred language</dt>
        <dd style={dd}>{orDash(d.preferredLanguageCode)}</dd>
      </dl>
      <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.3rem 0 0" }}>
        SOGI / race / ethnicity values are USCDI codes; M38 resolves them to display labels.
      </p>

      <h3 style={h3}>Identifiers</h3>
      <table
        style={{ borderCollapse: "collapse", fontSize: "0.85rem", width: "100%", maxWidth: 560 }}
      >
        <thead>
          <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
            <th style={th}>Type</th>
            <th style={th}>Value</th>
            <th style={th}>Issuer</th>
          </tr>
        </thead>
        <tbody>
          {identifiers.map((i) => (
            <tr
              key={i.id}
              style={{
                borderTop:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
              }}
            >
              <td style={td}>
                {i.kind.toUpperCase()}
                {i.kind === "mrn" ? (
                  <span
                    style={{ color: "var(--color-muted)" }}
                    title="MRN is immutable after creation"
                  >
                    {" "}
                    · immutable
                  </span>
                ) : null}
              </td>
              <td style={td}>
                {i.sensitive ? (
                  // §3.3/§8 masked identifier — read-only mask (no onReveal until the M5 SSN
                  // decryption follow-up wires the phi.read_ssn step-up).
                  <MaskedIdentifier
                    value="" // full value lives server-side (envelope-encrypted); never sent until reveal
                    masked={`xxx-xx-${i.last4 ?? "####"}`}
                    label={`${i.kind.toUpperCase()} (masked)`}
                  />
                ) : (
                  orDash(i.value)
                )}
              </td>
              <td style={td}>{orDash(i.issuer)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.4rem 0 0" }}>
        SSN / state-ID are envelope-encrypted and shown masked; full reveal requires the
        <code style={{ margin: "0 0.25rem" }}>phi.read_ssn</code> permission.
      </p>
    </>
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

  async function load(active = { v: true }) {
    setStatus("loading");
    const res = await client.GET("/api/v1/patients/{id}/addresses", {
      params: { path: { id: patientId } },
    });
    if (!active.v) return;
    if (res.error || !res.data) return setStatus("error");
    setAddresses((res.data as { addresses: Address[] }).addresses);
    setStatus("ready");
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load is recreated each render from client+patientId; depending on those is the intended trigger.
  useEffect(() => {
    const active = { v: true };
    void load(active);
    return () => {
      active.v = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, patientId]);

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
    if (res.error)
      return setSaveError("Could not save the address. Check the fields and try again.");
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
      <p style={{ color: "var(--color-error)", fontSize: "0.9rem" }}>
        Addresses could not be loaded.
      </p>
    );
  }

  const current = addresses.filter((a) => a.current);
  const history = addresses.filter((a) => !a.current);

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Addresses</h2>

      <h3 style={h3}>Current</h3>
      {current.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No current address on file.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: "0.25rem 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {current.map((a) => (
            <li
              key={a.id}
              style={{
                border:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
                borderRadius: "0.5rem",
                padding: "0.6rem 0.75rem",
                fontSize: "0.88rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  alignItems: "center",
                  marginBottom: "0.2rem",
                }}
              >
                <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{a.kind}</span>
                {a.isPrimary ? <span style={badge("primary")}>primary</span> : null}
                {a.geocodeLat && a.geocodeLng ? (
                  <span style={badge("success")} title={`${a.geocodeLat}, ${a.geocodeLng}`}>
                    geocoded
                  </span>
                ) : (
                  <span
                    style={badge("neutral")}
                    title="The M5 geocode job fills coordinates asynchronously"
                  >
                    geocoding…
                  </span>
                )}
              </div>
              <div>
                <AddressLine a={a} />
              </div>
              <div
                style={{ color: "var(--color-muted)", fontSize: "0.78rem", marginTop: "0.2rem" }}
              >
                since {a.effectiveFrom}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 style={h3}>Add address</h3>
      <form
        onSubmit={submit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.4rem",
          maxWidth: 420,
          fontSize: "0.85rem",
        }}
      >
        <input
          required
          placeholder="Street address"
          value={form.line1}
          onChange={(e) => setForm({ ...form, line1: e.target.value })}
          style={input}
        />
        <input
          placeholder="Apt / suite (optional)"
          value={form.line2}
          onChange={(e) => setForm({ ...form, line2: e.target.value })}
          style={input}
        />
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <input
            required
            placeholder="City"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
            style={{ ...input, flex: 2 }}
          />
          <input
            placeholder="ST"
            maxLength={2}
            value={form.state}
            onChange={(e) => setForm({ ...form, state: e.target.value })}
            style={{ ...input, flex: 1, width: 60 }}
          />
          <input
            required
            placeholder="ZIP"
            value={form.postalCode}
            onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
            style={{ ...input, flex: 1 }}
          />
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
            style={input}
          >
            {ADDRESS_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <label
            style={{
              display: "flex",
              gap: "0.3rem",
              alignItems: "center",
              color: "var(--color-on-surface)",
            }}
          >
            <input
              type="checkbox"
              checked={form.isPrimary}
              onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
            />
            Set as primary
          </label>
        </div>
        {form.isPrimary && current.some((a) => a.isPrimary) ? (
          <p style={{ color: "var(--color-warning)", fontSize: "0.78rem", margin: 0 }}>
            The current primary address will be closed and moved to history.
          </p>
        ) : null}
        {saveError ? (
          <p style={{ color: "var(--color-error)", fontSize: "0.8rem", margin: 0 }}>{saveError}</p>
        ) : null}
        <button
          type="submit"
          disabled={saving}
          style={{
            alignSelf: "flex-start",
            padding: "0.4rem 0.9rem",
            borderRadius: "9999px",
            border: "none",
            background: "var(--color-primary)",
            color: "var(--color-on-primary)",
            opacity: saving ? 0.6 : 1,
            cursor: saving ? "default" : "pointer",
            fontSize: "0.85rem",
            fontWeight: 600,
          }}
        >
          {saving ? "Saving…" : "Add address"}
        </button>
      </form>

      {history.length > 0 ? (
        <>
          <h3 style={h3}>History</h3>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: "0.82rem",
              width: "100%",
              maxWidth: 640,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
                <th style={th}>Type</th>
                <th style={th}>Address</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr
                  key={a.id}
                  style={{
                    borderTop:
                      "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
                    color: "var(--color-on-surface-variant)",
                  }}
                >
                  <td style={td}>
                    {a.kind}
                    {a.isPrimary ? (
                      <span style={{ color: "var(--color-muted)" }}> · was primary</span>
                    ) : null}
                  </td>
                  <td style={td}>
                    <AddressLine a={a} />
                  </td>
                  <td style={td}>{a.effectiveFrom}</td>
                  <td style={td}>{a.effectiveTo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
        Addresses are append-only (D5): a change keeps the prior row as history rather than
        overwriting it.
      </p>
    </>
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

function CoverageTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [payers, setPayers] = useState<PatientPayer[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    (async () => {
      setStatus("loading");
      const res = await client.GET("/api/v1/patients/{id}/payers", {
        params: { path: { id: patientId } },
      });
      if (!active) return;
      if (res.error || !res.data) return setStatus("error");
      const rows = (res.data as { payers: PatientPayer[] }).payers;
      setPayers(rows);
      setStatus("ready");
      // Resolve each distinct M40 payer's display name through the MDM client (best-effort).
      const ids = [...new Set(rows.map((r) => r.payerId))];
      const resolved = await Promise.all(
        ids.map(async (pid) => {
          const r = await client.GET("/api/v1/mdm/{kind}/{id}", {
            params: { path: { kind: "payer", id: pid } },
          });
          const name = (r.data as { canonical?: { displayName?: string } } | undefined)?.canonical
            ?.displayName;
          return [pid, name ?? ""] as const;
        }),
      );
      if (!active) return;
      setNames(Object.fromEntries(resolved.filter(([, n]) => n)));
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  if (status === "loading") return <LoadingSpinner />;
  if (status === "error" || payers === null) {
    return (
      <p style={{ color: "var(--color-error)", fontSize: "0.9rem" }}>
        Coverage could not be loaded.
      </p>
    );
  }

  const current = payers.filter((p) => p.current);
  const history = payers.filter((p) => !p.current);
  const payerName = (p: PatientPayer) =>
    names[p.payerId] ?? (
      <span style={{ color: "var(--color-muted)" }} title={`M40 payer ${p.payerId}`}>
        {p.payerId.slice(0, 8)}…
      </span>
    );

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Coverage / Payers</h2>

      <h3 style={h3}>Active coverage</h3>
      {current.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No active coverage on file.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: "0.25rem 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {current.map((p) => (
            <li
              key={p.id}
              style={{
                border:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
                borderRadius: "0.5rem",
                padding: "0.6rem 0.75rem",
                fontSize: "0.88rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  alignItems: "center",
                  marginBottom: "0.2rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>{payerName(p)}</span>
                {p.rank === 1 ? (
                  <span style={badge("primary")}>primary</span>
                ) : (
                  <span style={badge("neutral")}>rank {p.rank}</span>
                )}
                <span style={badge("success")}>{p.coverageKind}</span>
              </div>
              <div style={{ color: "var(--color-on-surface)" }}>
                Member ID {p.subscriberId}
                {p.groupNumber ? ` · Group ${p.groupNumber}` : ""}
                {p.binPcn ? ` · BIN/PCN ${p.binPcn}` : ""}
              </div>
              <div
                style={{ color: "var(--color-muted)", fontSize: "0.78rem", marginTop: "0.2rem" }}
              >
                since {p.effectiveFrom}
              </div>
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 ? (
        <>
          <h3 style={h3}>History</h3>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: "0.82rem",
              width: "100%",
              maxWidth: 640,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
                <th style={th}>Payer</th>
                <th style={th}>Kind</th>
                <th style={th}>Member ID</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr
                  key={p.id}
                  style={{
                    borderTop:
                      "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
                    color: "var(--color-on-surface-variant)",
                  }}
                >
                  <td style={td}>{payerName(p)}</td>
                  <td style={td}>{p.coverageKind}</td>
                  <td style={td}>{p.subscriberId}</td>
                  <td style={td}>{p.effectiveFrom}</td>
                  <td style={td}>{p.effectiveTo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
        Payer names resolve from M40 master data; an unresolved row shows its raw payer id.
      </p>
    </>
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
      if (res.error || !res.data) return setStatus("error");
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
      <p style={{ color: "var(--color-error)", fontSize: "0.9rem" }}>
        Care team could not be loaded.
      </p>
    );
  }

  const assignments = [...team.assignments].sort((a, b) => Number(b.current) - Number(a.current));
  const activeAssignments = assignments.filter((a) => a.current);
  const pastAssignments = assignments.filter((a) => !a.current);
  const caregivers = team.caregivers.filter((c) => c.current);
  const pastCaregivers = team.caregivers.filter((c) => !c.current);

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Care Team &amp; Assignments</h2>

      <h3 style={h3}>Clinical assignments</h3>
      {activeAssignments.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No active assignments on file.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: "0.25rem 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {activeAssignments.map((a) => (
            <li
              key={a.id}
              style={{
                border:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
                borderRadius: "0.5rem",
                padding: "0.6rem 0.75rem",
                fontSize: "0.88rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  alignItems: "center",
                  marginBottom: "0.2rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>{roleLabel(a.role)}</span>
                {a.role === "primary_rn" ? <span style={badge("primary")}>primary RN</span> : null}
              </div>
              <div
                style={{ color: "var(--color-on-surface)" }}
                title={`M2 user ${a.clinicianUserId}`}
              >
                Clinician{" "}
                <code style={{ fontSize: "0.82rem" }}>{a.clinicianUserId.slice(0, 8)}…</code>
              </div>
              <div
                style={{ color: "var(--color-muted)", fontSize: "0.78rem", marginTop: "0.2rem" }}
              >
                assigned {a.assignedAt}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 style={h3}>Caregivers</h3>
      {caregivers.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No caregivers on file.
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: "0.25rem 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {caregivers.map((c) => (
            <li
              key={c.id}
              style={{
                border:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
                borderRadius: "0.5rem",
                padding: "0.6rem 0.75rem",
                fontSize: "0.88rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "0.4rem",
                  alignItems: "center",
                  marginBottom: "0.2rem",
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {c.lastName}, {c.firstName}
                </span>
                <span style={badge("success")}>{titleCase(c.relationship)}</span>
                {c.isPrimary ? <span style={badge("primary")}>primary</span> : null}
                {c.isLegalRepresentative ? (
                  <span
                    style={badge("warning")}
                    title={`Legal-representative authority: ${titleCase(c.lrAuthority)}`}
                  >
                    legal rep · {titleCase(c.lrAuthority)}
                  </span>
                ) : null}
              </div>
              {c.phone || c.email ? (
                <div style={{ color: "var(--color-on-surface)" }}>
                  {[c.phone, c.email].filter(Boolean).join(" · ")}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 style={h3}>Emergency contacts</h3>
      {team.emergencyContacts.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No emergency contacts on file.
        </p>
      ) : (
        <table
          style={{ borderCollapse: "collapse", fontSize: "0.85rem", width: "100%", maxWidth: 640 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              <th style={th}>Relationship</th>
              <th style={th}>Contact</th>
            </tr>
          </thead>
          <tbody>
            {team.emergencyContacts.map((c) => (
              <tr
                key={c.id}
                style={{
                  borderTop:
                    "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
                }}
              >
                <td style={td}>{c.priority}</td>
                <td style={td}>{c.name}</td>
                <td style={td}>{c.relationship}</td>
                <td style={td}>{[c.phone, c.email].filter(Boolean).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pastAssignments.length > 0 || pastCaregivers.length > 0 ? (
        <>
          <h3 style={h3}>Past involvement</h3>
          <ul
            style={{
              margin: "0.25rem 0 0",
              paddingLeft: "1.1rem",
              color: "var(--color-on-surface-variant)",
              fontSize: "0.82rem",
            }}
          >
            {pastAssignments.map((a) => (
              <li key={a.id}>
                {roleLabel(a.role)} · clinician {a.clinicianUserId.slice(0, 8)}… · {a.assignedAt} →{" "}
                {a.unassignedAt ?? "—"}
              </li>
            ))}
            {pastCaregivers.map((c) => (
              <li key={c.id}>
                {c.lastName}, {c.firstName} · {titleCase(c.relationship)} (ended)
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
        Staff display names resolve from the M2 roster once it exposes them (Staff Management
        enrichment / M34); until then an assignment shows its care-team role and the clinician id.
      </p>
    </>
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
  const [flags, setFlags] = useState<PrivacyFlags | null>(null);
  const [consents, setConsents] = useState<ConsentRecord[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    (async () => {
      setStatus("loading");
      const [pf, cons] = await Promise.all([
        client.GET("/api/v1/patients/{id}/privacy-flags", { params: { path: { id: patientId } } }),
        client.GET("/api/v1/patients/{patientId}/consents", { params: { path: { patientId } } }),
      ]);
      if (!active) return;
      // The privacy-flags read is the tab's spine; a consents failure degrades that section only.
      if (pf.error || !pf.data) return setStatus("error");
      setFlags(pf.data as PrivacyFlags);
      setConsents(
        cons.error || !cons.data ? [] : ((cons.data as { data: ConsentRecord[] }).data ?? []),
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
      <p style={{ color: "var(--color-error)", fontSize: "0.9rem" }}>
        Privacy flags could not be loaded.
      </p>
    );
  }

  const nonSud = flags.flags.filter((f) => f !== "sud");

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Privacy Flags</h2>

      <h3 style={h3}>Active restrictions</h3>
      {flags.flags.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No privacy restrictions on file.
        </p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", margin: "0.4rem 0 0" }}>
          {flags.sudRestricted ? (
            <span
              style={badge("danger")}
              title="42 CFR Part 2 — SUD records require a Part 2 consent to disclose"
            >
              {flagLabel("sud")}
            </span>
          ) : null}
          {nonSud.map((f) => (
            <span key={f} style={badge("warning")}>
              {flagLabel(f)}
            </span>
          ))}
        </div>
      )}
      {flags.capturedAt ? (
        <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.4rem 0 0" }}>
          Snapshot captured {flags.capturedAt.slice(0, 10)} · recomputed from consent (M39).
        </p>
      ) : null}

      {flags.sudRestricted ? (
        <>
          <h3 style={h3}>Substance use (42 CFR Part 2)</h3>
          {flags.sudDisclosable ? (
            <p
              style={{
                color: "var(--color-on-surface)",
                fontSize: "0.88rem",
                margin: "0.25rem 0 0",
              }}
            >
              A Part 2 consent is on file — SUD-categorized records are disclosable to authorized
              care.
            </p>
          ) : (
            // §7.6 fail-closed: no Part-2 consent → the protected detail is sealed, not fabricated.
            // The §8 SealedBlock shows the redaction AS redaction (visible lock), never a blank.
            <div style={{ margin: "0.4rem 0 0" }}>
              <SealedBlock message="Substance-use (42 CFR Part 2) records are restricted. Disclosure requires a §2.31 Part 2 consent on file; none is active for this patient." />
            </div>
          )}
        </>
      ) : null}

      <h3 style={h3}>Active consents</h3>
      {consents === null || consents.length === 0 ? (
        <p
          style={{
            color: "var(--color-on-surface-variant)",
            fontSize: "0.88rem",
            margin: "0.25rem 0 0",
          }}
        >
          No active consents on file.
        </p>
      ) : (
        <table
          style={{ borderCollapse: "collapse", fontSize: "0.85rem", width: "100%", maxWidth: 640 }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
              <th style={th}>Type</th>
              <th style={th}>Status</th>
              <th style={th}>Effective</th>
              <th style={th}>Expires</th>
            </tr>
          </thead>
          <tbody>
            {consents.map((c) => (
              <tr
                key={c.id}
                style={{
                  borderTop:
                    "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
                }}
              >
                <td style={td}>{titleCase(c.typeKey)}</td>
                <td style={td}>
                  <StatusPill label={titleCase(c.status)} tone={consentTone(c.status)} />
                </td>
                <td style={td}>{c.effectiveAt ? c.effectiveAt.slice(0, 10) : "—"}</td>
                <td style={td}>{c.expiresAt ? c.expiresAt.slice(0, 10) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: "var(--color-muted)", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
        Privacy flags are a denormalized snapshot recomputed from consent (M39); Part 2 / SUD detail
        fails closed when no qualifying consent is on file.
      </p>
    </>
  );
}

const input = {
  padding: "0.35rem 0.5rem",
  borderRadius: "0.375rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 60%, transparent)",
  fontSize: "0.85rem",
} as const;
// Category chip (No-Line, theme-reactive): a semantic tone → tonal background + on-tone text.
// Lifecycle status uses <StatusPill>; this is for non-status category tags (primary, rank, kind).
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
    padding: "0.05rem 0.45rem",
    fontSize: "0.72rem",
    fontWeight: 600,
  }) as const;

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
