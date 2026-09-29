// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m25-taxonomy-unmapped-code-observed.ts —
// M23's last remaining `handlers-unbound` pair, #248: `m25.taxonomy.unmapped_code_observed`.
//
// ── WHY THIS DOES NOT REUSE THE `revalidate.consumer` QUEUE ─────────────────────────────────────────────
//
// `m23-revalidate-triggers.ts`'s own header already says why: that path RE-VALIDATES an existing claim
// (matched by `patientId`/`admissionId`/`encounterId`); this event carries none of those — it is a raw
// observation ("we just saw a CARC code M38's catalog doesn't know about") with no claim to re-validate.
// M25's own D13 spec text is the design brief: "the first occurrence of a CARC not present in M38's
// catalog ... generates `m25.taxonomy.unmapped_code_observed` outbox to M23 (suggesting a new
// pre-submission validation rule per architecture §11.A) ... M23 §11.A subscribes to this event; if
// `occurrenceCount` exceeds 50 within 30 days, M23 surfaces an `unmapped_taxonomy_alert` to the
// platform-admin queue (D13)."
//
// ── THE OCCURRENCE STORE (new table, `unmapped_taxonomy_occurrence`, migration 0255) ────────────────────
//
// A per-row history, not a maintained counter — see that migration's own header for why a 30-day ROLLING
// window needs individual rows to age out rather than a single counter that can only ever go up.
// Idempotent via a unique index on (organization_id, source_event_id = the delivered outbox event's own
// id): a redelivery inserts nothing a second time, so it cannot double-count toward the threshold.
//
// ── THE THRESHOLD ALERT: REUSES THE EXISTING `WorkerAlertPort` → M36 `AlertEmitter` SEAM, NOT A NEW ONE ─
//
// `jobs/m23-jobs.ts` already dispatches exactly this class of "surfaced, non-blocking, threshold-crossed"
// signal through `alertsOf(deps).dispatch({alertCode, severity, organizationId, payload})` for
// `claim.submission_stalled` / `claim.cap_projection_at_threshold` — this consumer reuses that SAME port
// shape rather than inventing a second alert-delivery mechanism. `AlertEmitter.emit` is inherently
// ORG-scoped (`emit(orgId, ...)`), so "the platform-admin queue" is read here as the org's own
// rule-config-authority surface (the `billing.rule_config.platform_admin` / `.edit` permission holders'
// alert inbox) rather than a cross-tenant WardenX-ops construct — no such cross-tenant queue exists
// anywhere in this codebase, and inventing one would be exactly the kind of new mechanism this pass was
// told not to guess at. `AlertEmitter.emit` is a documented no-op-with-a-persisted-row when no
// `alert_rule` matches the `eventType` yet (`createAlertEmitter`'s own doc comment: "no rule → a no-op
// alert, recipientCount 0") — the same "surface it even before a routing rule exists" posture F-160's
// M26 `surface-stuck-alert` binding already relies on — so this consumer does not need a pre-seeded
// `alert_rule` row to be correct; it becomes actionable the moment a tenant (or the platform) configures
// one.
//
// **`deps.alerts` is NOT bound at the composition root today** (a separate, already-reported gap: M23's
// `buildM23WorkerDeps` never receives an `alerts` port — see the standing finding on
// `runMacPortalHealth`). That is not this consumer's defect to fix; it is wired here as a first-class
// dependency exactly like every other M23 consumer's cross-module ports, so the composition root can bind
// it the same way `apps/backend/src/index.ts` already does for M25's cron `alerts` adapter
// (`AlertEmitter.emit` wrapped 1:1 into `dispatch({alertCode, severity, organizationId, payload})`).
//
// ── DEBOUNCE: FIRE ON EVERY OCCURRENCE PAST THE THRESHOLD, NOT ONLY THE ONE THAT CROSSES IT ─────────────
//
// The occurrence INSERT and the threshold check run inside one `withOrgContext` transaction that commits
// BEFORE the alert dispatch is attempted (the `CapConsumerStore`/`drizzle-store.ts` precedent: a
// cross-module seam call is never nested inside an open write transaction). That ordering means a failed
// dispatch (e.g. the port throws because it is still unbound) cannot roll back the occurrence row — and
// because the occurrence insert is idempotent, a REDELIVERY of the same event can never retry the missed
// alert. Firing on every occurrence once the rolling count exceeds 50 (rather than only the one delivery
// where the count first crosses from 50 to 51) means a single dropped dispatch delays the signal by at
// most one further occurrence rather than losing it until the window happens to dip back under 50 and
// cross again — the simpler, more robust choice given `alerts` is fail-closed until bound.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, sql } from "drizzle-orm";
import type { WorkerAlertPort } from "../jobs/m23-jobs";

