// apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-core.ts - what every wizard operation shares: the typed
// refusal, who may act on a step, the loaded tenant (templates, tasks, store) and the read model.
import { PLATFORM_ALERT_AUDIENCE_ROLE_KEY } from "@chartwarden/auth";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import {
  ONBOARDING_STATUS,
  type StepOwner,
  type StepTask,
  type StepTemplate,
  type TenantRef,
  type WizardActor,
} from "./model";
import type { WizardStore } from "./wizard-store";
import { type WizardView, buildWizardView } from "./wizard-view";

export const refuse = (code: string, message: string, status: number): ChartWardenError =>
  new ChartWardenError(code, message, status);

/** Who may act on a step. Platform operators act on any step; `either` is the tenant org_admin or platform ops. */
export function actorMayActOnStep(actor: WizardActor, owner: StepOwner): boolean {
  if (actor.kind === "platform") return true;
  if (owner === "platform_ops") return false;
  if (owner === "compliance_officer") return actor.roles.includes("compliance_officer");
  return actor.roles.includes("org_admin");
}

export const actorKindOf = (actor: WizardActor): "platform_ops" | "tenant" =>
  actor.kind === "platform" ? "platform_ops" : "tenant";

export const requireOnboarding = (tenant: TenantRef): void => {
  if (tenant.status !== ONBOARDING_STATUS) {
    throw refuse("TENANT_NOT_ONBOARDING", "the tenant is not in onboarding", 409);
  }
};

export interface Loaded {
  readonly store: WizardStore;
  readonly tenant: TenantRef;
  readonly templates: StepTemplate[];
  readonly tasks: StepTask[];
}

export async function loadTenant(
  store: WizardStore,
  by: { orgSlug: string } | { organizationId: string },
): Promise<TenantRef> {
  const tenant = await store.loadTenant(by);
  if (!tenant) throw new NotFoundError("tenant");
  return tenant;
}

export async function load(
  store: WizardStore,
  by: { orgSlug: string } | { organizationId: string },
): Promise<Loaded> {
  const tenant = await loadTenant(store, by);
  const [templates, tasks] = await Promise.all([
    store.listTemplates(),
    store.listTasks(tenant.tenantAccountId),
  ]);
  return { store, tenant, templates, tasks };
}

/** The task and its template, for a step action by `actor` (owner check included). */
export function targetOf(
  ctx: Loaded,
  taskId: string,
  actor: WizardActor,
): { task: StepTask; template: StepTemplate } {
  const task = ctx.tasks.find((t) => t.id === taskId);
  const template = task && ctx.templates.find((t) => t.key === task.templateKey);
  if (!task || !template) throw new NotFoundError("onboarding_task", taskId);
  if (!actorMayActOnStep(actor, template.owner)) {
    throw refuse(
      "ONBOARDING_STEP_OWNER_MISMATCH",
      `this step belongs to ${template.owner === "either" ? "the organization administrator" : template.owner}; you cannot act on it`,
      403,
    );
  }
  return { task, template };
}

export const conflict = (): ChartWardenError =>
  refuse(
    "ONBOARDING_TASK_CHANGED",
    "the onboarding step changed concurrently; reload and retry",
    409,
  );

/** The read model of a loaded tenant, as of `now`. */
export async function view(ctx: Loaded, now: () => Date): Promise<WizardView> {
  const [attestations, latestBaa] = await Promise.all([
    ctx.store.listGoLive(ctx.tenant),
    ctx.store.latestBaa(ctx.tenant.tenantAccountId),
  ]);
  return buildWizardView({
    tenant: ctx.tenant,
    templates: ctx.templates,
    tasks: ctx.tasks,
    attestations,
    latestBaa,
    today: now(),
  });
}

/**
 * Whether the member is ChartWarden staff: bound to the platform alert-audience role in this organisation, or holding a live
 * platform role at home. Every platform_ops operator has an active membership in every tenant (bootstrap/bind-platform-staff.ts),
 * so "is a member" cannot mean "belongs to the customer". Staff are never the compliance officer or the go-live attester: the
 * officer's attestation and the platform approval are the two parties, and one operator could otherwise be both hats.
 */
export async function isPlatformStaffMember(
  store: WizardStore,
  member: { readonly userId: string; readonly roleKeys: readonly string[] },
): Promise<boolean> {
  return (
    member.roleKeys.includes(PLATFORM_ALERT_AUDIENCE_ROLE_KEY) ||
    (await store.isPlatformStaff(member.userId))
  );
}

export const platformStaffRefusal = (what: string): ChartWardenError =>
  refuse(
    "COMPLIANCE_OFFICER_PLATFORM_STAFF",
    `ChartWarden platform staff cannot ${what}: the compliance officer must be a member of the customer's own staff`,
    422,
  );
