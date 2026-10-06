// apps/backend/src/modules/20-field-safety/jobs/worker-support.ts — the dep bag and tenancy plumbing every
// §4.8 M20 cron shares (the SOS SLA watchdog, the overdue detector, the coverage-gap watchdog).
//
// Split out of `cron-workers.ts` so the three worker bodies can each import it without importing each
// other (cron-workers.ts imports the bodies to construct the BullMQ Workers; a body importing back from
// cron-workers.ts would be a cycle).
import type { DbClient } from "@wardenx/db";
import type { SafetyPolicyProvider } from "@wardenx/types";
import type { ConnectionOptions } from "bullmq";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";

/** The system actor id every M20 cron stamps on its per-org `withOrgContext` tx. Empty, not a real UUID:
 *  the M4 write-audit trigger on the safety tables reads the ambient acting-user variable and casts it to
 *  `actor_user_id`, which has a NOT-NULL FK to `user`; an empty string reads back as SQL NULL, which the FK
 *  accepts — a system-driven transition names no actor (§3.3). Mirrors `consumers/m36-delivery-failed.ts`. */
export const M20_WORKER_SYSTEM_USER_ID = "";

/** The M2 active-org enumerator the cron fan-out reads (the M9/M6 `ActiveOrgListPort` shape, restated
 *  locally so this module takes no bootstrap import edge). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. `outbox` and `policy` are REQUIRED — the crons cannot decide
 *  anything without the pinned policy, and cannot record a decision without the outbox; only `activeOrgs`
 *  gets the lazy fail-closed thunk (the M9/M7 convention). No `alerts` port, matching every other M20
 *  outbox producer at the composition root: the §4.10 alert events ride the OUTBOX and M36 resolves
 *  recipients through its own seam. */
export interface M20WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly policy: SafetyPolicyProvider;
  readonly alerts?: AlertPort;
  readonly activeOrgs?: ActiveOrgListPort;
  /** The location's IANA timezone, read through M1's `FoundationSiteReader` (M20 reads no M1 table). Null =
   *  the id does not resolve. Unbound/null makes the overdue detector's `afterHours` default to true. */
  readonly locationTimezone?: (tx: DbClient, locationId: string) => Promise<string | null>;
  now?: () => Date;
}

export function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M20_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

export function activeOrgsOf(deps: M20WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unbound(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the cron fan-out source) under withPlatformContext",
        ),
    }
  );
}

/** Structured-ish logger the standalone worker functions share (M9's `runReassessmentDueCron` precedent). */
export function logM20Cron(msg: string, meta: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- cron workers log via console; the structured logger lives at the route layer.
  console.log(msg, meta);
}
