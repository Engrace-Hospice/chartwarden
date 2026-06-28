import {
  AdminSplitLayout,
  EmptyState,
  LoadingSpinner,
  MaskedIdentifier,
  PageHeader,
  SealedBlock,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the SURVEYOR READ VIEW (R2, §5.1 #21,
// route /admin/billing-audit, navGroup "Admin"). A read-only, denylist-aware projection of a single claim's
// compliance trail for an auditor/surveyor: the claim state timeline, validation runs (+ applied overrides),
// submissions, and 999/277CA/835 acknowledgments. INTERNAL worker-correlation identifiers (submission ids,
// acknowledgment ids, validation-run ids, actor membership ids) are REDACTED to a masked tail (they are
// operational plumbing, not the surveyor's concern); internal worker artifacts (the generated X12 file URI)
// read as a SealedBlock — visible AS redaction, never a blank. This surface is read-only: it issues NO writes.
//   GET /api/v1/billing/claims                         → the claim picker (page anchor) — REQUIRED.
//   GET /api/v1/billing/claims/{id}/state-history      → the transition timeline.
//   GET /api/v1/claims/{id}/validation-runs[/{runId}]  → runs + per-rule override status.
//   GET /api/v1/billing/claims/{id}/submissions        → dispatch attempts.
//   GET /api/v1/billing/claims/{id}/acknowledgments    → 999 / 277CA / 835 acks.
// All reads are org-scoped server-side (RLS); the server is the only authz point (ADR-0030) — a 503 degrades
// gracefully. Lantern: AdminSplitLayout (claim list | projection), No-Line tables (§6.7), CSS-var tokens only;
// state/outcome tones resolve through billing-status.ts (§6.6).
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  ackOutcomeTone,
  claimStateTone,
  statusLabel,
  submissionStatusTone,
  validationRunTone,
  validationSeverityTone,
} from "./billing-status";

interface ClaimSummary {
  claimId: string;
  claimControlNumber: string;
  state: string;
}

interface ClaimPage {
  items: ClaimSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface StateHistoryRow {
  historyId: string;
  fromState: string | null;
  toState: string;
  at: string;
  actorMembershipId: string | null;
  actorKind: string;
  reason: string | null;
}

interface ValidationRunView {
  validationRunId: string;
  outcome: string;
  rulesExecuted: number;
  rulesPassed: number;
  rulesFailed: number;
  startedAt: string;
}

interface OverrideView {
  overrideMembershipId: string;
  overrideRoleApplied: string;
  reason: string;
  appliedAt: string;
}

interface ResultView {
  resultId: string;
  ruleKey: string;
  severity: string;
  override: OverrideView | null;
}

interface OverrideEntry extends OverrideView {
  ruleKey: string;
  severity: string;
}

interface SubmissionRow {
  submissionId: string;
  kind: string;
  attemptIndex: number;
  outcome: string;
  outcomeReason: string | null;
  generatedFileUri: string | null;
  submittedAt: string | null;
}

interface AcknowledgmentRow {
  acknowledgmentId: string;
  submissionId: string;
  kind: string;
  outcomeStatus: string;
  ackReceivedAt: string;
}

interface Projection {
  history: StateHistoryRow[];
  runs: ValidationRunView[];
  overrides: OverrideEntry[];
  submissions: SubmissionRow[];
  acknowledgments: AcknowledgmentRow[];
}

function claimsInit(cursor: string | null): unknown {
  const query: Record<string, string | number> = { limit: 50 };
  if (cursor) query.cursor = cursor;
  return { params: { query } };
}

export function SurveyorReadView(): JSX.Element {
  const client = useApiClient();
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [selected, setSelected] = useState<ClaimSummary | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadClaims = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/billing/claims", claimsInit(null) as never);
    if (res.error) {
      setError("Surveyor view unavailable — the billing read seam is not bound, or you lack scope.");
      setLoading(false);
      return;
    }
    setClaims(((res.data as unknown as ClaimPage)?.items ?? []) as ClaimSummary[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void loadClaims();
  }, [loadClaims]);

  const loadProjection = useCallback(
    async (claim: ClaimSummary) => {
      setSelected(claim);
      setProjection(null);
      setDetailLoading(true);
      setDetailError(null);
      const [histRes, runRes, subRes, ackRes] = await Promise.all([
        client.GET("/api/v1/billing/claims/{id}/state-history", {
          params: { path: { id: claim.claimId } },
        }),
        client.GET("/api/v1/claims/{id}/validation-runs", {
          params: { path: { id: claim.claimId } },
        }),
        client.GET("/api/v1/billing/claims/{id}/submissions", {
          params: { path: { id: claim.claimId } },
        }),
        client.GET("/api/v1/billing/claims/{id}/acknowledgments", {
          params: { path: { id: claim.claimId } },
        }),
      ]);
      if (histRes.error && runRes.error && subRes.error && ackRes.error) {
        setDetailError("This claim's compliance trail could not be read.");
        setDetailLoading(false);
        return;
      }
      const runs = ((runRes.data as unknown as { runs?: ValidationRunView[] })?.runs ?? []) as ValidationRunView[];
      // Expand only `overridden` runs to surface the applied overrides (the surveyor-relevant exceptions).
      const overrideRuns = runs.filter((r) => r.outcome === "overridden");
      const overrideLists = await Promise.all(
        overrideRuns.map(async (run) => {
          const dRes = await client.GET("/api/v1/claims/{id}/validation-runs/{runId}", {
            params: { path: { id: claim.claimId, runId: run.validationRunId } },
          });
          if (dRes.error) return [] as OverrideEntry[];
          const results = ((dRes.data as unknown as { results?: ResultView[] })?.results ?? []) as ResultView[];
          return results
            .filter((res): res is ResultView & { override: OverrideView } => Boolean(res.override))
            .map<OverrideEntry>((res) => ({
              ruleKey: res.ruleKey,
              severity: res.severity,
              overrideMembershipId: res.override.overrideMembershipId,
              overrideRoleApplied: res.override.overrideRoleApplied,
              reason: res.override.reason,
              appliedAt: res.override.appliedAt,
            }));
        }),
      );
      setProjection({
        history: histRes.error
          ? []
          : (((histRes.data as unknown as { items?: StateHistoryRow[] })?.items ?? []) as StateHistoryRow[]),
        runs,
        overrides: overrideLists.flat(),
        submissions: subRes.error ? [] : ((subRes.data as unknown as SubmissionRow[]) ?? []),
        acknowledgments: ackRes.error ? [] : ((ackRes.data as unknown as AcknowledgmentRow[]) ?? []),
      });
      setDetailLoading(false);
    },
    [client],
  );

  return (
    <AdminSplitLayout
      header={<PageHeader title="Billing Audit (Surveyor)" breadcrumb="Admin · Compliance" />}
      list={
        loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : claims.length === 0 ? (
          <EmptyState title="No claims" description="No claims in scope." />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: "0.5rem" }}>
            {claims.map((c) => (
              <li key={c.claimId}>
                <button
                  type="button"
                  onClick={() => void loadProjection(c)}
                  aria-current={selected?.claimId === c.claimId ? "true" : undefined}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                    width: "100%",
                    textAlign: "left",
                    cursor: "pointer",
                    border: "none",
                    borderRadius: "var(--radius-md)",
                    padding: "0.5rem 0.6rem",
                    background:
                      selected?.claimId === c.claimId ? "var(--color-primary-tint)" : "transparent",
                    color: "var(--color-on-surface)",
                  }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
                    {c.claimControlNumber}
                  </span>
                  <StatusPill label={statusLabel(c.state)} tone={claimStateTone(c.state)} />
                </button>
              </li>
            ))}
          </ul>
        )
      }
    >
      {!selected ? (
        <EmptyState
          title="Select a claim"
          description="Choose a claim to read its compliance trail. This view is read-only."
        />
      ) : detailLoading ? (
        <LoadingSpinner />
      ) : detailError ? (
        <EmptyState title="Unavailable" description={detailError} />
      ) : projection ? (
        <ClaimProjection claim={selected} projection={projection} />
      ) : null}
    </AdminSplitLayout>
  );
}

