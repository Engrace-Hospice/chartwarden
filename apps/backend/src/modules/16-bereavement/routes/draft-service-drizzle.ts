// apps/backend/src/modules/16-bereavement/routes/draft-service-drizzle.ts — the Drizzle-backed pre-death draft service
// (ADR-0109 D5, routes 35 / 36).
//
// Everything that needs a cross-module seam runs BEFORE the transaction opens (a seam call inside our own tx self-deadlocks the
// pool — M21-T05): the admission's patient and siting come from M6's `AdmissionStatusReader`, the Part 2 disclosure verdict from
// M39. Inside the transaction the write checks that no plan exists for the admission (409 `DRAFT_LOCKED`) and applies the
// `If-Match` version, so a draft can never be edited after the plan that consumed it opened. A first write names version 0.
import { factorsToWire } from "@chartwarden/bereavement";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { AdmissionStatusReader, IsoInstant } from "@chartwarden/types";
import { NotFoundError } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { disciplineForRoleKeys } from "../abac-predicates";
import {
  BereavementStateError,
  assertDraftWritable,
  checkVersion,
  draftFactorsForReader,
  draftFactorsForStorage,
} from "../lifecycle/index";
import { getAdmissionStatusReader } from "../seams/consumed";
import type { M16ReadActor, M16WriteActor } from "./actor";
import {
  type BereavementDisclosurePort,
  resolveBereavementDisclosure,
  seamBereavementDisclosurePort,
} from "./disclosure";
import type { M16DraftService, PreDeathDraftView, PutPreDeathDraftInput } from "./draft-service";

/** The discipline recorded for an oversight writer whose roles evidence none of the three clinical ones. */
const OVERSIGHT_DISCIPLINE = "bereavement_oversight";

export interface M16DraftDeps {
  /** The M39 Part 2 verdict (default: the seam registry, fail-closed). */
  readonly disclosure?: BereavementDisclosurePort;
  /** M6's admission reader (default: the M1 seam registry). */
  readonly admissions?: () => AdmissionStatusReader;
}

const iso = (d: Date): IsoInstant => d.toISOString() as IsoInstant;

export function buildDrizzleM16DraftService(
  db: DbClient,
  deps: M16DraftDeps = {},
): M16DraftService {
  const DRAFT = schema.bereavementRiskAssessmentDraft;
  const PLAN = schema.bereavementPlan;
  const disclosure = deps.disclosure ?? seamBereavementDisclosurePort;
  const admissions = deps.admissions ?? getAdmissionStatusReader;

  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  /** The admission's patient, or null when it is absent / not visible to this tenant. */
  async function patientOf(organizationId: string, admissionId: string): Promise<string | null> {
    const care = await admissions().getAdmissionPatientCare(organizationId, admissionId as never);
    return care === null ? null : care.patientId;
  }

  const toView = (
    admissionId: string,
    row: typeof DRAFT.$inferSelect | undefined,
    locked: boolean,
    sudAllowed: boolean,
  ): PreDeathDraftView => ({
    admissionId,
    exists: row !== undefined,
    factors: factorsToWire(draftFactorsForReader(row?.factorsJsonb, sudAllowed)),
    lastEditedDiscipline: row?.lastEditedDiscipline ?? null,
    lastEditedAt: row === undefined ? null : iso(row.updatedAt),
    carriedScoreId: row?.carriedScoreId ?? null,
    carriedAt: row?.carriedAt ? iso(row.carriedAt) : null,
    locked,
    version: row?.version ?? 0,
    redactedCategories: sudAllowed ? [] : ["sud"],
  });

  return {
    async getDraft(actor, admissionId) {
      const patientId = await patientOf(actor.organizationId, admissionId);
      if (patientId === null) return null;
      const gate = await resolveBereavementDisclosure(actor, patientId, disclosure);
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(DRAFT)
          .where(eq(DRAFT.admissionId, admissionId))
          .limit(1);
        const [plan] = await tx
          .select({ id: PLAN.id })
          .from(PLAN)
          .where(eq(PLAN.admissionId, admissionId))
          .limit(1);
        return toView(admissionId, row, plan !== undefined, gate.sudAllowed);
      });
    },

    async putDraft(actor: M16WriteActor, admissionId: string, input: PutPreDeathDraftInput) {
      const patientId = await patientOf(actor.organizationId, admissionId);
      const siting =
        patientId === null
          ? null
          : await admissions().getAdmissionSiting(actor.organizationId, admissionId as never);
      // An admission with no siting is a draft admission that is not under care: nothing to assess yet.
      if (patientId === null || siting === null || siting.providerEntityId === null) {
        throw new NotFoundError("admission not found");
      }
      const providerEntityId: string = siting.providerEntityId;
      const gate = await resolveBereavementDisclosure(actor, patientId, disclosure);
      const discipline = disciplineForRoleKeys(actor.roles) ?? OVERSIGHT_DISCIPLINE;

      return withOrgContext(db, scope(actor), async (tx) => {
        // Checked IN the writing transaction: once a plan exists for the admission the draft is a closed record.
        const [plan] = await tx
          .select({ id: PLAN.id })
          .from(PLAN)
          .where(eq(PLAN.admissionId, admissionId))
          .limit(1);
        assertDraftWritable(plan !== undefined);

        const [existing] = await tx
          .select()
          .from(DRAFT)
          .where(eq(DRAFT.admissionId, admissionId))
          .limit(1);
        checkVersion(input.expectedVersion, existing?.version ?? 0);
        // An uncleared writer keeps the stored Part 2 slot (it cannot see it, so it must not erase it).
        const stored = draftFactorsForStorage(
          input.factors,
          gate.sudAllowed,
          existing?.factorsJsonb,
        );
        const stamp = {
          factorsJsonb: stored,
          lastEditedByMembershipId: actor.membershipId,
          lastEditedDiscipline: discipline,
        };
        const staleVersion = (): BereavementStateError =>
          new BereavementStateError(
            "STALE_VERSION",
            "the draft has moved on; re-read it and retry",
          );

        if (existing === undefined) {
          const [created] = await tx
            .insert(DRAFT)
            .values({
              organizationId: actor.organizationId,
              providerEntityId,
              locationId: siting.locationId,
              patientId,
              admissionId,
              ...stamp,
            })
            .onConflictDoNothing()
            .returning();
          // A concurrent first write won the (org, admission) unique index: this caller read a stale "nothing".
          if (!created) throw staleVersion();
          return toView(admissionId, created, false, gate.sudAllowed);
        }
        const [updated] = await tx
          .update(DRAFT)
          .set({ ...stamp, version: existing.version + 1, updatedAt: new Date() })
          .where(and(eq(DRAFT.id, existing.id), eq(DRAFT.version, existing.version)))
          .returning();
        if (!updated) throw staleVersion();
        return toView(admissionId, updated, false, gate.sudAllowed);
      });
    },
  };
}
