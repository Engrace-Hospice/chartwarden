// apps/backend/src/modules/19-oncall/jobs/triage-cron-common.ts — the scaffolding the four non-Tier-1 §4.8
// crons share (`callback-sla`, `awaiting-callback-timeout`, `close-documented`, `escalation-sla`): the org
// fan-out, the per-item transaction loop, and the "one failure never stops the rest" rule. Same shape as
// `shift-cron.ts` / `coverage-gap-watchdog.ts` (the Tier-1 pair), factored because four crons repeat it.
//
// EVERY ITEM IS ITS OWN ORG-SCOPED TRANSACTION. The candidate ids are read in one short transaction, then each
// call/escalation is locked (`FOR UPDATE`), re-checked and written in its own, so one row's failure rolls back
// only that row and a concurrent route that moved it first turns the item into a skip, not an error. The
// system actor is the typed NULL actor (`userId: ""` + `systemActor: true`, the M33/M16/M19-encounter-signed
// precedent): the audit trigger's actor FK targets "user", so no fabricated id.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant } from "@chartwarden/types";
import type { TriageCallFacts } from "../lifecycle/triage-call";
import type { WriteOutboxPort } from "../routes/write-service";
import type { ActiveOrgListPort } from "./worker";

/** The most calls/escalations one org's tick will act on; the rest drain on the next tick, oldest first. */
export const MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK = 100;

const MS_PER_MINUTE = 60_000;

export interface M19TriageCronDeps {
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  /** The real catalog-validating publisher (`callerModule` pinned to `m19`) — never `NOOP_OUTBOX`. */
  readonly outbox: WriteOutboxPort;
  now?: () => Date;
}

export interface TriageCronOrgResult {
  readonly acted: number;
  readonly skipped: number;
}

export type TriageCronItemOutcome = "acted" | "skipped";

/** The org context every item runs under: the typed system actor, scoped to one explicit org. */
export const triageCronContext = (organizationId: string) => ({
  organizationId,
  userId: "",
  systemActor: true as const,
});

export const iso = (d: Date): IsoInstant => d.toISOString() as IsoInstant;

export const minutesBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_MINUTE);

/** One `triage_call` row as the call machine's facts. */
export function callFactsOf(row: {
  state: string;
  version: number;
  selectedProtocolId: string | null;
  linkedEncounterId: string | null;
  firstResponseAt: Date | null;
  documentedAt: Date | null;
  paperOriginFlag: boolean;
}): TriageCallFacts {
  return {
    state: row.state as TriageCallFacts["state"],
    version: row.version,
    selectedProtocolId: row.selectedProtocolId,
    linkedEncounterId: row.linkedEncounterId,
    firstResponseAt: row.firstResponseAt === null ? null : iso(row.firstResponseAt),
    documentedAt: row.documentedAt === null ? null : iso(row.documentedAt),
    paperOriginFlag: row.paperOriginFlag,
  };
}

/** The §4.10 payload base every call-scoped `m19.triage_call.*` event carries. */
export const callEventBase = (
  call: { organizationId: string; providerEntityId: string; id: string },
  at: Date,
) => ({
  orgId: call.organizationId,
  providerEntityId: call.providerEntityId,
  triageCallId: call.id,
  occurredAt: iso(at),
});

/**
 * Act on each candidate id in its OWN org transaction; collect (never swallow) per-item failures and throw
 * them together once the whole list has been tried, so one bad row does not hide the rest of the backlog.
 */
export async function processOrgItems(
  deps: M19TriageCronDeps,
  input: {
    readonly label: string;
    readonly organizationId: string;
    readonly ids: readonly string[];
    readonly one: (tx: DbClient, id: string) => Promise<TriageCronItemOutcome>;
  },
): Promise<TriageCronOrgResult> {
  const failures: unknown[] = [];
  let acted = 0;
  let skipped = 0;
  for (const id of input.ids) {
    try {
      const outcome = await withOrgContext(
        deps.db,
        triageCronContext(input.organizationId),
        (handle) => input.one(handle as DbClient, id),
      );
      if (outcome === "acted") acted++;
      else skipped++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${input.label}: ${failures.length} item(s) failed for org ${input.organizationId}`,
    );
  }
  return { acted, skipped };
}

/** Run `perOrg` for every active org; one org's failure is collected and rethrown after the rest ran. */
export async function runForEachActiveOrg(
  deps: M19TriageCronDeps,
  label: string,
  perOrg: (organizationId: string, now: Date) => Promise<TriageCronOrgResult>,
): Promise<ReadonlyMap<string, TriageCronOrgResult>> {
  const now = (deps.now ?? (() => new Date()))();
  const results = new Map<string, TriageCronOrgResult>();
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      results.set(organizationId, await perOrg(organizationId, now));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${label}: ${failures.length} org failure(s)`);
  }
  return results;
}
