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
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the CLAIM EDITOR (R2, §5.1 #3, #7, #10).
// The full claim detail surface: the claim_line projection (rev/Q codes, LOC, modifiers, ICD pointers), the
// HIPPS / SIA / sequestration pricing cards, the latest validation-run summary (with a deep-link into the
// §11.A worklist drawer), and the replacement-chain breadcrumb (<nav aria-label="Replacement chain">). It
// also hosts the §10 ceremonies: Submit (#7 — control number + active MAC jurisdiction + latest validation
// outcome) and the Replace/Void builder (#10 — TOB 817/818, reason at the server's real floor + `ifVersion`).
// Reads GET /api/v1/billing/claims/:id (+ /lines, /state-history); writes go through POST :submit / :replace /
// :void with an If-Match header (the claim version) for §2.5 optimistic concurrency. The server is the only
// authz point (ADR-0030): a 503 (seams unbound) degrades the surface; a 412 (If-Match) / 422 (validation) on a
// write surfaces inline (role="alert"), never a toast; a STEP_UP_REQUIRED denial routes to the real /step-up
// screen with a returnTo, and the in-progress ceremony/reason survives that round trip via a process-memory
// draft cache (write-workflow.ts — never browser storage, since the reason can carry PHI) (TASK-021). Lantern:
// DetailPageLayout + No-Line table (§6.7), mono identifiers (claim control #, CCN, MAC), tabular-nums figures,
// CSS-var tokens only; every status pill resolves through billing-status.ts (§6.6). NOTE: the openapi marks
// these reads' bodies as `never` and the state-history query as `never`, so result payloads are cast and the
// optimistic-concurrency header is passed through a narrow cast — the server stays the authoritative
// parser/enforcer.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import type { RhcCarryOver } from "../../shell/rhc-carry-over";
import {
  claimStateTone,
  dollars,
  statusLabel,
  tobLabel,
  validationRunTone,
} from "./billing-status";
import { ClaimHistory } from "./claim-history";
import { ClaimStayEndPanels } from "./claim-stay-end-panels";
import { DdeFileAction, claimDdeOptions } from "./dde-file-action";
import type { ClaimAttention } from "./discharge-attention";
import { RhcDayCount } from "./rhc-day-count";
import { authFailureRedirect, clearDraft, loadDraft, saveDraft } from "./write-workflow";

const REPLACEABLE: ReadonlySet<string> = new Set(["ack_accepted", "ack_partial", "paid"]);

interface PerDiemClassPricing {
  perDiemClassCode: string;
  perDiemRateCents: number;
  wageIndexCcn: string;
  wageIndexFiscalYear: number;
  wageIndexFactor: string;
  calculatedAt: string;
  rhcDays1to60?: number;
  rhcDays61Plus?: number;
  rhcCarryOver?: RhcCarryOver | null;
}

interface SiaPricing {
  windowStart: string;
  totalQualifyingMinutes: number;
  siaAddOnCents: number;
  calculatedAt: string;
}

interface ValidationRunSummary {
  validationRunId: string;
  outcome: string;
  rulesExecuted: number;
  rulesPassed: number;
  rulesFailed: number;
  rulesWarn: number;
  rulesInfo: number;
  completedAt: string;
}

interface ClaimDetail {
  claimId: string;
  providerEntityId: string;
  patientId: string;
  admissionId: string;
  tob: string;
  state: string;
  serviceFrom: string;
  serviceTo: string;
  claimControlNumber: string;
  payerClaimControlNumber: string | null;
  macJurisdiction: string;
  totalChargeCents: number;
  totalExpectedPaymentCents: number;
  version: number;
  sequestrationAppliedPct: string;
  sequestrationPolicyId: string;
  replacesClaimId: string | null;
  replacedByClaimId: string | null;
  replacementReason: string | null;
  latestValidation: ValidationRunSummary | null;
  pricing: { perDiemClass: PerDiemClassPricing | null; sia: SiaPricing | null };
  /** How the stay ended → missing discharge details / Type of Bill change (server-computed, live M6 facts). */
  attention?: ClaimAttention | null;
}

interface ClaimLine {
  claimLineId: string;
  lineNumber: number;
  revenueCode: string;
  qCode: string;
  levelOfCare: string;
  hcpcsCode: string | null;
  serviceDateFrom: string;
  serviceDateTo: string;
  unitCount: number;
  unitRateCents: number;
  lineChargeCents: number;
  modifiers: readonly string[];
  icdPointerPositions: readonly number[];
}

// :claimId is the last path segment of /billing/claims/:claimId (routing not yet wired; M33/M34 precedent).
function claimIdFromPath(): string {
  const segs = window.location.pathname.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

type CeremonyMode = "submit" | "replace" | "void" | null;

// TASK-021 — the server's real minimum (packages/billing/src/schemas/{claim-replace,claim-void}.ts:
// `reason: string(minLength 20)`); the previous 40-char client floor was stricter than the wire contract.
const REASON_MIN = 20;

interface CeremonyDraft {
  ceremony: Exclude<CeremonyMode, null>;
  reason: string;
}
const ceremonyDraftKey = (claimId: string): string => `claim-ceremony:${claimId}`;

/** The claim-workbench's Replace/Void links (`?ceremony=replace|void`) open straight into that ceremony. */
function ceremonyFromParam(value: string | null): CeremonyMode {
  return value === "submit" || value === "replace" || value === "void" ? value : null;
}

export function ClaimEditor(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [claimId] = useState(claimIdFromPath);
  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [lines, setLines] = useState<ClaimLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linesDegraded, setLinesDegraded] = useState(false);

  // Active §10 ceremony + the inline write outcome (412/422/503 surface here, never a toast). The initial
  // ceremony resolves, in order: a resumed draft (a step-up round trip back to this exact page) > a
  // `?ceremony=` deep link (from the workbench's Replace/Void links) > none. The reason resumes only from
  // the draft — a fresh deep link never pre-fills it.
  const initialCeremonyDraft = loadDraft<CeremonyDraft>(ceremonyDraftKey(claimId));
  const [ceremony, setCeremony] = useState<CeremonyMode>(
    initialCeremonyDraft?.ceremony ?? ceremonyFromParam(searchParams.get("ceremony")),
  );
  const [reason, setReason] = useState(initialCeremonyDraft?.reason ?? "");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the draft cache current as the ceremony opens/closes or the reason is typed.
  useEffect(() => {
    if (ceremony) saveDraft(ceremonyDraftKey(claimId), { ceremony, reason });
    else clearDraft(ceremonyDraftKey(claimId));
  }, [claimId, ceremony, reason]);

  // The `?ceremony=` deep link has done its job once read into state above — strip it so a reload or the
  // back button doesn't keep reopening it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs once on mount only.
  useEffect(() => {
    if (searchParams.has("ceremony")) setSearchParams({}, { replace: true });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLinesDegraded(false);
    const [detailRes, linesRes] = await Promise.all([
      client.GET("/api/v1/billing/claims/{id}", { params: { path: { id: claimId } } }),
      client.GET("/api/v1/billing/claims/{id}/lines", { params: { path: { id: claimId } } }),
    ]);
    // The claim detail is the page anchor; a 404/503/403 here fails the whole surface.
    if (detailRes.error) {
      setError("Claim not found, the billing read seam is not bound, or you lack scope.");
      setLoading(false);
      return;
    }
    setClaim(detailRes.data as unknown as ClaimDetail);
    // Lines are best-effort: an absent read leaves the table degraded, never throws.
    if (linesRes.error) setLinesDegraded(true);
    else setLines(((linesRes.data as unknown as ClaimLine[]) ?? []) as ClaimLine[]);
    setLoading(false);
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
    async (mode: Exclude<CeremonyMode, null>) => {
      if (!claim) return;
      if ((mode === "replace" || mode === "void") && reason.trim().length < REASON_MIN) {
        setActionError(`Provide a reason of at least ${REASON_MIN} characters.`);
        return;
      }
      setBusy(true);
      setActionError(null);
      const init = {
        params: {
          path: { id: claim.claimId },
          header: { "If-Match": String(claim.version) },
        },
        // §2.5 — replace/void must carry `ifVersion` (the row version the caller read) alongside the
        // If-Match header; the route's TypeBox body (ClaimReplaceRequest/ClaimVoidRequest) requires it and
        // previously never received it, so every replace/void 422'd before If-Match was even checked.
        body: mode === "submit" ? {} : { reason: reason.trim(), ifVersion: claim.version },
      };
      const path =
        mode === "submit"
          ? "/api/v1/billing/claims/{id}/submit"
          : mode === "replace"
            ? "/api/v1/billing/claims/{id}/replace"
            : "/api/v1/billing/claims/{id}/void";
      // The header/body are not in the typed shape (openapi emits `never`), so the init is cast; the result
      // collapses to `never` and is read through a narrow envelope shape for the status code.
      const { error: err, response } = (await client.POST(path as never, init as never)) as {
        error?: { error?: { code?: string } };
        response?: Response;
      };
      if (err) {
        const redirect = authFailureRedirect(
          response?.status,
          err?.error?.code,
          window.location.pathname,
        );
        if (redirect) {
          // The draft-cache effect above already stashed {ceremony, reason} — resume it on return.
          navigate(redirect);
          return;
        }
        setBusy(false);
        if (response?.status === 412)
          setActionError("This claim changed since you opened it — close and reopen to retry.");
        else if (response?.status === 422)
          setActionError("Validation failed — resolve the claim's open findings first.");
        else if (response?.status === 503)
          setActionError("Billing write seam unavailable — try again shortly.");
        else if (response?.status === 403)
          setActionError("You do not have permission for this action.");
        else setActionError("The action could not be completed.");
        return;
      }
      setBusy(false);
      closeCeremony();
      void load();
    },
    [claim, reason, client, navigate, closeCeremony, load],
  );

  if (loading) return <LoadingSpinner />;
  if (error || !claim) return <EmptyState title="Unavailable" description={error ?? "No claim."} />;

  const canSubmit = claim.state === "ready";
  // The server's REPLACEABLE_STATES (write-service-drizzle.ts): accepted, partially accepted, paid.
  const canReplaceVoid = REPLACEABLE.has(claim.state);
  const v = claim.latestValidation;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Claim Editor"
          actions={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
              <StatusPill label={statusLabel(claim.state)} tone={claimStateTone(claim.state)} />
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
          <BillingTabs />
        </PageHeader>
      }
      aside={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <ClaimStayEndPanels
            claim={claim}
            canReplace={canReplaceVoid}
            onReplace={() => setCeremony("replace")}
            onRevalidated={() => void load()}
          />
          <DdeFileAction
            key={claim.claimId}
            subjectId={claim.claimId}
            options={claimDdeOptions(claim.state)}
          />
          <ReplacementChain claim={claim} />
          <ValidationSummary claimId={claim.claimId} run={v} />
          <SequestrationCard claim={claim} />
          <nav
            aria-label="Claim timelines"
            style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}
          >
            <a href={`/billing/claims/${claim.claimId}/submissions`} style={linkStyle}>
              Submissions timeline →
            </a>
            <a href={`/billing/claims/${claim.claimId}/acknowledgments`} style={linkStyle}>
              Acknowledgments timeline →
            </a>
            <a href={`/billing/claims/${claim.claimId}/validation`} style={linkStyle}>
              Validation worklist →
            </a>
          </nav>
          <nav
            aria-label="Related remittance and denial work"
            style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}
          >
            <Link to="/remittance" style={linkStyle}>
              Remittances →
            </Link>
            <Link to="/remittance/denials" style={linkStyle}>
              Denials →
            </Link>
          </nav>
        </div>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <ClaimSummaryGrid claim={claim} />
        <PricingCards claim={claim} />
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
            <LinesTable lines={lines} />
          )}
        </div>
        <ClaimHistory claimId={claim.claimId} />
      </section>

      {/* §10 Submit ceremony (#7): control number + active MAC + latest validation outcome. A STEP_UP_REQUIRED
          denial routes to the real /step-up screen (TASK-021) rather than a local decorative credential
          field — the modal has no step-up input because typing into one here never verified anything. */}
      <CeremonyModal
        open={ceremony === "submit"}
        title="Submit claim to MAC"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="shield" size={16} />
              <strong>Transmit claim {claim.claimControlNumber}</strong>
            </div>
            <Field label="Claim control #" value={claim.claimControlNumber} mono />
            <Field label="Active MAC jurisdiction" value={claim.macJurisdiction} mono />
            <Field
              label="Latest validation outcome"
              value={
                v ? (
                  <StatusPill label={statusLabel(v.outcome)} tone={validationRunTone(v.outcome)} />
                ) : (
                  "No run on file"
                )
              }
            />
            <Field label="Expected payment" value={dollars(claim.totalExpectedPaymentCents)} />
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I attest this claim is accurate, supported by the record, and ready for transmission to the MAC."
        signer={{ name: "Billing manager", role: "This session" }}
        commitLabel="Submit to MAC"
        onCommit={() => void runWrite("submit")}
        onCancel={closeCeremony}
      />

      {/* §10 Replacement / Void builder (#10): TOB 817/818, reason at the real server floor (TASK-021,
          REASON_MIN) + ifVersion in the write body; step-up denials route to /step-up (see above). */}
      <CeremonyModal
        open={ceremony === "replace" || ceremony === "void"}
        title={ceremony === "void" ? "Void claim (TOB 818)" : "Replace claim (TOB 817)"}
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <span style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
              {ceremony === "void"
                ? "Builds a TOB-818 void draft with no service lines, opened in the editor."
                : "Builds a TOB-817 replacement draft copying this claim's lines, opened in the editor."}
            </span>
            <Field label="Original claim control #" value={claim.claimControlNumber} mono />
            <label
              htmlFor="rv-reason"
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "var(--color-on-surface-variant)",
              }}
            >
              Reason (≥ {REASON_MIN} characters)
            </label>
            <textarea
              id="rv-reason"
              aria-label={`Reason for ${ceremony === "void" ? "voiding" : "replacing"} the claim`}
              aria-describedby="rv-reason-count"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={textareaStyle}
            />
            <span
              id="rv-reason-count"
              style={{
                fontSize: "0.7rem",
                color:
                  reason.trim().length >= REASON_MIN
                    ? "var(--color-on-surface-variant)"
                    : "var(--color-warning, var(--color-on-surface-variant))",
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
        legalText={
          ceremony === "void"
            ? "I authorize voiding this submitted claim and understand a TOB-818 cancel will be transmitted."
            : "I authorize replacing this submitted claim and understand a TOB-817 replacement will be transmitted."
        }
        signer={{ name: "Billing manager", role: "This session" }}
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

// ── replacement-chain breadcrumb (§5.4: <nav aria-label="Replacement chain">) ─────────────────────────
function ReplacementChain({ claim }: { claim: ClaimDetail }): JSX.Element {
  const hasPrev = Boolean(claim.replacesClaimId);
  const hasNext = Boolean(claim.replacedByClaimId);
  return (
    <nav aria-label="Replacement chain" style={cardStyle}>
      <h3 style={cardTitleStyle}>Replacement chain</h3>
      {!hasPrev && !hasNext ? (
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          This is an original claim — no replacement chain.
        </span>
      ) : (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.3rem",
            fontSize: "0.8rem",
          }}
        >
          {hasPrev ? (
            <li>
              <a href={`/billing/claims/${claim.replacesClaimId}`} style={linkMonoStyle}>
                ← Replaces {claim.replacesClaimId}
              </a>
            </li>
          ) : null}
          <li style={{ fontFamily: "var(--font-mono)", color: "var(--color-on-surface)" }}>
            • {claim.claimControlNumber} (current)
          </li>
          {hasNext ? (
            <li>
              <a href={`/billing/claims/${claim.replacedByClaimId}`} style={linkMonoStyle}>
                Replaced by {claim.replacedByClaimId} →
              </a>
            </li>
          ) : null}
        </ol>
      )}
      {claim.replacementReason ? (
        <span style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
          Reason: {claim.replacementReason}
        </span>
      ) : null}
    </nav>
  );
}

