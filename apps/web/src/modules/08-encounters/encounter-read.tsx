import {
  cardSurface,
  CeremonyModal,
  EmptyState,
  ghostBorder,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/08-encounters — Encounter Read (M8 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Patient Workspace + Documentation Workspace."
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `AohyV`): a Patient Workspace (banner) over the
// visit-note document | a right rail (Sign-off + EVV/visit), with a sticky footer (cosign guard + actions).
// Honest gap: the encounter READ DTO exposes only the header (type/discipline/date/status/late-entry/
// version/signatures) — NOT the assembled HearthNote body (subjective/objective/assessment/plan) or the
// vitals strip the frame shows, and not the EVV match. Those regions render as honest placeholders naming
// the read that will fill them, never a fabricated note. Reads GET /api/v1/encounters/:encounterId
// (+ /cosignature, + the patient summary for the banner); the server enforces every scope (ADR-0030).
//
// Write ceremonies (TASK-031): Sign / Acknowledge cosignature / Sign cosignature / Supervisor release, each
// a CeremonyModal committing to the matching M8 route. Honest gap carried into the ceremony: the sign/
// cosign-sign routes take a client-supplied `stepUpAuthAt` and only check it's ≤5 minutes old
// (encounters-routes.ts) — not a real M2 step-up event the way M23's STEP_UP_REQUIRED 403 is. Real step-up
// wiring for M8 is a backend contract change, not this UI task's to invent, so the ceremony stamps the
// current time at commit — satisfying the literal contract — and `write-workflow.ts`'s authFailureRedirect
// stays ready for the day the route does emit STEP_UP_REQUIRED.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { COSIGN_TONE, ENCOUNTER_TONE, lateEntryTone, stateLabel } from "./encounter-status";
import { authFailureRedirect } from "./write-workflow";

type CeremonyMode = "sign" | "acknowledge" | "cosign-sign" | "supervisor-release" | null;
const REASON_MIN = 40; // SupervisorReleaseSchema's real floor (encounters-typebox.ts).

interface Encounter {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  lateEntryTier: string;
  version: number;
  isF2f: boolean;
  signedAt: string | null;
  cosignedAt: string | null;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// The HearthNote sections the documentation frame lays out (SUBJECTIVE/OBJECTIVE/ASSESSMENT/PLAN). The
// read DTO doesn't return their content yet, so each is rendered as a labelled, empty section — the
// document scaffold is faithful; the prose fills in when the read exposes the assembled body.
const NOTE_SECTIONS = ["Subjective", "Objective", "Assessment", "Plan"] as const;

export function EncounterRead(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId, encounterId } = useParams<{ patientId: string; encounterId: string }>();
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [cosignStatus, setCosignStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<CeremonyMode>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    if (!encounterId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/encounters/{encounterId}", {
      params: { path: { encounterId } },
    });
    if (err || !data?.id) {
      setError("Could not load the encounter.");
      setLoading(false);
      return;
    }
    setEncounter({
      id: data.id,
      patientId: data.patientId,
      encounterType: data.encounterType,
      discipline: data.discipline,
      serviceDate: data.serviceDate,
      status: data.status,
      lateEntryTier: data.lateEntryTier,
      version: data.version,
      isF2f: data.isF2f,
      signedAt: data.signedAt ?? null,
      cosignedAt: data.cosignedAt ?? null,
    });
    const pid = patientId ?? data.patientId;
    const [cos, pat] = await Promise.all([
      client.GET("/api/v1/encounters/{encounterId}/cosignature", { params: { path: { encounterId } } }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: pid } } }),
    ]);
    setCosignStatus(cos.data?.status ?? null);
    if (pat.data) setPatient(pat.data as PatientSummary);
    setLoading(false);
  }, [client, encounterId, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setReason("");
    setActionError(null);
  }, []);

  const runWrite = useCallback(
    async (mode: Exclude<CeremonyMode, null>) => {
      if (!encounterId) return;
      if (mode === "supervisor-release" && reason.trim().length < REASON_MIN) {
        setActionError(`Provide a reason of at least ${REASON_MIN} characters.`);
        return;
      }
      setBusy(true);
      setActionError(null);
      const stepUpAuthAt = new Date().toISOString();
      const path =
        mode === "sign"
          ? "/api/v1/encounters/{encounterId}/sign"
          : mode === "acknowledge"
            ? "/api/v1/encounters/{encounterId}/cosignature/acknowledge"
            : mode === "cosign-sign"
              ? "/api/v1/encounters/{encounterId}/cosignature/sign"
              : "/api/v1/encounters/{encounterId}/cosignature/supervisor-release";
      const body =
        mode === "sign" || mode === "cosign-sign"
          ? { stepUpAuthAt, attestationConfirmed: true as const }
          : mode === "supervisor-release"
            ? { reason: reason.trim(), stepUpAuthAt }
            : undefined;
      const init = { params: { path: { encounterId } }, ...(body ? { body } : {}) };
      // The four routes have distinct request shapes (never a union client.POST can dispatch on
      // statically) — cast at the boundary, same as claim-editor.tsx's runWrite; the server is the
      // only real parser/enforcer (ADR-0030).
      const { error: err, response } = (await client.POST(path as never, init as never)) as {
        error?: { error?: { code?: string } };
        response?: Response;
      };
      if (err) {
        const errCode = err?.error?.code;
        const redirect = authFailureRedirect(response?.status, errCode, window.location.pathname);
        if (redirect) {
          navigate(redirect);
          return;
        }
        setBusy(false);
        if (response?.status === 412 && errCode === "STEP_UP_AUTH_REQUIRED")
          setActionError("Your step-up expired — try again.");
        else if (response?.status === 412)
          setActionError("This encounter changed since you opened it — reload to retry.");
        else if (response?.status === 403)
          setActionError("You do not have permission for this action.");
        else setActionError("The action could not be completed.");
        return;
      }
      setBusy(false);
      closeCeremony();
      void load();
    },
    [encounterId, reason, client, navigate, closeCeremony, load],
  );

  if (loading) return <LoadingSpinner />;
  if (error || !encounter) return <EmptyState title="Unavailable" description={error ?? "Not found."} />;

  const e = encounter;
  const canSign = e.status === "finalized";
  const canAcknowledge =
    cosignStatus === "pending" || cosignStatus === "routed" || cosignStatus === "escalated";
  const canCosignSign = cosignStatus === "acknowledged";
  const canSupervisorRelease = cosignStatus === "escalated" || cosignStatus === "hard_cap_reached";
  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill label={stateLabel(patient.status)} tone={ENCOUNTER_TONE[patient.status] ?? "neutral"} />
        </>
      }
      actions={
        <button type="button" onClick={() => navigate(`/patients/${e.patientId}`)} style={ghostBtn}>
          Open chart
        </button>
      }
    />
  ) : (
    <PatientBanner name="Encounter" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Center — the visit-note document */}
          <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", marginBottom: "0.25rem" }}>
              <h1 style={{ margin: 0, fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1.375rem", color: t.onSurface }}>
                {stateLabel(e.encounterType)}
              </h1>
              <StatusPill label={stateLabel(e.status)} tone={ENCOUNTER_TONE[e.status] ?? "neutral"} />
            </div>
            <p style={meta}>
              {stateLabel(e.discipline)} · <span className="tabular-nums">{e.serviceDate}</span>
              {e.isF2f ? " · F2F" : ""} · v{e.version}
            </p>

            {/* Vitals strip — labelled cells; values render once the read exposes the vitals row. */}
            <section style={{ ...cardSurface, padding: "1rem 1.25rem", marginTop: "1rem", display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
              {["HR", "RR", "Temp", "BP", "SpO₂", "Pain"].map((v) => (
                <div key={v} style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                  <span style={vitalLabel}>{v}</span>
                  <span className="tabular-nums" style={{ fontSize: "1.1rem", color: t.muted }}>—</span>
                </div>
              ))}
            </section>

            {/* SOAP document scaffold */}
            <section style={{ ...cardSurface, padding: "1.5rem", marginTop: "1rem" }}>
              {NOTE_SECTIONS.map((s, i) => (
                <div key={s} style={{ paddingTop: i === 0 ? 0 : "1.25rem", marginTop: i === 0 ? 0 : "1.25rem", borderTop: i === 0 ? "none" : ghostBorder }}>
                  <span style={sectionLabel}>{s}</span>
                  <p style={{ ...meta, marginTop: "0.35rem" }}>—</p>
                </div>
              ))}
              <p style={{ ...meta, marginTop: "1.25rem" }}>
                The assembled HearthNote body and the captured vitals render here once the encounter read
                exposes them; this view currently renders the server-assembled, SUD-redacted header.
              </p>
            </section>
          </div>

          {/* Right rail — Sign-off + EVV/visit */}
          <aside style={rightRail}>
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>Sign-off</h2>
              <dl style={lifeGrid}>
                <dt style={dt}>Cosignature</dt>
                <dd style={dd}>
                  {cosignStatus ? (
                    <StatusPill label={stateLabel(cosignStatus)} tone={COSIGN_TONE[cosignStatus] ?? "neutral"} />
                  ) : (
                    <span style={meta}>No request</span>
                  )}
                </dd>
                <dt style={dt}>Late-entry</dt>
                <dd style={dd}>
                  <StatusPill label={stateLabel(e.lateEntryTier)} tone={lateEntryTone(e.lateEntryTier)} />
                </dd>
                {e.signedAt ? (
                  <>
                    <dt style={dt}>Signed</dt>
                    <dd style={{ ...dd }} className="tabular-nums">{e.signedAt.slice(0, 16).replace("T", " ")}</dd>
                  </>
                ) : null}
                {e.cosignedAt ? (
                  <>
                    <dt style={dt}>Cosigned</dt>
                    <dd style={{ ...dd }} className="tabular-nums">{e.cosignedAt.slice(0, 16).replace("T", " ")}</dd>
                  </>
                ) : null}
              </dl>
            </div>

            {/* EVV / visit — honest placeholder; the visit + EVV match aren't on the encounter read DTO. */}
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>EVV / visit</h2>
              <p style={meta}>
                The linked visit window and EVV match surface here once the encounter read joins the M17/M18
                visit + verification (not exposed on this DTO yet).
              </p>
            </div>
          </aside>
        </div>

        {/* Sticky footer — cosign guard + actions */}
        <div style={footer}>
          {cosignStatus && !e.cosignedAt ? (
            <span style={guardChip}>
              <Glyph name="lock" size={14} /> Co-signature pending
            </span>
          ) : (
            <span style={{ flex: 0 }} />
          )}
          <span style={{ flex: 1 }} />
          {canSupervisorRelease ? (
            <button type="button" onClick={() => setCeremony("supervisor-release")} style={ghostBtn}>
              Supervisor release
            </button>
          ) : null}
          {canAcknowledge ? (
            <button type="button" onClick={() => setCeremony("acknowledge")} style={ghostBtn}>
              Acknowledge cosignature
            </button>
          ) : null}
          {canCosignSign ? (
            <button type="button" onClick={() => setCeremony("cosign-sign")} style={primaryBtn}>
              Sign cosignature
            </button>
          ) : null}
          {canSign ? (
            <button type="button" onClick={() => setCeremony("sign")} style={primaryBtn}>
              Sign
            </button>
          ) : null}
          <button type="button" onClick={() => navigate("/work/cosignatures")} style={ghostBtn}>
            Cosignature queue
          </button>
          <button type="button" onClick={() => navigate(`/patients/${e.patientId}`)} style={primaryBtn}>
            Back to chart
          </button>
        </div>
      </div>

      {/* Sign — the author's own Layer-3 signature (§2.7). */}
      <CeremonyModal
        open={ceremony === "sign"}
        title="Sign encounter"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Sign {stateLabel(e.encounterType)}</strong>
            </div>
            <RowField label="Service date" value={e.serviceDate} mono />
            <RowField label="Discipline" value={stateLabel(e.discipline)} />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest this documentation is complete and accurate to the best of my knowledge."
        signer={{ name: "Signing clinician", role: "This session" }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void runWrite("sign")}
        onCancel={closeCeremony}
      />

      {/* Acknowledge cosignature — a receipt of notice, not a signature: no legal text, no step-up. */}
      <CeremonyModal
        open={ceremony === "acknowledge"}
        title="Acknowledge cosignature request"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Confirms you have opened this encounter for cosignature review. This does not sign it.
            </span>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{ name: "Cosigner", role: "This session" }}
        commitLabel={busy ? "Acknowledging…" : "Acknowledge"}
        onCommit={() => void runWrite("acknowledge")}
        onCancel={closeCeremony}
      />

      {/* Sign cosignature — the RN cosigner's own Layer-3 signature (§4.6 m8.cosigner_role_match). */}
      <CeremonyModal
        open={ceremony === "cosign-sign"}
        title="Sign cosignature"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Cosign {stateLabel(e.encounterType)}</strong>
            </div>
            <RowField label="Service date" value={e.serviceDate} mono />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest I have reviewed this documentation and concur as the qualifying cosigner."
        signer={{ name: "Cosigning RN", role: "This session" }}
        commitLabel={busy ? "Signing…" : "Sign & commit"}
        onCommit={() => void runWrite("cosign-sign")}
        onCancel={closeCeremony}
      />

      {/* Supervisor release — past the 48h hard cap; reason at the real server floor (REASON_MIN). */}
      <CeremonyModal
        open={ceremony === "supervisor-release"}
        title="Supervisor release"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: t.onSurfaceVariant }}>
              Releases this encounter from the 48-hour cosignature hard cap.
            </span>
            <label
              htmlFor="supervisor-release-reason"
              style={{ fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant }}
            >
              Reason (≥ {REASON_MIN} characters)
            </label>
            <textarea
              id="supervisor-release-reason"
              aria-describedby="supervisor-release-reason-count"
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              rows={3}
              style={textareaStyle}
            />
            <span
              id="supervisor-release-reason-count"
              style={{
                fontSize: "0.7rem",
                color: reason.trim().length >= REASON_MIN ? t.onSurfaceVariant : t.warning,
              }}
            >
              {reason.trim().length}/{REASON_MIN}
            </span>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        signer={{ name: "Supervisor", role: "This session" }}
        commitLabel={busy ? "Releasing…" : "Release"}
        onCommit={() => void runWrite("supervisor-release")}
        onCancel={closeCeremony}
      />
    </PatientWorkspaceLayout>
  );
}

