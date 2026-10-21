import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the SURVEYOR READ VIEW (R2, §5.1 #19). The engagement-
// scoped, strictly READ-ONLY rendering of one Medicaid claim for a surveyor or auditor: the claim facts,
// the rule outcomes of its latest validation run, the override history against it, the R&B chain, and the
// COB chain. There is no action on this page by construction — not a disabled button, none at all — because
// the surveyor's role grants read and nothing else, and the server enforces that regardless (ADR-0030).
// Engagement scoping is a SERVER concern (M3 engagement-scoped grants); this surface simply reads the claim
// and shows what the caller is permitted to see. Backed by GET /api/v1/medicaid-claims/{id} (+ /lines,
// /validation-runs, and the org override list filtered to this claim). Lantern: DetailPageLayout + No-Line.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  CLAIM_STATE_TONE,
  VALIDATION_OUTCOME_TONE,
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
  mutedStyle,
  rowLine,
  sectionTitleStyle,
  tableStyle,
  td,
  tdMono,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

interface Claim {
  id: string;
  patientId: string;
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
  validationRunIdLatest: string | null;
  createdAt: string;
}

interface ClaimLine {
  id: string;
  lineNumber: number;
  serviceDate: string;
  revenueCode: string;
  levelOfCare: string;
  units: number;
  chargesCents: number;
  isRb: boolean;
}

interface ValidationResult {
  id: string;
  ruleKey: string;
  ruleVersion: number;
  outcome: string;
  remediationSummary: string | null;
}

interface ValidationRun {
  id: string;
  ruleRegistryVersion: string;
  at: string;
  totalResults: number;
  failedResults: number;
  warnedResults: number;
  results?: ValidationResult[];
}

interface Override {
  id: string;
  medicaidClaimId: string;
  ruleKey: string;
  overrideRoleApplied: string;
  reason: string;
  actorMembershipId: string;
  at: string;
}

export function MedicaidSurveyorReadView(): JSX.Element {
  const client = useApiClient();
  const { claimId } = useParams<{ claimId: string }>();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [lines, setLines] = useState<ClaimLine[]>([]);
  const [run, setRun] = useState<ValidationRun | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!claimId) return;
    setLoading(true);
    setError(null);
    const [claimRes, lineRes, overrideRes] = await Promise.all([
      client.GET("/api/v1/medicaid-claims/{id}", { params: { path: { id: claimId } } }),
      client.GET("/api/v1/medicaid-claims/{id}/lines", { params: { path: { id: claimId } } }),
      client.GET("/api/v1/medicaid-validation-overrides", {}),
    ]);
    if (claimRes.error) {
      setError("This claim is not within your engagement scope, or it does not exist.");
      setLoading(false);
      return;
    }
    const detail = claimRes.data as unknown as Claim;
    setClaim(detail);
    if (!lineRes.error) setLines((lineRes.data as unknown as ClaimLine[]) ?? []);
    if (!overrideRes.error)
      setOverrides(
        ((overrideRes.data as unknown as Override[]) ?? []).filter(
          (o) => o.medicaidClaimId === claimId,
        ),
      );
    // The latest validation run carries the rule outcomes a surveyor asks about.
    if (detail.validationRunIdLatest) {
      const runRes = await client.GET("/api/v1/medicaid-validation-runs/{id}", {
        params: { path: { id: detail.validationRunIdLatest } },
      });
      if (!runRes.error) setRun(runRes.data as unknown as ValidationRun);
    }
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!claimId) return <EmptyState title="No claim" description="No claim was specified." />;
  if (loading) return <LoadingSpinner />;
  if (error || !claim) return <EmptyState title="Unavailable" description={error ?? "No claim."} />;

  const totalCharges = lines.reduce((acc, l) => acc + l.chargesCents, 0);
  const rbLines = lines.filter((l) => l.isRb);

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Claim (read-only)"
          breadcrumb={
            <>
              Survey · Medicaid billing ·{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {claim.medicaidClaimControlNumber}
              </span>
            </>
          }
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Glyph name="eye" size={16} label="read-only" />
              <StatusPill
                label={humanize(claim.state)}
                tone={toneOf(CLAIM_STATE_TONE, claim.state)}
              />
            </div>
          }
        />
      }
      aside={
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <Card title="Room &amp; Board chain">
            {claim.rbArrangementId ? (
              <>
                <Field label="Arrangement" value={shortId(claim.rbArrangementId)} mono />
                <Field label="R&amp;B lines on claim" value={String(rbLines.length)} />
              </>
            ) : (
              <span style={mutedStyle}>No NF Room &amp; Board pass-through on this claim.</span>
            )}
          </Card>
          <Card title="COB chain">
            {claim.medicareClaimId ? (
              <Field label="Medicare primary" value={shortId(claim.medicareClaimId)} mono />
            ) : (
              <span style={mutedStyle}>Medicaid-primary claim — no Medicare coordination.</span>
            )}
          </Card>
          <Card title="Validation run">
            {run ? (
              <>
                <Field label="Registry version" value={run.ruleRegistryVersion} mono />
                <Field label="Run at" value={run.at.slice(0, 16).replace("T", " ")} />
                <Field
                  label="Outcome"
                  value={`${run.totalResults} rules · ${run.failedResults} failed · ${run.warnedResults} warn`}
                />
              </>
            ) : (
              <span style={mutedStyle}>No validation run is recorded for this claim.</span>
            )}
          </Card>
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
          <Field label="Patient" value={shortId(claim.patientId)} mono />
          <Field
            label="MCO"
            value={claim.mcoId ? shortId(claim.mcoId) : "Fee-for-service"}
            mono={Boolean(claim.mcoId)}
          />
          <Field label="Total charges" value={money(totalCharges)} />
          <Field label="Created" value={shortDate(claim.createdAt)} />
        </SummaryGrid>

        <div>
          <h2 style={sectionTitleStyle}>Rule outcomes</h2>
          {!run || (run.results ?? []).length === 0 ? (
            <EmptyState
              title="No rule outcomes"
              description="No per-rule validation results are recorded for this claim."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Rule</th>
                  <th style={th}>Outcome</th>
                  <th style={th}>Finding</th>
                </tr>
              </thead>
              <tbody>
                {(run.results ?? []).map((r) => (
                  <tr key={r.id} style={rowLine}>
                    <td style={tdMono}>
                      {r.ruleKey} <span style={mutedStyle}>v{r.ruleVersion}</span>
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={humanize(r.outcome)}
                        tone={toneOf(VALIDATION_OUTCOME_TONE, r.outcome)}
                      />
                    </td>
                    <td style={{ ...td, maxWidth: "28rem" }}>
                      {r.remediationSummary ?? <span style={mutedStyle}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 style={sectionTitleStyle}>Override history</h2>
          {overrides.length === 0 ? (
            <EmptyState
              title="No overrides"
              description="No validation rule was overridden on this claim."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Applied</th>
                  <th style={th}>Rule</th>
                  <th style={th}>Acting role</th>
                  <th style={th}>Actor</th>
                  <th style={th}>Rationale</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id} style={rowLine}>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {o.at.slice(0, 16).replace("T", " ")}
                    </td>
                    <td style={tdMono}>{o.ruleKey}</td>
                    <td style={td}>{humanize(o.overrideRoleApplied)}</td>
                    <td style={tdMono}>{shortId(o.actorMembershipId)}</td>
                    <td style={{ ...td, maxWidth: "28rem", whiteSpace: "pre-wrap" }}>{o.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 style={sectionTitleStyle}>Service lines</h2>
          {lines.length === 0 ? (
            <EmptyState title="No lines" description="This claim carries no service lines." />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Service date</th>
                  <th style={th}>Rev</th>
                  <th style={th}>LOC</th>
                  <th style={thNum}>Units</th>
                  <th style={thNum}>Charges</th>
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
                    <td style={td}>{l.levelOfCare}</td>
                    <td style={tdNum}>{l.units}</td>
                    <td style={tdNum}>{money(l.chargesCents)}</td>
                    <td style={td}>{l.isRb ? "R&B" : "Hospice"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </DetailPageLayout>
  );
}
