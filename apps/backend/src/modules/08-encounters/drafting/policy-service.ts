// apps/backend/src/modules/08-encounters/drafting/policy-service.ts — the per-tenant visit-note draft switch (ADR-0114 VN-D17).
//
// One row per organization in `visit_note_draft_policy`: is the deterministic draft (and its sign gate) on for this tenant. An ABSENT
// row means OFF, applied here in code (main auto-deploys, so a tenant is never switched on by default). `enabled_at` is stamped
// SERVER-SIDE when the switch moves off -> on, kept while it stays on, and cleared when it goes off. ENABLING is refused with a typed
// 409 `CORPUS_REVIEW_PENDING` while the platform phrase corpus has not had its clinical review (`CORPUS_CLINICAL_REVIEW.status`, VN-D14);
// disabling is always allowed. Every write also records an explicit `m8.encounter.draft_policy_changed` audit event (previous and new
// value only) next to the row trigger's record, the way the closure policy does (ADR-0113).
//
// The service takes the caller's transaction (`withOrgContext` upstream) so RLS scopes every row; it never opens its own.
import { type AuditContext, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { CORPUS_CLINICAL_REVIEW, type ClinicalReviewStatus } from "@chartwarden/narrative-vocab";
import { ChartWardenError } from "@chartwarden/types";
import { eq } from "drizzle-orm";

/** The explicit audit event a switch write records (catalogued in `M8_ACTION_CATALOG`); the row trigger records the row change too. */
export const DRAFT_POLICY_AUDIT_EVENT = "m8.encounter.draft_policy_changed";

/** The refusal code for enabling the draft before the phrase corpus has been clinically approved. */
export const CORPUS_REVIEW_PENDING_CODE = "CORPUS_REVIEW_PENDING";
const HTTP_CONFLICT = 409;

/** A tenant's effective switch (the absent-row default already applied). */
export interface DraftPolicy {
  readonly enabled: boolean;
  /** When the switch last moved off -> on; `null` while it is off. */
  readonly enabledAt: Date | null;
}

export const DEFAULT_DRAFT_POLICY: DraftPolicy = Object.freeze({ enabled: false, enabledAt: null });

/** The phrase corpus's clinical review state (what `CORPUS_CLINICAL_REVIEW` carries); injectable so a test can approve it. */
export interface CorpusReview {
  readonly reviewer: string;
  readonly status: ClinicalReviewStatus;
}

const P = schema.visitNoteDraftPolicies;

/** The organization's switch, or OFF when it has never configured one. */
export async function readDraftPolicy(tx: DbClient, organizationId: string): Promise<DraftPolicy> {
  const [row] = await tx
    .select({ enabled: P.enabled, enabledAt: P.enabledAt })
    .from(P)
    .where(eq(P.organizationId, organizationId))
    .limit(1);
  return row ? { enabled: row.enabled, enabledAt: row.enabledAt } : DEFAULT_DRAFT_POLICY;
}

/**
 * Whether the tenant has the visit-note draft switched on (absent row = false). Call it inside the request's `withOrgContext`
 * transaction: the read is one primary-key lookup under RLS, so it needs no cache.
 */
export async function isVisitNoteDraftEnabled(
  tx: DbClient,
  organizationId: string,
): Promise<boolean> {
  return (await readDraftPolicy(tx, organizationId)).enabled;
}

/** The instant after a write: now when the switch turns on, kept while it stays on, null when it is off. Pure. */
export function nextEnabledAt(previous: DraftPolicy, nextEnabled: boolean, now: Date): Date | null {
  if (!nextEnabled) return null;
  return previous.enabled ? (previous.enabledAt ?? now) : now;
}

export interface PutDraftPolicyInput {
  readonly organizationId: string;
  readonly enabled: boolean;
  /** The acting member (`visit_note_draft_policy.changed_by_membership_id`). */
  readonly actorMembershipId: string;
  /** The request's audit context (organization, acting user, correlation id) for the explicit audit event. */
  readonly audit: AuditContext;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: Date;
  /** Injected for tests; defaults to the shipped corpus's review state. */
  readonly corpusReview?: CorpusReview;
}

function assertMayEnable(review: CorpusReview): void {
  if (review.status === "approved") return;
  throw new ChartWardenError(
    CORPUS_REVIEW_PENDING_CODE,
    "The visit-note draft cannot be enabled until the phrase corpus has had its clinical review.",
    HTTP_CONFLICT,
  );
}

/**
 * Idempotent upsert of the tenant's switch. Refuses ENABLING while the corpus review is not approved BEFORE any IO, derives
 * `enabled_at` server-side, writes the explicit `m8.encounter.draft_policy_changed` audit event on the same transaction (severity warn,
 * previous and new value, no free text) and returns the effective switch written. The M4 audit trigger records the row change too.
 *
 * ponytail: read-then-upsert, no row lock, as the closure policy does. Two concurrent PUTs converge on the same primary key and the
 * later write wins; the only skew is which one stamps `enabled_at`, and both stamp "now".
 */
export async function putDraftPolicy(
  tx: DbClient,
  input: PutDraftPolicyInput,
): Promise<DraftPolicy> {
  if (input.enabled) assertMayEnable(input.corpusReview ?? CORPUS_CLINICAL_REVIEW);
  const now = input.now ?? new Date();
  const previous = await readDraftPolicy(tx, input.organizationId);
  const written: DraftPolicy = {
    enabled: input.enabled,
    enabledAt: nextEnabledAt(previous, input.enabled, now),
  };
  await tx
    .insert(P)
    .values({
      organizationId: input.organizationId,
      ...written,
      changedByMembershipId: input.actorMembershipId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: P.organizationId,
      set: { ...written, changedByMembershipId: input.actorMembershipId, updatedAt: now },
    });
  await audit(tx, input.audit, {
    eventType: DRAFT_POLICY_AUDIT_EVENT,
    resourceKind: "visit_note_draft_policy",
    // The policy's key is the organization: the row trigger's resource id is the organization too.
    resourceId: input.organizationId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: {
      previousEnabled: previous.enabled,
      enabled: written.enabled,
      enabledAt: written.enabledAt === null ? null : written.enabledAt.toISOString(),
    },
  });
  return written;
}