// ── latest validation-run summary with a worklist deep-link ───────────────────────────────────────────
function ValidationSummary({
  claimId,
  run,
}: { claimId: string; run: ValidationRunSummary | null }): JSX.Element {
  return (
    <section style={cardStyle}>
      <h3 style={cardTitleStyle}>Latest validation</h3>
      {!run ? (
        <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          No validation run on file.
        </span>
      ) : (
        <>
          <StatusPill label={statusLabel(run.outcome)} tone={validationRunTone(run.outcome)} />
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              fontSize: "0.78rem",
              color: "var(--color-on-surface-variant)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span>{run.rulesExecuted} run</span>
            <span>{run.rulesPassed} passed</span>
            <span>{run.rulesFailed} failed</span>
            <span>{run.rulesWarn} warn</span>
          </div>
        </>
      )}
      <a href={`/billing/claims/${claimId}/validation`} style={linkStyle}>
        Open validation worklist →
      </a>
    </section>
  );
}

// ── sequestration card ────────────────────────────────────────────────────────────────────────────────
function SequestrationCard({ claim }: { claim: ClaimDetail }): JSX.Element {
  return (
    <section style={cardStyle}>
      <h3 style={cardTitleStyle}>Sequestration</h3>
      <Field label="Applied reduction" value={`${claim.sequestrationAppliedPct}%`} />
      <Field label="Policy" value={claim.sequestrationPolicyId} mono />
    </section>
  );
}

