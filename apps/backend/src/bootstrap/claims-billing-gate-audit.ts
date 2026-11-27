// apps/backend/src/bootstrap/claims-billing-gate-audit.ts — CW-AC-24: the audit trail of the claims-billing gate's mode.
//
// Two platform-scoped rows (organization_id NULL, actor `system`, through the SECURITY DEFINER writer of migration 0187, so
// they land under the real NOBYPASSRLS app role and from a worker with no request context):
//   m23.claims_billing_gate.mode_bound   every boot of every process: the mode and, below `enforce`, the operator's written
//                                        reason (CLAIMS_BILLING_LOG_ONLY_REASON). The trail shows when a deployment ran
//                                        log-only, why, and the boot that flipped it to `enforce`.
//   m23.claims_billing_gate.would_block  log-only only: the work that `enforce` would have refused (402) or held, once per org,
//                                        site and reason per window. This is the evidence reviewed before a production flip
//                                        (docs/architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md, claims-billing gate rollout).
// Context carries ids, route templates, queue names and reason codes only: never a patient, claim or payer value.
// Both are compliance-retained (7 years): the would_block rows are the only record that work went ahead unenforced.
import { randomUUID } from "node:crypto";
import { type PlatformAuditExecutor, auditPlatformEvent } from "@chartwarden/audit";
import type { GateFindingSink } from "./claims-billing-gate";
import { type ClaimsBillingEnforcementMode, parseClaimsBillingLogOnlyReason } from "./env";

export const GATE_MODE_BOUND_EVENT = "m23.claims_billing_gate.mode_bound";
export const GATE_WOULD_BLOCK_EVENT = "m23.claims_billing_gate.would_block";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sink `configureClaimsBillingGate` takes: one `would_block` audit row per finding. A throw is the gate's to log. */
export function createGateFindingSink(db: PlatformAuditExecutor): GateFindingSink {
  return async (finding) => {
    await auditPlatformEvent(db, {
      eventType: GATE_WOULD_BLOCK_EVENT,
      resourceKind: "organization",
      ...(UUID_SHAPE.test(finding.organizationId) ? { resourceId: finding.organizationId } : {}),
      outcome: "success", // the work went ahead; `context.outcome` says what enforce would have done
      severity: "warn",
      correlationId: `claims-billing-gate:${randomUUID()}`,
      retentionClass: "compliance",
      context: {
        organizationId: finding.organizationId,
        outcome: finding.outcome,
        reason: finding.reason,
        ...(finding.route === undefined ? {} : { route: finding.route }),
        ...(finding.queue === undefined ? {} : { queue: finding.queue }),
      },
    });
  };
}

export interface GateModeBound {
  readonly mode: ClaimsBillingEnforcementMode;
  /** CLAIMS_BILLING_LOG_ONLY_REASON, when set. */
  readonly logOnlyReason?: string | undefined;
  readonly processRole: string;
  readonly nodeEnv: string | undefined;
}

/** What a boot records: the operator's reason only below `enforce` (a stale one beside an enforcing gate explains nothing). */
export function gateModeBoundFacts(
  mode: ClaimsBillingEnforcementMode,
  env: Readonly<Record<string, string | undefined>>,
  processRole: string,
): GateModeBound {
  return {
    mode,
    logOnlyReason: mode === "enforce" ? undefined : parseClaimsBillingLogOnlyReason(env),
    processRole,
    nodeEnv: env.NODE_ENV,
  };
}

/**
 * Record the mode at boot. A production boot below `enforce` is never unaudited: its write is awaited and a failure
 * refuses the boot (the deploy's environment check passed, so this is a database fault the process could not serve through
 * anyway). Any other boot is best-effort: the failure is reported through `onError` and the boot goes on.
 */
export async function bindGateModeAudit(
  db: PlatformAuditExecutor,
  bound: GateModeBound,
  onError: (message: string, err: unknown) => void,
): Promise<void> {
  const write = recordGateModeBound(db, bound);
  if (bound.mode !== "enforce" && bound.nodeEnv === "production") {
    await write;
    return;
  }
  await write.catch((err: unknown) =>
    onError("claims-billing gate mode audit row not written", err),
  );
}

/** Record the mode this process booted with. Below `enforce` it is a warning row; a failed write is the caller's to handle. */
export async function recordGateModeBound(
  db: PlatformAuditExecutor,
  bound: GateModeBound,
): Promise<void> {
  await auditPlatformEvent(db, {
    eventType: GATE_MODE_BOUND_EVENT,
    resourceKind: "claims_billing_gate",
    outcome: "success",
    severity: bound.mode === "enforce" ? "info" : "warn",
    correlationId: `claims-billing-gate-boot:${randomUUID()}`,
    retentionClass: "compliance",
    context: {
      mode: bound.mode,
      processRole: bound.processRole,
      nodeEnv: bound.nodeEnv ?? "unset",
      ...(bound.logOnlyReason === undefined ? {} : { logOnlyReason: bound.logOnlyReason }),
    },
  });
}
