// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m6-election-period-started.ts — the NOE
// draft, and the first thing that has ever written `noe_record` (F-106 / #103).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// The Notice of Election is the filing that tells Medicare a beneficiary has elected the hospice benefit.
// CMS requires it within FIVE CALENDAR DAYS of the election effective date; miss the window and the
// hospice forfeits payment for every day from the election start until the NOE is actually accepted
// (42 CFR 418.24(b), CR 8877). `noe_record.window_target_at` carries that deadline and its schema comment
// spells the arithmetic out — `= electionEffectiveDate + 5 days`.
//
// **`NoeRepository.create` had no caller anywhere in the repository** — not in production code, not in a
// single test — and `schema.noeRecord` is referenced only by M23's ABAC resolver and its eraser. Nor is
// there a route: `/api/v1/noe-records` is a GET list, and the only POSTs are `/:id/submit` and
// `/:id/cancel`, both of which load an existing row. So no Notice of Election has ever been created in any
// deployment, the 5-day watchdog cron (`noe_window_watch_idx`) has always scanned an empty table, and the
// NOE worklist screen has always been empty. The M16 `bereavement_plan` and M15 `discipline_care_plan`
// finding again: the consumer is the only creation path BY DESIGN, and it did not exist.
//
// `consumers/index.ts` explains the absence as "the live inbound dispatcher is a later platform phase".
// That dispatcher landed; the reason had expired, the `isPlatformOperator` shape.
//
// ── WHY THIS SUBSCRIBES TO `period_started` AND NOT `election.signed` ────────────────────────────────
//
// M23's §4.4 subscription map routes `create_noe_draft` off `m6.election.signed`. **The facts are not
// there yet at that moment.** `noe_record.election_effective_date` and `window_target_at` are both NOT
// NULL, and the election's effective date lives in exactly one place — `election_period.effective_at` —
// which is written by the `setActive` transition at ADMISSION ACTIVATION and by nothing else.
// `election_statement` carries only `signed_at`. In M6's own flow the statement is signed BEFORE the
// admission activates, so at `m6.election.signed` the anchor is NULL and a draft cannot be dated.
//
// `m6.election.period_started` is emitted from the same transaction that writes `effective_at`, already
// declares `m23`, and its own payload schema says a consumer that needs the window "can read it from
// `electionPeriodId` via the M6 seam once the seed path actually stores it" — which F-042 made true. The
// sibling event carries the fact, which is the F-101 shape exactly. `m23` is therefore dropped from
// `m6.election.signed`'s `declaredConsumers`: it is a ROUTING input, and M23 does not consume that topic.
//
// SEQUENCE 1 ONLY. An NOE is filed once per hospice election, not once per benefit period — a
// recertification into period 2 or 3 continues the same election and files no new notice.
// `noe_record_admission_uq` (one live NOE per admission) is the structural backstop; the sequence check is
// what keeps a recert from attempting a second insert at all.
//
// The event name is a STRING literal and no M6 schema is imported; the admission facts arrive through an
// INJECTED port the composition root binds to M6's org-explicit `electionPeriodContextForOrg`.
import { deriveControlNumber, repositories } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BillingDb, WriteOutboxPort } from "../services/claim-state-service";

/** The event M23 drafts the NOE from, and the `(eventId, consumerName)` receipt identity. */
export const M23_NOE_DRAFT_CONSUMER = {
  eventName: "m6.election.period_started",
  consumerName: "m23.m6-election-period-started",
} as const;

/** §2.2 / 42 CFR 418.24(b) — the NOE filing window, in calendar days from the election effective date. */
export const NOE_FILING_WINDOW_DAYS = 5;

/** The M6-owned election-period facts the draft needs, org-explicit (see the file header). */
export type ElectionPeriodResolver = (
  organizationId: string,
  electionPeriodId: string,
) => Promise<{
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly sequenceNumber: number;
  readonly effectiveAt: string | null;
  /** The period starts the admission's election (period 1, or a readmission's continuing period). Absent → the
   *  legacy `sequenceNumber === 1` rule. */
  readonly isElectionStart?: boolean;
} | null>;

/** The 6-char CCN the D4 control number is derived from. M23 may not import M40, so this is a PORT —
 *  the same `ProviderCcnPort` the composition root already binds for the claim write service. */
export type CcnResolver = (organizationId: string, providerEntityId: string) => Promise<string>;

