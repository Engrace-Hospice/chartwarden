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
// key that is holding it, with a remediation hint per group and a per-claim drill-in.
//
// Backed by the dedicated GET /api/v1/medicaid-validation-worklist read: ONE server-side join over each
// blocked claim's latest validation run, excluding results that already carry an override. The server
// returns the blocked-claim denominator alongside the groups, so the surface can distinguish "nothing is
// blocked" from "blocked, but attributable to no readable rule" — and reports `truncated` when its scan hit
// the cap. Nothing here is silently dropped: on a compliance surface a quiet truncation reads as
// "nothing else is failing". Lantern: WorkQueueLayout + No-Line table (§6.7); CSS-var tokens only.
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

interface WorklistClaim {
  claimId: string;
  medicaidClaimControlNumber: string;
  patientId: string;
  serviceState: string;
  state: string;
  updatedAt: string;
}

interface WorklistGroup {
  ruleKey: string;
  remediationSummary: string | null;
  remediationFixAction: string | null;
  claims: WorklistClaim[];
}

interface Worklist {
  groups: WorklistGroup[];
  blockedClaimCount: number;
  unattributedClaimCount: number;
  truncated: boolean;
}

/** The in-app destination for a remediation action (PHI-free; the target module owns the fix). */
function fixActionHref(action: string | null): string | null {
  switch (action) {
    case "refresh_eligibility":
      return "/medicaid/billing/eligibility";
    case "review_rb_days":
      return "/medicaid/billing/rb-arrangements";
    case "resolve_in_m18":
      return "/evv/exceptions";
    default:
      return null;
  }
}

function fixActionLabel(action: string | null): string {
  switch (action) {
    case "edit_in_m6":
      return "Edit in Admission";
    case "cosign_in_m8":
      return "Cosign encounter";
    case "resolve_in_m18":
      return "Resolve EVV visit";
    case "refresh_eligibility":
      return "Refresh eligibility";
    case "review_rb_days":
      return "Review R&B days";
    default:
      return "Open";
  }
}

export function MedicaidValidationQueue(): JSX.Element {
  const client = useApiClient();
  const [worklist, setWorklist] = useState<Worklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await client.GET("/api/v1/medicaid-validation-worklist", {});
    if (res.error) {
      setError("The blocked-claim worklist is unavailable — you may lack billing visibility.");
      setLoading(false);
      return;
    }
    setWorklist(res.data as unknown as Worklist);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error || !worklist)
    return <EmptyState title="Unavailable" description={error ?? "No worklist."} />;

  const { groups, blockedClaimCount, unattributedClaimCount, truncated } = worklist;

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
            {blockedClaimCount} blocked claim{blockedClaimCount === 1 ? "" : "s"} (failed validation
            or partially acknowledged) · {groups.length} rule{groups.length === 1 ? "" : "s"}{" "}
            holding them
          </span>
          {unattributedClaimCount > 0 ? (
            <span style={mutedStyle}>
              {unattributedClaimCount} blocked claim{unattributedClaimCount === 1 ? " is" : "s are"}{" "}
              not listed below — no validation run yet, or every failing rule already overridden.
              Open{" "}
              <a href="/medicaid/billing/claims?state=FAILED_VALIDATION" style={linkStyle}>
                the workbench
              </a>{" "}
              to review {unattributedClaimCount === 1 ? "it" : "them"}.
            </span>
          ) : null}
          {truncated ? (
            <output style={mutedStyle}>
              This is a partial view — the worklist scan hit its cap, so more blocked claims exist
              than are grouped here.
            </output>
          ) : null}
        </div>
      }
      table={
        groups.length === 0 ? (
          <EmptyState
            title={blockedClaimCount === 0 ? "Nothing blocked" : "No rule detail"}
            description={
              blockedClaimCount === 0
                ? "No Medicaid claim is failing validation or partially acknowledged."
                : "Blocked claims exist but none carry an outstanding failing rule — open them individually from the workbench."
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
              {groups.map((g) => {
                const href = fixActionHref(g.remediationFixAction);
                return (
                  <tr key={g.ruleKey} style={rowLine}>
                    <td style={tdMono}>{g.ruleKey}</td>
                    <td style={tdNum}>{g.claims.length}</td>
                    <td style={{ ...td, maxWidth: "24rem" }}>
                      {g.remediationSummary ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                          <span>{g.remediationSummary}</span>
                          {href ? (
                            <a href={href} style={linkStyle}>
                              {fixActionLabel(g.remediationFixAction)} →
                            </a>
                          ) : null}
                        </div>
                      ) : (
                        <span style={mutedStyle}>—</span>
                      )}
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                        {g.claims.map((c) => (
                          <a
                            key={c.claimId}
                            href={`/medicaid/billing/claims/${c.claimId}/validation`}
                            style={linkMonoStyle}
                            title={`${humanize(c.state)} · ${c.serviceState} · patient ${shortId(c.patientId)}`}
                          >
                            {c.medicaidClaimControlNumber}
                          </a>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
      detail={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          <StatusPill
            label={`${groups.length} rule${groups.length === 1 ? "" : "s"} blocking`}
            tone={groups.length === 0 ? "success" : "warning"}
          />
          <span style={mutedStyle}>
            Select a control number to open that claim's validation worklist, where a failed rule
            can be overridden with a rationale. Overridden failures drop off this queue.
          </span>
        </div>
      }
    />
  );
}