// ── read-only claim projection — four No-Line sections, internal correlation ids redacted ─────────────
function ClaimProjection({
  claim,
  projection,
}: { claim: ClaimSummary; projection: Projection }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.95rem", color: "var(--color-on-surface)" }}>
          {claim.claimControlNumber}
        </span>
        <StatusPill label={statusLabel(claim.state)} tone={claimStateTone(claim.state)} />
      </div>

      <Section title="State timeline">
        {projection.history.length === 0 ? (
          <Muted>No transitions recorded.</Muted>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRowStyle}>
                <th style={thStyle} scope="col">
                  Transition
                </th>
                <th style={thStyle} scope="col">
                  Actor
                </th>
                <th style={thStyle} scope="col">
                  Reason
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  At
                </th>
              </tr>
            </thead>
            <tbody>
              {projection.history.map((h, i) => (
                <tr key={h.historyId} style={rowStyle(i)}>
                  <td style={tdStyle}>
                    {h.fromState ? `${statusLabel(h.fromState)} → ` : ""}
                    <StatusPill label={statusLabel(h.toState)} tone={claimStateTone(h.toState)} />
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
                      {statusLabel(h.actorKind)}
                    </span>
                    {h.actorMembershipId ? (
                      <div>
                        <MaskedIdentifier value={h.actorMembershipId} label="Actor membership" />
                      </div>
                    ) : null}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: "20rem" }}>{h.reason ?? "—"}</td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {new Date(h.at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Validation runs">
        {projection.runs.length === 0 ? (
          <Muted>No validation runs.</Muted>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRowStyle}>
                <th style={thStyle} scope="col">
                  Outcome
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Executed
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Passed
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Failed
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Started
                </th>
              </tr>
            </thead>
            <tbody>
              {projection.runs.map((r, i) => (
                <tr key={r.validationRunId} style={rowStyle(i)}>
                  <td style={tdStyle}>
                    <StatusPill label={statusLabel(r.outcome)} tone={validationRunTone(r.outcome)} />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.rulesExecuted}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.rulesPassed}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.rulesFailed}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {new Date(r.startedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Applied overrides">
        {projection.overrides.length === 0 ? (
          <Muted>No validation overrides.</Muted>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRowStyle}>
                <th style={thStyle} scope="col">
                  Rule
                </th>
                <th style={thStyle} scope="col">
                  Severity
                </th>
                <th style={thStyle} scope="col">
                  Role / actor
                </th>
                <th style={thStyle} scope="col">
                  Reason
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Applied
                </th>
              </tr>
            </thead>
            <tbody>
              {projection.overrides.map((o, i) => (
                <tr key={`${o.ruleKey}-${o.appliedAt}`} style={rowStyle(i)}>
                  <td style={{ ...tdStyle, fontFamily: "var(--font-mono)" }}>{o.ruleKey}</td>
                  <td style={tdStyle}>
                    <StatusPill label={statusLabel(o.severity)} tone={validationSeverityTone(o.severity)} />
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontSize: "0.8rem" }}>{statusLabel(o.overrideRoleApplied)}</div>
                    <MaskedIdentifier value={o.overrideMembershipId} label="Override membership" />
                  </td>
                  <td style={{ ...tdStyle, maxWidth: "18rem" }}>{o.reason}</td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {new Date(o.appliedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Submissions">
        {projection.submissions.length === 0 ? (
          <Muted>No dispatch attempts.</Muted>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRowStyle}>
                <th style={thStyle} scope="col">
                  Kind
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Attempt
                </th>
                <th style={thStyle} scope="col">
                  Outcome
                </th>
                <th style={thStyle} scope="col">
                  Internal ref
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Submitted
                </th>
              </tr>
            </thead>
            <tbody>
              {projection.submissions.map((s, i) => (
                <tr key={s.submissionId} style={rowStyle(i)}>
                  <td style={tdStyle}>{statusLabel(s.kind)}</td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {s.attemptIndex}
                  </td>
                  <td style={tdStyle}>
                    <StatusPill label={statusLabel(s.outcome)} tone={submissionStatusTone(s.outcome)} />
                    {s.outcomeReason ? (
                      <div style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
                        {s.outcomeReason}
                      </div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    <MaskedIdentifier value={s.submissionId} label="Submission id" />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {s.submittedAt ? new Date(s.submittedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Internal worker artifact (the generated X12 file) is sealed, never projected to the surveyor. */}
        {projection.submissions.some((s) => s.generatedFileUri) ? (
          <div style={{ marginTop: "0.75rem" }}>
            <SealedBlock message="Generated X12 transmission files are internal worker artifacts and are not exposed in the surveyor view." />
          </div>
        ) : null}
      </Section>

      <Section title="Acknowledgments">
        {projection.acknowledgments.length === 0 ? (
          <Muted>No acknowledgments received.</Muted>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={headRowStyle}>
                <th style={thStyle} scope="col">
                  Kind
                </th>
                <th style={thStyle} scope="col">
                  Outcome
                </th>
                <th style={thStyle} scope="col">
                  Internal ref
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} scope="col">
                  Received
                </th>
              </tr>
            </thead>
            <tbody>
              {projection.acknowledgments.map((a, i) => (
                <tr key={a.acknowledgmentId} style={rowStyle(i)}>
                  <td style={tdStyle}>{a.kind}</td>
                  <td style={tdStyle}>
                    <StatusPill label={statusLabel(a.outcomeStatus)} tone={ackOutcomeTone(a.outcomeStatus)} />
                  </td>
                  <td style={tdStyle}>
                    <MaskedIdentifier value={a.acknowledgmentId} label="Acknowledgment id" />
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {new Date(a.ackReceivedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <h3
        style={{
          margin: 0,
          fontFamily: "var(--font-display)",
          fontSize: "1rem",
          fontWeight: 500,
          color: "var(--color-on-surface)",
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>{children}</p>
  );
}

const tableStyle = { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.85rem" };
const headRowStyle = { textAlign: "left" as const, color: "var(--color-on-surface-variant)" };
const thStyle = {
  padding: "0.4rem 0.6rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = { padding: "0.4rem 0.6rem", color: "var(--color-on-surface)", verticalAlign: "top" as const };
const rowStyle = (i: number): { background: string } => ({
  background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent",
});
