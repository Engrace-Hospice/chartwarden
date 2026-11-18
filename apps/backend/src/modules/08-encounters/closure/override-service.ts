// apps/backend/src/modules/08-encounters/closure/override-service.ts — the supervisor override of the closure block (ADR-0113 D7, D8).
//
// A supervisor lifts ONLY the block for one clinician and one obligation kind for at most 24 hours (default 4). Alerts, deadlines
// and the policy are unchanged, and it does not satisfy the late-entry override routes. The table is append-only for the
// application role: this service INSERTs a grant, stamps the two revocation columns on revoke, and never deletes.
//
// THE REASON is free text a supervisor typed (40 to 500 chars) next to a clinician's name. It is screened for SSN / MBI shapes before
// anything is written (a refusal names the field and never echoes the text), stored on the override row (the row's audit snapshot
// scrubs it), and carried, screened, as `context.justification` of the explicit `m8.encounter.closure_override_granted` event: that
// event is the audit copy. No route returns the reason. The revoke event carries ids and instants only.
//
// WHO MAY BE RELEASED, AND BY WHOM is decided by override-grant-guards.ts, in this order: the grantor has nothing of their own past its
// block instant (overrides ignored), the clinician's oldest open note is in the grantor's scope, the clinician is blocked. A revoke is
// allowed for the original grantor or an org-wide caller. The caller's transaction (`withOrgContext`) is taken as-is so RLS scopes every row and each audit write
// is atomic with the change it records.
import { type AuditContext, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { looksLikePatientIdentifier } from "@chartwarden/shared";
import {
  ACTIVE_DOCUMENTATION_OBLIGATION_KINDS,
  CLOSURE_OVERRIDE_DEFAULT_HOURS,
  CLOSURE_OVERRIDE_MAX_HOURS,
  CLOSURE_OVERRIDE_MAX_REASON_CHARS,
  CLOSURE_OVERRIDE_MIN_REASON_CHARS,
  type DocumentationObligationKind,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { and, eq, isNull } from "drizzle-orm";
import { assertGrantAllowed, assertMayRevoke } from "./override-grant-guards";
import {
  type ClosureOverrideView,
  remainingActiveUntil,
  closureOverrideViewColumns as viewColumns,
} from "./override-lookup";

export {
  NOTE_CLOSURE_GRANTOR_BLOCKED_CODE,
  NOTE_CLOSURE_SUBJECT_NOT_BLOCKED_CODE,
  NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE_CODE,
} from "./override-grant-guards";
export { type ClosureOverrideView, findActiveOverride, isOverrideActive } from "./override-lookup";

/** The explicit audit event a grant writes (catalogued in `M8_ACTION_CATALOG`); the row trigger records the row change too. */
export const CLOSURE_OVERRIDE_AUDIT_EVENT = "m8.encounter.closure_override_granted";
/** The explicit audit event a revoke writes, only when THIS call revoked the grant. Ids and instants; never the reason. */
export const CLOSURE_OVERRIDE_REVOKED_AUDIT_EVENT = "m8.encounter.closure_override_revoked";

const MIN_OVERRIDE_HOURS = 1;
const MS_PER_HOUR = 3_600_000;
const OVERRIDE_RESOURCE_KIND = "documentation_obligation_override";
/** The details code of a reason refused for looking like a patient identifier (the house screen's own code). */
const LOOKS_LIKE_IDENTIFIER_CODE = "EVIDENCE_LOOKS_LIKE_PHI";
const REASON_HAS_IDENTIFIER_MESSAGE =
  "reason looks like it contains a patient identifier (a Social Security or Medicare number). Describe the situation without naming a patient or quoting an identifier.";

const O = schema.documentationObligationOverrides;
const M = schema.memberships;

function refuse(field: string, message: string, code = "INVALID"): never {
  throw new ValidationError("request validation failed", [{ field, code, message }]);
}

export interface GrantClosureOverrideInput {
  readonly organizationId: string;
  readonly subjectMembershipId: string;
  readonly grantedByMembershipId: string;
  readonly obligationKind: DocumentationObligationKind;
  readonly reason: string;
  /** 1..24, default 4. */
  readonly hours?: number;
  /** The grantor's location scope, as the overdue board reads it: `null` = org-wide, otherwise their sites (empty = none). */
  readonly locationIds: readonly string[] | null;
  /** The request's audit context (organization, acting user, correlation id) for the explicit audit event. */
  readonly audit: AuditContext;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: Date;
}

function validatedWindowHours(hours: number | undefined): number {
  const value = hours ?? CLOSURE_OVERRIDE_DEFAULT_HOURS;
  const valid =
    Number.isInteger(value) && value >= MIN_OVERRIDE_HOURS && value <= CLOSURE_OVERRIDE_MAX_HOURS;
  if (!valid)
    refuse(
      "hours",
      `hours must be a whole number from ${MIN_OVERRIDE_HOURS} to ${CLOSURE_OVERRIDE_MAX_HOURS}`,
    );
  return value;
}

/** Every rule that needs no database, in the order a caller should hear about them. Returns the trimmed reason and window. */
function validatedGrant(input: GrantClosureOverrideInput): { reason: string; hours: number } {
  if (!ACTIVE_DOCUMENTATION_OBLIGATION_KINDS.includes(input.obligationKind)) {
    refuse(
      "obligationKind",
      `only ${ACTIVE_DOCUMENTATION_OBLIGATION_KINDS.join(", ")} can be overridden`,
    );
  }
  if (input.subjectMembershipId === input.grantedByMembershipId) {
    throw new ForbiddenError("a supervisor cannot override their own closure block");
  }
  const reason = input.reason.trim();
  if (reason.length < CLOSURE_OVERRIDE_MIN_REASON_CHARS) {
    refuse("reason", `reason must be at least ${CLOSURE_OVERRIDE_MIN_REASON_CHARS} characters`);
  }
  if (reason.length > CLOSURE_OVERRIDE_MAX_REASON_CHARS) {
    refuse("reason", `reason must be at most ${CLOSURE_OVERRIDE_MAX_REASON_CHARS} characters`);
  }
  // The screen runs on the text as stored, here, at the one place it is written: a second caller of the service cannot put an
  // identifier on the row or in the audit event.
  if (looksLikePatientIdentifier(reason)) {
    refuse("reason", REASON_HAS_IDENTIFIER_MESSAGE, LOOKS_LIKE_IDENTIFIER_CODE);
  }
  return { reason, hours: validatedWindowHours(input.hours) };
}

async function assertActiveSubject(
  tx: DbClient,
  organizationId: string,
  subjectMembershipId: string,
): Promise<void> {
  const [subject] = await tx
    .select({ id: M.id })
    .from(M)
    .where(
      and(
        eq(M.id, subjectMembershipId),
        eq(M.organizationId, organizationId),
        eq(M.status, "active"),
      ),
    )
    .limit(1);
  if (!subject)
    refuse("subjectMembershipId", "the clinician must be an active member of this organization");
}

/**
 * Grant a closure override. Validates before any IO (including the identifier screen on the reason), requires an active subject in
 * the organization, applies the three grant guards, INSERTs the grant (the DB CHECKs and triggers repeat the self-grant, reason,
 * 24h and same-organization rules) and writes the explicit audit event on the same transaction.
 */
export async function grantClosureOverride(
  tx: DbClient,
  input: GrantClosureOverrideInput,
): Promise<ClosureOverrideView> {
  const { reason, hours } = validatedGrant(input);
  await assertActiveSubject(tx, input.organizationId, input.subjectMembershipId);
  const now = input.now ?? new Date();
  await assertGrantAllowed(tx, {
    organizationId: input.organizationId,
    subjectMembershipId: input.subjectMembershipId,
    grantedByMembershipId: input.grantedByMembershipId,
    locationIds: input.locationIds,
    now,
  });
  const expiresAt = new Date(now.getTime() + hours * MS_PER_HOUR);
  const [created] = await tx
    .insert(O)
    .values({
      organizationId: input.organizationId,
      subjectMembershipId: input.subjectMembershipId,
      grantedByMembershipId: input.grantedByMembershipId,
      obligationKind: input.obligationKind,
      reason,
      grantedAt: now,
      expiresAt,
    })
    .returning(viewColumns);
  if (!created) throw new Error("closure override insert returned no row");
  await audit(tx, input.audit, {
    eventType: CLOSURE_OVERRIDE_AUDIT_EVENT,
    resourceKind: OVERRIDE_RESOURCE_KIND,
    resourceId: created.id,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: {
      overrideId: created.id,
      subjectMembershipId: input.subjectMembershipId,
      grantedByMembershipId: input.grantedByMembershipId,
      obligationKind: input.obligationKind,
      hours,
      expiresAt: expiresAt.toISOString(),
    },
    // The screened reason: the only audit copy of it (the row trigger scrubs the row snapshot). The key follows
    // `hope.late_deadline_override`, which carries its justification the same way.
    context: { justification: reason },
  });
  return created;
}

export interface RevokeClosureOverrideInput {
  readonly organizationId: string;
  readonly overrideId: string;
  readonly revokedByMembershipId: string;
  /** The revoker's location scope, as the overdue board reads it: `null` = org-wide (any override), otherwise their sites (only their own grants). */
  readonly locationIds: readonly string[] | null;
  /** The request's audit context for the explicit revoke event. */
  readonly audit: AuditContext;
  readonly now?: Date;
}

/** A revoked grant as the route returns it: the grant, and whether another supervisor's grant still lifts the same clinician. */
export interface RevokedClosureOverride {
  readonly override: ClosureOverrideView;
  /** The latest expiry of any OTHER active grant for the same clinician and kind; null when the revoke re-blocks them. */
  readonly remainingActiveUntil: Date | null;
}

async function readOverride(
  tx: DbClient,
  organizationId: string,
  overrideId: string,
): Promise<ClosureOverrideView | undefined> {
  const [row] = await tx
    .select(viewColumns)
    .from(O)
    .where(and(eq(O.id, overrideId), eq(O.organizationId, organizationId)))
    .limit(1);
  return row;
}

/**
 * Stamp the two revocation columns once. Returns the stored row and whether THIS call revoked it: an UPDATE that matched nothing
 * (a concurrent revoke won the row) returns the row as stored, never a guess.
 */
async function stampRevocation(
  tx: DbClient,
  input: RevokeClosureOverrideInput,
  asOf: Date,
): Promise<{ readonly stored: ClosureOverrideView; readonly revokedNow: boolean }> {
  const [revoked] = await tx
    .update(O)
    .set({ revokedAt: asOf, revokedByMembershipId: input.revokedByMembershipId })
    .where(
      and(
        eq(O.id, input.overrideId),
        eq(O.organizationId, input.organizationId),
        isNull(O.revokedAt),
      ),
    )
    .returning(viewColumns);
  if (revoked) return { stored: revoked, revokedNow: true };
  const stored = await readOverride(tx, input.organizationId, input.overrideId);
  if (!stored) throw new NotFoundError("closure override", input.overrideId);
  return { stored, revokedNow: false };
}

/**
 * Revoke a grant by stamping the two revocation columns (the only columns the application role may UPDATE). The UPDATE's
 * RETURNING row is what comes back, so the response is the stored row. Idempotent: an already-revoked grant (or one a concurrent
 * revoke won) is returned as stored and writes no second audit event. An id outside the organization is a 404 (RLS hides it, the
 * predicate says so too). The response also says whether another active grant still lifts the clinician.
 */
export async function revokeClosureOverride(
  tx: DbClient,
  input: RevokeClosureOverrideInput,
): Promise<RevokedClosureOverride> {
  const existing = await readOverride(tx, input.organizationId, input.overrideId);
  if (!existing) throw new NotFoundError("closure override", input.overrideId);
  assertMayRevoke({
    grantedByMembershipId: existing.grantedByMembershipId,
    revokedByMembershipId: input.revokedByMembershipId,
    locationIds: input.locationIds,
  });
  const asOf = input.now ?? new Date();
  const { stored, revokedNow } =
    existing.revokedAt === null
      ? await stampRevocation(tx, input, asOf)
      : { stored: existing, revokedNow: false };
  if (revokedNow) await auditRevoke(tx, input, stored);
  return {
    override: stored,
    remainingActiveUntil: await remainingActiveUntil(
      tx,
      {
        organizationId: input.organizationId,
        subjectMembershipId: stored.subjectMembershipId,
        obligationKind: stored.obligationKind,
        exceptOverrideId: stored.id,
      },
      asOf,
    ),
  };
}

async function auditRevoke(
  tx: DbClient,
  input: RevokeClosureOverrideInput,
  revoked: ClosureOverrideView,
): Promise<void> {
  await audit(tx, input.audit, {
    eventType: CLOSURE_OVERRIDE_REVOKED_AUDIT_EVENT,
    resourceKind: OVERRIDE_RESOURCE_KIND,
    resourceId: revoked.id,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: {
      overrideId: revoked.id,
      subjectMembershipId: revoked.subjectMembershipId,
      grantedByMembershipId: revoked.grantedByMembershipId,
      revokedByMembershipId: input.revokedByMembershipId,
      obligationKind: revoked.obligationKind,
      expiresAt: revoked.expiresAt.toISOString(),
      revokedAt: revoked.revokedAt?.toISOString() ?? null,
    },
  });
}
