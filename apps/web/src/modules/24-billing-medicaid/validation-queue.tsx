import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the ORG-WIDE VALIDATION WORKLIST (R2, §5.1 #5). The
// compliance/biller view of every claim sitting in FAILED_VALIDATION or ACK_PARTIAL, grouped by the rule
// key that is holding it, with a remediation deep-link per group and a per-claim drill-in.
//
// There is no org-wide validation-results read on the §4.1 surface, so this screen composes the existing
// reads: the two claim-state queries, then the latest validation run per claim. That fan-out is BOUNDED to
// the first CLAIM_SCAN_CAP claims and the cap is stated in the UI — a silently truncated queue would read
// as "nothing else is failing", which is exactly the wrong signal on a compliance surface. Claims whose run
// could not be read are counted separately rather than dropped. Lantern: WorkQueueLayout + No-Line table.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { humanize, shortId } from "./medicaid-status";
import {
  linkMonoStyle,
  linkStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

/** The blocked states this worklist covers (§5.1 #5). */
const BLOCKED_STATES = ["FAILED_VALIDATION", "ACK_PARTIAL"] as const;
/** How many blocked claims we resolve rule detail for per load (stated in the UI — never silent). */
const CLAIM_SCAN_CAP = 40;

interface ClaimRow {
  id: string;
  patientId: string;
  serviceState: string;
  medicaidClaimControlNumber: string;
  state: string;
  validationRunIdLatest: string | null;
  updatedAt: string;
}

interface ValidationResult {
  id: string;
  ruleKey: string;
  outcome: string;
  remediationSummary: string | null;
}

interface ValidationRun {
  id: string;
  results?: ValidationResult[];
}

interface RuleGroup {
  ruleKey: string;
  remediationSummary: string | null;
  claims: ClaimRow[];
}

export function MedicaidValidationQueue(): JSX.Element {
  const client = useApiClient();
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [blockedCount, setBlockedCount] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [unresolved, setUnresolved] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    // 1 — every claim in a blocked state (one query per state; the list read is cursor-paginated).
    const pages = await Promise.all(
      BLOCKED_STATES.map((s) =>
        client.GET("/api/v1/medicaid-claims", { params: { query: { state: s } } } as never),
      ),
    );
    if (pages.every((p) => p.error)) {
      setError("The blocked-claim queue is unavailable — you may lack billing visibility.");
      setLoading(false);
      return;
    }
    const blocked = pages.flatMap((p) =>
      p.error ? [] : ((p.data as unknown as { items?: ClaimRow[] } | undefined)?.items ?? []),
    );
    setBlockedCount(blocked.length);

    // 2 — resolve the latest run per claim, bounded. Claims with no run yet are not "unresolved" errors.
    const scanTargets = blocked.slice(0, CLAIM_SCAN_CAP);
    setScanned(scanTargets.length);
    const runs = await Promise.all(
      scanTargets.map(async (claim) => {
        if (!claim.validationRunIdLatest) return { claim, run: null, failed: false };
        const res = await client.GET("/api/v1/medicaid-validation-runs/{id}", {
          params: { path: { id: claim.validationRunIdLatest } },
        });
        if (res.error) return { claim, run: null, failed: true };
        return { claim, run: res.data as unknown as ValidationRun, failed: false };
      }),
    );
    setUnresolved(runs.filter((r) => r.failed).length);

    // 3 — group the failing results by rule key, most-blocking first.
    const byRule = new Map<string, RuleGroup>();
    for (const { claim, run } of runs) {
      for (const result of run?.results ?? []) {
        if (result.outcome !== "fail") continue;
        const existing = byRule.get(result.ruleKey);
        if (existing) {
          if (!existing.claims.some((c) => c.id === claim.id)) existing.claims.push(claim);
        } else {
          byRule.set(result.ruleKey, {
            ruleKey: result.ruleKey,
            remediationSummary: result.remediationSummary,
            claims: [claim],
          });
        }
      }
    }
    setGroups([...byRule.values()].sort((a, b) => b.claims.length - a.claims.length));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const truncated = blockedCount > scanned;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Validation Worklist"
          breadcrumb="Billing — Medicaid · blocked claims by rule"
          actions={
            <a href="/medicaid/billing/claims" style={linkStyle}>
              Open claim workbench →
            </a>
          }
        />
      }
      filters={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <span style={mutedStyle}>
            {blockedCount} blocked claim{blockedCount === 1 ? "" : "s"} (failed validation or partially
            acknowledged) · rule detail resolved for {scanned}
            {truncated ? ` of ${blockedCount} — refine in the workbench to review the rest` : ""}
          </span>
          {unresolved > 0 ? (
            <span style={mutedStyle}>
              {unresolved} claim{unresolved === 1 ? "'s" : "s'"} validation run could not be read and{" "}
              {unresolved === 1 ? "is" : "are"} not represented below.
            </span>
          ) : null}
        </div>
      }
      table={
        groups.length === 0 ? (
          <EmptyState
            title={blockedCount === 0 ? "Nothing blocked" : "No rule detail"}
            description={
              blockedCount === 0
                ? "No Medicaid claim is failing validation or partially acknowledged."
                : "Blocked claims exist but none carry a readable failing rule — open them individually from the workbench."
            }
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Rule</th>
                <th style={thNum}>Claims</th>
                <th style={th}>Remediation</th>
                <th style={th}>Blocked claims</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.ruleKey} style={rowLine}>
                  <td style={tdMono}>{g.ruleKey}</td>
                  <td style={tdNum}>{g.claims.length}</td>
                  <td style={{ ...td, maxWidth: "24rem" }}>
                    {g.remediationSummary ?? <span style={mutedStyle}>—</span>}
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {g.claims.map((c) => (
                        <a
                          key={c.id}
                          href={`/medicaid/billing/claims/${c.id}/validation`}
                          style={linkMonoStyle}
                          title={`${humanize(c.state)} · patient ${shortId(c.patientId)}`}
                        >
                          {c.medicaidClaimControlNumber}
                        </a>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      detail={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <StatusPill label={`${groups.length} rule${groups.length === 1 ? "" : "s"} blocking`} tone="warning" />
          <span style={mutedStyle}>
            Select a control number to open that claim's validation worklist, where a failed rule can be
            overridden with a rationale.
          </span>
        </div>
      }
    />
  );
}
