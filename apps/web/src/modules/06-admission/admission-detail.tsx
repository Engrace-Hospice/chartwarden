import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  type GateItem,
  GateStepper,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/06-admission — Admission Detail (M6 §5.2.4 + §5.2.5 activation gate, Track B).
// Spec: docs/design/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Detail Page."
// Reads the admission aggregate from GET /api/v1/admissions/:id (which carries the R-AC-01 activation
// gate — the SAME server-truth gate route 14 enforces, so the §5.2.5 checklist can never diverge),
// plus the election-periods and compliance-windows sub-lists. Reconciled to Lantern (R1): the §5.2.5
// activation gate renders as a Guardrail GateStepper (blockers-first, alert glyphs) under a GuardChip
// summary; states are §6.6 status pills. Reads + the Acknowledge-NOR and Activate ceremonies (TASK-031).
//
// State-graph fix: `transitionAdmission`'s legal-transition graph (state-machines/admission.ts) only
// accepts `activate` FROM `notice_of_rights_acknowledged`, not from `pending` — a fresh admission
// (`acceptReferral`/`createAdmission`) always starts `pending`. Gating Activate on `state === "pending"`
// (an earlier draft of this file did) made the button permanently unreachable: the one route that
// advances `pending → notice_of_rights_acknowledged` (`POST /admissions/:id/nor`) had no UI anywhere in
// M6, so no admission could ever legally reach the state Activate requires. Both gaps are fixed here:
// Activate is gated on the real prerequisite state, and the Acknowledge-NOR ceremony (`state ===
// "pending"`) is what gets an admission there. Activate itself is only ever enabled when the SAME
// `activationGate.ready` the server enforces is true (route 14 now calls the identical
// `computeActivationGate` before transitioning — see admission-route-service-db.ts), so the button can
// never promise something the server would then refuse.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ADMISSION_TONE, WINDOW_TONE, stateLabel } from "./admission-status";
import { authFailureRedirect } from "./write-workflow";

const NOR_METHODS = [
  { value: "electronic_witnessed", label: "Electronic (witnessed)" },
  { value: "wet_ink_scanned", label: "Wet ink (scanned)" },
  { value: "verbal_with_witness", label: "Verbal (with witness)" },
] as const;
type NorMethod = (typeof NOR_METHODS)[number]["value"];

interface SummaryRow {
  id: string;
  state: string;
  version: number;
}
interface AdmissionDetailView extends SummaryRow {
  activationGate: { ready: boolean; missing: string[] };
  // #50 — tenancy metadata that scopes the activation ceremony's service-location picker.
  providerEntityId?: string | null;
  locationId?: string | null;
}

/** A service location the admission may be sited at (M1 `/api/v1/locations`, non-PHI directory). */
interface LocationOption {
  id: string;
  name: string;
  city: string;
  state: string;
}

// §5.2.5 — the four activation preconditions, in checklist order; the server's `missing[]` codes drive
// which rows pulse red. Kept verbatim from computeActivationGate so the UI renders server truth.
const GATE_ROWS: { code: string; label: string }[] = [
  { code: "election_signed", label: "Election statement signed (period 1)" },
  { code: "nor_acknowledged", label: "Notice of Rights acknowledged" },
  { code: "cti_signed", label: "CTI signed by hospice medical director" },
  { code: "attending_signed", label: "CTI signed by attending physician (period 1)" },
];