// ── claim summary grid (header facts) ─────────────────────────────────────────────────────────────────
function ClaimSummaryGrid({ claim }: { claim: ClaimDetail }): JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(12rem, 1fr))",
        gap: "0.75rem 1.5rem",
      }}
    >
      <Field label="Type of bill" value={tobLabel(claim.tob)} />
      <Field label="MAC jurisdiction" value={claim.macJurisdiction} mono />
      <Field label="Service dates" value={`${claim.serviceFrom} → ${claim.serviceTo}`} />
      <Field label="Total charge" value={dollars(claim.totalChargeCents)} />
      <Field label="Expected payment" value={dollars(claim.totalExpectedPaymentCents)} />
      <Field
        label="Payer control #"
        value={claim.payerClaimControlNumber ?? "—"}
        mono={Boolean(claim.payerClaimControlNumber)}
      />
    </div>
  );
}

// ── Per-diem (internal class) / SIA pricing cards ─────────────────────────────────────────────────────────────────────────
function PricingCards({ claim }: { claim: ClaimDetail }): JSX.Element {
  const { perDiemClass, sia } = claim.pricing;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
      <section style={{ ...cardStyle, minWidth: "16rem", flex: "1 1 16rem" }}>
        <h3 style={cardTitleStyle}>Per-diem pricing</h3>
        {!perDiemClass ? (
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            Not priced.
          </span>
        ) : (
          <>
            <Field label="Per-diem class (internal)" value={perDiemClass.perDiemClassCode} mono />
            <Field label="Per-diem rate" value={dollars(perDiemClass.perDiemRateCents)} />
            <Field label="Wage-index CCN" value={perDiemClass.wageIndexCcn} mono />
            <Field
              label="Wage index"
              value={`${perDiemClass.wageIndexFactor} · FY${perDiemClass.wageIndexFiscalYear}`}
            />
          </>
        )}
      </section>
      <section style={{ ...cardStyle, minWidth: "16rem", flex: "1 1 16rem" }}>
        <h3 style={cardTitleStyle}>Service Intensity Add-on (SIA)</h3>
        {!sia ? (
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            No SIA add-on.
          </span>
        ) : (
          <>
            <Field label="Window start" value={sia.windowStart} />
            <Field label="Qualifying minutes" value={String(sia.totalQualifyingMinutes)} />
            <Field label="SIA add-on" value={dollars(sia.siaAddOnCents)} />
          </>
        )}
      </section>
      {perDiemClass &&
      perDiemClass.rhcDays1to60 !== undefined &&
      perDiemClass.rhcDays61Plus !== undefined ? (
        <section style={{ ...cardStyle, flex: "1 1 100%" }}>
          <h3 style={cardTitleStyle}>RHC day count</h3>
          <RhcDayCount
            pricing={{
              rhcDays1to60: perDiemClass.rhcDays1to60,
              rhcDays61Plus: perDiemClass.rhcDays61Plus,
              rhcCarryOver: perDiemClass.rhcCarryOver ?? null,
            }}
          />
        </section>
      ) : null}
    </div>
  );
}

