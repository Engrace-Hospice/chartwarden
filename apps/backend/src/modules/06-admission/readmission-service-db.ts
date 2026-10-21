// apps/backend/src/modules/06-admission/readmission-service-db.ts — the Drizzle side of the readmission workflow:
//
//   • `resolveFirstBenefitPeriod` — the ONE place a NEW admission's first benefit period is decided (direct intake,
//     referral conversion, readmission). It used to be hard-wired to sequence 1; now it is the staff-entered number
//     (validated) or, absent one, our own history's suggestion (intake/benefit-period.ts), with how it was
//     established recorded on the period (migration 0373).
//   • `createDbReadmissionService` — the read behind the readmission / new-admission screens (BenefitPeriodPlan).
//
// The prior election's NOTR / final-claim status is an M23 fact: it is read through the injected
// `PriorElectionClosurePort` AFTER the M6 transaction closes (one connection at a time), and reported `unknown` when
// the port is unbound or fails — the plan never guesses "filed".
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { LocalDate } from "@chartwarden/types";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { DEFAULT_ORG_TIME_ZONE, localDateOfInstant } from "./certification/window-math";
import {
  type BenefitPeriodEntry,
  type BenefitPeriodSource,
  assertBenefitPeriodEntry,
  assertF2fExceptionReason,
  suggestBenefitPeriod,
} from "./intake/benefit-period";
import { type PriorElectionClosureFacts, buildBenefitPeriodPlan } from "./intake/readmission-plan";
import type { PriorElectionClosurePort, ReadmissionService } from "./routes/readmission-service";
import type { BenefitPeriodPlan, BenefitPeriodPlanQuery } from "./routes/readmission-typebox";
import type { FirstBenefitPeriodInput } from "./routes/service";
import {
  type PriorEpisode,
  latestLiveEndedEpisode,
  loadPriorEpisodes,
} from "./seams/prior-episodes";
import { electionPeriodKindForSequence } from "./state-machines/election-period";
import { AdmissionStateError } from "./state-machines/errors";

const ADM = schema.admissions;
const OPEN_EXCLUDED = ["discharged", "bereavement", "closed"] as const;

/** Today, org-local (the date a staff member would read off a calendar). */
export function orgToday(now: Date = new Date()): LocalDate {
  return localDateOfInstant(now.toISOString(), DEFAULT_ORG_TIME_ZONE);
}

/** The first-period columns `election_period` is inserted with, plus the admission's planned date. */
export interface FirstBenefitPeriodPlan {
  readonly sequence: number;
  readonly periodValues: {
    readonly sequenceNumber: number;
    readonly periodKind: "ninety_day" | "sixty_day";
    readonly benefitPeriodSource: BenefitPeriodSource;
    readonly benefitPeriodSuggested: number;
    readonly benefitPeriodConfirmedBy: string | null;
    readonly benefitPeriodConfirmedOn: string | null;
    readonly f2fExceptionReason: string | null;
    readonly f2fExceptionDocumentedBy: string | null;
    readonly f2fExceptionDocumentedAt: Date | null;
  };
  /** The planned admission date as the `admission.admission_at` instant (`null` when not given). It also anchors a
   *  period-3+ first period's F2F window (`resolvePeriodF2fWindowStart` falls back to it), so a later correction of
   *  the admission date moves the window with it. */
  readonly admissionAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorOrNull = (actorUserId: string): string | null =>
  UUID.test(actorUserId) ? actorUserId : null;

function readmissionSourceInvalid(message: string): never {
  throw new AdmissionStateError("READMISSION_SOURCE_INVALID", message, [
    { field: "readmittedFromAdmissionId", code: "READMISSION_SOURCE_INVALID", message },
  ]);
}

/**
 * Decide (and validate) a NEW admission's first benefit period, inside the creating transaction (RLS-scoped `tx`).
 * Throws a field-scoped 422 for a malformed entry and a 409 READMISSION_SOURCE_INVALID when the readmission names
 * an admission that is not an earlier, live-ended stay of the same patient.
 */
export async function resolveFirstBenefitPeriod(
  tx: DbClient,
  args: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly input: FirstBenefitPeriodInput & { readonly readmittedFromAdmissionId?: string };
    readonly actorUserId: string;
    readonly now: Date;
  },
): Promise<FirstBenefitPeriodPlan> {
  const today = orgToday(args.now);
  const episodes = await loadPriorEpisodes(tx, args.organizationId, args.patientId);
  const fromId = args.input.readmittedFromAdmissionId;
  if (fromId) {
    const from = episodes.find((e) => e.admissionId === fromId);
    if (!from)
      readmissionSourceInvalid(
        "The admission readmitted from must be an earlier, discharged admission of the same patient",
      );
    if (from.endKind === "death")
      readmissionSourceInvalid("A stay that ended in death cannot be readmitted");
  }
  const suggestion = suggestBenefitPeriod(episodes);
  const entry: BenefitPeriodEntry = args.input.benefitPeriod ?? {
    sequence: suggestion.suggestedSequence,
    source: "internal_history",
  };
  assertBenefitPeriodEntry(entry, today);
  const exceptionReason = args.input.f2fException?.reason;
  assertF2fExceptionReason(exceptionReason, entry.sequence);
  const actor = actorOrNull(args.actorUserId);
  const admissionDate = args.input.admissionDate ?? null;
  return {
    sequence: entry.sequence,
    periodValues: {
      sequenceNumber: entry.sequence,
      periodKind: electionPeriodKindForSequence(entry.sequence),
      benefitPeriodSource: entry.source,
      benefitPeriodSuggested: suggestion.suggestedSequence,
      benefitPeriodConfirmedBy: actor,
      benefitPeriodConfirmedOn:
        entry.source === "hets_confirmed" ? (entry.confirmedOn ?? null) : null,
      f2fExceptionReason: exceptionReason?.trim() ?? null,
      f2fExceptionDocumentedBy: exceptionReason ? actor : null,
      f2fExceptionDocumentedAt: exceptionReason ? args.now : null,
    },
    admissionAt: admissionDate ? new Date(`${admissionDate}T00:00:00.000Z`) : null,
  };
}