export function AdmissionDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [admission, setAdmission] = useState<AdmissionDetailView | null>(null);
  const [periods, setPeriods] = useState<SummaryRow[]>([]);
  const [windows, setWindows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<"activate" | "nor" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // #50 — the service location this admission is served from. `admission.location_id` was never written
  // by any code path, so every admission was unsited and M10 refused to create its HOPE timepoint
  // windows (`hope_timepoint_schedule.location_id` is NOT NULL). The server DERIVES the location when
  // the elected provider entity has exactly one active site and REQUIRES one when it has several, so
  // this picker only appears in the case where a human genuinely has to choose.
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationId, setLocationId] = useState("");

  const [formVersionId, setFormVersionId] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<NorMethod>("electronic_witnessed");
  const [acknowledgedByName, setAcknowledgedByName] = useState("");
  const [acknowledgedByRole, setAcknowledgedByRole] = useState<"patient" | "legal_representative">(
    "patient",
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/admissions/{id}", {
      params: { path: { id } },
    });
    if (err || !data) {
      setError("Admission not found or not visible to you.");
      setLoading(false);
      return;
    }
    setAdmission(data);
    const [p, w] = await Promise.all([
      client.GET("/api/v1/admissions/{id}/election-periods", { params: { path: { id } } }),
      client.GET("/api/v1/admissions/{id}/compliance-windows", { params: { path: { id } } }),
    ]);
    setPeriods(p.data?.items ?? []);
    setWindows(w.data?.items ?? []);
    setLoading(false);
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setActionError(null);
    setFormVersionId("");
    setAcknowledgedByName("");
  }, []);

  const branchError = useCallback(
    (status: number | undefined, code: string | undefined, fallback: string) => {
      const redirect = authFailureRedirect(status, code, window.location.pathname);
      if (redirect) {
        navigate(redirect);
        return true;
      }
      setBusy(false);
      if (status === 412)
        setActionError("This admission changed since you opened it — reload to retry.");
      else if (status === 403) setActionError("You do not have permission for this action.");
      else if (status === 422 && code === "M6_LOCATION_REQUIRED")
        setActionError("Choose the service location this admission is served from.");
      else if (status === 422 && code === "M6_LOCATION_NOT_UNDER_PROVIDER_ENTITY")
        setActionError("That location does not belong to this admission's hospice.");
      else if (status === 422) setActionError("Validation failed — check the values you entered.");
      else setActionError(fallback);
      return false;
    },
    [navigate],
  );

  // Loaded when the ceremony opens, scoped to the ELECTED provider entity — the only locations this
  // admission may legally be sited at. A failure here is left silent: the picker simply does not appear,
  // and the server's own 422 is what tells the user a location is needed. Better a missing convenience
  // than a blocked activation for an org where one location is the obvious answer.
  useEffect(() => {
    if (ceremony !== "activate" || !admission?.providerEntityId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await client.GET("/api/v1/locations", {
        params: {
          query: { providerEntityId: admission.providerEntityId as string, status: "active" },
        },
      });
      if (cancelled) return;
      const items = (data as { items?: LocationOption[] } | undefined)?.items ?? [];
      setLocations(items);
      // One candidate is not a choice — the server derives it, so the picker stays hidden.
      setLocationId(items.length === 1 ? (items[0]?.id ?? "") : "");
    })();
    return () => {
      cancelled = true;
    };
  }, [ceremony, admission?.providerEntityId, client]);

  const activate = useCallback(async () => {
    if (!id || !admission) return;
    // Mirrors the server rule so the user is told before the round-trip, never instead of it.
    if (locations.length > 1 && !locationId) {
      setActionError("Choose the service location this admission is served from.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/admissions/{id}/activate", {
      params: { path: { id } },
      body: { ifVersion: admission.version, ...(locationId ? { locationId } : {}) },
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Activation failed.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [id, admission, client, branchError, closeCeremony, load, locations.length, locationId]);

  const acknowledgeNor = useCallback(async () => {
    if (!id) return;
    if (formVersionId.trim().length === 0 || acknowledgedByName.trim().length === 0) {
      setActionError("Provide the NOR form version id and the acknowledging person's name.");
      return;
    }
    setBusy(true);
    setActionError(null);
    const { error: err, response } = await client.POST("/api/v1/admissions/{id}/nor", {
      params: { path: { id } },
      body: {
        formVersionId: formVersionId.trim(),
        deliveryMethod,
        acknowledgedAt: new Date().toISOString(),
        acknowledgedByName: acknowledgedByName.trim(),
        acknowledgedByRole,
      },
    });
    if (err) {
      branchError(response?.status, err?.error?.code, "Could not record the acknowledgment.");
      return;
    }
    setBusy(false);
    closeCeremony();
    void load();
  }, [
    id,
    formVersionId,
    deliveryMethod,
    acknowledgedByName,
    acknowledgedByRole,
    client,
    branchError,
    closeCeremony,
    load,
  ]);

  if (loading) return <LoadingSpinner />;
  if (error || !admission)
    return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const canAcknowledgeNor = admission.state === "pending";
  const canActivate =
    admission.state === "notice_of_rights_acknowledged" && admission.activationGate.ready;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Admission"
          breadcrumb="Admissions / Detail"
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
              <StatusPill
                label={stateLabel(admission.state)}
                tone={ADMISSION_TONE[admission.state] ?? "neutral"}
              />
              {canAcknowledgeNor ? (
                <button type="button" onClick={() => setCeremony("nor")} style={ghostBtn}>
                  Acknowledge NOR
                </button>
              ) : null}
              {canActivate ? (
                <button type="button" onClick={() => setCeremony("activate")} style={primaryBtn}>
                  Activate
                </button>
              ) : null}
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Admission <span className="wx-data-md">{admission.id}</span> · version{" "}
            <span className="tabular-nums">{admission.version}</span>
          </div>
        </PageHeader>
      }
      aside={
        <RightDetailPanel title="Activation gate">
          <ActivationChecklist gate={admission.activationGate} />
        </RightDetailPanel>
      }
    >
      <div style={contentShellStyle}>
        <section style={summaryCardStyle}>
          <div style={summaryHeaderStyle}>
            <div>
              <h2 style={sectionTitleStyle}>Admission state</h2>
              <div style={summaryMetaStyle}>
                Server-truth lifecycle state and activation readiness.
              </div>
            </div>
            <StatusPill
              label={stateLabel(admission.state)}
              tone={ADMISSION_TONE[admission.state] ?? "neutral"}
            />
          </div>
          <div style={fieldGridStyle}>
            <Field label="Admission ID" value={admission.id} mono />
            <Field label="Version" value={String(admission.version)} mono />
            <Field
              label="Activation"
              value={admission.activationGate.ready ? "Ready" : "Blocked"}
            />
          </div>
        </section>

        <Section title="Election periods">
          <RowList rows={periods} empty="No election periods yet." />
        </Section>
        <Section title="Compliance windows">
          <RowList rows={windows} empty="No open compliance windows." toneFor={WINDOW_TONE} />
        </Section>
      </div>

      <CeremonyModal
        open={ceremony === "nor"}
        title="Acknowledge Notice of Rights"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
              Records that the patient (or their legal representative) received and acknowledged the
              Notice of Rights. Required before the admission can activate.
            </span>
            <label htmlFor="nor-form-version" style={fieldLabel}>
              NOR form version id
            </label>
            <input
              id="nor-form-version"
              value={formVersionId}
              onChange={(ev) => setFormVersionId(ev.target.value)}
              style={inputStyle}
            />
            <label htmlFor="nor-method" style={fieldLabel}>
              Delivery method
            </label>
            <select
              id="nor-method"
              value={deliveryMethod}
              onChange={(ev) => setDeliveryMethod(ev.target.value as NorMethod)}
            >
              {NOR_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <label htmlFor="nor-name" style={fieldLabel}>
              Acknowledged by (name)
            </label>
            <input
              id="nor-name"
              value={acknowledgedByName}
              onChange={(ev) => setAcknowledgedByName(ev.target.value)}
              style={inputStyle}
            />
            <label htmlFor="nor-role" style={fieldLabel}>
              Acknowledged by (role)
            </label>
            <select
              id="nor-role"
              value={acknowledgedByRole}
              onChange={(ev) =>
                setAcknowledgedByRole(ev.target.value as "patient" | "legal_representative")
              }
            >
              <option value="patient">Patient</option>
              <option value="legal_representative">Legal representative</option>
            </select>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{ name: "Recording clinician", role: "This session" }}
        commitLabel={busy ? "Recording…" : "Record acknowledgment"}
        onCommit={() => void acknowledgeNor()}
        onCancel={closeCeremony}
      />

      <CeremonyModal
        open={ceremony === "activate"}
        title="Activate admission"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
              All four R-AC-01 preconditions are satisfied — activating opens active-period billing
              and compliance tracking for this admission.
            </span>
            {locations.length > 1 ? (
              <>
                <label htmlFor="activate-location" style={fieldLabel}>
                  Service location
                </label>
                <select
                  id="activate-location"
                  value={locationId}
                  onChange={(ev) => setLocationId(ev.target.value)}
                >
                  <option value="">Select a location…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} — {l.city}, {l.state}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
                  This hospice has several active sites. The location is stamped on the admission
                  and anchors its HOPE timepoint windows, so it cannot be guessed.
                </span>
              </>
            ) : null}
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest the admission is ready for activation."
        signer={{ name: "Activating clinician", role: "This session" }}
        commitLabel={busy ? "Activating…" : "Activate"}
        onCommit={() => void activate()}
        onCancel={closeCeremony}
      />
    </DetailPageLayout>
  );
}

