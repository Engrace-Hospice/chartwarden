// apps/web/src/modules/16-bereavement — the RISK SCORE VIEW (§5.1 #12, Track B / ADR-0030).
// Spec: docs/design/screens/clinical — "Use Record Detail."
//
// Route 29's append-only ledger plus route 28's recompute. Four things this screen is careful about:
//
//  1. D17 TRI-STATE. A factor is `true`, `false`, or `unknown` — and `unknown` is a REAL answer, not a
//     missing one. The recompute form offers all three, and the ledger renders `unknown` explicitly.
//     Coercing unknown to false would silently lower a survivor's score by asserting a fact nobody knows.
//  2. CONFIDENCE IS SURFACED, NOT BURIED. `dataCompleteness` + `confidenceBand` ride every row, because a
//     LOW-confidence `low` tier and a HIGH-confidence `low` tier are different clinical statements.
//     `evidenceDegraded` says the unknowns were an OUTAGE (a seam was unreadable) rather than an unasked
//     question — the two must not read the same.
//  3. THE LEDGER IS IMMUTABLE. `bereavement_risk_score` refuses UPDATE at the database. A §7.3 counselor
//     override does not edit a row: it APPENDS a new one whose `tier` differs from `deterministicTier`,
//     and this screen shows both so the rubric's own answer is never lost behind the override.
//  4. LAYER 2 IS GATED. The narrative is only produced when Part-A `ai.full` is on. The request checkbox
//     is offered; a server that has the flag off simply returns a deterministic-only row, which this
//     screen reports rather than pretending a narrative was suppressed for another reason.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type BereavementRiskFactors,
  type BereavementRiskTier,
  type PlanDetail,
  type RiskScoreRow,
  type TriState,
  errorMessage,
  getPlan,
  listRiskScores,
  recomputeRisk,
} from "./bereavement-api";
import {
  Card,
  CheckboxField,
  Field,
  FilterRow,
  Modal,
  Notice,
  RiskTierPill,
  SelectField,
  SummaryGrid,
  TextAreaField,
  alertStyle,
  columnStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./bereavement-ui";
import {
  CONFIDENCE_BAND_TONE,
  DATA_COMPLETENESS_TONE,
  RISK_FACTOR_KEYS,
  dateTime,
  humanize,
  redactionLabel,
  riskFactorLabel,
  scoreLabel,
  shortId,
  toneOf,
} from "./bereavement-status";

const TIERS = ["low", "moderate", "high", "complicated"];

export function BereavementRiskView(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [scores, setScores] = useState<RiskScoreRow[]>([]);
  const [contactFilter, setContactFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputeOpen, setRecomputeOpen] = useState(false);

  const load = useCallback(async () => {
    if (!planId) return;
    setLoading(true);
    setError(null);
    const [detail, page] = await Promise.all([
      getPlan(client, planId),
      listRiskScores(client, planId, { contactId: contactFilter || undefined, limit: 100 }),
    ]);
    if (detail.error) {
      setError(errorMessage(detail.error, "This bereavement plan could not be loaded."));
      setLoading(false);
      return;
    }
    if (page.error) {
      setError(errorMessage(page.error, "The risk-score history could not be loaded."));
      setLoading(false);
      return;
    }
    setPlan(detail.plan);
    setScores(page.page?.data ?? []);
    setLoading(false);
  }, [client, planId, contactFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (!plan || !planId)
    return <EmptyState title="Not found" description="This bereavement plan does not exist, or is not on your caseload." />;

  const nameOf = (contactId: string | null) =>
    contactId === null
      ? "Plan-level rollup"
      : (plan.contacts.find((c) => c.contactId === contactId)?.displayName ?? shortId(contactId));

  const latest = scores[0];
  const anyRedacted = scores.some((s) => s.redactedCategories.length > 0);

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Bereavement risk</span>}
        breadcrumb={`Bereavement — plan ${shortId(planId)}`}
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <button type="button" style={primaryButtonStyle} onClick={() => setRecomputeOpen(true)}>
              Recompute
            </button>
            <Link to={`/bereavement/plans/${planId}`} style={ghostButtonStyle}>
              Back to plan
            </Link>
          </div>
        }
      />

      {latest ? (
        <Notice
          tone={
            latest.confidenceBand === "LOW"
              ? "error"
              : latest.confidenceBand === "MEDIUM"
                ? "warning"
                : "info"
          }
        >
          {latest.confidenceBand} confidence — data completeness {humanize(latest.dataCompleteness)}
          {latest.evidenceDegraded
            ? ". At least one evidence source was unreadable when this score was computed, so the unknown factors are an outage rather than an unasked question."
            : "."}
        </Notice>
      ) : null}

      {anyRedacted ? (
        <Notice tone="info">{redactionLabel(scores.flatMap((s) => s.redactedCategories))}</Notice>
      ) : null}

      <FilterRow>
        <SelectField
          label="Scope"
          value={contactFilter}
          options={[
            { value: "", label: "every score on this plan" },
            ...plan.contacts.map((c) => ({ value: c.contactId, label: c.displayName })),
          ]}
          onChange={setContactFilter}
        />
      </FilterRow>

      {latest ? (
        <Card
          title="Most recent score"
          actions={<RiskTierPill tier={latest.tier} />}
        >
          <SummaryGrid>
            <Field label="Scope" value={nameOf(latest.contactId)} />
            <Field label="Assessed" value={dateTime(latest.assessedAt)} />
            <Field label="Rule score" value={scoreLabel(latest.ruleScore)} />
            <Field
              label="Deterministic tier"
              value={<RiskTierPill tier={latest.deterministicTier} />}
            />
            <Field
              label="Data completeness"
              value={
                <StatusPill
                  label={humanize(latest.dataCompleteness)}
                  tone={toneOf(DATA_COMPLETENESS_TONE, latest.dataCompleteness)}
                />
              }
            />
            <Field
              label="Confidence"
              value={
                <StatusPill
                  label={latest.confidenceBand}
                  tone={toneOf(CONFIDENCE_BAND_TONE, latest.confidenceBand)}
                />
              }
            />
            <Field label="PG-13" value={scoreLabel(latest.pg13Score)} />
            <Field label="IPGR" value={scoreLabel(latest.ipgrScore)} />
            <Field label="Kind" value={humanize(latest.scoreKind)} />
          </SummaryGrid>
          {latest.tier !== latest.deterministicTier ? (
            <Notice tone="warning">
              A counselor override moved this score off the rubric's own tier (
              {humanize(latest.deterministicTier)}). The rubric answer is retained above — the ledger row
              carries both, because an override that erased what the rubric said would leave a surveyor
              with no way to see it was overridden.
            </Notice>
          ) : null}
          {latest.factors ? (
            <FactorTable factors={latest.factors} />
          ) : (
            <span style={mutedStyle}>
              The factor vector is not disclosed to you on this row. That is a confidentiality gate, not an
              empty rubric.
            </span>
          )}
        </Card>
      ) : (
        <Card title="Most recent score">
          <span style={mutedStyle}>
            No risk score has been computed for this plan yet. The rubric runs on the survivors' factors
            plus what Modules 9 and 15 publish; recomputing it here appends the first ledger row.
          </span>
        </Card>
      )}

      <Card title={`Score ledger (${scores.length})`}>
        {scores.length === 0 ? (
          <span style={mutedStyle}>The append-only ledger is empty.</span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Assessed</th>
                <th style={th}>Scope</th>
                <th style={th}>Tier</th>
                <th style={th}>Rubric tier</th>
                <th style={thNum}>Score</th>
                <th style={th}>Completeness</th>
                <th style={th}>Confidence</th>
                <th style={th}>Kind</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.scoreId} style={rowLine}>
                  <td style={td}>{dateTime(s.assessedAt)}</td>
                  <td style={td}>{nameOf(s.contactId)}</td>
                  <td style={td}>
                    <RiskTierPill tier={s.tier} />
                  </td>
                  <td style={td}>
                    <RiskTierPill tier={s.deterministicTier} />
                  </td>
                  <td style={tdNum}>{scoreLabel(s.ruleScore)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(s.dataCompleteness)}
                      tone={toneOf(DATA_COMPLETENESS_TONE, s.dataCompleteness)}
                    />
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={s.confidenceBand}
                      tone={toneOf(CONFIDENCE_BAND_TONE, s.confidenceBand)}
                    />
                    {s.evidenceDegraded ? <div style={mutedStyle}>evidence degraded</div> : null}
                  </td>
                  <td style={td}>{humanize(s.scoreKind)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          The ledger is append-only — the database refuses UPDATE on a score row outright. A correction is
          a new row, never an edit.
        </span>
      </Card>

      {recomputeOpen ? (
        <RecomputeModal
          planId={planId}
          contacts={plan.contacts.map((c) => ({ id: c.contactId, name: c.displayName }))}
          onClose={() => setRecomputeOpen(false)}
          onDone={() => {
            setRecomputeOpen(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/** The D17 tri-state factor vector, rendered so `unknown` reads as an answer rather than a blank. */
function FactorTable({ factors }: { factors: Record<string, boolean | "unknown"> }): JSX.Element {
  const rows = RISK_FACTOR_KEYS.filter((k) => k in factors);
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={th}>Factor</th>
          <th style={th}>Observation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => {
          const v = factors[k];
          return (
            <tr key={k} style={rowLine}>
              <td style={td}>{riskFactorLabel(k)}</td>
              <td style={td}>
                {v === "unknown" ? (
                  <StatusPill label="Unknown" tone="neutral" />
                ) : v ? (
                  <StatusPill label="Present" tone="warning" />
                ) : (
                  <StatusPill label="Absent" tone="success" />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Route 28 — recompute. §7.3's override needs BOTH a tier and a ≥40-char documented reason. */
function RecomputeModal({
  planId,
  contacts,
  onClose,
  onDone,
}: {
  planId: string;
  contacts: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [contactId, setContactId] = useState("");
  const [factors, setFactors] = useState<Record<string, TriState>>(
    Object.fromEntries(RISK_FACTOR_KEYS.map((k) => [k, "unknown" as TriState])),
  );
  const [supplyFactors, setSupplyFactors] = useState(false);
  const [requestAugmentation, setRequestAugmentation] = useState(false);
  const [overrideTier, setOverrideTier] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overrideIncomplete = overrideTier !== "" && overrideReason.trim().length < 40;

  const submit = async () => {
    setBusy(true);
    setError(null);
    // `factors`'s keys are always exactly RISK_FACTOR_KEYS, and `overrideTier` is always "" or one of the
    // closed vocabulary the SelectField below offers.
    const { error: err } = await recomputeRisk(client, planId, {
      bereavedContactId: contactId || undefined,
      factors: supplyFactors ? (factors as unknown as BereavementRiskFactors) : undefined,
      requestAugmentation: requestAugmentation || undefined,
      overrideTier: (overrideTier || undefined) as BereavementRiskTier,
      overrideReason: overrideTier ? overrideReason : undefined,
    });
    setBusy(false);
    if (err) {
      setError(errorMessage(err, "The risk score could not be recomputed."));
      return;
    }
    onDone();
  };

  return (
    <Modal
      title="Recompute bereavement risk"
      onClose={onClose}
      footer={
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || overrideIncomplete}
          onClick={submit}
        >
          {busy ? "Recomputing…" : "Recompute"}
        </button>
      }
    >
      <SelectField
        label="Scope"
        value={contactId}
        options={[
          { value: "", label: "the whole plan" },
          ...contacts.map((c) => ({ value: c.id, label: c.name })),
        ]}
        onChange={setContactId}
      />

      <CheckboxField
        label="Supply the factor observations from this form"
        checked={supplyFactors}
        onChange={setSupplyFactors}
      />
      {supplyFactors ? (
        <>
          <Notice tone="info">
            `Unknown` is a real answer. The scorer adjusts its divisor to the knowable factors and lowers
            the confidence band accordingly — it never treats unknown as absent.
          </Notice>
          {RISK_FACTOR_KEYS.map((k) => (
            <SelectField
              key={k}
              label={riskFactorLabel(k)}
              value={factors[k] === "unknown" ? "unknown" : factors[k] ? "true" : "false"}
              options={[
                { value: "true", label: "Present" },
                { value: "false", label: "Absent" },
                { value: "unknown", label: "Unknown" },
              ]}
              onChange={(v) =>
                setFactors({ ...factors, [k]: v === "unknown" ? "unknown" : v === "true" })
              }
            />
          ))}
        </>
      ) : (
        <span style={mutedStyle}>
          Without supplied observations the rubric reads what Modules 9 and 15 publish. A source that is
          unreadable yields `unknown`, not `absent`.
        </span>
      )}

      <CheckboxField
        label="Request the narrative (Layer 2)"
        checked={requestAugmentation}
        onChange={setRequestAugmentation}
      />
      <span style={mutedStyle}>
        The narrative requires the platform's full-AI capability. With it off, the server returns a
        deterministic-only row — the rubric itself never depends on AI.
      </span>

      <SelectField
        label="Counselor override (optional)"
        value={overrideTier}
        options={[
          { value: "", label: "no override — use the rubric's tier" },
          ...TIERS.map((t2) => ({ value: t2, label: humanize(t2) })),
        ]}
        onChange={setOverrideTier}
      />
      {overrideTier ? (
        <TextAreaField
          label="Override reason"
          value={overrideReason}
          onChange={setOverrideReason}
          rows={4}
          hint={`${overrideReason.trim().length} / 40 characters minimum. The rubric's own tier is retained on the ledger row alongside your override.`}
        />
      ) : null}

      {error ? <p style={alertStyle}>{error}</p> : null}
    </Modal>
  );
}
