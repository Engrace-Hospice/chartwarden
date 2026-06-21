// apps/web/src/modules/05-patient — Patient Chart (M5, Track A).
// Spec: docs/ui/screens/clinical/WARDENX_UI_PATIENT_CHART.md — "Use Patient Workspace."
// The patient-scoped hub: sticky Patient Banner + a module nav rail + a center summary. This builds
// the M5 FRAME (banner + summary) plus the M5-owned Demographics & Identifiers tab (FB-T06); the
// cross-module tabs (Encounters, Orders, eMAR, …) graft on as those modules land (Track B). Backed by
// GET /api/v1/patients/:id (+ /demographics, /identifiers) via the typed client.
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useParams } from "react-router-dom";
import {
  CenteredStatusLayout,
  LeftNavRail,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";

interface PatientSummary {
  id: string;
  organizationId: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// Module nav rail (spec). Only sections whose module is built are active now; the rest are
// placeholders that light up in Track B as their module lands.
const NAV_SECTIONS: { label: string; ready: boolean }[] = [
  { label: "Summary", ready: true },
  { label: "Demographics & Identifiers", ready: true },
  { label: "Addresses", ready: true },
  { label: "Coverage / Payers", ready: true },
  { label: "Care Team & Assignments", ready: true },
  { label: "Care Plan", ready: false },
  { label: "Encounters / Visits", ready: false },
  { label: "Assessments", ready: false },
  { label: "Orders", ready: false },
  { label: "Medications / eMAR", ready: false },
  { label: "Documents", ready: false },
  { label: "Election & Certification", ready: false },
  { label: "IDG History", ready: false },
];

export function PatientChart(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [section, setSection] = useState("Summary");
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "notfound" } | { kind: "error" } | { kind: "ready"; patient: PatientSummary }
  >({ kind: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      const { data, error, response } = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
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
    return <CenteredStatusLayout headline="Patient not found" explanation="This patient does not exist or is outside your access." />;
  }
  if (state.kind === "error") {
    return <CenteredStatusLayout headline="Unavailable" explanation="The patient chart could not be loaded." />;
  }

  const p = state.patient;
  return (
    <PatientWorkspaceLayout
      banner={
        <PatientBanner
          name={`${p.lastName}, ${p.firstName}`}
          mrn={p.mrn}
          dob={p.dob}
          codeStatus={<span style={{ color: "#9ca3af" }}>—</span>}
        />
      }
    >
      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <LeftNavRail ariaLabel="Patient modules">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {NAV_SECTIONS.map((s) => (
              <li
                key={s.label}
                onClick={s.ready ? () => setSection(s.label) : undefined}
                aria-current={s.ready && s.label === section ? "page" : undefined}
                style={{
                  padding: "0.4rem 0.5rem",
                  borderRadius: "0.375rem",
                  color: s.ready ? "#111827" : "#9ca3af",
                  cursor: s.ready ? "pointer" : "default",
                  background: s.ready && s.label === section ? "#eef2ff" : "transparent",
                  fontWeight: s.ready && s.label === section ? 600 : 400,
                }}
                title={s.ready ? undefined : "Available when this module ships"}
              >
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
          ) : (
            <SummaryTab patient={p} />
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function SummaryTab({ patient }: { patient: PatientSummary }): JSX.Element {
  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Summary</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1rem", fontSize: "0.9rem" }}>
        <dt style={dt}>MRN</dt>
        <dd style={dd}>{patient.mrn}</dd>
        <dt style={dt}>Date of birth</dt>
        <dd style={dd}>{patient.dob}</dd>
        <dt style={dt}>Status</dt>
        <dd style={dd}>{patient.status}</dd>
      </dl>
      <p style={{ marginTop: "1.5rem", color: "#6b7280", fontSize: "0.85rem" }}>
        Clinical sections (problems, visits, orders, medications, assessments) populate as their
        modules ship.
      </p>
    </>
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
  aliases: { kind: string; fullName: string | null; firstName: string | null; middleName: string | null; lastName: string | null }[];
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
    return <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>Demographics could not be loaded.</p>;
  }

  const d = demographics;
  const codes = (arr: string[]) => (arr.length ? arr.join(", ") : "—");
  const orDash = (v: string | null) => (v && v.length ? v : "—");

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Demographics &amp; Identifiers</h2>

      <h3 style={h3}>Name</h3>
      <dl style={grid}>
        <dt style={dt}>Legal name</dt>
        <dd style={dd}>
          {[d.legalLastName, [d.legalFirstName, d.legalMiddleName].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
          {d.legalNameSuffix ? ` ${d.legalNameSuffix}` : ""}
        </dd>
        <dt style={dt}>Aliases</dt>
        <dd style={dd}>
          {d.aliases.length === 0
            ? "—"
            : d.aliases
                .map((a) => `${a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(" ")} (${a.kind})`)
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
      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.3rem 0 0" }}>
        SOGI / race / ethnicity values are USCDI codes; M38 resolves them to display labels.
      </p>

      <h3 style={h3}>Identifiers</h3>
      <table style={{ borderCollapse: "collapse", fontSize: "0.85rem", width: "100%", maxWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Type</th>
            <th style={th}>Value</th>
            <th style={th}>Issuer</th>
          </tr>
        </thead>
        <tbody>
          {identifiers.map((i) => (
            <tr key={i.id} style={{ borderTop: "1px solid #f3f4f6" }}>
              <td style={td}>
                {i.kind.toUpperCase()}
                {i.kind === "mrn" ? <span style={{ color: "#9ca3af" }} title="MRN is immutable after creation"> · immutable</span> : null}
              </td>
              <td style={td}>
                {i.sensitive ? (
                  <span title="Full value requires phi.read_ssn (M5 SSN decryption follow-up)">
                    xxx-xx-{i.last4 ?? "####"} <span style={{ color: "#9ca3af" }}>(masked)</span>
                  </span>
                ) : (
                  orDash(i.value)
                )}
              </td>
              <td style={td}>{orDash(i.issuer)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.4rem 0 0" }}>
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
  const [form, setForm] = useState({ line1: "", line2: "", city: "", state: "", postalCode: "", kind: "home", isPrimary: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function load(active = { v: true }) {
    setStatus("loading");
    const res = await client.GET("/api/v1/patients/{id}/addresses", { params: { path: { id: patientId } } });
    if (!active.v) return;
    if (res.error || !res.data) return setStatus("error");
    setAddresses((res.data as { addresses: Address[] }).addresses);
    setStatus("ready");
  }

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
    const body: Record<string, unknown> = {
      line1: form.line1,
      city: form.city,
      postalCode: form.postalCode,
      kind: form.kind,
      isPrimary: form.isPrimary,
    };
    if (form.line2) body.line2 = form.line2;
    if (form.state) body.state = form.state.toUpperCase();
    const res = await client.POST("/api/v1/patients/{id}/addresses", { params: { path: { id: patientId } }, body: body as never });
    setSaving(false);
    if (res.error) return setSaveError("Could not save the address. Check the fields and try again.");
    setForm({ line1: "", line2: "", city: "", state: "", postalCode: "", kind: "home", isPrimary: false });
    await load();
  }

  if (status === "loading" && addresses === null) return <LoadingSpinner />;
  if (status === "error" || addresses === null) {
    return <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>Addresses could not be loaded.</p>;
  }

  const current = addresses.filter((a) => a.current);
  const history = addresses.filter((a) => !a.current);

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Addresses</h2>

      <h3 style={h3}>Current</h3>
      {current.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.88rem", margin: "0.25rem 0 0" }}>No current address on file.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0.25rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {current.map((a) => (
            <li key={a.id} style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "0.6rem 0.75rem", fontSize: "0.88rem" }}>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.2rem" }}>
                <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{a.kind}</span>
                {a.isPrimary ? <span style={badge("#eef2ff", "#4338ca")}>primary</span> : null}
                {a.geocodeLat && a.geocodeLng ? (
                  <span style={badge("#ecfdf5", "#047857")} title={`${a.geocodeLat}, ${a.geocodeLng}`}>geocoded</span>
                ) : (
                  <span style={badge("#f3f4f6", "#6b7280")} title="The M5 geocode job fills coordinates asynchronously">geocoding…</span>
                )}
              </div>
              <div><AddressLine a={a} /></div>
              <div style={{ color: "#9ca3af", fontSize: "0.78rem", marginTop: "0.2rem" }}>since {a.effectiveFrom}</div>
            </li>
          ))}
        </ul>
      )}

      <h3 style={h3}>Add address</h3>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.4rem", maxWidth: 420, fontSize: "0.85rem" }}>
        <input required placeholder="Street address" value={form.line1} onChange={(e) => setForm({ ...form, line1: e.target.value })} style={input} />
        <input placeholder="Apt / suite (optional)" value={form.line2} onChange={(e) => setForm({ ...form, line2: e.target.value })} style={input} />
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <input required placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} style={{ ...input, flex: 2 }} />
          <input placeholder="ST" maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} style={{ ...input, flex: 1, width: 60 }} />
          <input required placeholder="ZIP" value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} style={{ ...input, flex: 1 }} />
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} style={input}>
            {ADDRESS_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", color: "#374151" }}>
            <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} />
            Set as primary
          </label>
        </div>
        {form.isPrimary && current.some((a) => a.isPrimary) ? (
          <p style={{ color: "#92400e", fontSize: "0.78rem", margin: 0 }}>The current primary address will be closed and moved to history.</p>
        ) : null}
        {saveError ? <p style={{ color: "#b91c1c", fontSize: "0.8rem", margin: 0 }}>{saveError}</p> : null}
        <button type="submit" disabled={saving} style={{ alignSelf: "flex-start", padding: "0.4rem 0.9rem", borderRadius: "0.375rem", border: "1px solid #4338ca", background: saving ? "#c7d2fe" : "#4f46e5", color: "#fff", cursor: saving ? "default" : "pointer", fontSize: "0.85rem" }}>
          {saving ? "Saving…" : "Add address"}
        </button>
      </form>

      {history.length > 0 ? (
        <>
          <h3 style={h3}>History</h3>
          <table style={{ borderCollapse: "collapse", fontSize: "0.82rem", width: "100%", maxWidth: 640 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Type</th>
                <th style={th}>Address</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid #f3f4f6", color: "#6b7280" }}>
                  <td style={td}>
                    {a.kind}
                    {a.isPrimary ? <span style={{ color: "#9ca3af" }}> · was primary</span> : null}
                  </td>
                  <td style={td}><AddressLine a={a} /></td>
                  <td style={td}>{a.effectiveFrom}</td>
                  <td style={td}>{a.effectiveTo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
        Addresses are append-only (D5): a change keeps the prior row as history rather than overwriting it.
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
      const res = await client.GET("/api/v1/patients/{id}/payers", { params: { path: { id: patientId } } });
      if (!active) return;
      if (res.error || !res.data) return setStatus("error");
      const rows = (res.data as { payers: PatientPayer[] }).payers;
      setPayers(rows);
      setStatus("ready");
      // Resolve each distinct M40 payer's display name through the MDM client (best-effort).
      const ids = [...new Set(rows.map((r) => r.payerId))];
      const resolved = await Promise.all(
        ids.map(async (pid) => {
          const r = await client.GET("/api/v1/mdm/{kind}/{id}", { params: { path: { kind: "payer", id: pid } } });
          const name = (r.data as { canonical?: { displayName?: string } } | undefined)?.canonical?.displayName;
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
    return <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>Coverage could not be loaded.</p>;
  }

  const current = payers.filter((p) => p.current);
  const history = payers.filter((p) => !p.current);
  const payerName = (p: PatientPayer) => names[p.payerId] ?? <span style={{ color: "#9ca3af" }} title={`M40 payer ${p.payerId}`}>{p.payerId.slice(0, 8)}…</span>;

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Coverage / Payers</h2>

      <h3 style={h3}>Active coverage</h3>
      {current.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.88rem", margin: "0.25rem 0 0" }}>No active coverage on file.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0.25rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {current.map((p) => (
            <li key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "0.6rem 0.75rem", fontSize: "0.88rem" }}>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.2rem" }}>
                <span style={{ fontWeight: 600 }}>{payerName(p)}</span>
                {p.rank === 1 ? <span style={badge("#eef2ff", "#4338ca")}>primary</span> : <span style={badge("#f3f4f6", "#6b7280")}>rank {p.rank}</span>}
                <span style={badge("#ecfdf5", "#047857")}>{p.coverageKind}</span>
              </div>
              <div style={{ color: "#374151" }}>
                Member ID {p.subscriberId}
                {p.groupNumber ? ` · Group ${p.groupNumber}` : ""}
                {p.binPcn ? ` · BIN/PCN ${p.binPcn}` : ""}
              </div>
              <div style={{ color: "#9ca3af", fontSize: "0.78rem", marginTop: "0.2rem" }}>since {p.effectiveFrom}</div>
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 ? (
        <>
          <h3 style={h3}>History</h3>
          <table style={{ borderCollapse: "collapse", fontSize: "0.82rem", width: "100%", maxWidth: 640 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Payer</th>
                <th style={th}>Kind</th>
                <th style={th}>Member ID</th>
                <th style={th}>From</th>
                <th style={th}>To</th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #f3f4f6", color: "#6b7280" }}>
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
      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
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
      const res = await client.GET("/api/v1/patients/{id}/care-team", { params: { path: { id: patientId } } });
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
    return <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>Care team could not be loaded.</p>;
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
        <p style={{ color: "#6b7280", fontSize: "0.88rem", margin: "0.25rem 0 0" }}>No active assignments on file.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0.25rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {activeAssignments.map((a) => (
            <li key={a.id} style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "0.6rem 0.75rem", fontSize: "0.88rem" }}>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.2rem" }}>
                <span style={{ fontWeight: 600 }}>{roleLabel(a.role)}</span>
                {a.role === "primary_rn" ? <span style={badge("#eef2ff", "#4338ca")}>primary RN</span> : null}
              </div>
              <div style={{ color: "#374151" }} title={`M2 user ${a.clinicianUserId}`}>
                Clinician <code style={{ fontSize: "0.82rem" }}>{a.clinicianUserId.slice(0, 8)}…</code>
              </div>
              <div style={{ color: "#9ca3af", fontSize: "0.78rem", marginTop: "0.2rem" }}>assigned {a.assignedAt}</div>
            </li>
          ))}
        </ul>
      )}

      <h3 style={h3}>Caregivers</h3>
      {caregivers.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.88rem", margin: "0.25rem 0 0" }}>No caregivers on file.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0.25rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {caregivers.map((c) => (
            <li key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "0.6rem 0.75rem", fontSize: "0.88rem" }}>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.2rem" }}>
                <span style={{ fontWeight: 600 }}>{c.lastName}, {c.firstName}</span>
                <span style={badge("#ecfdf5", "#047857")}>{titleCase(c.relationship)}</span>
                {c.isPrimary ? <span style={badge("#eef2ff", "#4338ca")}>primary</span> : null}
                {c.isLegalRepresentative ? (
                  <span style={badge("#fef3c7", "#92400e")} title={`Legal-representative authority: ${titleCase(c.lrAuthority)}`}>
                    legal rep · {titleCase(c.lrAuthority)}
                  </span>
                ) : null}
              </div>
              {c.phone || c.email ? (
                <div style={{ color: "#374151" }}>{[c.phone, c.email].filter(Boolean).join(" · ")}</div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h3 style={h3}>Emergency contacts</h3>
      {team.emergencyContacts.length === 0 ? (
        <p style={{ color: "#6b7280", fontSize: "0.88rem", margin: "0.25rem 0 0" }}>No emergency contacts on file.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", fontSize: "0.85rem", width: "100%", maxWidth: 640 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>#</th>
              <th style={th}>Name</th>
              <th style={th}>Relationship</th>
              <th style={th}>Contact</th>
            </tr>
          </thead>
          <tbody>
            {team.emergencyContacts.map((c) => (
              <tr key={c.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                <td style={td}>{c.priority}</td>
                <td style={td}>{c.name}</td>
                <td style={td}>{c.relationship}</td>
                <td style={td}>{[c.phone, c.email].filter(Boolean).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(pastAssignments.length > 0 || pastCaregivers.length > 0) ? (
        <>
          <h3 style={h3}>Past involvement</h3>
          <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem", color: "#6b7280", fontSize: "0.82rem" }}>
            {pastAssignments.map((a) => (
              <li key={a.id}>{roleLabel(a.role)} · clinician {a.clinicianUserId.slice(0, 8)}… · {a.assignedAt} → {a.unassignedAt ?? "—"}</li>
            ))}
            {pastCaregivers.map((c) => (
              <li key={c.id}>{c.lastName}, {c.firstName} · {titleCase(c.relationship)} (ended)</li>
            ))}
          </ul>
        </>
      ) : null}

      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.6rem 0 0" }}>
        Staff display names resolve from the M2 roster once it exposes them (Staff Management enrichment / M34);
        until then an assignment shows its care-team role and the clinician id.
      </p>
    </>
  );
}

const input = { padding: "0.35rem 0.5rem", borderRadius: "0.375rem", border: "1px solid #d1d5db", fontSize: "0.85rem" } as const;
const badge = (bg: string, fg: string) =>
  ({ background: bg, color: fg, borderRadius: "0.25rem", padding: "0.05rem 0.4rem", fontSize: "0.72rem", fontWeight: 600 }) as const;

const dt = { color: "#6b7280", margin: 0 } as const;
const dd = { margin: 0 } as const;
const grid = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1rem", fontSize: "0.9rem", margin: "0.25rem 0 0" } as const;
const h3 = { fontSize: "0.92rem", margin: "1.25rem 0 0.4rem", color: "#374151" } as const;
const th = { padding: "0.3rem 0.5rem", fontWeight: 500 } as const;
const td = { padding: "0.3rem 0.5rem" } as const;