const primaryBtn = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
} as const;
const ghostBtn: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
};
const fieldLabel: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};
const inputStyle: CSSProperties = {
  padding: "0.5rem 0.625rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--color-outline-variant)",
};
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };

const contentShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const summaryCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1rem 1.25rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const summaryHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

const summaryMetaStyle: CSSProperties = {
  marginTop: "0.25rem",
  fontSize: "0.82rem",
  color: "var(--color-on-surface-variant)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem 1rem",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};

const fieldLabelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const fieldValueStyle: CSSProperties = {
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
};

const sectionCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1rem 1.25rem",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface-lowest)",
  boxShadow: "var(--shadow-soft)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};

const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  color: "var(--color-on-surface)",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid var(--color-surface-container)",
};

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.85rem",
  color: "var(--color-on-surface-variant)",
};

// §5.2.5 activation gate as a Guardrail treatment: a blocked GuardChip summary (or a success pill when
// ready) over a GateStepper whose rows render server-truth — each unmet precondition is `blocked`
// (alert glyph, error tint, surfaced first), each met one `complete` (check, struck through).
function ActivationChecklist({
  gate,
}: { gate: AdmissionDetailView["activationGate"] }): JSX.Element {
  const items: GateItem[] = GATE_ROWS.map((row) => ({
    id: row.code,
    label: row.label,
    status: gate.missing.includes(row.code) ? "blocked" : "complete",
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {gate.ready ? (
        <StatusPill tone="success" label="Ready to activate" />
      ) : (
        <GuardChip
          tone="error"
          reason={`${gate.missing.length} precondition${gate.missing.length === 1 ? "" : "s"} block activation`}
        />
      )}
      <GateStepper items={items} ariaLabel="Activation preconditions" />
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <span className={mono ? "wx-data-md" : undefined} style={fieldValueStyle}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <section style={sectionCardStyle}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

function RowList({
  rows,
  empty,
  toneFor,
}: {
  rows: SummaryRow[];
  empty: string;
  toneFor?: Record<string, StatusTone>;
}): JSX.Element {
  if (rows.length === 0) return <p style={emptyTextStyle}>{empty}</p>;
  return (
    <table style={tableStyle}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={rowStyle}>
            <td className="wx-data-md" style={tdStyle}>
              {r.id}
            </td>
            <td style={tdStyle}>
              <StatusPill label={stateLabel(r.state)} tone={toneFor?.[r.state] ?? "neutral"} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
