// apps/backend/src/modules/08-encounters/closure/override-service.ts — the supervisor override of the closure block (ADR-0113 D7).
//
// A supervisor lifts ONLY the block for one clinician and one obligation kind for at most 24 hours (default 4). Alerts, deadlines
// and the policy are unchanged, and it does not satisfy the late-entry override routes. The table is append-only for the
// application role: this service INSERTs a grant, stamps the two revocation columns on revoke, and never deletes. The reason is
// free text a supervisor typed (>= 40 chars): the row trigger scrubs it from its audit row, and the explicit audit event below
// never carries it at all.
//
// The caller's transaction (`withOrgContext`) is taken as-is so RLS scopes every row and the audit write is atomic with the grant.
import { type AuditContext, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import {
  ACTIVE_DOCUMENTATION_OBLIGATION_KINDS,
  CLOSURE_OVERRIDE_DEFAULT_HOURS,
  CLOSURE_OVERRIDE_MAX_HOURS,
  CLOSURE_OVERRIDE_MIN_REASON_CHARS,
  type DocumentationObligationKind,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { and, desc, eq, isNull } from "drizzle-orm";

/** The explicit audit event a grant writes (catalogued in `M8_ACTION_CATALOG`); the row trigger records the row change too. */
export const CLOSURE_OVERRIDE_AUDIT_EVENT = "m8.encounter.closure_override_granted";

const MIN_OVERRIDE_HOURS = 1;
const MS_PER_HOUR = 3_600_000;

const O = schema.documentationObligationOverrides;
const M = schema.memberships;

/** A grant as the routes and the gate see it. The free-text reason is deliberately absent. */
export interface ClosureOverrideView {
  readonly id: string;
  readonly subjectMembershipId: string;
  readonly grantedByMembershipId: string;
  readonly obligationKind: DocumentationObligationKind;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

const viewColumns = {
  id: O.id,
  subjectMembershipId: O.subjectMembershipId,
  grantedByMembershipId: O.grantedByMembershipId,
  obligationKind: O.obligationKind,
  grantedAt: O.grantedAt,
  expiresAt: O.expiresAt,
  revokedAt: O.revokedAt,
};

function refuse(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

/** The ONE definition of "active": not revoked, and `asOf` is strictly before `expires_at`. SQL only narrows to unrevoked rows. */
export function isOverrideActive(
  override: Pick<ClosureOverrideView, "expiresAt" | "revokedAt">,
  asOf: Date,
): boolean {
  return override.revokedAt === null && asOf.getTime() < override.expiresAt.getTime();
}

export interface GrantClosureOverrideInput {
  readonly organizationId: string;
  readonly subjectMembershipId: string;
  readonly grantedByMembershipId: string;
  readonly obligationKind: DocumentationObligationKind;
  readonly reason: string;
  /** 1..24, default 4. */
  readonly hours?: number;
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
 * Grant a closure override. Validates before any IO, requires an active subject in the organization, INSERTs the grant (the DB
 * CHECKs repeat the self-grant, reason and 24h rules) and writes the explicit audit event on the same transaction.
 */
export async function grantClosureOverride(
  tx: DbClient,
  input: GrantClosureOverrideInput,
): Promise<ClosureOverrideView> {
  const { reason, hours } = validatedGrant(input);
  await assertActiveSubject(tx, input.organizationId, input.subjectMembershipId);
  const now = input.now ?? new Date();
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
    resourceKind: "documentation_obligation_override",
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
  });
  return created;
}

export interface RevokeClosureOverrideInput {
  readonly organizationId: string;
  readonly overrideId: string;
  readonly revokedByMembershipId: string;
  readonly now?: Date;
}

/**
 * Revoke a grant by stamping the two revocation columns (the only columns the application role may UPDATE). Idempotent: an
 * already-revoked grant is returned unchanged. An id outside the organization is a 404 (RLS hides it, the predicate says so too).
 */
export async function revokeClosureOverride(
  tx: DbClient,
  input: RevokeClosureOverrideInput,
): Promise<ClosureOverrideView> {
  const [existing] = await tx
    .select(viewColumns)
    .from(O)
    .where(and(eq(O.id, input.overrideId), eq(O.organizationId, input.organizationId)))
    .limit(1);
  if (!existing) throw new NotFoundError("closure override", input.overrideId);
  if (existing.revokedAt !== null) return existing;
  const revokedAt = input.now ?? new Date();
  await tx
    .update(O)
    .set({ revokedAt, revokedByMembershipId: input.revokedByMembershipId })
    .where(
      and(
        eq(O.id, input.overrideId),
        eq(O.organizationId, input.organizationId),
        isNull(O.revokedAt),
      ),
    );
  return { ...existing, revokedAt };
}

/**
 * The clinician's active override for `kind` at `asOf`, or null. SQL returns the unrevoked grant that expires last (the
 * `documentation_obligation_override_active_idx` partial index); {@link isOverrideActive} decides whether it still counts.
 */
export async function findActiveOverride(
  tx: DbClient,
  organizationId: string,
  membershipId: string,
  kind: DocumentationObligationKind,
  asOf: Date,
): Promise<ClosureOverrideView | null> {
  const [latest] = await tx
    .select(viewColumns)
    .from(O)
    .where(
      and(
        eq(O.organizationId, organizationId),
        eq(O.subjectMembershipId, membershipId),
        eq(O.obligationKind, kind),
        isNull(O.revokedAt),
      ),
    )
    .orderBy(desc(O.expiresAt))
    .limit(1);
  return latest && isOverrideActive(latest, asOf) ? latest : null;
}
