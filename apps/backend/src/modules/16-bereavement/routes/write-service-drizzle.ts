// apps/backend/src/modules/16-bereavement/routes/write-service-drizzle.ts — the Drizzle-backed M16 WRITE
// service (§4.1 routes 3–9, 11–18, 20–28, 32, 33).
//
// Shape of EVERY command: open `withOrgContext` (RLS pins app.org_id) → load the aggregate row → run the
// PURE §2.2–§2.4 decision (`../lifecycle`) over already-resolved cross-module facts (`../seams/consumed`
// resolves M15/M9/M39 through the seam registry) → execute the transition's DECLARED side effects
// (`./effects-runner`) and apply the row change under the §2.5 optimistic-concurrency guard → emit the
// §4.4 outbox event on the SAME tx. No business rule lives in SQL, and no event can outlive a rolled-back
// write.
//
// The M4 write-audit triggers (migration 0102) record every mutation with the per-table §8.1 denylist, so
// this layer never hand-writes an audit row — the denylisted narrative columns
// (`pause_reason_redacted`, `reason_narrative_redacted`, `cancellation_reason_redacted`,
// `ineligible_reason_redacted`, `contact_notes_cipher`, the risk `notes_cipher` / `narrative` json-paths)
// are scrubbed at the trigger, which is why they may be written here in full.
//
// FOUR decisions that are load-bearing and easy to get wrong:
//
//   1. `assignVolunteer` is NOT a state transition. The §2.2 graph has no `assignVolunteer` edge — a
//      volunteer joins a plan that is already `initiating` or `active` without moving it — so this method
//      is a guarded column write plus the §4.4 event, and NOT a `transitionBereavementPlan` call that
//      would raise ILLEGAL_TRANSITION for every plan in the system.
//   2. The M5 CAREGIVER ROSTER is read through the `PatientCaregiverRosterReader` seam (GAP-129) when
//      `seedFromCaregivers` is not false: each current caregiver not already on the plan becomes a `proposed`
//      contact (never twice), alongside the counselor's `additionalContacts`. A deny-stub boot (no M5 db)
//      degrades to the additions only, and the §2.2 `ROSTER_EMPTY` guard refuses an activation that would
//      have produced a bereavement program serving nobody.
//   3. An ad-hoc contact log CREATES its outreach row. `bereavement_contact_log.outreach_id` is NOT NULL
//      (§3.3.5), so routes 26 / 32 materialize a `completed` outreach row for the touchpoint that just
//      happened and hang the log off it. Inventing a nullable column instead would have made the CoP
//      denominator unable to see counselor-initiated contacts at all.
//   4. Every `*_cipher` column is written through the per-tenant DEK envelope (`../bereavement-crypto`,
//      GAP-129). With no cipher bound a request that carries an email / phone / address / note is REFUSED 503 —
//      a plaintext row in a `_cipher` column is worse than an absent one, and silently discarding it told the
//      counselor it was saved. Sealing runs before the transaction opens (the key provider has its own pool).
import {
  bereavementWindowEnd,
  isClosedPlanStatus,
  requiresSourceEncounter,
} from "@wardenx/bereavement";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ForbiddenError,
  NotFoundError,
  type PatientCaregiverRosterReader,
  WardenXError,
} from "@wardenx/types";
import type {
  BereavedContactRelationship,
  BereavementAnniversaryMark,
  BereavementContactLogOutcome,
  BereavementEncounterReader,
  BereavementExternalSourceMetadata,
  BereavementOptOutKind,
  BereavementOutreachKind,
  BereavementPlanClosureReason,
  BereavementPlanPauseKind,
  BereavementRiskTier,
  IsoInstant,
  MembershipId,
} from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { NotImplementedError, getSeam } from "../../../bootstrap/index";
import type { BereavementCipher, BereavementCipherColumn } from "../bereavement-crypto";
import {
  BereavementStateError,
  anniversaryMarksForTier,
  assertCompletionKindMatchesOutreach,
  assertCosignerDistinct,
  assertEarlyCloseRequestable,
  checkExternalSourceFirstContactGate,
  checkOutreachKindAllowed,
  checkVersion,
  generateOutreachSchedule,
  transitionBereavedContact,
  transitionBereavementOutreach,
  transitionBereavementPlan,
  verifySourceEncounter,
} from "../lifecycle/index";
import { scoreBereavementRisk } from "../risk/index";
import { planCaregiverSeeds } from "../roster-seed";
import { getBereavementEncounterReader, getVolunteerComplianceProvider } from "../seams/index";
import type { M16MutatingActor, M16WriteActor } from "./actor";
import { type EffectPatch, runEffects } from "./effects-runner";
import type {
  BereavedContactRowView,
  BereavementClosureView,
  BereavementOutreachRowView,
  BereavementPlanDetail,
  BereavementRiskScoreView,
  M16ReadService,
} from "./read-service";
import { unreachableProposalOf } from "./read-service";
import type {
  AlertPort,
  AssignCounselorInput,
  AssignVolunteerInput,
  BereavementContactLogView,
  CancelOutreachInput,
  CloseEarlyInput,
  CompleteOutreachInput,
  ConfirmContactInput,
  CosignCloseInput,
  CreateContactInput,
  DismissUnreachableProposalInput,
  FlagComplicatedGriefInput,
  InitiateContactInput,
  LateAttemptInput,
  LogDirectContactInput,
  M16WriteService,
  MarkDeceasedInput,
  MarkUnreachableInput,
  OptOutInput,
  OutreachOutcomeInput,
  PausePlanInput,
  PlanActivationView,
  RecomputeRiskInput,
  ReferExternalInput,
  RegenerateScheduleInput,
  RescindOptOutInput,
  ResumePlanInput,
  ScheduleRegenerationView,
  SeedRosterAndScheduleInput,
  UpdateContactInput,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const localDate = (d: string | Date): string =>
  typeof d === "string" ? d : d.toISOString().slice(0, 10);

/** Deps the composition root binds (outbox publisher + M36 alerts + clock; M39/M15 are seam-resolved). */
export interface M16WriteDeps {
  readonly outbox?: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly now?: () => IsoInstant;
  /**
   * D6 — is an active `bereavement_outreach_consent` (or the primary caregiver's `family_caregiver_access`)
   * on file for this contact? Unbound ⇒ FAIL-CLOSED: `confirmContact` refuses, because an unconsented
   * condolence call to a grieving family is the exact harm the rule exists to prevent.
   */
  readonly bereavementConsentActive?: (input: {
    organizationId: string;
    patientId: string;
    consentRecordId?: string;
  }) => Promise<{ hasOutreachConsent: boolean; isPrimaryCaregiverWithFamilyAccess: boolean }>;
  /**
   * §2.3 / §2.5 — is the submitted `relationship_code` in M38's relationship-to-decedent value set? The
   * `bereaved_contact_relationship` pgEnum already mirrors that set and the column would reject anything
   * else, so the default answers `true` and the DB is the backstop. A bound M38 probe narrows it further.
   */
  readonly relationshipInValueSet?: (code: string) => Promise<boolean>;
  /** §7.13 — the reader's 42 CFR Part 2 posture, passed into the D17 evidence gather. Defaults to false
   *  (the conservative reading: an unresolved consent leaves the SUD factor `unknown`, never `false`). */
  readonly sudDisclosureAllowed?: (input: {
    organizationId: string;
    patientId: string;
  }) => Promise<boolean>;
  /** GAP-049 — resolves M8's BereavementEncounterReader per call (default: the M1 seam registry). */
  readonly encounterReader?: () => BereavementEncounterReader;
  /**
   * GAP-129 — the per-tenant DEK envelope for the four `*_cipher` columns (the composition root binds M34's
   * `getTenantKeyProvider()`). UNBOUND ⇒ FAIL-CLOSED: a request that carries an email / phone / mailing address /
   * note is refused 503 rather than silently discarded or written as plaintext into a ciphertext column.
   */
  readonly cipher?: BereavementCipher;
  /** GAP-129 — M5's caregiver roster (default: the M1 seam registry). A deny-stub / unbound reader degrades to
   *  the counselor's additions only; the §2.2 `ROSTER_EMPTY` guard still refuses an empty program. */
  readonly caregiverRoster?: () => PatientCaregiverRosterReader;
}

/**
 * GAP-129 — email / phone / mailing address / counselor notes are sealed into the `*_cipher` columns with the tenant DEK.
 * Without a bound cipher a request that CARRIES one of them is refused (503): accepting it and silently discarding it told
 * the counselor it was saved. A request without any is unaffected.
 */
export const CHANNEL_STORAGE_UNAVAILABLE = "CHANNEL_STORAGE_UNAVAILABLE";
const channelStorageUnavailable = (): WardenXError =>
  new WardenXError(
    CHANNEL_STORAGE_UNAVAILABLE,
    "contact details and counselor notes cannot be stored until the encrypted store is available; submit without them",
    503,
  );
export function assertSensitiveStorable(
  values: ReadonlyArray<string | undefined | null>,
  cipherBound: boolean,
): void {
  if (cipherBound) return;
  if (!values.some((v) => typeof v === "string" && v.trim().length > 0)) return;
  throw channelStorageUnavailable();
}

export function buildDrizzleM16WriteService(
  db: DbClient,
  readService: M16ReadService,
  deps: M16WriteDeps = {},
): M16WriteService {
  const PLAN = schema.bereavementPlan;
  const CONTACT = schema.bereavedContact;
  const OUTREACH = schema.bereavementOutreach;
  const LOG = schema.bereavementContactLog;
  const SCORE = schema.bereavementRiskScore;
  const CLOSURE = schema.bereavementPlanClosure;
  const OPT_OUT = schema.bereavementOptOut;
  const REMINDER = schema.bereavementAnniversaryReminder;

  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const alerts = deps.alerts;
  const now = deps.now ?? (() => new Date().toISOString() as IsoInstant);
  const consentProbe =
    deps.bereavementConsentActive ??
    (async () => ({ hasOutreachConsent: false, isPrimaryCaregiverWithFamilyAccess: false }));
  const relationshipOk = deps.relationshipInValueSet ?? (async () => true);
  const sudAllowed = deps.sudDisclosureAllowed ?? (async () => false);
  const encounterReader = deps.encounterReader ?? getBereavementEncounterReader;
  const cipher = deps.cipher;
  const rosterReader = deps.caregiverRoster ?? (() => getSeam("PatientCaregiverRosterReader"));
  /**
   * The decedent's current caregivers. A DENY-STUB (`NotImplementedError` — a boot without M5's db) degrades to an
   * empty roster so the counselor's additions still land and the §2.2 `ROSTER_EMPTY` guard decides; ANY other failure
   * propagates, because a roster that could not be read must not become a silently smaller program.
   */
  async function readCaregiverRoster(organizationId: string, patientId: string) {
    try {
      return await rosterReader().caregiversForPatient(organizationId, patientId);
    } catch (error) {
      if (error instanceof NotImplementedError) return [];
      throw error;
    }
  }

  /**
   * Seal one value for a `*_cipher` column. `undefined` = untouched, `null` / blank = cleared. Runs BEFORE the
   * transaction opens: the M34 key provider takes its own pooled connection, and holding ours while it does is the
   * M21-T05 / M36 self-deadlock.
   */
  async function seal(
    organizationId: string,
    column: BereavementCipherColumn,
    value: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (value === undefined) return undefined;
    if (value === null || value.trim().length === 0) return null;
    if (!cipher) throw channelStorageUnavailable();
    return cipher.encrypt(organizationId, column, value);
  }
  const sealNotes = (organizationId: string, notes: string | undefined | null) =>
    seal(organizationId, "bereavement_contact_log.contact_notes", notes).then((v) => v ?? null);
  async function sealChannels(
    organizationId: string,
    channels: {
      readonly email?: string | null;
      readonly phone?: string | null;
      readonly mailingAddress?: string | null;
    },
  ) {
    assertSensitiveStorable(
      [channels.email, channels.phone, channels.mailingAddress],
      cipher !== undefined,
    );
    return {
      email: await seal(organizationId, "bereaved_contact.email", channels.email),
      phone: await seal(organizationId, "bereaved_contact.phone", channels.phone),
      mailingAddress: await seal(
        organizationId,
        "bereaved_contact.mailing_address",
        channels.mailingAddress,
      ),
    };
  }
  /** The `*_cipher` column set for an INSERT (a missing channel is NULL). */
  const channelColumnsForInsert = (sealed: Awaited<ReturnType<typeof sealChannels>>) => ({
    emailCipher: sealed.email ?? null,
    phoneCipher: sealed.phone ?? null,
    mailingAddressCipher: sealed.mailingAddress ?? null,
  });

  const scope = (actor: M16MutatingActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
  type PlanRow = typeof PLAN.$inferSelect;
  type ContactRow = typeof CONTACT.$inferSelect;
  type OutreachRow = typeof OUTREACH.$inferSelect;

  /** Load the plan aggregate root, or 404 (an absent/cross-tenant plan is invisible under RLS). */
  async function planOr404(tx: Tx, planId: string): Promise<PlanRow> {
    const [row] = await tx.select().from(PLAN).where(eq(PLAN.id, planId)).limit(1);
    if (!row) throw new NotFoundError("bereavement plan not found");
    return row;
  }

  async function contactOr404(tx: Tx, contactId: string): Promise<ContactRow> {
    const [row] = await tx.select().from(CONTACT).where(eq(CONTACT.id, contactId)).limit(1);
    if (!row) throw new NotFoundError("bereaved contact not found");
    return row;
  }

  async function outreachOr404(tx: Tx, outreachId: string): Promise<OutreachRow> {
    const [row] = await tx.select().from(OUTREACH).where(eq(OUTREACH.id, outreachId)).limit(1);
    if (!row) throw new NotFoundError("bereavement outreach not found");
    return row;
  }

  /** The tenancy columns every child row inherits from the plan root (the M15-F05 denormalization). */
  const inherit = (plan: PlanRow) => ({
    organizationId: plan.organizationId,
    providerEntityId: plan.providerEntityId,
    locationId: plan.locationId,
  });

  const externalSourceOf = (row: PlanRow): BereavementExternalSourceMetadata | null =>
    (row.externalSourceMetadata as BereavementExternalSourceMetadata | null) ?? null;

  const allowedKindsOf = (raw: unknown): BereavementOutreachKind[] => {
    const kinds = (raw as { allowed_kinds?: unknown } | null)?.allowed_kinds;
    return Array.isArray(kinds)
      ? kinds.filter((k): k is BereavementOutreachKind => typeof k === "string")
      : [];
  };

  const toOutreachView = (r: OutreachRow, sourceEncounterId = null as string | null) =>
    ({
      outreachId: r.id,
      planId: r.planId,
      contactId: r.bereavedContactId,
      kind: r.kind,
      status: r.status,
      anniversaryMark: r.anniversaryMark ?? null,
      dueAt: iso(r.dueAt) as IsoInstant,
      lateGraceUntil: iso(r.lateGraceUntil) as IsoInstant,
      startedAt: isoN(r.startedAt) as IsoInstant | null,
      completedAt: isoN(r.completedAt) as IsoInstant | null,
      cancelledAt: isoN(r.cancelledAt) as IsoInstant | null,
      assigneeUserId: r.assigneeUserId ?? null,
      renderedDocumentId: r.renderedDocumentId ?? null,
      sourceEncounterId,
      version: 0,
    }) satisfies BereavementOutreachRowView;

  const toContactView = (r: ContactRow): BereavedContactRowView => ({
    contactId: r.id,
    planId: r.planId,
    status: r.status,
    displayName: r.displayName,
    relationshipCode: r.relationshipCode,
    preferredLanguageIso639: r.preferredLanguageIso639,
    portalAccountId: r.portalAccountId ?? null,
    consentRecordId: r.consentRecordId ?? null,
    allowedOutreachKinds: allowedKindsOf(r.outreachPreferencesJsonb),
    volunteerVisibleOnly: r.volunteerVisibleOnly,
    confirmedAt: isoN(r.confirmedAt) as IsoInstant | null,
    optedOutAt: isoN(r.optedOutAt) as IsoInstant | null,
    unreachableAt: isoN(r.unreachableAt) as IsoInstant | null,
    ...unreachableProposalOf(r),
    deceasedAt: isoN(r.deceasedAt) as IsoInstant | null,
    mayRescindOptOut: false,
    currentRiskTier: r.currentRiskTier ?? null,
    version: r.version,
  });

  const toClosureView = (r: typeof CLOSURE.$inferSelect): BereavementClosureView => ({
    closureId: r.id,
    planId: r.planId,
    reason: r.reason,
    closeKind: r.closeKind,
    closedAt: iso(r.closedAt) as IsoInstant,
    closedByUserId: r.closedByUserId ?? null,
    cosignedByUserId: r.cosignedByUserId ?? null,
    cosignedAt: isoN(r.cosignedAt) as IsoInstant | null,
    stats: {
      completedCount: r.outreachCompletedCount,
      missedCount: r.outreachMissedCount,
      contactsActiveCount: r.contactsActiveCount,
      contactsOptedOutCount: r.contactsOptedOutCount,
    },
    bereavementSummaryDocumentId: r.bereavementSummaryDocumentId ?? null,
  });

  /** The effect-runner context every transition shares. */
  const effectCtx = (
    actor: M16MutatingActor,
    plan: PlanRow,
    at: string,
    payloads: Record<string, Record<string, unknown>>,
    alertPayloads?: Record<string, Record<string, unknown>>,
  ) => ({
    organizationId: actor.organizationId,
    at: new Date(at),
    outbox,
    alerts,
    aggregateKind: "bereavement_plan",
    aggregateId: plan.id,
    payloads: payloads as never,
    alertPayloads,
  });

  /** Apply a §2.5-guarded UPDATE to the plan root, bumping `version`. */
  async function patchPlan(
    tx: Tx,
    plan: PlanRow,
    status: PlanRow["status"],
    patch: EffectPatch,
    at: string,
  ): Promise<void> {
    await tx
      .update(PLAN)
      .set({
        status,
        version: plan.version + 1,
        updatedAt: new Date(at),
        ...(patch.openedAt ? { openedAt: patch.openedAt } : {}),
        ...(patch.pausedAt ? { pausedAt: patch.pausedAt } : {}),
        ...(patch.closedAt ? { closedAt: patch.closedAt } : {}),
        ...(patch.assignedCounselorUserId
          ? {
              assignedCounselorUserId: patch.assignedCounselorUserId,
              assignedCounselorAssignedAt: patch.assignedCounselorAssignedAt,
            }
          : {}),
        ...(patch.assignedVolunteerUserId
          ? {
              assignedVolunteerUserId: patch.assignedVolunteerUserId,
              assignedVolunteerAssignedAt: patch.assignedVolunteerAssignedAt,
            }
          : {}),
        ...(patch.externalSourceMetadata !== undefined
          ? { externalSourceMetadata: patch.externalSourceMetadata }
          : {}),
        ...(patch.legalHoldId !== undefined ? { legalHoldId: patch.legalHoldId } : {}),
      })
      .where(eq(PLAN.id, plan.id));
  }

  /** §2.2 / §2.3 `cancel_future_outreach` — cancel every FUTURE-dated `scheduled` row in the scope. */
  async function cancelFutureOutreach(
    tx: Tx,
    scopeKey: { planId: string } | { contactId: string },
    at: string,
    reason: string,
  ): Promise<number> {
    const where =
      "planId" in scopeKey
        ? and(
            eq(OUTREACH.planId, scopeKey.planId),
            eq(OUTREACH.status, "scheduled"),
            gte(OUTREACH.dueAt, new Date(at)),
          )
        : and(
            eq(OUTREACH.bereavedContactId, scopeKey.contactId),
            eq(OUTREACH.status, "scheduled"),
            gte(OUTREACH.dueAt, new Date(at)),
          );
    const rows = await tx.select({ id: OUTREACH.id }).from(OUTREACH).where(where);
    if (rows.length === 0) return 0;
    await tx
      .update(OUTREACH)
      .set({
        status: "cancelled",
        cancelledAt: new Date(at),
        cancellationReasonRedacted: reason,
        updatedAt: new Date(at),
      })
      .where(
        inArray(
          OUTREACH.id,
          rows.map((r) => r.id),
        ),
      );
    return rows.length;
  }

  /**
   * D4 — materialize the schedule for one contact and emit one `outreach_scheduled` per row. `fromIso`
   * makes it forward-only (a resume / rescind regeneration), which is what stops a paused plan from
   * manufacturing backdated obligations it would then report as missed.
   */
  async function materializeSchedule(
    tx: Tx,
    plan: PlanRow,
    contact: ContactRow,
    fromIso: string | undefined,
  ): Promise<OutreachRow[]> {
    const tier: BereavementRiskTier = contact.currentRiskTier ?? plan.currentRiskTier ?? "low";
    const planned = generateOutreachSchedule(
      localDate(plan.deathDate),
      { riskTier: tier, allowedKinds: allowedKindsOf(contact.outreachPreferencesJsonb) },
      fromIso === undefined ? {} : { fromIso: fromIso as IsoInstant },
    );
    if (planned.length === 0) return [];
    const inserted = await tx
      .insert(OUTREACH)
      .values(
        planned.map((p) => ({
          ...inherit(plan),
          planId: plan.id,
          bereavedContactId: contact.id,
          kind: p.kind,
          status: "scheduled" as const,
          anniversaryMark: p.anniversaryMark,
          deathAnchorAt: new Date(p.deathAnchorAt),
          dueAt: new Date(p.dueAt),
          lateGraceUntil: new Date(p.lateGraceUntil),
          assigneeUserId: plan.assignedCounselorUserId,
        })),
      )
      .returning();
    for (const row of inserted) {
      await outbox.publish(tx, {
        organizationId: plan.organizationId,
        eventName: "m16.bereavement.outreach_scheduled",
        payload: {
          planId: plan.id,
          contactId: contact.id,
          outreachId: row.id,
          kind: row.kind,
          dueAt: iso(row.dueAt),
        },
        aggregateKind: "bereavement_outreach",
        aggregateId: row.id,
      });
    }
    return inserted;
  }

  /** Insert the §3.3.6 anniversary reminders the §4.9 lookahead cron alerts off. */
  async function seedAnniversaryReminders(
    tx: Tx,
    plan: PlanRow,
    marks: readonly BereavementAnniversaryMark[],
  ): Promise<number> {
    if (marks.length === 0) return 0;
    const anchorMs = Date.parse(`${localDate(plan.deathDate)}T00:00:00.000Z`);
    const OFFSET_DAYS: Record<BereavementAnniversaryMark, number> = {
      one_month: 30,
      three_month: 90,
      six_month: 180,
      nine_month_high_risk_only: 270,
      anniversary: 365,
    };
    const rows = await tx
      .insert(REMINDER)
      .values(
        marks.map((mark) => ({
          ...inherit(plan),
          planId: plan.id,
          mark,
          targetDate: new Date(anchorMs + OFFSET_DAYS[mark] * 86_400_000)
            .toISOString()
            .slice(0, 10),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: REMINDER.id });
    return rows.length;
  }

  /** The §7.11 closeout counts frozen onto the closure row (recomputing them later would drift). */
  async function closeoutStats(tx: Tx, planId: string) {
    const [outreach] = await tx
      .select({
        completed: sql<number>`count(*) filter (where ${OUTREACH.status} in ('completed','declined'))::int`,
        missed: sql<number>`count(*) filter (where ${OUTREACH.status} = 'missed')::int`,
      })
      .from(OUTREACH)
      .where(eq(OUTREACH.planId, planId));
    const [contacts] = await tx
      .select({
        active: sql<number>`count(*) filter (where ${CONTACT.status} = 'active')::int`,
        optedOut: sql<number>`count(*) filter (where ${CONTACT.status} = 'opted_out')::int`,
      })
      .from(CONTACT)
      .where(eq(CONTACT.planId, planId));
    return {
      outreachCompletedCount: outreach?.completed ?? 0,
      outreachMissedCount: outreach?.missed ?? 0,
      contactsActiveCount: contacts?.active ?? 0,
      contactsOptedOutCount: contacts?.optedOut ?? 0,
    };
  }

  /** The plan detail every plan-shaped mutation answers with (re-read so the caller sees the new version). */
  async function planDetail(
    actor: M16MutatingActor,
    planId: string,
  ): Promise<BereavementPlanDetail> {
    const detail = await readService.getPlan(actor, planId);
    if (detail === null) throw new NotFoundError("bereavement plan not found");
    return detail;
  }

  /** §2.3 — the consecutive `no_response` streak the 3-strikes guard counts. */
  async function consecutiveNoResponse(tx: Tx, contactId: string): Promise<number> {
    const rows = await tx
      .select({ outcome: LOG.outcome, contactAt: LOG.contactAt })
      .from(LOG)
      .where(eq(LOG.bereavedContactId, contactId))
      .orderBy(desc(LOG.contactAt))
      .limit(20);
    let streak = 0;
    for (const row of rows) {
      if (row.outcome !== "no_response") break;
      streak += 1;
    }
    return streak;
  }

  /** §4.3.3 — append one immutable score row and return the view the route answers with. */
  async function appendScore(
    tx: Tx,
    actor: M16WriteActor,
    plan: PlanRow,
    contact: ContactRow | null,
    input: RecomputeRiskInput,
    amendmentKind: "initial" | "scheduled_reassessment" | "counselor_override",
  ): Promise<BereavementRiskScoreView> {
    const assessedAt = now();
    const [prior] = await tx
      .select()
      .from(SCORE)
      .where(
        contact === null
          ? and(eq(SCORE.planId, plan.id), isNull(SCORE.bereavedContactId))
          : eq(SCORE.bereavedContactId, contact.id),
      )
      .orderBy(desc(SCORE.assessedAt), desc(SCORE.id))
      .limit(1);

    const rosterCount = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(CONTACT)
      .where(and(eq(CONTACT.planId, plan.id), eq(CONTACT.status, "active")))
      .then((rows) => rows[0]?.n ?? 0);

    const result = await scoreBereavementRisk(
      {
        organizationId: actor.organizationId,
        admissionId: plan.admissionId as never,
        patientId: plan.patientId as never,
        deathAt: (plan.deathTime
          ? iso(plan.deathTime)
          : `${localDate(plan.deathDate)}T00:00:00.000Z`) as IsoInstant,
        // F-159 (#248) — `BereavementRosterEvidence`'s real fields are `isPrimaryCaregiver`/
        // `enrolledSurvivorCount`; this object was `{activeContactCount, relationshipCode}` under an
        // `as never` cast, so `deriveRiskFactors` read `undefined` for both `roster.isPrimaryCaregiver`
        // (which its `!== null` check treats as a definite non-caregiver value, never falling back to
        // the MSW-derived slot) and `roster.enrolledSurvivorCount` (whose `< SOCIAL_SUPPORT_ROSTER_FLOOR`
        // comparison against `undefined` is always `false` in JS) — every score ever appended through this
        // route silently mis-scored `primaryCaregiverRole` and the roster-fallback half of
        // `socialIsolation`. No bound seam resolves M5's `patient_caregiver.is_primary` for a survivor, so
        // `isPrimaryCaregiver` is honestly `null` (extract.ts's own "KNOWN GAP" pattern) rather than
        // guessed; `enrolledSurvivorCount` is the same already-computed `rosterCount`, correctly named.
        roster: {
          isPrimaryCaregiver: null,
          enrolledSurvivorCount: rosterCount,
        },
        sudDisclosureAllowed: await sudAllowed({
          organizationId: actor.organizationId,
          patientId: plan.patientId,
        }),
      },
      {
        planId: plan.id as never,
        ...(contact === null ? {} : { contactId: contact.id as never }),
        providerEntityId: plan.providerEntityId,
        locationId: plan.locationId,
        assessedByUserId: actor.membershipId,
        assessedAt,
        amendmentKind,
        amendedFromScoreId: prior?.id ?? null,
        ...(input.overrideTier === undefined
          ? {}
          : { overrideTier: input.overrideTier as BereavementRiskTier }),
        ...(input.overrideReason === undefined ? {} : { amendmentReason: input.overrideReason }),
        priorTier: contact?.currentRiskTier ?? plan.currentRiskTier ?? null,
      },
    );

    const [row] = await tx
      .insert(SCORE)
      .values({
        ...inherit(plan),
        planId: plan.id,
        bereavedContactId: result.draft.bereavedContactId,
        scoreKind: result.draft.scoreKind,
        assessedAt: new Date(result.draft.assessedAt),
        assessedByUserId: result.draft.assessedByUserId,
        riskFactorsJsonb: result.draft.riskFactorsJsonb,
        ruleScore: result.draft.ruleScore,
        ruleTier: result.draft.ruleTier,
        dataCompleteness: result.draft.dataCompleteness,
        confidenceBand: result.draft.confidenceBand,
      })
      .returning();
    if (!row) throw new Error("m16: the risk-score append returned no row");

    // The tier ROLLUP is a denormalization of the ledger's newest row — never a second source of truth.
    if (contact === null) {
      await tx
        .update(PLAN)
        .set({ currentRiskTier: row.ruleTier, currentRiskComputedAt: row.assessedAt })
        .where(eq(PLAN.id, plan.id));
    } else {
      await tx
        .update(CONTACT)
        .set({ currentRiskTier: row.ruleTier, currentRiskScoreId: row.id })
        .where(eq(CONTACT.id, contact.id));
    }

    await runEffects(
      tx,
      result.effects,
      effectCtx(
        actor,
        plan,
        assessedAt,
        {
          "m16.bereavement.risk_score_computed": {
            planId: plan.id,
            ...(contact === null ? {} : { contactId: contact.id }),
            scoreKind: row.scoreKind,
            tier: row.ruleTier,
            scoreId: row.id,
            dataCompleteness: row.dataCompleteness,
            confidenceBand: row.confidenceBand,
          },
        },
        {
          risk_tier_escalated: {
            planId: plan.id,
            contactId: contact?.id ?? null,
            fromTier: contact?.currentRiskTier ?? plan.currentRiskTier ?? null,
            toTier: row.ruleTier,
          },
        },
      ),
    );

    return {
      scoreId: row.id,
      planId: row.planId,
      contactId: row.bereavedContactId ?? null,
      scoreKind: row.scoreKind,
      assessedAt: iso(row.assessedAt) as IsoInstant,
      assessedByUserId: row.assessedByUserId ?? null,
      tier: row.ruleTier,
      deterministicTier: result.scored.tier,
      ruleScore: row.ruleScore,
      dataCompleteness: row.dataCompleteness,
      confidenceBand: row.confidenceBand,
      // `BereavementRiskFactorInputs` is a closed 8-key record; the DTO publishes it as an open map so a
      // future rubric factor does not force a wire-shape change on every consumer.
      factors: { ...result.derived.factors } as Record<string, boolean | "unknown">,
      pg13Score: result.draft.riskFactorsJsonb.pg13Score,
      ipgrScore: result.draft.riskFactorsJsonb.ipgrScore,
      evidenceDegraded: result.draft.riskFactorsJsonb.evidenceDegraded,
      redactedCategories: [],
    };
  }

  /**
   * Materialize an ad-hoc `completed` outreach row for a touchpoint that just happened without a schedule
   * (routes 26 / 32) — see decision 3 in the module header.
   */
  async function adHocOutreach(
    tx: Tx,
    plan: PlanRow,
    contact: ContactRow,
    kind: BereavementOutreachKind,
    at: string,
  ): Promise<OutreachRow> {
    const anchor = new Date(`${localDate(plan.deathDate)}T00:00:00.000Z`);
    const [row] = await tx
      .insert(OUTREACH)
      .values({
        ...inherit(plan),
        planId: plan.id,
        bereavedContactId: contact.id,
        kind,
        status: "completed",
        deathAnchorAt: anchor,
        dueAt: new Date(at),
        lateGraceUntil: new Date(at),
        completedAt: new Date(at),
        assigneeUserId: plan.assignedCounselorUserId,
      })
      .returning();
    if (!row) throw new Error("m16: the ad-hoc outreach insert returned no row");
    return row;
  }

  return {
    // ── 3 — assign the counselor (`eligible → initiating`) ──────────────────────────────────────────
    async assignCounselor(actor, planId, input: AssignCounselorInput) {
      await withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        const at = input.effectiveAt ?? now();
        // The §4.8 guard already answered this for the request; the machine re-asks so a stale grant
        // cannot land an ineligible counselor between the guard and the commit.
        const transition = transitionBereavementPlan(plan.status, {
          type: "assignCounselor",
          counselorUserId: input.counselorUserId as MembershipId,
          at: at as IsoInstant,
          counselorCanProvideBereavement: true,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.counselor_assigned": {
              planId: plan.id,
              counselorUserId: input.counselorUserId,
              assignedAt: at,
            },
          }),
        );
        await patchPlan(tx, plan, transition.to, patch, at);
      });
      return planDetail(actor, planId);
    },

    // ── 4 — assign a volunteer (NOT a state transition; see decision 1) ─────────────────────────────
    async assignVolunteer(actor, planId, input: AssignVolunteerInput) {
      await withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        if (isClosedPlanStatus(plan.status)) {
          throw new BereavementStateError("PLAN_CLOSED", `the bereavement plan is ${plan.status}`);
        }
        // The 418.78 gate is M15's ONE implementation, re-asked here so an expiry between the guard and
        // the commit cannot leave an ungated volunteer on a bereavement roster. Fail-CLOSED on an outage.
        const status = await getVolunteerComplianceProvider()
          .effectiveStatusFor(actor.organizationId as never, input.volunteerUserId as MembershipId)
          .catch(() => null);
        if (status === null || !status.isActive) {
          throw new BereavementStateError(
            "VOLUNTEER_GATES_UNMET",
            `the volunteer's 42 CFR 418.78 gates are not satisfied${
              status === null
                ? " (the compliance seam could not be read)"
                : `: ${status.failingGates.join(", ")}`
            }`,
          );
        }
        const at = input.effectiveAt ?? now();
        await tx
          .update(PLAN)
          .set({
            assignedVolunteerUserId: input.volunteerUserId,
            assignedVolunteerAssignedAt: new Date(at),
            version: plan.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(PLAN.id, plan.id));
        await outbox.publish(tx, {
          organizationId: plan.organizationId,
          eventName: "m16.bereavement.volunteer_assigned",
          payload: { planId: plan.id, volunteerUserId: input.volunteerUserId, assignedAt: at },
          aggregateKind: "bereavement_plan",
          aggregateId: plan.id,
        });
      });
      return planDetail(actor, planId);
    },

    // ── 5 — seed the roster + the D4 schedule (`initiating → active`) ───────────────────────────────
    async seedRosterAndSchedule(actor, planId, input: SeedRosterAndScheduleInput) {
      // GAP-129 — everything that needs a cross-module seam or the M34 key provider runs BEFORE the transaction
      // (a seam / key-provider call inside our own tx self-deadlocks the pool — M21-T05). The plan's patient is a
      // short pre-read; the roster is read once; every channel is sealed.
      const drafts = input.additionalContacts ?? [];
      const sealedDrafts = await Promise.all(
        drafts.map((draft) => sealChannels(actor.organizationId, draft)),
      );
      const roster =
        input.seedFromCaregivers === false
          ? []
          : await readCaregiverRoster(
              actor.organizationId,
              (await withOrgContext(db, scope(actor), async (tx) => planOr404(tx, planId)))
                .patientId,
            );
      const sealedRoster = await Promise.all(
        roster.map((entry) =>
          sealChannels(actor.organizationId, { email: entry.email, phone: entry.phone }),
        ),
      );
      const result = await withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        const at = now();

        // M5 caregivers still to seed (never twice: a link already on the plan is skipped), as `proposed` contacts.
        const alreadySeeded = new Set(
          (
            await tx
              .select({ link: CONTACT.patientCaregiverIdFromM5 })
              .from(CONTACT)
              .where(eq(CONTACT.planId, plan.id))
          )
            .map((r) => r.link)
            .filter((id): id is string => id !== null),
        );
        const seeded: ContactRow[] = [];
        const seedPlan = planCaregiverSeeds(roster, alreadySeeded);
        for (const caregiver of seedPlan) {
          const channels =
            sealedRoster[roster.findIndex((r) => r.caregiverId === caregiver.caregiverId)];
          const [row] = await tx
            .insert(CONTACT)
            .values({
              ...inherit(plan),
              planId: plan.id,
              status: "proposed",
              displayName: caregiver.displayName,
              relationshipCode: caregiver.relationshipCode as BereavedContactRelationship,
              caregiverIdFromM5: caregiver.caregiverId,
              patientCaregiverIdFromM5: caregiver.patientCaregiverId,
              ...(channels ? channelColumnsForInsert(channels) : {}),
              preferredLanguageIso639: caregiver.preferredLanguageIso639,
            })
            .returning();
          if (row) seeded.push(row);
        }
        for (const [draftIndex, draft] of drafts.entries()) {
          if (!(await relationshipOk(draft.relationshipCode))) {
            throw new BereavementStateError(
              "RELATIONSHIP_NOT_IN_VALUE_SET",
              `'${draft.relationshipCode}' is not in the M38 relationship-to-decedent value set`,
            );
          }
          const [row] = await tx
            .insert(CONTACT)
            .values({
              ...inherit(plan),
              planId: plan.id,
              status: "proposed",
              displayName: draft.displayName,
              relationshipCode: draft.relationshipCode as BereavedContactRelationship,
              ...(sealedDrafts[draftIndex]
                ? channelColumnsForInsert(sealedDrafts[draftIndex])
                : {}),
              preferredLanguageIso639: draft.preferredLanguageIso639 ?? "en",
              consentRecordId: draft.consentRecordId ?? null,
              ...(draft.outreachPreferences
                ? {
                    outreachPreferencesJsonb: {
                      allowed_kinds: draft.outreachPreferences.allowedKinds,
                    },
                  }
                : {}),
            })
            .returning();
          if (row) seeded.push(row);
        }

        const existing = await tx.select().from(CONTACT).where(eq(CONTACT.planId, plan.id));

        // §2.2 guard — the initial deterministic score must exist before the cadence can be generated.
        const initialScore =
          existing.length > 0 ? await appendScore(tx, actor, plan, null, {}, "initial") : null;
        const tier = initialScore?.tier ?? "low";
        const marks = anniversaryMarksForTier(tier);

        const transition = transitionBereavementPlan(plan.status, {
          type: "seedRosterAndSchedule",
          at: at as IsoInstant,
          contactCount: existing.length,
          initialRiskScored: initialScore !== null,
          archivesAt: bereavementWindowEnd(localDate(plan.deathDate)) as IsoInstant,
          anniversaryMarks: marks,
        });

        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.plan_opened": {
              planId: plan.id,
              patientId: plan.patientId,
              admissionId: plan.admissionId,
              deathDate: localDate(plan.deathDate),
              assignedCounselorUserId: plan.assignedCounselorUserId ?? "",
              archivesAt: bereavementWindowEnd(localDate(plan.deathDate)),
            },
            // D14 — the M22 welcome-packet render handshake rides the plan-opened transition.
            "m16.bereavement.outreach_artifact_requested": {
              planId: plan.id,
              // F-099 — the chart target M22 files the rendered packet against. The decedent, whose chart
              // the bereavement record belongs to; `contactId` below is the recipient, not the chart.
              patientId: plan.patientId,
              contactId: existing[0]?.id ?? "",
              // No `bereavement_outreach` row exists yet at plan-open — those materialize per-contact in
              // the loop below, after this effects call. See the schema's own comment for why this is
              // genuinely null here rather than a placeholder.
              outreachId: null,
              templateKey: "bereavement_welcome_packet",
              payloadJsonb: { deathDate: localDate(plan.deathDate) },
            },
          }),
        );

        const withTier = { ...plan, currentRiskTier: tier };
        let outreachScheduledCount = 0;
        for (const contact of existing) {
          const rows = await materializeSchedule(tx, withTier, contact, undefined);
          outreachScheduledCount += rows.length;
        }
        const anniversaryRemindersCount = await seedAnniversaryReminders(tx, plan, marks);

        await patchPlan(tx, plan, transition.to, patch, at);
        return {
          contactsSeededCount: seeded.length,
          outreachScheduledCount,
          anniversaryRemindersCount,
          effects: transition.effects.map((e) => e.kind),
        };
      });

      const view: PlanActivationView = { plan: await planDetail(actor, planId), ...result };
      return view;
    },

    // ── 6 — pause ───────────────────────────────────────────────────────────────────────────────────
    async pausePlan(actor, planId, input: PausePlanInput) {
      await withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        const at = now();
        const transition = transitionBereavementPlan(plan.status, {
          type: "pausePlan",
          pauseKind: input.pauseKind as BereavementPlanPauseKind,
          reason: input.reason,
          at: at as IsoInstant,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.plan_paused": {
              planId: plan.id,
              pauseKind: input.pauseKind,
              pausedAt: at,
            },
          }),
        );
        await cancelFutureOutreach(tx, { planId: plan.id }, at, "plan paused");
        await tx
          .update(PLAN)
          .set({
            pauseKind: input.pauseKind as BereavementPlanPauseKind,
            pauseReasonRedacted: input.reason,
          })
          .where(eq(PLAN.id, plan.id));
        await patchPlan(tx, plan, transition.to, patch, at);
      });
      return planDetail(actor, planId);
    },

    // ── 7 — resume (forward-only regeneration) ──────────────────────────────────────────────────────
    async resumePlan(actor, planId, input: ResumePlanInput) {
      await withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        const at = now();
        const transition = transitionBereavementPlan(plan.status, {
          type: "resumePlan",
          at: at as IsoInstant,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.plan_resumed": { planId: plan.id, resumedAt: at },
          }),
        );
        const contacts = await tx
          .select()
          .from(CONTACT)
          .where(and(eq(CONTACT.planId, plan.id), eq(CONTACT.status, "active")));
        for (const contact of contacts) await materializeSchedule(tx, plan, contact, at);
        await tx.update(PLAN).set({ pauseKind: null }).where(eq(PLAN.id, plan.id));
        await patchPlan(tx, plan, transition.to, patch, at);
      });
      return planDetail(actor, planId);
    },

    // ── 8 — D7 early close REQUEST (GAP-047) ────────────────────────────────────────────────────────
    // Records a PENDING request on the plan and nothing else: the plan stays in its current state, no
    // outreach is cancelled and no closure row or event is written. The transition is route 9's, performed
    // by a DIFFERENT supervisor — the requesting counselor is never recorded as the cosigner.
    async closeEarly(actor, planId, input: CloseEarlyInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        assertEarlyCloseRequestable(plan.status, plan.earlyCloseRequestedAt);
        const at = now();
        // Dry-run the machine so an illegal state, a short narrative or a legal hold is refused NOW rather
        // than at cosign time. The requester stands in as cosigner only to satisfy the guard; the result is
        // discarded and nothing is executed.
        transitionBereavementPlan(plan.status, {
          type: "closeEarly",
          reason: input.reason as BereavementPlanClosureReason,
          narrative: input.narrative,
          at: at as IsoInstant,
          cosignedByUserId: actor.membershipId as MembershipId,
          legalHoldActive: plan.legalHoldId !== null,
        });
        await tx
          .update(PLAN)
          .set({
            earlyCloseReason: input.reason as BereavementPlanClosureReason,
            earlyCloseNarrativeRedacted: input.narrative,
            earlyCloseRequestedByUserId: actor.membershipId,
            earlyCloseRequestedAt: new Date(at),
            version: plan.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(PLAN.id, plan.id));
        return planDetail(actor, planId);
      });
    },

    // ── 9 — the D7 supervisor cosign: performs the transition (GAP-047) ─────────────────────────────
    async cosignClose(actor, planId, input: CosignCloseInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        const { earlyCloseReason, earlyCloseNarrativeRedacted, earlyCloseRequestedByUserId } = plan;
        if (!earlyCloseReason || !earlyCloseNarrativeRedacted || !earlyCloseRequestedByUserId) {
          throw new BereavementStateError(
            "EARLY_CLOSE_NOT_REQUESTED",
            "no early close is awaiting a clinical-supervisor cosign",
          );
        }
        // §6.1 (S) — the requester and the cosigner must be two people, or the D7 ratification means nothing.
        assertCosignerDistinct(earlyCloseRequestedByUserId, actor.membershipId);
        const at = now();
        const transition = transitionBereavementPlan(plan.status, {
          type: "closeEarly",
          reason: earlyCloseReason as BereavementPlanClosureReason,
          narrative: earlyCloseNarrativeRedacted,
          at: at as IsoInstant,
          cosignedByUserId: actor.membershipId as MembershipId,
          requestedByUserId: earlyCloseRequestedByUserId as MembershipId,
          legalHoldActive: plan.legalHoldId !== null,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.plan_closed_early": {
              planId: plan.id,
              reason: earlyCloseReason,
              closedAt: at,
              cosignedByUserId: actor.membershipId,
            },
          }),
        );
        await cancelFutureOutreach(tx, { planId: plan.id }, at, "plan closed early");
        const stats = await closeoutStats(tx, plan.id);
        const [closure] = await tx
          .insert(CLOSURE)
          .values({
            ...inherit(plan),
            planId: plan.id,
            reason: earlyCloseReason as BereavementPlanClosureReason,
            reasonNarrativeRedacted: earlyCloseNarrativeRedacted,
            closedAt: new Date(at),
            closedByUserId: earlyCloseRequestedByUserId,
            closeKind: "manual",
            cosignedByUserId: actor.membershipId,
            cosignedAt: new Date(at),
            ...stats,
          })
          .returning();
        if (!closure) throw new Error("m16: the closure insert returned no row");
        await patchPlan(tx, plan, transition.to, patch, at);
        await tx
          .update(PLAN)
          .set({
            earlyCloseReason: null,
            earlyCloseNarrativeRedacted: null,
            earlyCloseRequestedByUserId: null,
            earlyCloseRequestedAt: null,
          })
          .where(eq(PLAN.id, plan.id));
        return toClosureView(closure);
      });
    },

    // ── 11 — add a bereaved contact ─────────────────────────────────────────────────────────────────
    async createContact(actor, planId, input: CreateContactInput) {
      const sealed = await sealChannels(actor.organizationId, input);
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        if (isClosedPlanStatus(plan.status)) {
          throw new BereavementStateError("PLAN_CLOSED", `the bereavement plan is ${plan.status}`);
        }
        if (!(await relationshipOk(input.relationshipCode))) {
          throw new BereavementStateError(
            "RELATIONSHIP_NOT_IN_VALUE_SET",
            `'${input.relationshipCode}' is not in the M38 relationship-to-decedent value set`,
          );
        }
        const [row] = await tx
          .insert(CONTACT)
          .values({
            ...inherit(plan),
            planId: plan.id,
            status: "proposed",
            displayName: input.displayName,
            relationshipCode: input.relationshipCode as BereavedContactRelationship,
            ...channelColumnsForInsert(sealed),
            preferredLanguageIso639: input.preferredLanguageIso639 ?? "en",
            consentRecordId: input.consentRecordId ?? null,
            ...(input.outreachPreferences
              ? {
                  outreachPreferencesJsonb: {
                    allowed_kinds: input.outreachPreferences.allowedKinds,
                  },
                }
              : {}),
          })
          .returning();
        if (!row) throw new Error("m16: the contact insert returned no row");
        return toContactView(row);
      });
    },

    // ── 12 — preferences / channels ─────────────────────────────────────────────────────────────────
    async updateContact(actor, contactId, input: UpdateContactInput) {
      const sealed = await sealChannels(actor.organizationId, input);
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const at = now();
        // GAP-129 — a submitted channel is sealed with the tenant DEK (above, before the tx); `undefined` leaves the
        // column untouched and `null` clears it.
        const [row] = await tx
          .update(CONTACT)
          .set({
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
            ...(sealed.email === undefined ? {} : { emailCipher: sealed.email }),
            ...(sealed.phone === undefined ? {} : { phoneCipher: sealed.phone }),
            ...(sealed.mailingAddress === undefined
              ? {}
              : { mailingAddressCipher: sealed.mailingAddress }),
            ...(input.preferredLanguageIso639 === undefined
              ? {}
              : { preferredLanguageIso639: input.preferredLanguageIso639 }),
            ...(input.outreachPreferences === undefined
              ? {}
              : {
                  outreachPreferencesJsonb: {
                    allowed_kinds: input.outreachPreferences.allowedKinds,
                  },
                }),
            ...(input.volunteerVisibleOnly === undefined
              ? {}
              : { volunteerVisibleOnly: input.volunteerVisibleOnly }),
            version: contact.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the contact update returned no row");
        return toContactView(row);
      });
    },

    // ── 13 — proposed → active (D6 consent verified, fail-CLOSED) ───────────────────────────────────
    async confirmContact(actor, contactId, input: ConfirmContactInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const plan = await planOr404(tx, contact.planId);
        const at = now();
        const verdict = await consentProbe({
          organizationId: actor.organizationId,
          patientId: plan.patientId,
          ...(input.consentRecordId === undefined
            ? {}
            : { consentRecordId: input.consentRecordId }),
        }).catch(() => ({
          hasOutreachConsent: false,
          isPrimaryCaregiverWithFamilyAccess: false,
        }));

        const transition = transitionBereavedContact(contact.status, {
          type: "confirmContact",
          at: at as IsoInstant,
          hasBereavementOutreachConsent: verdict.hasOutreachConsent,
          isPrimaryCaregiverWithFamilyAccess: verdict.isPrimaryCaregiverWithFamilyAccess,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.contact_active": {
              planId: plan.id,
              contactId: contact.id,
              portalAccountId: contact.portalAccountId ?? null,
            },
          }),
        );
        const [row] = await tx
          .update(CONTACT)
          .set({
            status: transition.to,
            confirmedAt: patch.confirmedAt ?? new Date(at),
            ...(input.consentRecordId === undefined
              ? {}
              : { consentRecordId: input.consentRecordId }),
            version: contact.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the confirm update returned no row");
        // §2.6 `recompute_risk` — the confirmed survivor now has a per-contact score.
        await appendScore(tx, actor, plan, row, {}, "scheduled_reassessment");
        return toContactView(row);
      });
    },

    // ── 14 — per-contact opt-out (D9; staff OR the survivor's own portal session) ────────────────────
    async optOutContact(actor, contactId, input: OptOutInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const plan = await planOr404(tx, contact.planId);
        const at = now();
        const transition = transitionBereavedContact(contact.status, {
          type: "optOut",
          at: at as IsoInstant,
          optOutKind: input.optOutKind as BereavementOptOutKind,
          source: input.sourceKind as never,
          reason: input.reason ?? "not stated",
          ...(input.channelKinds === undefined ? {} : { channelKinds: input.channelKinds }),
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.contact_opted_out": {
              planId: plan.id,
              contactId: contact.id,
              optOutKind: input.optOutKind,
              source: input.sourceKind,
            },
          }),
        );
        await tx.insert(OPT_OUT).values({
          ...inherit(plan),
          planId: plan.id,
          bereavedContactId: contact.id,
          optOutKind: input.optOutKind as BereavementOptOutKind,
          ...(input.channelKinds === undefined ? {} : { channelKinds: input.channelKinds }),
          reasonRedacted: input.reason ?? null,
          optedOutAt: new Date(at),
          // §3.3.8 — NULL on the portal self-service path, which is exactly the session that has no
          // workforce membership. That is the whole reason this route takes a mutating (not write) actor.
          recordedByUserId: actor.membershipId,
          sourceKind: input.sourceKind,
        });
        await cancelFutureOutreach(tx, { contactId: contact.id }, at, "contact opted out");
        const [row] = await tx
          .update(CONTACT)
          .set({
            status: transition.to,
            optedOutAt: patch.optedOutAt ?? new Date(at),
            version: contact.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the opt-out update returned no row");
        return toContactView(row);
      });
    },

    // ── 15 — rescind an opt-out ─────────────────────────────────────────────────────────────────────
    async rescindOptOut(actor, contactId, input: RescindOptOutInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const plan = await planOr404(tx, contact.planId);
        const at = now();
        const [open] = await tx
          .select()
          .from(OPT_OUT)
          .where(and(eq(OPT_OUT.bereavedContactId, contactId), isNull(OPT_OUT.rescindedAt)))
          .orderBy(desc(OPT_OUT.optedOutAt))
          .limit(1);
        if (!open) throw new NotFoundError("no open bereavement opt-out to rescind");

        const transition = transitionBereavedContact(contact.status, {
          type: "rescindOptOut",
          at: at as IsoInstant,
          optedOutAt: iso(open.optedOutAt) as IsoInstant,
          // §2.3 — a COUNSELOR rescind with a documented reason is not bound by the D9 90-day window; the
          // survivor's own portal session is. `membershipId !== null` is exactly "this is staff".
          byCounselor: actor.membershipId !== null && (input.reason ?? "").trim().length > 0,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.contact_opt_out_rescinded": {
              planId: plan.id,
              contactId: contact.id,
            },
          }),
        );
        void patch;
        await tx
          .update(OPT_OUT)
          .set({ rescindedAt: new Date(at), rescindedByUserId: actor.membershipId })
          .where(eq(OPT_OUT.id, open.id));
        const [row] = await tx
          .update(CONTACT)
          .set({
            status: transition.to,
            optedOutAt: null,
            version: contact.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the rescind update returned no row");
        await materializeSchedule(tx, plan, row, at);
        return toContactView(row);
      });
    },

    // ── 16 — the survivor themselves died ───────────────────────────────────────────────────────────
    async markContactDeceased(actor, contactId, input: MarkDeceasedInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const plan = await planOr404(tx, contact.planId);
        const at = input.deceasedAt;
        const transition = transitionBereavedContact(contact.status, {
          type: "markDeceased",
          at: at as IsoInstant,
          deathVerified: input.deathSource.trim().length > 0,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.contact_deceased": { planId: plan.id, contactId: contact.id },
          }),
        );
        await cancelFutureOutreach(tx, { contactId }, now(), "contact deceased");
        const [row] = await tx
          .update(CONTACT)
          .set({
            status: transition.to,
            deceasedAt: patch.deceasedAt ?? new Date(at),
            version: contact.version + 1,
            updatedAt: new Date(now()),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the mark-deceased update returned no row");
        return toContactView(row);
      });
    },

    // ── 17 — accept the 3-strikes unreachable proposal ──────────────────────────────────────────────
    async markContactUnreachable(actor, contactId, input: MarkUnreachableInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const plan = await planOr404(tx, contact.planId);
        const at = now();
        const streak = await consecutiveNoResponse(tx, contactId);
        const transition = transitionBereavedContact(contact.status, {
          type: "markUnreachable",
          at: at as IsoInstant,
          consecutiveNoResponseCount: streak,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(
            actor,
            plan,
            at,
            {
              "m16.bereavement.contact_unreachable": {
                planId: plan.id,
                contactId: contact.id,
                missedTouchpointCount: streak,
              },
            },
            {
              contact_unreachable: {
                planId: plan.id,
                contactId: contact.id,
                missedTouchpointCount: streak,
              },
            },
          ),
        );
        const [row] = await tx
          .update(CONTACT)
          .set({
            status: transition.to,
            unreachableAt: patch.unreachableAt ?? new Date(at),
            version: contact.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the mark-unreachable update returned no row");
        return toContactView(row);
      });
    },

    // ── 34 — "keep trying": dismiss the unreachable proposal until a strictly newer no_response strike ──
    async dismissUnreachableProposal(actor, contactId, input: DismissUnreachableProposalInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        if (
          !unreachableProposalOf(contact).unreachableProposed ||
          !contact.unreachableProposedThroughAt
        ) {
          throw new BereavementStateError(
            "ILLEGAL_TRANSITION",
            "there is no pending unreachable proposal to dismiss",
          );
        }
        const [row] = await tx
          .update(CONTACT)
          .set({
            unreachableProposalDismissedAt: contact.unreachableProposedThroughAt,
            version: contact.version + 1,
            updatedAt: new Date(now()),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the dismiss-unreachable-proposal update returned no row");
        return toContactView(row);
      });
    },

    // ── 18 — §7.7 complicated grief → external referral ─────────────────────────────────────────────
    async flagComplicatedGrief(actor, contactId, input: FlagComplicatedGriefInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        checkVersion(input.expectedVersion, contact.version);
        const plan = await planOr404(tx, contact.planId);
        const at = now();
        const transition = transitionBereavedContact(contact.status, {
          type: "flagComplicatedGrief",
          at: at as IsoInstant,
          externalResourceId: input.externalResourceId as never,
        });
        const patch = await runEffects(
          tx,
          transition.effects,
          effectCtx(
            actor,
            plan,
            at,
            {
              "m16.bereavement.contact_referred_external": {
                planId: plan.id,
                contactId: contact.id,
                externalResourceId: input.externalResourceId,
              },
            },
            {
              complicated_grief_referral: {
                planId: plan.id,
                contactId: contact.id,
                externalResourceId: input.externalResourceId,
              },
            },
          ),
        );
        // The §2.6 `log_external_referral` effect, executed here because it carries the acting membership
        // and the free-text note the descriptor deliberately omits.
        const outreach = await adHocOutreach(tx, plan, contact, "external_referral", at);
        await tx.insert(LOG).values({
          ...inherit(plan),
          planId: plan.id,
          bereavedContactId: contact.id,
          outreachId: outreach.id,
          contactAt: new Date(at),
          kind: "external_referral",
          outcome: "crisis_referral",
          contactNotesCipher: null,
          loggedByUserId: actor.membershipId,
          contactRespondedDirectly: false,
          externalResourceIdFromM40: input.externalResourceId,
        });
        await cancelFutureOutreach(tx, { contactId }, at, "referred to external grief services");
        const [row] = await tx
          .update(CONTACT)
          .set({
            status: transition.to,
            ineligibleAt: patch.ineligibleAt ?? new Date(at),
            ineligibleReasonRedacted: input.note ?? "complicated grief — referred externally",
            version: contact.version + 1,
            updatedAt: new Date(at),
          })
          .where(eq(CONTACT.id, contactId))
          .returning();
        if (!row) throw new Error("m16: the complicated-grief update returned no row");
        return toContactView(row);
      });
    },

    // ── 20 — scheduled → in_progress ────────────────────────────────────────────────────────────────
    async startOutreach(actor, outreachId) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const outreach = await outreachOr404(tx, outreachId);
        const plan = await planOr404(tx, outreach.planId);
        const at = now();
        const transition = transitionBereavementOutreach(outreach.status, {
          type: "startContact",
          at: at as IsoInstant,
        });
        await runEffects(tx, transition.effects, effectCtx(actor, plan, at, {}));
        const [row] = await tx
          .update(OUTREACH)
          .set({ status: transition.to, startedAt: new Date(at), updatedAt: new Date(at) })
          // bereavement_outreach has no version column (GAP-194): the status read above is the guard, so a
          // concurrent transition matches no row instead of being overwritten.
          .where(and(eq(OUTREACH.id, outreachId), eq(OUTREACH.status, outreach.status)))
          .returning();
        if (!row) throw new Error("m16: the outreach start returned no row");
        return toOutreachView(row);
      });
    },

    // ── 21 — in_progress → completed (writes the contact-log row in the SAME tx) ────────────────────
    async completeOutreach(actor, outreachId, input: CompleteOutreachInput) {
      assertSensitiveStorable([input.notes], cipher !== undefined);
      const notesCipher = await sealNotes(actor.organizationId, input.notes);
      return withOrgContext(db, scope(actor), async (tx) => {
        const outreach = await outreachOr404(tx, outreachId);
        const plan = await planOr404(tx, outreach.planId);
        // GAP-049 / D15 — the kind recorded is the kind the row was scheduled as, never the client's claim;
        // and an in-person visit's encounter is resolved through M8 (signed, same patient, bereavement_contact).
        assertCompletionKindMatchesOutreach(outreach.kind, input.kind);
        if (requiresSourceEncounter(outreach.kind) && input.sourceEncounterId) {
          await verifySourceEncounter({
            reader: encounterReader(),
            organizationId: actor.organizationId,
            patientId: plan.patientId,
            encounterId: input.sourceEncounterId,
          });
        }
        const at = now();
        // The contact-log row lands FIRST so §2.4's "completion means at least one contact-log row exists"
        // guard is satisfied by a real count rather than by an optimistic 1.
        const [log] = await tx
          .insert(LOG)
          .values({
            ...inherit(plan),
            planId: plan.id,
            bereavedContactId: outreach.bereavedContactId,
            outreachId: outreach.id,
            contactAt: new Date(at),
            kind: input.kind as BereavementOutreachKind,
            outcome: input.outcome as BereavementContactLogOutcome,
            sourceEncounterId: requiresSourceEncounter(input.kind as BereavementOutreachKind)
              ? (input.sourceEncounterId ?? null)
              : null,
            contactNotesCipher: notesCipher,
            artifactDocumentId: input.artifactDocumentId ?? null,
            loggedByUserId: actor.membershipId,
            contactRespondedDirectly: input.contactResponded,
          })
          .returning();
        if (!log) throw new Error("m16: the contact-log insert returned no row");

        const transition = transitionBereavementOutreach(outreach.status, {
          type: "completeContact",
          at: at as IsoInstant,
          kind: input.kind as BereavementOutreachKind,
          outcome: input.outcome as BereavementContactLogOutcome,
          sourceEncounterId: (input.sourceEncounterId ?? null) as never,
          contactLogCount: 1,
        });
        await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.outreach_completed": {
              planId: plan.id,
              contactId: outreach.bereavedContactId,
              outreachId: outreach.id,
              outcome: input.outcome,
              ...(input.sourceEncounterId === undefined
                ? {}
                : { sourceEncounterId: input.sourceEncounterId }),
            },
          }),
        );
        const [row] = await tx
          .update(OUTREACH)
          .set({ status: transition.to, completedAt: new Date(at), updatedAt: new Date(at) })
          .where(eq(OUTREACH.id, outreachId))
          .returning();
        if (!row) throw new Error("m16: the outreach complete returned no row");
        return toOutreachView(row, log.sourceEncounterId ?? null);
      });
    },

    // ── 22 — the survivor declined THIS touchpoint ──────────────────────────────────────────────────
    async declineOutreach(actor, outreachId, input: OutreachOutcomeInput) {
      assertSensitiveStorable([input.notes], cipher !== undefined);
      const notesCipher = await sealNotes(actor.organizationId, input.notes);
      return withOrgContext(db, scope(actor), async (tx) => {
        const outreach = await outreachOr404(tx, outreachId);
        const plan = await planOr404(tx, outreach.planId);
        const at = now();
        const transition = transitionBereavementOutreach(outreach.status, {
          type: "contactDeclined",
          at: at as IsoInstant,
        });
        await tx.insert(LOG).values({
          ...inherit(plan),
          planId: plan.id,
          bereavedContactId: outreach.bereavedContactId,
          outreachId: outreach.id,
          contactAt: new Date(at),
          kind: outreach.kind,
          outcome: "declined",
          contactNotesCipher: notesCipher,
          loggedByUserId: actor.membershipId,
          contactRespondedDirectly: true,
        });
        await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.outreach_completed": {
              planId: plan.id,
              contactId: outreach.bereavedContactId,
              outreachId: outreach.id,
              outcome: "declined",
            },
          }),
        );
        const [row] = await tx
          .update(OUTREACH)
          .set({ status: transition.to, completedAt: new Date(at), updatedAt: new Date(at) })
          .where(eq(OUTREACH.id, outreachId))
          .returning();
        if (!row) throw new Error("m16: the outreach decline returned no row");
        void input;
        return toOutreachView(row);
      });
    },

    // ── 23 — no response after retries ──────────────────────────────────────────────────────────────
    async noResponseOutreach(actor, outreachId, input: OutreachOutcomeInput) {
      assertSensitiveStorable([input.notes], cipher !== undefined);
      const notesCipher = await sealNotes(actor.organizationId, input.notes);
      return withOrgContext(db, scope(actor), async (tx) => {
        const outreach = await outreachOr404(tx, outreachId);
        const plan = await planOr404(tx, outreach.planId);
        const at = now();
        await tx.insert(LOG).values({
          ...inherit(plan),
          planId: plan.id,
          bereavedContactId: outreach.bereavedContactId,
          outreachId: outreach.id,
          contactAt: new Date(at),
          kind: outreach.kind,
          outcome: "no_response",
          contactNotesCipher: notesCipher,
          loggedByUserId: actor.membershipId,
          contactRespondedDirectly: false,
        });
        const streak = await consecutiveNoResponse(tx, outreach.bereavedContactId);
        const transition = transitionBereavementOutreach(outreach.status, {
          type: "noResponseAfterRetries",
          at: at as IsoInstant,
          consecutiveNoResponseCount: streak,
        });
        await runEffects(
          tx,
          transition.effects,
          effectCtx(actor, plan, at, {
            "m16.bereavement.outreach_completed": {
              planId: plan.id,
              contactId: outreach.bereavedContactId,
              outreachId: outreach.id,
              outcome: "no_response",
            },
          }),
        );
        const [row] = await tx
          .update(OUTREACH)
          .set({ status: transition.to, completedAt: new Date(at), updatedAt: new Date(at) })
          .where(eq(OUTREACH.id, outreachId))
          .returning();
        if (!row) throw new Error("m16: the outreach no-response returned no row");
        void input;
        return toOutreachView(row);
      });
    },

    // ── 24 — cancel a scheduled touchpoint ──────────────────────────────────────────────────────────
    async cancelOutreach(actor, outreachId, input: CancelOutreachInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const outreach = await outreachOr404(tx, outreachId);
        const plan = await planOr404(tx, outreach.planId);
        const at = now();
        const transition = transitionBereavementOutreach(outreach.status, {
          type: "cancel",
          at: at as IsoInstant,
          reason: input.reason,
        });
        await runEffects(tx, transition.effects, effectCtx(actor, plan, at, {}));
        const [row] = await tx
          .update(OUTREACH)
          .set({
            status: transition.to,
            cancelledAt: new Date(at),
            cancellationReasonRedacted: input.reason,
            updatedAt: new Date(at),
          })
          .where(eq(OUTREACH.id, outreachId))
          .returning();
        if (!row) throw new Error("m16: the outreach cancel returned no row");
        return toOutreachView(row);
      });
    },

    // ── 25 — missed → in_progress inside the 7-day grace ────────────────────────────────────────────
    async lateAttemptOutreach(actor, outreachId, input: LateAttemptInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const outreach = await outreachOr404(tx, outreachId);
        const plan = await planOr404(tx, outreach.planId);
        const at = now();
        const transition = transitionBereavementOutreach(outreach.status, {
          type: "lateAttempt",
          at: at as IsoInstant,
          lateGraceUntil: iso(outreach.lateGraceUntil) as IsoInstant,
        });
        await runEffects(tx, transition.effects, effectCtx(actor, plan, at, {}));
        const [row] = await tx
          .update(OUTREACH)
          .set({ status: transition.to, startedAt: new Date(at), updatedAt: new Date(at) })
          .where(eq(OUTREACH.id, outreachId))
          .returning();
        if (!row) throw new Error("m16: the outreach late-attempt returned no row");
        void input;
        return toOutreachView(row);
      });
    },

    // ── 26 — an ad-hoc contact-log row ──────────────────────────────────────────────────────────────
    async logDirectContact(actor, contactId, input: LogDirectContactInput) {
      assertSensitiveStorable([input.notes], cipher !== undefined);
      const notesCipher = await sealNotes(actor.organizationId, input.notes);
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        const plan = await planOr404(tx, contact.planId);
        if (isClosedPlanStatus(plan.status)) {
          throw new BereavementStateError("PLAN_CLOSED", `the bereavement plan is ${plan.status}`);
        }
        // §2.5 — an AD-HOC touchpoint must be a kind the survivor allows. Stricter than the schedule
        // generator on purpose: the generator is discharging a regulatory minimum, a counselor adding an
        // extra call is not, and has no standing to override the family's stated wishes.
        checkOutreachKindAllowed(
          input.kind as BereavementOutreachKind,
          allowedKindsOf(contact.outreachPreferencesJsonb),
        );
        const outreach = await adHocOutreach(
          tx,
          plan,
          contact,
          input.kind as BereavementOutreachKind,
          input.contactAt,
        );
        const [log] = await tx
          .insert(LOG)
          .values({
            ...inherit(plan),
            planId: plan.id,
            bereavedContactId: contact.id,
            outreachId: outreach.id,
            contactAt: new Date(input.contactAt),
            kind: input.kind as BereavementOutreachKind,
            outcome: input.outcome as BereavementContactLogOutcome,
            contactNotesCipher: notesCipher,
            artifactDocumentId: input.artifactDocumentId ?? null,
            loggedByUserId: actor.membershipId,
            contactRespondedDirectly: input.contactResponded,
          })
          .returning();
        if (!log) throw new Error("m16: the direct contact-log insert returned no row");
        await outbox.publish(tx, {
          organizationId: plan.organizationId,
          eventName: "m16.bereavement.outreach_completed",
          payload: {
            planId: plan.id,
            contactId: contact.id,
            outreachId: outreach.id,
            outcome: input.outcome,
          },
          aggregateKind: "bereavement_outreach",
          aggregateId: outreach.id,
        });
        const view: BereavementContactLogView = {
          contactLogId: log.id,
          planId: log.planId,
          contactId: log.bereavedContactId,
          outreachId: log.outreachId,
          kind: log.kind,
          outcome: log.outcome,
          contactAt: iso(log.contactAt),
          artifactDocumentId: log.artifactDocumentId ?? null,
        };
        return view;
      });
    },

    // ── 27 — regenerate the FORWARD schedule ────────────────────────────────────────────────────────
    async regenerateSchedule(actor, planId, input: RegenerateScheduleInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        checkVersion(input.expectedVersion, plan.version);
        const from = input.fromAt ?? now();
        const contacts = await tx
          .select()
          .from(CONTACT)
          .where(
            input.contactId
              ? and(eq(CONTACT.planId, planId), eq(CONTACT.id, input.contactId))
              : and(eq(CONTACT.planId, planId), eq(CONTACT.status, "active")),
          );
        let cancelledCount = 0;
        const generated: BereavementOutreachRowView[] = [];
        for (const contact of contacts) {
          cancelledCount += await cancelFutureOutreach(
            tx,
            { contactId: contact.id },
            from,
            "schedule regenerated",
          );
          const rows = await materializeSchedule(tx, plan, contact, from);
          for (const row of rows) generated.push(toOutreachView(row));
        }
        const view: ScheduleRegenerationView = {
          planId,
          cancelledCount,
          generatedCount: generated.length,
          outreach: generated,
        };
        return view;
      });
    },

    // ── 28 — recompute the deterministic score (append-only) ────────────────────────────────────────
    async recomputeRisk(actor, planId, input: RecomputeRiskInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        const contact =
          input.bereavedContactId === undefined
            ? null
            : await contactOr404(tx, input.bereavedContactId);
        if (contact !== null && contact.planId !== planId) {
          throw new NotFoundError("bereaved contact not found on this plan");
        }
        return appendScore(
          tx,
          actor,
          plan,
          contact,
          input,
          input.overrideTier === undefined ? "scheduled_reassessment" : "counselor_override",
        );
      });
    },

    // ── 32 — log an external referral WITHOUT ending the program ────────────────────────────────────
    async referExternal(actor, contactId, input: ReferExternalInput) {
      assertSensitiveStorable([input.notes], cipher !== undefined);
      const notesCipher = await sealNotes(actor.organizationId, input.notes);
      return withOrgContext(db, scope(actor), async (tx) => {
        const contact = await contactOr404(tx, contactId);
        const plan = await planOr404(tx, contact.planId);
        if (isClosedPlanStatus(plan.status)) {
          throw new BereavementStateError("PLAN_CLOSED", `the bereavement plan is ${plan.status}`);
        }
        const at = input.contactAt ?? now();
        const outreach = await adHocOutreach(tx, plan, contact, "external_referral", at);
        const [log] = await tx
          .insert(LOG)
          .values({
            ...inherit(plan),
            planId: plan.id,
            bereavedContactId: contact.id,
            outreachId: outreach.id,
            contactAt: new Date(at),
            kind: "external_referral",
            outcome: "requested_followup",
            contactNotesCipher: notesCipher,
            loggedByUserId: actor.membershipId,
            contactRespondedDirectly: false,
            externalResourceIdFromM40: input.externalResourceId,
          })
          .returning();
        if (!log) throw new Error("m16: the referral log insert returned no row");
        const view: BereavementContactLogView = {
          contactLogId: log.id,
          planId: log.planId,
          contactId: log.bereavedContactId,
          outreachId: log.outreachId,
          kind: log.kind,
          outcome: log.outcome,
          contactAt: iso(log.contactAt),
          artifactDocumentId: null,
        };
        return view;
      });
    },

    // ── 33 — the D18-gated counselor first contact (§4.3.2) ─────────────────────────────────────────
    async initiateContact(actor, planId, input: InitiateContactInput) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const plan = await planOr404(tx, planId);
        const contact = await contactOr404(tx, input.contactId);
        if (contact.planId !== planId) {
          throw new NotFoundError("bereaved contact not found on this plan");
        }
        const [override] = await tx
          .select()
          .from(schema.tenantBereavementExternalSourceGateOverride)
          .limit(1);
        // D18 — the refusal is a 409 carrying the exact machine-readable gate code (§4.3.2), which §8.1
        // audits as `m16.first_contact.gate_refused`. A route guard would have collapsed all three
        // distinct reasons into one anonymous 403.
        checkExternalSourceFirstContactGate(
          externalSourceOf(plan),
          override
            ? {
                requireDeathCertificateUploaded: override.requireDeathCertificateUploaded,
                requireCoordinatorAcknowledgment: override.requireCoordinatorAcknowledgment,
              }
            : null,
          { hasDeathCertificate: false, hasCoordinatorAcknowledgment: false },
        );

        const at = now();
        const kind = (input.kind ?? "phone_call") as BereavementOutreachKind;
        checkOutreachKindAllowed(kind, allowedKindsOf(contact.outreachPreferencesJsonb));
        // The first contact IS a touchpoint, so it lands as a real `in_progress` outreach row the
        // counselor then completes through route 21 — not as a bare flag nobody can audit.
        const [row] = await tx
          .insert(OUTREACH)
          .values({
            ...inherit(plan),
            planId: plan.id,
            bereavedContactId: contact.id,
            kind,
            status: "in_progress",
            deathAnchorAt: new Date(`${localDate(plan.deathDate)}T00:00:00.000Z`),
            dueAt: new Date(at),
            lateGraceUntil: new Date(at),
            startedAt: new Date(at),
            assigneeUserId: actor.membershipId,
          })
          .returning();
        if (!row) throw new Error("m16: the initiate-contact insert returned no row");
        await outbox.publish(tx, {
          organizationId: plan.organizationId,
          eventName: "m16.bereavement.outreach_scheduled",
          payload: {
            planId: plan.id,
            contactId: contact.id,
            outreachId: row.id,
            kind: row.kind,
            dueAt: iso(row.dueAt),
          },
          aggregateKind: "bereavement_outreach",
          aggregateId: row.id,
        });
        return toOutreachView(row);
      });
    },
  };
}

/** Re-exported for the composition root's readability (the write service needs the read service). */
export type { M16ReadService };
