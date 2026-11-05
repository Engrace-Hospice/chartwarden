// apps/backend/src/modules/34-saas-tenant-platform/onboarding/go-live.ts — the two-party go-live (pure).
//
// onboarding -> active needs TWO people: (a) the tenant's compliance officer attests readiness (step-up), then (b) a
// platform operator approves (step-up, human, reason). Approval re-evaluates the activation guards at that instant and
// refuses, listing every guard that failed. Nothing here touches IO; wizard-service.ts runs these against a store.
import { ChartWardenError } from "@chartwarden/types";
import {
  type ActivationGuards,
  evaluateActivationGuards,
} from "../routes/platform/activation-guards";
import {
  GO_LIVE_TEMPLATE_KEY,
  type GoLiveAttestation,
  ONBOARDING_STATUS,
  type StepTask,
  type StepTemplate,
} from "./model";
import { assertStepActionable, currentStepKey, gatingTemplateKeys, isSettled } from "./sequence";

export type GoLiveState =
  | "not_ready"
  | "awaiting_attestation"
  | "awaiting_approval"
  | "live"
  | "closed";

/**
 * The activation guards as approval will judge them: the go-live step itself is the thing being approved, so it counts
 * as settled; every other gating step must really be done or skipped. Optional and retired steps are not in `templates`
 * as gating keys.
 */
export function evaluateGoLiveGuards(input: {
  readonly templates: readonly StepTemplate[];
  readonly tasks: readonly StepTask[];
  readonly latestBaa: { readonly baaStatus: string; readonly expiresOn: string | null } | undefined;
  readonly today: Date;
}): ActivationGuards {
  const overlaid = input.tasks.map((t) =>
    t.templateKey === GO_LIVE_TEMPLATE_KEY ? { ...t, status: "done" as const } : t,
  );
  return evaluateActivationGuards({
    canonicalTemplateKeys: gatingTemplateKeys(input.templates),
    tasks: overlaid,
    latestBaa: input.latestBaa,
    today: input.today,
  });
}

const GUARD_MESSAGES: Readonly<Record<string, string>> = {
  canonicalTasksComplete: "every required onboarding step must be done or skipped",
  baaExecuted: "the latest platform BAA must be executed",
  baaExpiryClearsNinetyDays: "the executed BAA must have more than 90 days left",
};

/** Refuses (409) listing every failed guard, and every open step behind `canonicalTasksComplete`. */
export function assertGuardsPass(
  guards: ActivationGuards,
  templates: readonly StepTemplate[],
  tasks: readonly StepTask[],
): void {
  const details: { field: string; code: string; message: string }[] = [];
  const failed: string[] = [];
  const statusByKey = new Map(tasks.map((t) => [t.templateKey, t.status]));
  for (const name of [
    "canonicalTasksComplete",
    "baaExecuted",
    "baaExpiryClearsNinetyDays",
  ] as const) {
    if (guards[name]) continue;
    failed.push(name);
    details.push({ field: "guard", code: name, message: GUARD_MESSAGES[name] as string });
    if (name !== "canonicalTasksComplete") continue;
    for (const key of gatingTemplateKeys(templates)) {
      const status = statusByKey.get(key);
      if (key === GO_LIVE_TEMPLATE_KEY || (status !== undefined && isSettled(status))) continue;
      details.push({
        field: "templateKey",
        code: key,
        message: `${templates.find((t) => t.key === key)?.title ?? key} is ${status ?? "missing"}`,
      });
    }
  }
  if (failed.length === 0) return;
  throw new ChartWardenError(
    "ACTIVATION_GUARDS_FAILED",
    `the tenant cannot go live yet: ${failed.join(", ")} not satisfied`,
    409,
    details,
  );
}

const latestOf = (attestations: readonly GoLiveAttestation[]): GoLiveAttestation | undefined =>
  [...attestations].sort((a, b) => b.attestedAt.getTime() - a.attestedAt.getTime())[0];

const pendingOf = (attestations: readonly GoLiveAttestation[]): GoLiveAttestation | undefined =>
  attestations.find((a) => a.status === "pending");

export function goLiveStateOf(input: {
  readonly tenantStatus: string;
  readonly templates: readonly StepTemplate[];
  readonly tasks: readonly StepTask[];
  readonly attestations: readonly GoLiveAttestation[];
}): GoLiveState {
  if (input.tenantStatus === "active") return "live";
  if (input.tenantStatus !== ONBOARDING_STATUS) return "closed";
  if (pendingOf(input.attestations)) return "awaiting_approval";
  const current = currentStepKey(input.templates, input.tasks);
  return current === null || current === GO_LIVE_TEMPLATE_KEY
    ? "awaiting_attestation"
    : "not_ready";
}

const refuse = (code: string, message: string, status: number): ChartWardenError =>
  new ChartWardenError(code, message, status);

const notOnboarding = (): ChartWardenError =>
  refuse("TENANT_NOT_ONBOARDING", "the tenant is not in onboarding", 409);

export function assertCanAttest(input: {
  readonly tenantStatus: string;
  readonly templates: readonly StepTemplate[];
  readonly tasks: readonly StepTask[];
  readonly attestations: readonly GoLiveAttestation[];
  readonly assignedOfficer: string | null;
  readonly actorMembershipId: string;
}): void {
  if (input.tenantStatus !== ONBOARDING_STATUS) throw notOnboarding();
  if (pendingOf(input.attestations)) {
    throw refuse(
      "GO_LIVE_ALREADY_ATTESTED",
      "readiness is already attested and awaiting platform approval",
      409,
    );
  }
  if (input.assignedOfficer !== null && input.assignedOfficer !== input.actorMembershipId) {
    throw refuse(
      "GO_LIVE_NOT_ASSIGNED_OFFICER",
      "only the assigned compliance officer may attest go-live readiness",
      403,
    );
  }
  assertStepActionable(input.templates, input.tasks, GO_LIVE_TEMPLATE_KEY);
}

export function assertCanApprove(input: {
  readonly tenantStatus: string;
  readonly attestations: readonly GoLiveAttestation[];
  readonly approverMembershipId: string;
}): GoLiveAttestation {
  if (input.tenantStatus !== ONBOARDING_STATUS) throw notOnboarding();
  const pending = pendingOf(input.attestations);
  if (!pending) {
    throw refuse(
      "GO_LIVE_NOT_ATTESTED",
      "the tenant's compliance officer has not attested go-live readiness",
      409,
    );
  }
  if (pending.attestedByMembershipId === input.approverMembershipId) {
    throw refuse("GO_LIVE_SELF_APPROVAL", "the attester cannot approve their own attestation", 409);
  }
  return pending;
}

export function assertCanRevoke(input: {
  readonly tenantStatus: string;
  readonly attestations: readonly GoLiveAttestation[];
}): GoLiveAttestation {
  if (input.tenantStatus !== ONBOARDING_STATUS) throw notOnboarding();
  const pending = pendingOf(input.attestations);
  if (!pending) {
    throw refuse("GO_LIVE_NOT_ATTESTED", "there is no pending go-live attestation to revoke", 409);
  }
  return pending;
}

/** The most recent attestation of any status (for the read model). */
export const latestAttestation = latestOf;
