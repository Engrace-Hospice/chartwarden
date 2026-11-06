// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-progress-drizzle.ts — the tenant list's and overview's
// onboarding progress, read for MANY tenants in three queries (templates, tasks, go-live attestations), never one set per tenant.
//
// The judgement is `summarizeOnboarding` (onboarding/progress.ts), over the same rows the wizard reads: the non-retired templates and
// the tenant's tasks on those templates. A task kept as history on a retired template is therefore never counted.
import { type DbClient, schema } from "@chartwarden/db";
import { OnboardingRepository } from "@chartwarden/saas-tenant-platform";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { GoLiveAttestation, StepTask } from "../../onboarding/model";
import { type OnboardingProgress, summarizeOnboarding } from "../../onboarding/progress";
import { toGoLive, toTask, toTemplate } from "../../onboarding/wizard-store-drizzle";

const K = schema.onboardingTask;
const T = schema.onboardingTaskTemplate;
const G = schema.tenantGoLiveAttestation;

export interface ProgressSubject {
  readonly id: string;
  readonly status: string;
}

function groupBy<V>(rows: readonly V[], key: (row: V) => string): Map<string, V[]> {
  const grouped = new Map<string, V[]>();
  for (const row of rows) {
    const k = key(row);
    grouped.set(k, [...(grouped.get(k) ?? []), row]);
  }
  return grouped;
}

/** Progress per tenant account id. An empty subject list issues no query. */
export async function readOnboardingProgress(
  tx: DbClient,
  subjects: readonly ProgressSubject[],
): Promise<ReadonlyMap<string, OnboardingProgress>> {
  if (subjects.length === 0) return new Map();
  const ids = subjects.map((s) => s.id);
  const templates = (await new OnboardingRepository(tx).listTemplates()).map(toTemplate);
  const taskRows = await tx
    .select({ row: K })
    .from(K)
    .innerJoin(T, eq(K.templateKey, T.key))
    .where(and(inArray(K.tenantAccountId, ids), isNull(T.retiredAt)));
  const attestationRows = await tx
    .select()
    .from(G)
    .where(inArray(G.tenantAccountId, ids))
    .orderBy(desc(G.attestedAt));
  const tasksByTenant = groupBy(taskRows, (r) => r.row.tenantAccountId);
  const attestationsByTenant = groupBy(attestationRows, (r) => r.tenantAccountId);
  return new Map(
    subjects.map((s) => {
      const tasks: StepTask[] = (tasksByTenant.get(s.id) ?? []).map((r) => toTask(r.row));
      const attestations: GoLiveAttestation[] = (attestationsByTenant.get(s.id) ?? []).map(
        toGoLive,
      );
      return [
        s.id,
        summarizeOnboarding({ tenantStatus: s.status, templates, tasks, attestations }),
      ] as const;
    }),
  );
}