// ── No-Line service-lines table (§6.7): modifiers + ICD pointers per line ─────────────────────────────
function LinesTable({ lines }: { lines: ClaimLine[] }): JSX.Element {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
          <th style={thStyle}>#</th>
          <th style={thStyle}>Rev</th>
          <th style={thStyle}>Q</th>
          <th style={thStyle}>LOC</th>
          <th style={thStyle}>HCPCS</th>
          <th style={thStyle}>Service dates</th>
          <th style={{ ...thStyle, textAlign: "right" }}>Units</th>
          <th style={{ ...thStyle, textAlign: "right" }}>Rate</th>
          <th style={{ ...thStyle, textAlign: "right" }}>Charge</th>
          <th style={thStyle}>Modifiers</th>
          <th style={thStyle}>ICD ptrs</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr
            key={l.claimLineId}
            style={{ background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent" }}
          >
            <td style={numTd}>{l.lineNumber}</td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{l.revenueCode}</td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{l.qCode}</td>
            <td style={tdStyle}>{statusLabel(l.levelOfCare)}</td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{l.hcpcsCode ?? "—"}</td>
            <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
              {l.serviceDateFrom} → {l.serviceDateTo}
            </td>
            <td style={numTd}>{l.unitCount}</td>
            <td style={numTd}>{dollars(l.unitRateCents)}</td>
            <td style={numTd}>{dollars(l.lineChargeCents)}</td>
            <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>
              {l.modifiers.length ? l.modifiers.join(" ") : "—"}
            </td>
            <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
              {l.icdPointerPositions.length ? l.icdPointerPositions.join(", ") : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Field({
  label,
  value,
  mono,
}: { label: string; value: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</span>
      <span
        style={{
          fontSize: "0.85rem",
          color: "var(--color-on-surface)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {value}
      </span>
    </div>
  );
}

const sectionTitleStyle = {
  margin: "0 0 0.5rem",
  fontFamily: "var(--font-display)",
  fontSize: "1rem",
  fontWeight: 500 as const,
  color: "var(--color-on-surface)",
};
const cardStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.5rem",
  background: "var(--color-surface-lowest)",
  borderRadius: "var(--radius-xl, 1rem)",
  boxShadow: "var(--shadow-soft)",
  padding: "1rem 1.25rem",
};
const cardTitleStyle = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: "0.95rem",
  fontWeight: 500 as const,
  color: "var(--color-on-surface)",
};
const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600 as const,
};
const tdStyle = { padding: "0.5rem 0.75rem", color: "var(--color-on-surface)" };
const numTd = { ...tdStyle, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };
const linkStyle = { fontSize: "0.8rem", color: "var(--color-primary)", textDecoration: "none" };
const linkMonoStyle = { ...linkStyle, fontFamily: "var(--font-mono)" };
const alertStyle = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
const textareaStyle = {
  width: "100%",
  padding: "0.5rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontFamily: "var(--font-sans)",
  resize: "vertical" as const,
};
const primaryButtonStyle = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-primary)",
  color: "var(--color-on-primary)",
  fontSize: "0.8rem",
  fontWeight: 600 as const,
};
const ghostButtonStyle = {
  padding: "0.4rem 0.85rem",
  borderRadius: "var(--radius-md)",
  border: "none",
  cursor: "pointer",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.8rem",
  fontWeight: 600 as const,
  textDecoration: "none",
};
const disabledButtonStyle = { ...ghostButtonStyle, cursor: "not-allowed", opacity: 0.5 };