const OCC = schema.unmappedTaxonomyOccurrence;

/** The 30-day rolling window D13 specifies. */
const WINDOW_DAYS = 30;
/** "exceeds 50" (D13) — the count strictly greater than this fires the alert. */
const OCCURRENCE_THRESHOLD = 50;

export const M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_EVENT = "m25.taxonomy.unmapped_code_observed" as const;
export const M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_ALERT_CODE =
  "m23.taxonomy.unmapped_taxonomy_alert" as const;

export interface M23TaxonomyUnmappedCodeConsumerDeps {
  readonly db: DbClient;
  readonly alerts: WorkerAlertPort;
}

interface TaxonomyUnmappedCodePayload {
  readonly carcCode: string;
  readonly rarcCode: string | null;
  readonly providerEntityId: string;
  readonly denialCaseId: string;
}

function factsOf(payload: unknown): TaxonomyUnmappedCodePayload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const carcCode = p.carcCode;
  const providerEntityId = p.providerEntityId;
  const denialCaseId = p.denialCaseId;
  const rarcCode = p.rarcCode;
  if (typeof carcCode !== "string" || carcCode.length === 0) {
    throw new Error(`m23.m25-taxonomy-unmapped-code-observed: payload has no carcCode`);
  }
  if (typeof providerEntityId !== "string" || providerEntityId.length === 0) {
    throw new Error(`m23.m25-taxonomy-unmapped-code-observed: payload has no providerEntityId`);
  }
  if (typeof denialCaseId !== "string" || denialCaseId.length === 0) {
    throw new Error(`m23.m25-taxonomy-unmapped-code-observed: payload has no denialCaseId`);
  }
  return {
    carcCode,
    rarcCode: typeof rarcCode === "string" && rarcCode.length > 0 ? rarcCode : null,
    providerEntityId,
    denialCaseId,
  };
}

/**
 * M23's live `m25.taxonomy.unmapped_code_observed` binding (D13, §11.A) — the last of M23's originally
 * `handlers-unbound` group. Records the occurrence, then — only once the org's rolling 30-day count for
 * this CARC code exceeds 50 — dispatches the D13 surfaced alert.
 */
export function buildM23TaxonomyUnmappedCodeObservedConsumer(deps: M23TaxonomyUnmappedCodeConsumerDeps) {
  return {
    consumerName: "m23.m25-taxonomy-unmapped-code-observed",
    consumerModule: "m23" as const,
    eventTypes: [M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_EVENT] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      const outcome = await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const [inserted] = await tx
          .insert(OCC)
          .values({
            organizationId,
            carcCode: facts.carcCode,
            rarcCode: facts.rarcCode,
            providerEntityId: facts.providerEntityId,
            denialCaseId: facts.denialCaseId,
            sourceEventId: event.id,
          })
          .onConflictDoNothing({
            target: [OCC.organizationId, OCC.sourceEventId],
          })
          .returning({ id: OCC.id });

        if (!inserted) {
          // A redelivery of an already-recorded occurrence — idempotent no-op, nothing to (re-)count.
          return { fireAlert: false, occurrenceCount: 0 };
        }

        const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const [row] = await tx
          .select({ occurrenceCount: sql<number>`count(*)::int` })
          .from(OCC)
          .where(
            and(
              eq(OCC.organizationId, organizationId),
              eq(OCC.carcCode, facts.carcCode),
              gte(OCC.observedAt, windowStart),
            ),
          );
        const occurrenceCount = row?.occurrenceCount ?? 0;
        return { fireAlert: occurrenceCount > OCCURRENCE_THRESHOLD, occurrenceCount };
      });

      if (!outcome.fireAlert) return;

      await deps.alerts.dispatch({
        alertCode: M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_ALERT_CODE,
        severity: "warn",
        organizationId,
        payload: {
          carcCode: facts.carcCode,
          rarcCode: facts.rarcCode,
          providerEntityId: facts.providerEntityId,
          denialCaseId: facts.denialCaseId,
          occurrenceCount: outcome.occurrenceCount,
          windowDays: WINDOW_DAYS,
        },
      });
    },
  };
}
