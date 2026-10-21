// apps/backend/src/modules/22-documents/workers/form-render-worker.ts — the §4.8 `form-render` worker (GAP-140 /
// GAP-141): consumes `form_fill` rows in `queued`, renders each through the §4.3 `DocumentRenderer` and settles
// the row (`rendered` + `result_document_id`, or `failed` + a PHI-free reason).
//
// Until this existed `POST /admin/form-fills/:id/retry` flipped a row to `queued` and nothing ever consumed it.
//
// SHAPE. One minute-cadence repeatable trigger enumerates active orgs under the audited platform context (the
// records-request-expiry precedent), and each org's batch runs in its own `withOrgContext` transaction (a cron
// tick is not a request). Inside that transaction the rows are claimed `FOR UPDATE SKIP LOCKED`, so two worker
// replicas never render the same fill, and a crash mid-render rolls the whole claim back — the row is simply
// still `queued` for the next tick (no stuck `rendering` rows to recover).
//
// FAILURE. An unknown template or a payload with no aggregate identity is PERMANENT (`failed` at once). Any other
// error is retried up to {@link MAX_RENDER_ATTEMPTS} times (`render_attempts` is a text column, parsed here), then
// settles `failed`. `failure_reason` carries the error CLASS and message only — never the payload (PHI-bearing,
// audit-denylisted). A terminal failure raises the critical `m22.document.render_failed` alert.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DocumentRenderer } from "@chartwarden/types";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { asc, eq } from "drizzle-orm";
import { UnknownTemplateError } from "../seams/renderer";

export const M22_FORM_RENDER_QUEUE = "documents.form_render";
/** Every minute: a queued render is user-visible (a retry button), so the tick is short. */
export const M22_FORM_RENDER_SCHEDULE = "* * * * *";
/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M22_FORM_RENDER_PLATFORM_JOB_ID = "m22.form_render";
/** Rows rendered per org per tick (bounds the transaction; the next tick continues). */
export const FORM_RENDER_BATCH_SIZE = 10;
/** Transient failures retried this many times in total before the fill settles `failed`. */
export const MAX_RENDER_ATTEMPTS = 3;
const MAX_FAILURE_REASON_CHARS = 500;

const FF = schema.formFills;
const FTV = schema.formTemplateVersions;
const FT = schema.formTemplates;

export interface FormRenderAlert {
  readonly organizationId: string;
  readonly formFillId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly failureReason: string;
  readonly retryCount: number;
}

export interface FormRenderDeps {
  readonly db: DbClient;
  readonly renderer: DocumentRenderer;
  /** Best-effort critical alert on a TERMINAL failure; a throw here never fails the tick. */
  readonly onTerminalFailure?: (alert: FormRenderAlert) => Promise<void> | void;
  readonly now?: () => Date;
}

/** Permanent failures: retrying cannot help. */
export function isPermanentRenderFailure(error: unknown): boolean {
  return error instanceof UnknownTemplateError;
}

/** A PHI-free, bounded failure reason: the error class + message, never the payload. */
export function failureReasonOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${message}`.slice(0, MAX_FAILURE_REASON_CHARS);
}

const attemptsOf = (raw: string): number => {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Render one org's queued fills. Returns how many settled `rendered` / `failed` and how many were requeued. */
export async function renderQueuedFormFillsForOrg(
  deps: FormRenderDeps,
  organizationId: string,
): Promise<{ rendered: number; failed: number; retried: number }> {
  const now = deps.now ?? (() => new Date());
  const terminal: FormRenderAlert[] = [];
  const counts = { rendered: 0, failed: 0, retried: 0 };

  await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
    const rows = await tx
      .select({
        id: FF.id,
        createdAt: FF.createdAt,
        aggregateType: FF.aggregateType,
        aggregateId: FF.aggregateId,
        renderPayload: FF.renderPayload,
        renderAttempts: FF.renderAttempts,
        templateKey: FT.templateKey,
      })
      .from(FF)
      .innerJoin(FTV, eq(FTV.id, FF.templateVersionId))
      .innerJoin(FT, eq(FT.id, FTV.templateId))
      .where(eq(FF.status, "queued"))
      .orderBy(asc(FF.createdAt))
      .limit(FORM_RENDER_BATCH_SIZE)
      .for("update", { of: FF, skipLocked: true });

    for (const row of rows) {
      const attempt = attemptsOf(row.renderAttempts) + 1;
      // The renderer needs the aggregate identity; the row's own column is authoritative over the payload's.
      const payload = {
        ...((row.renderPayload ?? {}) as Record<string, unknown>),
        aggregateId: row.aggregateId,
      };
      try {
        const { documentId } = await deps.renderer.render(
          { orgId: organizationId },
          row.templateKey,
          payload,
        );
        // Match on `id` ALONE: `created_at` is microsecond-precision in Postgres but a JS `Date` is millisecond, so
        // `created_at = row.createdAt` never matched — the UPDATE touched 0 rows while the tick still counted the
        // fill rendered (found by the live suite). `.returning` makes a no-op update visible instead of silent.
        const rendered = await tx
          .update(FF)
          .set({
            status: "rendered",
            resultDocumentId: documentId,
            failureReason: null,
            renderAttempts: String(attempt),
            renderedAt: now(),
          })
          .where(eq(FF.id, row.id))
          .returning({ id: FF.id });
        if (rendered.length > 0) counts.rendered += 1;
      } catch (error) {
        const reason = failureReasonOf(error);
        const settle = isPermanentRenderFailure(error) || attempt >= MAX_RENDER_ATTEMPTS;
        const settled = await tx
          .update(FF)
          .set({
            status: settle ? "failed" : "queued",
            failureReason: reason,
            renderAttempts: String(attempt),
          })
          .where(eq(FF.id, row.id))
          .returning({ id: FF.id });
        if (settled.length === 0) continue;
        if (settle) {
          counts.failed += 1;
          terminal.push({
            organizationId,
            formFillId: row.id,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            failureReason: reason,
            retryCount: attempt,
          });
        } else {
          counts.retried += 1;
        }
      }
    }
  });

  for (const alert of terminal) {
    try {
      await deps.onTerminalFailure?.(alert);
    } catch {
      // best-effort: the failed row is the durable record; an alert outage must not fail the tick.
    }
  }
  return counts;
}

export interface FormRenderWorkerDeps extends FormRenderDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly log?: (msg: string, detail: Record<string, unknown>) => void;
}

/** One tick: every active org, failures isolated and re-raised together so BullMQ retries the tick. */
export async function runFormRenderFanout(
  deps: Omit<FormRenderWorkerDeps, "connection">,
): Promise<{ orgs: number; rendered: number; failed: number }> {
  const failures: unknown[] = [];
  let orgs = 0;
  let rendered = 0;
  let failed = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    orgs += 1;
    try {
      const res = await renderQueuedFormFillsForOrg(deps, organizationId);
      rendered += res.rendered;
      failed += res.failed;
      if (res.rendered + res.failed + res.retried > 0) {
        deps.log?.("m22.form_render.tick", { organizationId, ...res });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `M22_FORM_RENDER: ${failures.length} org failure(s)`);
  }
  return { orgs, rendered, failed };
}

export function registerFormRenderWorker(deps: FormRenderWorkerDeps): Worker {
  return new Worker(M22_FORM_RENDER_QUEUE, async () => runFormRenderFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleFormRender(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M22_FORM_RENDER_QUEUE, { connection });
  await queue.add(
    "every-minute",
    {},
    {
      repeat: { pattern: M22_FORM_RENDER_SCHEDULE },
      jobId: "m22-form-render-every-minute",
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