export interface M23NoeDraftConsumerDeps {
  readonly db: BillingDb;
  /** The catalog-validating `m23` tx publisher — `m23.noe.draft_created` is emitted on the insert's own
   *  transaction, so a draft cannot exist without its announcement. */
  readonly outbox: WriteOutboxPort;
  readonly resolveElectionPeriod: ElectionPeriodResolver;
  readonly resolveCcn: CcnResolver;
  /** Sink for a delivery that deliberately wrote nothing (a recert, or a redelivery). A skip is a SETTLED
   *  decision — the outbox row completes — so without this it would be silent. Not the DLQ path. */
  readonly onSkipped?: (info: {
    readonly reason: "not_first_period" | "already_drafted";
    readonly organizationId: string;
    readonly electionPeriodId: string;
  }) => void;
}

/** `effectiveAt + 5 days` as a `yyyy-mm-dd`. Calendar days, per CR 8877 — not business days. */
export function noeWindowTargetAt(electionEffectiveDate: string): string {
  const ms = Date.parse(`${electionEffectiveDate}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new RangeError(`noeWindowTargetAt: malformed date '${electionEffectiveDate}'`);
  }
  return new Date(ms + NOE_FILING_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * M23's live NOE-draft binding (§4.4, task 47).
 *
 * Idempotent at three levels: the dispatcher's `(eventId, consumerName)` receipt, the
 * `findActiveByAdmission` pre-read, and `noe_record_admission_uq` — the partial unique index over the
 * non-terminal states, which is the structural backstop a pre-read cannot be (it races a concurrent
 * redelivery). A cancelled or rejected NOE is deliberately outside that index, so a re-elected patient
 * whose first notice was rejected can be drafted again.
 */
export function buildM23NoeDraftConsumer(deps: M23NoeDraftConsumerDeps) {
  return {
    consumerName: M23_NOE_DRAFT_CONSUMER.consumerName,
    consumerModule: "m23" as const,
    eventTypes: [M23_NOE_DRAFT_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const electionPeriodId = stringField(event.payload, "electionPeriodId");
      if (electionPeriodId === null) {
        throw new Error(`${M23_NOE_DRAFT_CONSUMER.consumerName}: payload has no electionPeriodId`);
      }
      const organizationId = event.organizationId;

      const period = await deps.resolveElectionPeriod(organizationId, electionPeriodId);
      if (period === null) {
        throw new Error(
          `${M23_NOE_DRAFT_CONSUMER.consumerName}: election period ${electionPeriodId} not found in org`,
        );
      }

      // An NOE is filed once per election, not per benefit period — a recert continues the same election. A
      // re-election (readmission) is a NEW election in the next available period (42 CFR 418.24), so it is drafted
      // whatever its sequence; M6 says which period starts an election.
      if (!(period.isElectionStart ?? period.sequenceNumber === 1)) {
        deps.onSkipped?.({ reason: "not_first_period", organizationId, electionPeriodId });
        return;
      }

      // Both are NOT NULL on the row and one of them IS the CMS deadline. A period that reports no
      // effective date has not actually started, which contradicts the event — fail the delivery rather
      // than date a federal filing from a guess.
      const electionEffectiveDate = period.effectiveAt;
      if (electionEffectiveDate === null) {
        throw new Error(
          `${M23_NOE_DRAFT_CONSUMER.consumerName}: election period ${electionPeriodId} started with no effective date`,
        );
      }
      if (period.providerEntityId === null) {
        throw new Error(
          `${M23_NOE_DRAFT_CONSUMER.consumerName}: admission ${period.admissionId} has no provider entity to bill under`,
        );
      }
      const providerEntityId = period.providerEntityId;
      const ccn = await deps.resolveCcn(organizationId, providerEntityId);

      await withOrgContext(deps.db as never, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as BillingDb;
        const noes = new repositories.NoeRepository(tx);
        if (await noes.findActiveByAdmission(period.admissionId)) {
          deps.onSkipped?.({ reason: "already_drafted", organizationId, electionPeriodId });
          return;
        }

        const windowTargetAt = noeWindowTargetAt(electionEffectiveDate);
        // The D4 deterministic control number. `electionPeriodId` is the aggregate identity here (the
        // draft has no id until the insert returns), which keeps the number reproducible for the same
        // election on a redelivery rather than drifting per attempt.
        const noeControlNumber = deriveControlNumber({
          ccn,
          serviceFrom: electionEffectiveDate,
          claimId: electionPeriodId,
          attemptIndex: 0,
        });

        const created = await noes.create({
          organizationId,
          providerEntityId,
          patientId: period.patientId,
          admissionId: period.admissionId,
          electionPeriodId,
          electionEffectiveDate,
          windowTargetAt,
          noeControlNumber,
        });

        await deps.outbox.publish(tx, {
          eventName: "m23.noe.draft_created",
          organizationId,
          aggregateKind: "noe_record",
          aggregateId: created.id,
          payload: {
            noeId: created.id,
            providerEntityId,
            admissionId: period.admissionId,
            electionEffectiveDate,
            windowTargetAt,
          },
        });
      });
    },
  };
}
