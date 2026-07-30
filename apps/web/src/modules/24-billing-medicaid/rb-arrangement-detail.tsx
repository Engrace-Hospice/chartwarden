import {
  CeremonyModal,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the R&B ARRANGEMENT DETAIL (R2, §5.1 #12 + the #13 day
// override modal). One NF Room & Board arrangement: the contract facts, the activate/terminate lifecycle
// actions, and the day-by-day status table. A single day's status can be flipped (pending ↔ billable ↔
// excluded ↔ voided) with a reason — `excluded` REQUIRES one, and a day already consumed by a claim line is
// not offered (the claim must be replaced or voided first). Reads GET /api/v1/rb-arrangements/{id} +
// /api/v1/rb-days; writes POST :activate / :terminate and PATCH /api/v1/rb-days/{id}, each carrying the
// row version as If-Match (§2.5). The server is the only authz point (ADR-0030) — a 412/409/403 surfaces
// inline (role="alert"). Lantern: DetailPageLayout + No-Line table (§6.7); CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  RB_ARRANGEMENT_STATE_TONE,
  RB_DAY_STATUS_TONE,
  humanize,
  money,
  pct,
  shortDate,
  shortId,
  toneOf,
} from "./medicaid-status";
import {
  Card,
  Field,
  SummaryGrid,
  alertStyle,
  backdropStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  iconButtonStyle,
  linkStyle,
  modalStyle,
  modalTitleStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  sectionTitleStyle,
  selectStyle,
  tableStyle,
  td,
  tdMono,
  tdNum,
  textareaStyle,
  th,
  thNum,
} from "./medicaid-ui";

interface RbDay {
  id: string;
  rbArrangementId: string;
  serviceDate: string;
  locOfDay: string;
  perDiemCentsSnapshot: number;
  status: string;
  exclusionReason: string | null;
  medicaidClaimLineId: string | null;
  version: number;
}

interface Arrangement {
  id: string;
  patientId: string;
  providerEntityId: string;
  nfFacilityMdmId: string;
  nfFacilityNameSnapshot: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  nfPerDiemRoutineCents: number;
  nfPerDiemRespCents: number;
  nfPerDiemGipCents: number;
  passThroughPct: number;
  retentionPct: number;
  state: string;
  version: number;
  createdAt: string;
  days?: RbDay[];
}

/** The statuses a manual override may set — `billed` is system-only (set when a claim line consumes it). */
const OVERRIDE_STATUSES = ["pending", "billable", "excluded", "voided"] as const;
const REASON_MIN = 40;

export function MedicaidRbArrangementDetail(): JSX.Element {
  const client = useApiClient();
  const { arrangementId } = useParams<{ arrangementId: string }>();
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [days, setDays] = useState<RbDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [terminating, setTerminating] = useState(false);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dayTarget, setDayTarget] = useState<RbDay | null>(null);

  const load = useCallback(async () => {
    if (!arrangementId) return;
    setLoading(true);
    setError(null);
    const [detailRes, dayRes] = await Promise.all([
      client.GET("/api/v1/rb-arrangements/{id}", { params: { path: { id: arrangementId } } }),
      client.GET("/api/v1/rb-days", { params: { query: { rbArrangementId: arrangementId } } } as never),
    ]);
    if (detailRes.error) {
      setError("Arrangement not found, or you lack scope for this provider entity.");
      setLoading(false);
      return;
    }
    const detail = detailRes.data as unknown as Arrangement;
    setArrangement(detail);
    // The detail read may already embed the days; the dedicated read is the fallback and the refresh path.
    if (!dayRes.error) setDays((dayRes.data as unknown as RbDay[]) ?? []);
    else setDays(detail.days ?? []);
    setLoading(false);
  }, [client, arrangementId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runLifecycle = useCallback(
    async (mode: "activate" | "terminate") => {
      if (!arrangement) return;
      if (mode === "terminate" && reason.trim().length < REASON_MIN) {
        setActionError(`Provide a reason of at least ${REASON_MIN} characters.`);
        return;
      }
      setBusy(true);
      setActionError(null);
      const init = {
        params: {
          path: { id: arrangement.id },
          header: { "If-Match": String(arrangement.version) },
        },
        body: mode === "terminate" ? { reason: reason.trim() } : {},
      };
      const path =
        mode === "activate"
          ? "/api/v1/rb-arrangements/{id}/activate"
          : "/api/v1/rb-arrangements/{id}/terminate";
      const { error: err, response } = (await client.POST(path as never, init as never)) as {
        error?: unknown;
        response?: Response;
      };
      setBusy(false);
      if (err) {
        setActionError(writeErrorMessage(response?.status));
        return;
      }
      setTerminating(false);
      setReason("");
      void load();
    },
    [arrangement, reason, client, load],
  );

  if (!arrangementId) return <EmptyState title="No arrangement" description="No arrangement was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error || !arrangement)
    return <EmptyState title="Unavailable" description={error ?? "No arrangement."} />;

  const canActivate = arrangement.state === "DRAFT";
  const canTerminate = arrangement.state === "ACTIVE";
  const billable = days.filter((d) => d.status === "billable").length;
  const pending = days.filter((d) => d.status === "pending").length;
  const excluded = days.filter((d) => d.status === "excluded").length;
  const ordered = [...days].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={arrangement.nfFacilityNameSnapshot || "R&B Arrangement"}
          breadcrumb="Billing — Medicaid · nursing-facility pass-through"
          actions={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
              <StatusPill
                label={humanize(arrangement.state)}
                tone={toneOf(RB_ARRANGEMENT_STATE_TONE, arrangement.state)}
              />
              <button
                type="button"
                disabled={!canActivate || busy}
                onClick={() => void runLifecycle("activate")}
                style={canActivate && !busy ? primaryButtonStyle : disabledButtonStyle}
              >
                Activate
              </button>
              <button
                type="button"
                disabled={!canTerminate || busy}
                onClick={() => setTerminating(true)}
                style={canTerminate && !busy ? ghostButtonStyle : disabledButtonStyle}
              >
                Terminate
              </button>
            </div>
          }
        />
      }
      aside={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Card title="Day ledger">
            <Field label="Billable" value={String(billable)} />
            <Field label="Pending decision" value={String(pending)} />
            <Field label="Excluded" value={String(excluded)} />
            <Field label="Total days" value={String(days.length)} />
          </Card>
          <Card title="Split">
            <Field label="Pass-through" value={pct(arrangement.passThroughPct, false)} />
            <Field label="Agency retention" value={pct(arrangement.retentionPct, false)} />
          </Card>
          <nav aria-label="Related" style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <a href="/medicaid/billing/rb-arrangements" style={linkStyle}>
              ← All arrangements
            </a>
            <a href={`/medicaid/billing/claims?patientId=${arrangement.patientId}`} style={linkStyle}>
              Claims for this patient →
            </a>
          </nav>
        </div>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        <SummaryGrid>
          <Field label="Patient" value={shortId(arrangement.patientId)} mono />
          <Field label="Facility" value={shortId(arrangement.nfFacilityMdmId)} mono />
          <Field
            label="Effective"
            value={`${shortDate(arrangement.effectiveFrom)} → ${
              arrangement.effectiveTo ? shortDate(arrangement.effectiveTo) : "open"
            }`}
          />
          <Field label="Routine per-diem" value={money(arrangement.nfPerDiemRoutineCents)} />
          <Field label="Respite per-diem" value={money(arrangement.nfPerDiemRespCents)} />
          <Field label="GIP per-diem" value={money(arrangement.nfPerDiemGipCents)} />
          <Field label="Version" value={String(arrangement.version)} />
        </SummaryGrid>

        {actionError ? (
          <p role="alert" aria-live="assertive" style={alertStyle}>
            {actionError}
          </p>
        ) : null}

        <div>
          <h2 style={sectionTitleStyle}>Days</h2>
          {ordered.length === 0 ? (
            <EmptyState
              title="No days generated"
              description="Days are generated once the arrangement is activated."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Service date</th>
                  <th style={th}>LOC</th>
                  <th style={thNum}>Per-diem</th>
                  <th style={th}>Status</th>
                  <th style={th}>Exclusion reason</th>
                  <th style={th}>Claim line</th>
                  <th style={{ ...th, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((d) => {
                  const consumed = Boolean(d.medicaidClaimLineId);
                  return (
                    <tr key={d.id} style={rowLine}>
                      <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                        {shortDate(d.serviceDate)}
                      </td>
                      <td style={td}>{d.locOfDay}</td>
                      <td style={tdNum}>{money(d.perDiemCentsSnapshot)}</td>
                      <td style={td}>
                        <StatusPill
                          label={humanize(d.status)}
                          tone={toneOf(RB_DAY_STATUS_TONE, d.status)}
                        />
                      </td>
                      <td style={{ ...td, maxWidth: "18rem" }}>
                        {d.exclusionReason ?? <span style={mutedStyle}>—</span>}
                      </td>
                      <td style={tdMono}>{consumed ? shortId(d.medicaidClaimLineId) : "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {consumed ? (
                          <span style={mutedStyle} title="Billed on a claim — replace or void that claim first">
                            Billed
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDayTarget(d)}
                            aria-label={`Change status of ${d.serviceDate}`}
                            style={ghostButtonStyle}
                          >
                            Change
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Terminate ceremony — reason ≥40 chars; ends the pass-through and stops day generation. */}
      <CeremonyModal
        open={terminating}
        title="Terminate arrangement"
        attestation={
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <Glyph name="alert" size={16} />
              <strong>{arrangement.nfFacilityNameSnapshot || shortId(arrangement.nfFacilityMdmId)}</strong>
            </div>
            <span style={mutedStyle}>
              Terminating stops day generation. Days already billed on a claim are unaffected.
            </span>
            <label
              htmlFor="m24-rb-terminate-reason"
              style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--color-on-surface-variant)" }}
            >
              Reason (≥ {REASON_MIN} characters)
            </label>
            <textarea
              id="m24-rb-terminate-reason"
              aria-label="Reason for terminating the arrangement"
              aria-describedby="m24-rb-terminate-count"
              aria-invalid={reason.trim().length < REASON_MIN}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={textareaStyle}
            />
            <span id="m24-rb-terminate-count" style={mutedStyle}>
              {reason.trim().length}/{REASON_MIN}
            </span>
            {actionError ? (
              <p role="alert" aria-live="assertive" style={alertStyle}>
                {actionError}
              </p>
            ) : null}
          </div>
        }
        legalText="I confirm this Room & Board arrangement has ended and authorize terminating it in the record."
        signer={{ name: "Billing manager", role: "This session" }}
        commitLabel={busy ? "Working…" : "Terminate"}
        onCommit={() => void runLifecycle("terminate")}
        onCancel={() => {
          setTerminating(false);
          setReason("");
          setActionError(null);
        }}
      />

      {dayTarget ? (
        <DayOverrideModal
          day={dayTarget}
          onClose={() => setDayTarget(null)}
          onApplied={() => {
            setDayTarget(null);
            void load();
          }}
        />
      ) : null}
    </DetailPageLayout>
  );
}

// ── day override modal (§5.1 #13) — status flip with a reason on a single rb_day ────────────────────────
function DayOverrideModal({
  day,
  onClose,
  onApplied,
}: { day: RbDay; onClose: () => void; onApplied: () => void }): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<string>(day.status === "pending" ? "billable" : "pending");
  const [exclusionReason, setExclusionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReason = status === "excluded";
  const reasonMissing = needsReason && exclusionReason.trim().length === 0;

  const apply = useCallback(async () => {
    if (reasonMissing) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { status };
    if (needsReason) body.exclusionReason = exclusionReason.trim();
    const { error: err, response } = (await client.PATCH("/api/v1/rb-days/{id}", {
      params: { path: { id: day.id }, header: { "If-Match": String(day.version) } },
      body,
    } as never)) as { error?: unknown; response?: Response };
    setBusy(false);
    if (err) {
      setError(writeErrorMessage(response?.status));
      return;
    }
    onApplied();
  }, [client, day, status, needsReason, exclusionReason, reasonMissing, onApplied]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="m24-rb-day-title"
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div style={modalStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 id="m24-rb-day-title" style={modalTitleStyle}>
            Change day status
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" style={iconButtonStyle}>
            <Glyph name="close" size={16} label="" />
          </button>
        </div>

        <Field label="Service date" value={shortDate(day.serviceDate)} />
        <Field label="Current status" value={humanize(day.status)} />

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface)" }}>New status</span>
          <select
            aria-label="New day status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={selectStyle}
          >
            {OVERRIDE_STATUSES.filter((s) => s !== day.status).map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </label>

        {needsReason ? (
          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface)" }}>Exclusion reason</span>
            <textarea
              aria-label="Exclusion reason"
              aria-invalid={reasonMissing}
              value={exclusionReason}
              onChange={(e) => setExclusionReason(e.target.value)}
              rows={3}
              style={textareaStyle}
            />
            {reasonMissing ? (
              <span style={{ fontSize: "0.75rem", color: "var(--color-error)" }}>
                An excluded day requires a reason.
              </span>
            ) : null}
          </label>
        ) : null}

        {error ? (
          <p role="alert" style={alertStyle}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" onClick={onClose} style={ghostButtonStyle}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={reasonMissing || busy}
            aria-disabled={reasonMissing || busy}
            style={reasonMissing || busy ? disabledButtonStyle : primaryButtonStyle}
          >
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Map a write status code to a precise, PHI-free inline message (§5.4). */
function writeErrorMessage(status: number | undefined): string {
  if (status === 412) return "This record changed since you opened it — reload and retry.";
  if (status === 409) return "That transition is not available from the current state.";
  if (status === 422) return "The requested change is not valid for this record.";
  if (status === 401 || status === 403) return "You lack permission for this action.";
  if (status === 503) return "The service is unavailable — try again shortly.";
  return "The action could not be completed.";
}
