// apps/backend/src/modules/08-encounters/closure/refusal-audit.ts — the audit event of a closure-gate refusal (ADR-0113 D6, CW-AC-47).
//
// The gate (bootstrap/note-closure-gate.ts, M1 code that imports nothing from a module) refuses a blocked clinician 403 NOTE_CLOSURE_REQUIRED on every
// non-allowlisted call. Until now that was a throttled per-organization log line and an unlabelled counter, so no refusal could be tied to a member.
// The gate hands this writer one refusal per member per minute (it counts the rest into `refused`); this writes the `m8.encounter.closure_refused`
// event on its OWN transaction under the member's tenant context (the refused request has no transaction of its own to join), ids and counts only.
// Best effort and never throwing: a failure goes to `onFailure` (error class only, a database error's message can carry arbitrary text) and the
// caller still answers its 403.
import { randomUUID } from "node:crypto";
import { audit } from "@chartwarden/audit";
import { type DbClient, runOutsideCommitTracker } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";

/** The explicit audit event of a refusal (catalogued in `M8_ACTION_CATALOG`). */
export const CLOSURE_REFUSED_AUDIT_EVENT = "m8.encounter.closure_refused";

/** What the gate reports of one refused member (`NoteClosureMemberRefusal`, restated here so this module imports nothing from bootstrap). */
export interface ClosureRefusalFacts {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly encounterId: string | null;
  readonly overdueCount: number;
  readonly method: string | null;
  readonly routeTemplate: string | null;
  readonly refused: number;
}

const REFUSED_RESOURCE_KIND = "encounter";

/**
 * Writes the refusal's audit event on its own transaction. Never throws.
 *
 * It runs OUTSIDE the request's commit tracker (CW-AC-36): the EVV offline-sync routes ask the gate from inside their handler, after the
 * Idempotency-Key claim, and a committed audit write counted against that request would make the idempotency middleware cache the retryable
 * 403 instead of releasing the key, so a same-key retry after the clinician closed the note would replay the refusal for 24 hours. The audit
 * write is a record about the refusal, not part of the guarded write, so the request must not own it (and, unowned, it is not fenced either).
 */
export async function recordClosureRefusal(
  db: DbClient,
  refusal: ClosureRefusalFacts,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await runOutsideCommitTracker(() =>
      withOrgContext(db, { organizationId: refusal.organizationId, userId: refusal.userId }, (tx) =>
        audit(
          tx as unknown as DbClient,
          {
            organizationId: refusal.organizationId,
            userId: refusal.userId,
            correlationId: randomUUID(),
          },
          {
            eventType: CLOSURE_REFUSED_AUDIT_EVENT,
            resourceKind: REFUSED_RESOURCE_KIND,
            ...(refusal.encounterId === null ? {} : { resourceId: refusal.encounterId }),
            outcome: "denied",
            severity: "warn",
            retentionClass: "compliance",
            context: {
              membershipId: refusal.membershipId,
              method: refusal.method,
              routeTemplate: refusal.routeTemplate,
              overdueCount: refusal.overdueCount,
              refused: refusal.refused,
            },
          },
        ),
      ),
    );
  } catch (error) {
    onFailure(error);
  }
}
