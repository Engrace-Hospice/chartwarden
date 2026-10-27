// apps/web/src/modules/41-billing-commercial — COMMERCIAL CLAIM SEND GATE (M41, issue #822).
//   GET /api/v1/billing/commercial/claims/{id}/send-gate   every reason the claim cannot be sent now (read-audited)
// Shown before the click: each reason carries a stable code and a fixed message that says what to do next, and for rule-backed reasons
// the rule keys. The server judges on the claim's current facts; the browser only displays the verdict, it never computes one. No
// patient data is shown or logged here.
import { Glyph, InlineAlert, Panel, StatusPill, useApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { ClaimSubpage } from "./claim-subpage";
import { COMMERCIAL_PATHS, claimStateTone, statusLabel } from "./commercial-model";

export function CommercialClaimSendGate(): JSX.Element {
  const client = useApiClient();
  return (
    <ClaimSubpage
      title="Send gate"
      description="Every reason this claim cannot be sent to the payer right now."
      read={(id) =>
        client.GET("/api/v1/billing/commercial/claims/{id}/send-gate", {
          params: { path: { id } },
        })
      }
    >
      {(gate) => (
        <Panel title="Can this claim be sent?" icon="shield-check">
          <p
            style={{
              margin: "0 0 0.75rem",
              display: "flex",
              gap: "0.625rem",
              alignItems: "center",
            }}
          >
            <StatusPill
              label={gate.canSubmit ? "Ready to send" : "Cannot be sent"}
              tone={gate.canSubmit ? "success" : "error"}
            />
            <span className="wx-row-sub">
              Claim state:{" "}
              <StatusPill label={statusLabel(gate.state)} tone={claimStateTone(gate.state)} />
            </span>
          </p>
          {gate.canSubmit ? (
            <InlineAlert tone="success">
              No reason blocks this claim. Sending needs the submit permission and a fresh step-up.
            </InlineAlert>
          ) : gate.reasons.length === 0 ? (
            <InlineAlert tone="warning">
              The claim cannot be sent, but no reason was returned. Reload to try again.
            </InlineAlert>
          ) : (
            <ul className="wx-checklist" aria-label="Reasons the claim cannot be sent">
              {gate.reasons.map((r) => (
                <li key={r.code}>
                  <Glyph name="alert-circle" />
                  <span className="wx-checklist-text">
                    <strong className="wx-nums">{r.code}</strong> · {r.message}
                    {r.ruleKeys && r.ruleKeys.length > 0 ? (
                      <span className="wx-row-sub"> Rules: {r.ruleKeys.join(", ")}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="wx-row-sub" style={{ margin: "0.75rem 0 0" }}>
            <Link to={COMMERCIAL_PATHS.claim(gate.claimId)}>Back to the claim</Link> ·{" "}
            <Link to={COMMERCIAL_PATHS.timeline(gate.claimId)}>Claim history</Link>
          </p>
        </Panel>
      )}
    </ClaimSubpage>
  );
}
