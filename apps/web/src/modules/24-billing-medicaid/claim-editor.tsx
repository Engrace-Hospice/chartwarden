import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID CLAIM EDITOR (R2, §5.1 #3, #7, #10). The
// single-claim surface: the claim_line projection (rev/Q code, LOC, units, rate — with the R&B lines called
// out), the R&B context panel, the COB context panel (populated only when the claim carries an M23 Medicare
// primary), the latest validation summary with a deep-link into the worklist, and the submission/ack
// timeline links. It also hosts the §10 ceremonies: Submit (#7 — control-number + channel + MCO + latest
// validation outcome + step-up) and the Replace/Void builder (#10 — TOB 817/818, reason ≥40 chars + step-up).
// Reads GET /api/v1/medicaid-claims/{id} (+ /lines); writes POST :submit / :replace / :void carrying the
// claim version as If-Match (§2.5 optimistic concurrency). The server is the only authz point (ADR-0030):
// a 412 (stale), 422 (validation), 503 (adapter/seam unbound — the Phase-1 ADAPTER_NOT_WIRED deferral) or
// 401/403 (step-up) surfaces INLINE (role="alert"), never a toast. Lantern: DetailPageLayout + No-Line table.
import { MedicaidBillingTabs } from "../../shell/medicaid-billing-tabs";
import {
  CLAIM_STATE_TONE,
  VALIDATION_OUTCOME_TONE,
  channelLabel,
  humanize,
  kindLabel,
  money,
  shortDate,
  shortId,
  tobLabel,
  toneOf,
} from "./medicaid-status";
import {
  Card,
  Field,
  SummaryGrid,
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkMonoStyle,
  linkStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  sectionTitleStyle,
  tableStyle,
  td,
  tdMono,
  tdNum,
  textareaStyle,
  th,
  thNum,
} from "./medicaid-ui";

interface ClaimDetail {
  id: string;
  providerEntityId: string;
  patientId: string;
  admissionId: string;
  serviceState: string;
  kind: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  mcoId: string | null;
  medicareClaimId: string | null;
  rbArrangementId: string | null;
  medicaidClaimControlNumber: string;
  state: string;
  version: number;
  validationRunIdLatest: string | null;
  eligibilityOutcomeSnapshot: string | null;
  electronicSubmissionRefusal: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PatientSummary {
  firstName: string;
  lastName: string;
}

interface ClaimLine {
  id: string;
  lineNumber: number;
  serviceDate: string;
  revenueCode: string;
  qCode: string;
  levelOfCare: string;
  units: number;
  rateAtAssemblyCents: number;
  chargesCents: number;
  cobPaidCents: number | null;
  isRb: boolean;
  rbDayId: string | null;
}

type Ceremony = "submit" | "replace" | "void" | null;

const REASON_MIN = 40;
/** §2.2: submission is only offered from READY (the validated, eligibility-fresh state). */
const SUBMITTABLE = new Set(["READY"]);
const NO_GATEWAY_CODE = "MEDICAID_STATE_NO_ELECTRONIC_GATEWAY";
/** §2.3: a replacement/void is only meaningful once the payer has adjudicated the claim. */
const REPLACEABLE = new Set(["ACK_ACCEPTED", "PAID", "DENIED"]);

export function MedicaidClaimEditor(): JSX.Element {
  const client = useApiClient();
  const { claimId } = useParams<{ claimId: string }>();
  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [lines, setLines] = useState<ClaimLine[]>([]);
  const [linesDegraded, setLinesDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ceremony, setCeremony] = useState<Ceremony>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!claimId) return;
    setLoading(true);
    setError(null);
    setLinesDegraded(false);
    const [detailRes, linesRes] = await Promise.all([
      client.GET("/api/v1/medicaid-claims/{id}", { params: { path: { id: claimId } } }),
      client.GET("/api/v1/medicaid-claims/{id}/lines", { params: { path: { id: claimId } } }),
    ]);
    if (detailRes.error) {
      setError("Claim not found, or you lack scope for this provider entity.");
      setLoading(false);
      return;
    }
    const detail = detailRes.data as unknown as ClaimDetail;
    setClaim(detail);
    if (linesRes.error) setLinesDegraded(true);
    else setLines((linesRes.data as unknown as ClaimLine[]) ?? []);
    setLoading(false);
    // Fetched after (not alongside) the claim, since the patient id only becomes known once the
    // claim loads — resolves the "Patient" field to a name instead of a raw id (§5.1's own
    // convention elsewhere, e.g. the M14 IDG History patient banner).
    const pRes = await client.GET("/api/v1/patients/{id}", {
      params: { path: { id: detail.patientId } },
    });
    if (pRes.data) setPatient(pRes.data as unknown as PatientSummary);
  }, [client, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeCeremony = useCallback(() => {
    setCeremony(null);
    setReason("");
    setActionError(null);
  }, []);

  const runWrite = useCallback(
    async (mode: Exclude<Ceremony, null>) => {
      if (!claim) return;
      if (mode !== "submit" && reason.trim().length < REASON_MIN) {
        setActionError(`Provide a reason of at least ${REASON_MIN} characters.`);
        return;
      }
      setBusy(true);
      setActionError(null);
      const init = {
        params: { path: { id: claim.id }, header: { "If-Match": String(claim.version) } },
        body: mode === "submit" ? {} : { reason: reason.trim() },
      };
      const path =
        mode === "submit"
          ? "/api/v1/medicaid-claims/{id}/submit"
          : mode === "replace"
            ? "/api/v1/medicaid-claims/{id}/replace"
            : "/api/v1/medicaid-claims/{id}/void";
      const { error: err, response } = (await client.POST(path as never, init as never)) as {
        error?: unknown;
        response?: Response;
      };
      setBusy(false);
      if (err) {
        const env = (err as { error?: { code?: string; message?: string } }).error;
        // S11: the server message names the manual/paper alternative; show it verbatim.
        setActionError(
          env?.code === NO_GATEWAY_CODE && env.message
            ? env.message
            : writeErrorMessage(response?.status),
        );
        return;
      }
      closeCeremony();
      void load();
    },
    [claim, reason, client, closeCeremony, load],
  );

  if (!claimId) return <EmptyState title="No claim" description="No claim was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error || !claim) return <EmptyState title="Unavailable" description={error ?? "No claim."} />;

  const canSubmit = SUBMITTABLE.has(claim.state) && !claim.electronicSubmissionRefusal;
  const canReplaceVoid = REPLACEABLE.has(claim.state);
  const totalCharges = lines.reduce((acc, l) => acc + l.chargesCents, 0);
  const rbLines = lines.filter((l) => l.isRb);
  const cobPaid = lines.reduce((acc, l) => acc + (l.cobPaidCents ?? 0), 0);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Medicaid Claim"
          breadcrumb={
            <>
              Billing — Medicaid ·{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {claim.medicaidClaimControlNumber}
              </span>
            </>
          }
          actions={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
              <StatusPill
                label={humanize(claim.state)}
                tone={toneOf(CLAIM_STATE_TONE, claim.state)}
              />
              <a href={`/admin/medicaid-billing-audit/${claim.id}`} style={linkStyle}>
                Surveyor view
              </a>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => setCeremony("submit")}
                style={canSubmit ? primaryButtonStyle : disabledButtonStyle}
              >
                Submit
              </button>
              <button
                type="button"
                disabled={!canReplaceVoid}
                onClick={() => setCeremony("replace")}
                style={canReplaceVoid ? ghostButtonStyle : disabledButtonStyle}
              >
                Replace
              </button>
              <button
                type="button"
                disabled={!canReplaceVoid}
                onClick={() => setCeremony("void")}
                style={canReplaceVoid ? ghostButtonStyle : disabledButtonStyle}
              >
                Void
              </button>
            </div>
          }
        >
          <div style={{ marginTop: "0.75rem" }}>
            <MedicaidBillingTabs />
          </div>
        </PageHeader>
      }
      aside={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {claim.electronicSubmissionRefusal ? (
            <Card title="Submission">
              <output style={mutedStyle}>{claim.electronicSubmissionRefusal}</output>
            </Card>
          ) : null}

          {/* R&B context (§5.1) — present only for combined / rb_only claims. */}
          <Card title="Room &amp; Board">
            {claim.rbArrangementId ? (
              <>
                <Field label="Arrangement" value={shortId(claim.rbArrangementId)} mono />
                <Field label="R&amp;B lines" value={String(rbLines.length)} />
                <a
                  href={`/medicaid/billing/rb-arrangements/${claim.rbArrangementId}`}
                  style={linkStyle}
                >
                  Open arrangement →
                </a>
              </>
            ) : (
              <span style={mutedStyle}>
                Hospice-only claim — no NF Room &amp; Board pass-through attached.
              </span>
            )}
          </Card>

          {/* COB context (§2.6) — populated only when a Medicare primary claim is linked (dual-eligible). */}
          <Card title="Coordination of benefits">
            {claim.medicareClaimId ? (
              <>
                <Field label="Medicare primary" value={shortId(claim.medicareClaimId)} mono />
                <Field label="COB paid (lines)" value={money(cobPaid)} />
                <a href={`/billing/claims/${claim.medicareClaimId}`} style={linkStyle}>
                  Open Medicare claim →
                </a>
              </>
            ) : (
              <span style={mutedStyle}>
                Medicaid-primary claim — no Medicare COB chain on this service period.
              </span>
            )}
          </Card>

          <Card title="Latest validation">
            {claim.validationRunIdLatest ? (
              <Field label="Run" value={shortId(claim.validationRunIdLatest)} mono />
            ) : (
              <span style={mutedStyle}>No validation run on file.</span>
            )}
            <Field
              label="Eligibility at assembly"
              value={
                claim.eligibilityOutcomeSnapshot ? (
                  <StatusPill
                    label={humanize(claim.eligibilityOutcomeSnapshot)}
                    tone={toneOf(VALIDATION_OUTCOME_TONE, "info")}
                  />
                ) : (
                  "—"
                )
              }
            />
            <a href={`/medicaid/billing/claims/${claim.id}/validation`} style={linkStyle}>
              Open validation worklist →
            </a>
          </Card>

          <nav
            aria-label="Claim timelines"
            style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}
          >
            <a href={`/medicaid/billing/claims/${claim.id}/submissions`} style={linkStyle}>
              Submissions timeline →
            </a>
            <a href={`/medicaid/billing/claims/${claim.id}/acknowledgments`} style={linkStyle}>
              Acknowledgments timeline →
            </a>
          </nav>
        </div>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <SummaryGrid>
          <Field label="Service state" value={claim.serviceState} />
          <Field label="Claim kind" value={kindLabel(claim.kind)} />
          <Field label="Type of bill" value={tobLabel(claim.tob)} />
          <Field
            label="Service dates"
            value={`${shortDate(claim.serviceFrom)} → ${shortDate(claim.serviceTo)}`}
          />
          <Field
            label="MCO"
            value={claim.mcoId ? shortId(claim.mcoId) : "Fee-for-service"}
            mono={Boolean(claim.mcoId)}
          />
          <Field label="Total charges" value={money(totalCharges)} />
          <Field
            label="Patient"
            value={patient ? `${patient.firstName} ${patient.lastName}` : shortId(claim.patientId)}
            mono={!patient}
          />
          <Field label="Version" value={String(claim.version)} />
        </SummaryGrid>

        <div>
          <h2 style={sectionTitleStyle}>Service lines</h2>
          {linesDegraded ? (
            <EmptyState
              title="Lines unavailable"
              description="The claim-line read is degraded — reload to retry."
            />
          ) : lines.length === 0 ? (
            <EmptyState title="No lines" description="This claim has no service lines." />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Service date</th>
                  <th style={th}>Rev</th>
                  <th style={th}>Q</th>
                  <th style={th}>LOC</th>
                  <th style={thNum}>Units</th>
                  <th style={thNum}>Rate</th>
                  <th style={thNum}>Charges</th>
                  <th style={thNum}>COB paid</th>
                  <th style={th}>Source</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} style={rowLine}>
                    <td style={tdNum}>{l.lineNumber}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {shortDate(l.serviceDate)}
                    </td>
                    <td style={tdMono}>{l.revenueCode}</td>
                    <td style={tdMono}>{l.qCode}</td>
                    <td style={td}>{l.levelOfCare}</td>
                    <td style={tdNum}>{l.units}</td>
                    <td style={tdNum}>{money(l.rateAtAssemblyCents)}</td>
                    <td style={tdNum}>{money(l.chargesCents)}</td>
                    <td style={tdNum}>{l.cobPaidCents == null ? "—" : money(l.cobPaidCents)}</td>
                    <td style={td}>
                      {l.isRb ? (
                        l.rbDayId ? (
                          <a
                            href={`/medicaid/billing/rb-arrangements/${claim.rbArrangementId ?? ""}`}
                            style={linkMonoStyle}
                          >
                            R&amp;B day
                          </a>
                        ) : (
                          "R&B"
                        )
                      ) : (
                        "Hospice"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* §10 Submit ceremony (#7): control number + channel/MCO + validation posture + step-up. */}
      <CeremonyModal
        open={ceremony === "submit"}
        title="Submit claim to the state"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Transmit {claim.medicaidClaimControlNumber}</strong>
            </div>
            <Field label="Claim control #" value={claim.medicaidClaimControlNumber} mono />
            <Field label="Service state" value={claim.serviceState} />
            <Field
              label="Routing"
              value={claim.mcoId ? `MCO ${shortId(claim.mcoId)}` : channelLabel("direct_mmis")}
            />
            <Field label="Total charges" value={money(totalCharges)} />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest this Medicaid claim is accurate, supported by the record, and ready for transmission to the state."
        signer={{ name: "Billing manager", role: "This session" }}
        stepUp={{ label: "Re-enter your credentials to submit", type: "password" }}
        commitLabel={busy ? "Working…" : "Submit to state"}
        onCommit={() => void runWrite("submit")}
        onCancel={closeCeremony}
      />

      {/* §10 Replacement / Void builder (#10): TOB 817/818, reason ≥40 chars + step-up. */}
      <CeremonyModal
        open={ceremony === "replace" || ceremony === "void"}
        title={ceremony === "void" ? "Void claim (TOB 818)" : "Replace claim (TOB 817)"}
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={mutedStyle}>
              {ceremony === "void"
                ? "Builds a TOB-818 void draft with no service lines, opened in the editor."
                : "Builds a TOB-817 replacement draft copying this claim's lines, opened in the editor."}
            </span>
            <Field label="Original control #" value={claim.medicaidClaimControlNumber} mono />
            <label
              htmlFor="m24-rv-reason"
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "var(--color-on-surface-variant)",
              }}
            >
              Reason (≥ {REASON_MIN} characters)
            </label>
            <textarea
              id="m24-rv-reason"
              aria-label={`Reason for ${ceremony === "void" ? "voiding" : "replacing"} the claim`}
              aria-describedby="m24-rv-reason-count"
              aria-invalid={reason.trim().length < REASON_MIN}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={textareaStyle}
            />
            <span id="m24-rv-reason-count" style={mutedStyle}>
              {reason.trim().length}/{REASON_MIN}
            </span>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText={
          ceremony === "void"
            ? "I authorize voiding this submitted Medicaid claim and understand a TOB-818 cancel will be transmitted."
            : "I authorize replacing this submitted Medicaid claim and understand a TOB-817 replacement will be transmitted."
        }
        signer={{ name: "Billing manager", role: "This session" }}
        stepUp={{ label: "Re-enter your credentials to continue", type: "password" }}
        epcs={false}
        commitLabel={
          busy ? "Working…" : ceremony === "void" ? "Build void draft" : "Build replacement draft"
        }
        onCommit={() => void runWrite(ceremony === "void" ? "void" : "replace")}
        onCancel={closeCeremony}
      />
    </DetailPageLayout>
  );
}

/** Map a write status code to a precise, PHI-free inline message (§5.4). */
function writeErrorMessage(status: number | undefined): string {
  if (status === 412) return "This claim changed since you opened it — close and reopen to retry.";
  if (status === 422) return "Validation failed — resolve the claim's open findings first.";
  if (status === 409) return "This action is not available from the claim's current state.";
  if (status === 401 || status === 403)
    return "Step-up authentication is required, or you lack permission for this action.";
  if (status === 503)
    return "The state adapter is not wired for this service state — submission is unavailable.";
  return "The action could not be completed.";
}