async function closureOf(
  port: PriorElectionClosurePort | undefined,
  organizationId: string,
  episode: PriorEpisode | null,
): Promise<PriorElectionClosureFacts | null | undefined> {
  if (!episode) return undefined;
  if (!port) return null;
  try {
    return await port.closureFor(organizationId, {
      admissionId: episode.admissionId,
      patientId: episode.patientId,
    });
  } catch {
    return null; // reported as `unknown`, never as filed
  }
}

export function createDbReadmissionService(
  db: DbClient,
  closurePort?: PriorElectionClosurePort,
  now: () => Date = () => new Date(),
): ReadmissionService {
  async function planFor(
    organizationId: string,
    patientId: string,
    query: BenefitPeriodPlanQuery,
    facts: {
      readonly episodes: readonly PriorEpisode[];
      readonly openAdmissionExists: boolean;
      readonly readmitFrom?: { admissionId: string; state: string };
      readonly newerAdmissionExists?: boolean;
    },
  ): Promise<BenefitPeriodPlan> {
    const closure = await closureOf(
      closurePort,
      organizationId,
      latestLiveEndedEpisode(facts.episodes),
    );
    return buildBenefitPeriodPlan({
      patientId,
      ...facts,
      closure,
      startDate: query.startDate ?? orgToday(now()),
      ...(query.sequence ? { sequence: query.sequence } : {}),
    });
  }

  async function openAdmissionExists(
    tx: DbClient,
    organizationId: string,
    patientId: string,
  ): Promise<boolean> {
    const [open] = await tx
      .select({ id: ADM.id })
      .from(ADM)
      .where(
        and(
          eq(ADM.organizationId, organizationId),
          eq(ADM.patientId, patientId),
          notInArray(ADM.status, [...OPEN_EXCLUDED]),
        ),
      )
      .limit(1);
    return !!open;
  }

  return {
    async getReadmissionContext(organizationId, admissionId, query) {
      const facts = await withOrgContext(db, { organizationId, userId: "" }, async (raw) => {
        const tx = raw as DbClient;
        const [adm] = await tx
          .select({
            id: ADM.id,
            patientId: ADM.patientId,
            status: ADM.status,
            createdAt: ADM.createdAt,
          })
          .from(ADM)
          .where(and(eq(ADM.organizationId, organizationId), eq(ADM.id, admissionId)))
          .limit(1);
        if (!adm) return null;
        const [newer] = await tx
          .select({ id: ADM.id })
          .from(ADM)
          .where(
            and(
              eq(ADM.organizationId, organizationId),
              eq(ADM.patientId, adm.patientId),
              ne(ADM.id, adm.id),
              // Compared in SQL: the JS Date round-trip drops the column's microseconds.
              sql`${ADM.createdAt} > (SELECT a.created_at FROM admission a WHERE a.id = ${adm.id})`,
              inArray(ADM.status, [...OPEN_EXCLUDED]),
            ),
          )
          .limit(1);
        return {
          patientId: adm.patientId,
          readmitFrom: { admissionId: adm.id, state: String(adm.status) },
          episodes: await loadPriorEpisodes(tx, organizationId, adm.patientId),
          openAdmissionExists: await openAdmissionExists(tx, organizationId, adm.patientId),
          newerAdmissionExists: !!newer,
        };
      });
      if (!facts) return null;
      return planFor(organizationId, facts.patientId, query, facts);
    },
    async getPatientBenefitPeriodPlan(organizationId, patientId, query) {
      const facts = await withOrgContext(db, { organizationId, userId: "" }, async (raw) => {
        const tx = raw as DbClient;
        return {
          episodes: await loadPriorEpisodes(tx, organizationId, patientId),
          openAdmissionExists: await openAdmissionExists(tx, organizationId, patientId),
        };
      });
      return planFor(organizationId, patientId, query, facts);
    },
  };
}