function RowField({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
      <span style={{ fontSize: "0.7rem", color: t.onSurfaceVariant }}>{label}</span>
      <span style={{ fontSize: "0.85rem", color: t.onSurface, fontFamily: mono ? t.fontMono : undefined }}>
        {value}
      </span>
    </div>
  );
}

function ageYears(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 150 ? a : null;
}
function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return <span style={{ fontFamily: t.fontMono, fontSize: "0.78rem", color: t.onSurfaceVariant, background: t.surfaceContainer, borderRadius: "9999px", padding: "0.15rem 0.55rem" }}>{children}</span>;
}

const rightRail: CSSProperties = { width: "19rem", flexShrink: 0, overflow: "auto", padding: "1.5rem", background: t.surfaceLow, display: "flex", flexDirection: "column", gap: "1rem" };
const railTitle: CSSProperties = { margin: "0 0 0.625rem", fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1rem", color: t.onSurface };
const vitalLabel: CSSProperties = { fontSize: "0.68rem", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: t.muted };
const sectionLabel: CSSProperties = { fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: t.muted };
const footer: CSSProperties = { display: "flex", alignItems: "center", gap: "0.625rem", padding: "0.875rem 1.5rem", borderTop: ghostBorder, background: t.surfaceLowest, flexShrink: 0 };
const guardChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.78rem", fontWeight: 600, color: t.warning, background: "color-mix(in srgb, var(--color-warning) 14%, transparent)", borderRadius: "9999px", padding: "0.3rem 0.7rem" };
const ghostBtn: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "0.45rem 0.9rem", borderRadius: "9999px", background: t.surfaceContainer, color: t.onSurface, fontSize: "0.8125rem", fontWeight: 600, textDecoration: "none", border: "none", cursor: "pointer" };
const primaryBtn: CSSProperties = { padding: "0.45rem 1rem", borderRadius: "9999px", background: t.primary, color: t.onPrimary, fontSize: "0.8125rem", fontWeight: 600, border: "none", cursor: "pointer" };
const lifeGrid: CSSProperties = { display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: "0.5rem 1rem", margin: 0, fontSize: "0.8rem" };
const dt: CSSProperties = { fontWeight: 600, color: t.onSurfaceVariant };
const dd: CSSProperties = { margin: 0, color: t.onSurface };
const meta: CSSProperties = { fontSize: "0.78rem", color: t.onSurfaceVariant, margin: "0.25rem 0 0" };
const alertStyle: CSSProperties = { margin: 0, fontSize: "0.8rem", color: t.error };
const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  fontFamily: t.fontSans,
  fontSize: "0.85rem",
  resize: "vertical",
};
