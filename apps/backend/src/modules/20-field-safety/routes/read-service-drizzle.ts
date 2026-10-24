// apps/backend/src/modules/20-field-safety/routes/read-service-drizzle.ts — the Drizzle-backed M20 READ
// service (§4.1's GET rows).
//
// Every method opens its own `withOrgContext` so RLS scopes each statement to `app.org_id`; no query
// compares `organization_id` as its ONLY tenancy control (the eq() clauses that do appear are defence in
// depth behind RLS, never instead of it).
//
// FOUR DECISIONS THAT ARE LOAD-BEARING:
//
//   1. THE CIPHER PORT'S DEFAULT REFUSES, AND THE DTO SAYS SO. `narrative`, `witnesses`, `actionPlan` and
//      `resolutionNarrative` are `null` with an `*Available: false` beside them when no decipher is bound.
//      Returning the stored bytes as though they were plaintext would put an unreadable blob on a
//      clinician's screen AND make the per-access audit row claim a decrypt happened. "There is no
//      narrative" and "we cannot open it here" are different answers on the wire (the M19-T08 rule).
//   2. THE COORDINATE READ IS THE ONLY PLACE A LATITUDE EXISTS, AND IT REFUSES WITHOUT A REASON ONCE THE
//      ALERT CLOSES. §6's post-SOS Compliance-Officer escalation requires "an audit-event narrative ≥40
//      chars explaining the reason", and the check runs HERE rather than at the guard because the guard
//      cannot see the alert's lifecycle state. During an active alert the responder needs no essay; after
//      it, the read is a compliance act and must say why.
//   3. THE BOARD IS THE §4.3 SEAM, NOT A SECOND QUERY. `getDashboard` calls M20's own
//      `SafetyDashboardProvider` (registered at M20-T05) rather than re-assembling the snapshot from SQL.
//      Two implementations of "is everyone OK?" that could disagree is exactly the failure a safety
//      surface must not have — and the seam already merges the cross-module half (M17's current visit,
//      M18's last-known location, the §7.7 spoof badge) that this layer has no business resolving.
//   4. A CLINICIAN WITH NO SUPERVISOR GRANT SEES ONLY HER OWN ROW, AND THAT FILTER IS HERE. §6's
//      "clinicians see their own state only" cannot be expressed by `caseload_or_scope` — an ABAC
//      predicate answers yes/no for a request, not which rows come back. The guard admits her to the
//      route; this layer narrows the snapshot.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type IsoInstant,
  NotFoundError,
  SAFETY_SOS_OPEN_STATES,
  type SafetyAlertKind,
  type SafetyCheckInKind,
  type SafetyCheckInState,
  type SafetyCheckInStatus,
  type SafetyConsentPurpose,
  type SafetyDashboardSnapshot,
  type SafetyEmergencyContactConsentStatus,
  type SafetyHighRiskAreaPolicy,
  type SafetyHighRiskCategory,
  type SafetyIncidentCategory,
  type SafetyIncidentSeverity,
  type SafetyIncidentState,
  type SafetyPolicyEffectiveDto,
  type SafetyPolygonRings,
  type SafetySosCancelStatus,
  type SafetySosLifecycleState,
  type SafetySosOutcome,
  type SafetySubscriptionScopeKind,
} from "@chartwarden/types";
import { and, asc, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ACTIVE_SOS_RESPONDER_STATES, decideSafetySupervisorOrAbove } from "../abac-predicates";
import { mergeEffectivePolicy, safetyPolicyFloorSeed } from "../lifecycle/policy";
import { getSafetyDashboardProvider } from "../seams/index";
import type { M20ReadActor } from "./actor";
import {
  type CursorPage,
  M20_PAGE_SIZES,
  clampLimit,
  decodeCursor,
  toCursorPage,
} from "./concurrency";
import { coordinatesCaptured, decodeCoordinates } from "./coordinates";
import type {
  ActiveSosView,
  CheckInFilters,
  DashboardFilters,
  HighRiskAreaFilters,
  IncidentFilters,
  LocationStreamFilters,
  M20ReadService,
  SafetyCheckInView,
  SafetyConsentSurface,
  SafetyConsentView,
  SafetyHighRiskAreaView,
  SafetyIncidentView,
  SafetyMyDayView,
  SafetySosAlertView,
  SafetySubscriptionView,
  SosLocationStreamPage,
} from "./read-service";

const iso = (d: Date | string | null): IsoInstant | null =>
  d === null
    ? null
    : ((d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant);
const isoReq = (d: Date | string): IsoInstant => iso(d) as IsoInstant;

/** §4.1 row 3 — the amendment grace §4.6 states in words ("self, within 5-min grace"). */
export const CHECK_IN_AMENDMENT_GRACE_MINUTES = 5;

/**
 * The per-tenant DEK envelope (D14) every `*_cipher` column rides.
 *
 * Phase 1 has no key-management binding for M20, so the decrypt port is INJECTED and the default REFUSES
 * rather than returning the stored bytes. `null` from a bound port means "this row carries none"; a THROW
 * means "not decryptable here", and the read service turns the throw into `available: false` rather than
 * failing the whole read — a supervisor must still be able to see that an incident EXISTS while its
 * narrative is unreadable.
 */
export interface SafetyDecipherPort {
  decrypt(input: {
    readonly organizationId: string;
    readonly cipher: Uint8Array;
  }): Promise<string | null>;
}

/** The default: refuses, loudly, rather than handing ciphertext up as plaintext. */
export const denyStubSafetyDecipherPort: SafetyDecipherPort = {
  async decrypt() {
    throw new ChartWardenError(
      "SAFETY_CIPHER_UNBOUND",
      "no per-tenant DEK decipher is bound for M20; the stored value cannot be opened here",
      503,
    );
  },
};

/** Deps the composition root binds. */
export interface M20ReadDeps {
  readonly decipher?: SafetyDecipherPort;
  readonly now?: () => Date;
}

/** A decrypted free-text field plus whether the decrypt actually happened. */
async function openCipher(
  port: SafetyDecipherPort | undefined,
  organizationId: string,
  cipher: Uint8Array | null,
): Promise<{ value: string | null; available: boolean }> {
  if (cipher === null) return { value: null, available: true }; // the row genuinely carries none
  if (port === undefined) return { value: null, available: false };
  try {
    return { value: await port.decrypt({ organizationId, cipher }), available: true };
  } catch {
    return { value: null, available: false };
  }
}

export function buildDrizzleM20ReadService(db: DbClient, deps: M20ReadDeps = {}): M20ReadService {
  const CHECK_IN = schema.safetyCheckIn;
  const SCHEDULE = schema.safetyCheckInSchedule;
  const SOS = schema.safetySosAlert;
  const SOS_HISTORY = schema.safetySosAlertStateHistory;
  const STREAM = schema.safetySosLocationStream;
  const ACK = schema.safetyAcknowledgment;
  const INCIDENT = schema.safetyIncident;
  const INCIDENT_HISTORY = schema.safetyIncidentStateHistory;
  const POLICY_VERSION = schema.safetyPolicyVersion;
  const SUBSCRIPTION = schema.safetySupervisorSubscription;
  const AREA = schema.safetyHighRiskArea;
  const CONSENT = schema.safetyEmergencyContactConsent;

  const decipher = deps.decipher;
  const now = deps.now ?? (() => new Date());
  const ctx = (actor: M20ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  /** §2.2.4 — the effective policy, floor merged under the tenant's version in force at `asOf`. */
  async function effectivePolicy(
    actor: M20ReadActor,
    asOfIso?: string,
  ): Promise<SafetyPolicyEffectiveDto> {
    const at = asOfIso === undefined ? now() : new Date(asOfIso);
    return withOrgContext(db, ctx(actor), async (tx) => {
      const [row] = await tx
        .select()
        .from(POLICY_VERSION)
        .where(
          and(
            eq(POLICY_VERSION.organizationId, actor.organizationId),
            lte(POLICY_VERSION.effectiveFrom, at),
            or(isNull(POLICY_VERSION.effectiveTo), sql`${POLICY_VERSION.effectiveTo} > ${at}`),
          ),
        )
        .orderBy(desc(POLICY_VERSION.effectiveFrom))
        .limit(1);
      if (!row) {
        // A tenant with no version row yet reads the PLATFORM FLOOR rather than erroring: every threshold
        // the SOS ladder and the overdue detector need has a floor value, and refusing here would make a
        // freshly-onboarded agency's first SOS un-raisable. `versionId` is empty, which is the honest
        // signal that nothing has been pinned yet.
        return {
          organizationId: actor.organizationId as SafetyPolicyEffectiveDto["organizationId"],
          versionId: "" as SafetyPolicyEffectiveDto["versionId"],
          effectiveFrom: isoReq(at),
          effectiveTo: null,
          ...safetyPolicyFloorSeed(),
        };
      }
      return mergeEffectivePolicy(
        actor.organizationId as SafetyPolicyEffectiveDto["organizationId"],
        {
          versionId: row.id as SafetyPolicyEffectiveDto["versionId"],
          effectiveFrom: isoReq(row.effectiveFrom),
          effectiveTo: iso(row.effectiveTo),
          midVisitCadenceMinutes: row.midVisitCadenceMinutes,
          midVisitMinVisitDurationMinutes: row.midVisitMinVisitDurationMinutes,
          preVisitWindowMinutes: row.preVisitWindowMinutes,
          postVisitWindowMinutes: row.postVisitWindowMinutes,
          gentleReminderMinutes: row.gentleReminderMinutes,
          supervisorAlertMinutes: row.supervisorAlertMinutes,
          escalationMinutes: row.escalationMinutes,
          sosEquivalentMinutes: row.sosEquivalentMinutes,
          sosCancelWindowSeconds: row.sosCancelWindowSeconds,
          sosCancelRequiresBiometric: row.sosCancelRequiresBiometric,
          sosContinuousLocationEnabled: row.sosContinuousLocationEnabled,
          sosContinuousLocationSampleSeconds: row.sosContinuousLocationSampleSeconds,
          sosContinuousLocationMaxDurationHours: row.sosContinuousLocationMaxDurationHours,
          sosTier1SlaSeconds: row.sosTier1SlaSeconds,
          sosTier2SlaSeconds: row.sosTier2SlaSeconds,
          sosTier3SlaSeconds: row.sosTier3SlaSeconds,
          subscriptionModel: row.subscriptionModel,
          afterHoursStartHour: row.afterHoursStartHour,
          afterHoursEndHour: row.afterHoursEndHour,
          oshaReportableAutoFlagCategories: (row.oshaReportableAutoFlagCategories ??
            []) as readonly SafetyIncidentCategory[],
        },
      );
    });
  }

  return {
    async getCheckIn(actor, checkInId) {
      return withOrgContext(db, ctx(actor), async (tx): Promise<SafetyCheckInView> => {
        const [row] = await tx
          .select()
          .from(CHECK_IN)
          .where(and(eq(CHECK_IN.id, checkInId), eq(CHECK_IN.organizationId, actor.organizationId)))
          .limit(1);
        if (!row) throw new NotFoundError("safety check-in");
        const graceEnds = new Date(
          row.postedAt.getTime() + CHECK_IN_AMENDMENT_GRACE_MINUTES * 60_000,
        );
        return {
          id: row.id,
          scheduleId: row.scheduleId,
          visitId: row.visitId,
          postedByMembershipId: row.postedByMembershipId,
          postedAt: isoReq(row.postedAt),
          kind: row.kind as SafetyCheckInKind,
          status: row.status as SafetyCheckInStatus,
          concernNote: row.concernNote,
          coordinatesCaptured: row.postedCoordinatesCipher !== null,
          isPartOfSosBracket: row.isPartOfSosBracket,
          correctsCheckInId: row.correctsCheckInId,
          supersededAt: iso(row.supersededAt),
          supersededByCheckInId: row.supersededByCheckInId,
          amendableUntil: row.supersededAt === null && graceEnds > now() ? isoReq(graceEnds) : null,
        };
      });
    },

    async getMyDay(actor, filters) {
      const membershipId = actor.membershipId;
      if (membershipId === null) throw new NotFoundError("membership");
      const at = now();
      const from =
        filters.from !== undefined
          ? new Date(filters.from)
          : new Date(at.getTime() - 24 * 3_600_000);
      const to =
        filters.to !== undefined ? new Date(filters.to) : new Date(at.getTime() + 24 * 3_600_000);
      return withOrgContext(db, ctx(actor), async (tx): Promise<SafetyMyDayView> => {
        const obligations = await tx
          .select()
          .from(SCHEDULE)
          .where(
            and(
              eq(SCHEDULE.organizationId, actor.organizationId),
              eq(SCHEDULE.clinicianMembershipId, membershipId),
              gte(SCHEDULE.expectedAt, from),
              lte(SCHEDULE.expectedAt, to),
            ),
          )
          .orderBy(asc(SCHEDULE.expectedAt))
          .limit(200);
        const posts = await tx
          .select()
          .from(CHECK_IN)
          .where(
            and(
              eq(CHECK_IN.organizationId, actor.organizationId),
              eq(CHECK_IN.postedByMembershipId, membershipId),
              gte(CHECK_IN.postedAt, from),
            ),
          )
          .orderBy(desc(CHECK_IN.postedAt))
          .limit(clampLimit(filters.limit, M20_PAGE_SIZES.checkIns));
        return {
          asOf: isoReq(at),
          obligations: obligations.map((o) => ({
            scheduleId: o.id,
            visitId: o.visitId,
            kind: o.kind as SafetyCheckInKind,
            expectedAt: isoReq(o.expectedAt),
            windowMinutes: o.windowMinutes,
            state: o.state as SafetyCheckInState,
            fulfilledByCheckInId: o.fulfilledByCheckInId,
          })),
          recentCheckIns: posts.map((row) => ({
            id: row.id,
            scheduleId: row.scheduleId,
            visitId: row.visitId,
            postedByMembershipId: row.postedByMembershipId,
            postedAt: isoReq(row.postedAt),
            kind: row.kind as SafetyCheckInKind,
            status: row.status as SafetyCheckInStatus,
            concernNote: row.concernNote,
            coordinatesCaptured: row.postedCoordinatesCipher !== null,
            isPartOfSosBracket: row.isPartOfSosBracket,
            correctsCheckInId: row.correctsCheckInId,
            supersededAt: iso(row.supersededAt),
            supersededByCheckInId: row.supersededByCheckInId,
            amendableUntil: null, // the list is a history view; the grace is answered by the detail route
          })),
        };
      });
    },

    async getSosAlert(actor, sosAlertId) {
      return withOrgContext(db, ctx(actor), async (tx): Promise<SafetySosAlertView> => {
        const [row] = await tx
          .select()
          .from(SOS)
          .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, actor.organizationId)))
          .limit(1);
        if (!row) throw new NotFoundError("SOS alert");
        const history = await tx
          .select()
          .from(SOS_HISTORY)
          .where(eq(SOS_HISTORY.sosAlertId, sosAlertId))
          .orderBy(asc(SOS_HISTORY.transitionedAt));
        const acks = await tx
          .select()
          .from(ACK)
          .where(eq(ACK.sosAlertId, sosAlertId))
          .orderBy(asc(ACK.acknowledgedAt));
        const narrative = await openCipher(
          decipher,
          actor.organizationId,
          row.resolutionNarrativeCipher,
        );
        return {
          id: row.id,
          providerEntityId: row.providerEntityId,
          postedByMembershipId: row.postedByMembershipId,
          postedAt: isoReq(row.postedAt),
          lastKnownVisitId: row.lastKnownVisitId,
          lifecycleState: row.lifecycleState as SafetySosLifecycleState,
          cancelWindowExpiredAt: isoReq(row.cancelWindowExpiredAt),
          cancelStatus: row.cancelStatus as SafetySosCancelStatus,
          cancelAttemptedAt: iso(row.cancelAttemptedAt),
          acknowledgedAt: iso(row.acknowledgedAt),
          acknowledgedByMembershipId: row.acknowledgedByMembershipId,
          resolvedAt: iso(row.resolvedAt),
          resolvedByMembershipId: row.resolvedByMembershipId,
          outcome: row.outcome as SafetySosOutcome | null,
          resolutionNarrative: narrative.value,
          resolutionNarrativeAvailable: narrative.available,
          linkedIncidentId: row.linkedIncidentId,
          // §3.3 makes the coordinate cipher NOT NULL on this table, so M20-F16's declined-consent press
          // writes a SENTINEL there (./coordinates.ts). That module is the ONE reader of the decision, so
          // this DTO, the `sos_alert_raised` payload and the §4.9 alert cannot drift about whether the
          // responder has a location.
          coordinatesCaptured: coordinatesCaptured(row.postedCoordinatesCipher),
          version: row.version,
          stateHistory: history.map((h) => ({
            fromState: h.fromState as SafetySosLifecycleState | null,
            toState: h.toState as SafetySosLifecycleState,
            transitionedAt: isoReq(h.transitionedAt),
            transitionedByMembershipId: h.transitionedByMembershipId,
          })),
          acknowledgments: acks.map((a) => ({
            id: a.id,
            acknowledgedByMembershipId: a.acknowledgedByMembershipId,
            acknowledgedAt: isoReq(a.acknowledgedAt),
            actionTaken: a.actionTaken,
            outcome: a.outcome,
          })),
        };
      });
    },

    async getLocationStream(actor, sosAlertId, filters) {
      const limit = clampLimit(filters.limit, M20_PAGE_SIZES.locationStream);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      return withOrgContext(db, ctx(actor), async (tx): Promise<SosLocationStreamPage> => {
        const [alert] = await tx
          .select({
            id: SOS.id,
            lifecycleState: SOS.lifecycleState,
            postedByMembershipId: SOS.postedByMembershipId,
          })
          .from(SOS)
          .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, actor.organizationId)))
          .limit(1);
        if (!alert) throw new NotFoundError("SOS alert");

        // Decision 2 — the post-SOS compliance read must say why. During an active alert the responder
        // needs no essay; once the alert closes, §6 makes the coordinate read an escalation with a
        // narrative attached to the audit entry the poster will later see.
        const stillActive = (ACTIVE_SOS_RESPONDER_STATES as readonly string[]).includes(
          alert.lifecycleState,
        );
        if (!stillActive && (filters.accessReason ?? "").trim().length < 40) {
          throw new ChartWardenError(
            "COORDINATE_ACCESS_REASON_REQUIRED",
            "reading a closed alert's coordinate stream requires a ≥40-character reason; the poster sees this access on her own consent surface (§6, §8.7)",
            422,
          );
        }

        const rows = await tx
          .select()
          .from(STREAM)
          .where(
            and(
              eq(STREAM.sosAlertId, sosAlertId),
              eq(STREAM.organizationId, actor.organizationId),
              ...(cursor === null ? [] : [sql`${STREAM.sampledAt} > ${new Date(cursor.a)}`]),
            ),
          )
          .orderBy(asc(STREAM.sampledAt))
          .limit(limit + 1);

        const opened = await Promise.all(
          rows.map(async (r) => {
            const plain = await openCipher(decipher, actor.organizationId, r.coordinatesCipher);
            // An unusable sample is DROPPED below rather than rendered at 0,0 — a real place in the Gulf
            // of Guinea, and the wrong place to put a clinician's marker (./coordinates.ts).
            const decoded = decodeCoordinates(plain.value);
            return {
              row: r,
              latitude: decoded?.lat ?? Number.NaN,
              longitude: decoded?.lng ?? Number.NaN,
            };
          }),
        );
        const usable = opened.filter(
          (o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude),
        );

        const page = toCursorPage(
          actor.organizationId,
          usable,
          limit,
          (o) => ({ a: isoReq(o.row.sampledAt), id: o.row.id }),
          (o) => ({
            id: o.row.id,
            sampledAt: isoReq(o.row.sampledAt),
            latitude: o.latitude,
            longitude: o.longitude,
            accuracyM: o.row.accuracyM,
          }),
        );
        return {
          sosAlertId,
          samples: page.data,
          next_cursor: page.next_cursor,
          has_more: page.has_more,
          auditWarningBanner:
            "Coordinate access is logged; the clinician who raised this alert will see this access on her self-service consent surface.",
        };
      });
    },

    async listActiveSos(actor) {
      const at = now();
      return withOrgContext(db, ctx(actor), async (tx): Promise<ActiveSosView> => {
        const supervisor = decideSafetySupervisorOrAbove(actor.roles);
        const rows = await tx
          .select()
          .from(SOS)
          .where(
            and(
              eq(SOS.organizationId, actor.organizationId),
              sql`${SOS.lifecycleState} IN ${SAFETY_SOS_OPEN_STATES}`,
              // Decision 4 — a clinician with no supervisor grant sees only her own presses.
              ...(supervisor || actor.membershipId === null
                ? []
                : [eq(SOS.postedByMembershipId, actor.membershipId)]),
            ),
          )
          .orderBy(desc(SOS.postedAt))
          .limit(M20_PAGE_SIZES.sosAlerts.maxSize);
        return {
          alerts: rows.map((r) => ({
            id: r.id,
            postedByMembershipId: r.postedByMembershipId,
            // §8.2 minimum-necessary: the board tile carries no name at all. The §5 screen resolves the
            // first name through M2 for the memberships it is entitled to; a name joined in here would
            // travel to every caller of this route regardless of what they may see.
            postedByFirstName: "",
            postedAt: isoReq(r.postedAt),
            lifecycleState: r.lifecycleState as SafetySosLifecycleState,
            minutesOpen: Math.max(0, Math.round((at.getTime() - r.postedAt.getTime()) / 60_000)),
            acknowledgedAt: iso(r.acknowledgedAt),
          })),
          fetchedAt: isoReq(at),
        };
      });
    },

    async getIncident(actor, incidentId) {
      return withOrgContext(db, ctx(actor), async (tx): Promise<SafetyIncidentView> => {
        const [row] = await tx
          .select()
          .from(INCIDENT)
          .where(
            and(eq(INCIDENT.id, incidentId), eq(INCIDENT.organizationId, actor.organizationId)),
          )
          .limit(1);
        if (!row) throw new NotFoundError("safety incident");
        const history = await tx
          .select()
          .from(INCIDENT_HISTORY)
          .where(eq(INCIDENT_HISTORY.incidentId, incidentId))
          .orderBy(asc(INCIDENT_HISTORY.transitionedAt));
        const [narrative, witnesses, actionPlan] = await Promise.all([
          openCipher(decipher, actor.organizationId, row.narrativeCipher),
          openCipher(decipher, actor.organizationId, row.witnessesCipher),
          openCipher(decipher, actor.organizationId, row.actionPlanCipher),
        ]);
        return {
          id: row.id,
          providerEntityId: row.providerEntityId,
          affectedClinicianMembershipId: row.affectedClinicianMembershipId,
          reportedByMembershipId: row.reportedByMembershipId,
          category: row.category as SafetyIncidentCategory,
          severity: row.severity as SafetyIncidentSeverity,
          visitId: row.visitId,
          patientId: row.patientId,
          occurredAt: isoReq(row.occurredAt),
          reportedAt: isoReq(row.reportedAt),
          locationDescription: row.locationDescription,
          narrative: narrative.value,
          narrativeAvailable: narrative.available,
          witnesses: witnesses.value,
          oshaReportable: row.oshaReportable,
          oshaReportableSignedOffByMembershipId: row.oshaReportableSignedOffByMembershipId,
          oshaReportableSignedOffAt: iso(row.oshaReportableSignedOffAt),
          workersCompClaimInitiated: row.workersCompClaimInitiated,
          workersCompClaimReference: row.workersCompClaimReference,
          linkedSosAlertId: row.linkedSosAlertId,
          lifecycleState: row.lifecycleState as SafetyIncidentState,
          submittedAt: iso(row.submittedAt),
          reviewedByMembershipId: row.reviewedByMembershipId,
          reviewedAt: iso(row.reviewedAt),
          actionPlan: actionPlan.value,
          actionPlanAvailable: actionPlan.available,
          closedAt: iso(row.closedAt),
          reopenReason: row.reopenReason,
          version: row.version,
          stateHistory: history.map((h) => ({
            fromState: h.fromState as SafetyIncidentState | null,
            toState: h.toState as SafetyIncidentState,
            transitionedAt: isoReq(h.transitionedAt),
            transitionedByMembershipId: h.transitionedByMembershipId,
            reason: h.reason,
          })),
        };
      });
    },

    async listIncidents(actor, filters) {
      const limit = clampLimit(filters.limit, M20_PAGE_SIZES.incidents);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      const supervisor = decideSafetySupervisorOrAbove(actor.roles);
      return withOrgContext(db, ctx(actor), async (tx): Promise<CursorPage<SafetyIncidentView>> => {
        const rows = await tx
          .select({ id: INCIDENT.id, occurredAt: INCIDENT.occurredAt })
          .from(INCIDENT)
          .where(
            and(
              eq(INCIDENT.organizationId, actor.organizationId),
              ...(filters.lifecycleState === undefined
                ? []
                : [sql`${INCIDENT.lifecycleState} = ${filters.lifecycleState}`]),
              ...(filters.oshaReportable === undefined
                ? []
                : [eq(INCIDENT.oshaReportable, filters.oshaReportable)]),
              // Decision 4's sibling: a clinician with no oversight grant sees only incidents about her.
              ...(supervisor || actor.membershipId === null
                ? []
                : [eq(INCIDENT.affectedClinicianMembershipId, actor.membershipId)]),
              ...(cursor === null ? [] : [lt(INCIDENT.occurredAt, new Date(cursor.a))]),
            ),
          )
          .orderBy(desc(INCIDENT.occurredAt))
          .limit(limit + 1);

        // The detail projection is re-used per row rather than duplicated as a narrower list DTO: one
        // shape, one disclosure gate, no drift (the M16-T06 posture). The cipher opens are what make this
        // costly, and they are exactly what a list of incidents a caller may read is entitled to.
        const views: SafetyIncidentView[] = [];
        for (const r of rows) views.push(await this.getIncident(actor, r.id));
        return toCursorPage(
          actor.organizationId,
          views,
          limit,
          (v) => ({ a: v.occurredAt, id: v.id }),
          (v) => v,
        );
      });
    },

    async getPolicy(actor, asOfIso) {
      return effectivePolicy(actor, asOfIso);
    },

    async listSubscriptions(actor, filters) {
      const limit = clampLimit(filters.limit, M20_PAGE_SIZES.subscriptions);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      return withOrgContext(
        db,
        ctx(actor),
        async (tx): Promise<CursorPage<SafetySubscriptionView>> => {
          const rows = await tx
            .select()
            .from(SUBSCRIPTION)
            .where(
              and(
                eq(SUBSCRIPTION.organizationId, actor.organizationId),
                isNull(SUBSCRIPTION.supersededAt),
                isNull(SUBSCRIPTION.deactivatedAt),
                ...(filters.clinicianMembershipId === undefined
                  ? []
                  : [eq(SUBSCRIPTION.clinicianMembershipId, filters.clinicianMembershipId)]),
                ...(filters.supervisorMembershipId === undefined
                  ? []
                  : [eq(SUBSCRIPTION.supervisorMembershipId, filters.supervisorMembershipId)]),
                ...(cursor === null ? [] : [lt(SUBSCRIPTION.createdAt, new Date(cursor.a))]),
              ),
            )
            .orderBy(desc(SUBSCRIPTION.createdAt))
            .limit(limit + 1);
          return toCursorPage(
            actor.organizationId,
            rows,
            limit,
            (r) => ({ a: isoReq(r.createdAt), id: r.id }),
            (r): SafetySubscriptionView => ({
              id: r.id,
              supervisorMembershipId: r.supervisorMembershipId,
              clinicianMembershipId: r.clinicianMembershipId,
              locationId: r.locationId,
              providerEntityId: r.providerEntityId,
              scopeKind: r.scopeKind as SafetySubscriptionScopeKind,
              alertKinds: r.alertKinds as readonly SafetyAlertKind[],
              isVacationForwarding: r.isVacationForwarding,
              vacationForwardToMembershipId: r.vacationForwardToMembershipId,
              createdAt: isoReq(r.createdAt),
            }),
          );
        },
      );
    },

    async listHighRiskAreas(actor, filters) {
      const limit = clampLimit(filters.limit, M20_PAGE_SIZES.highRiskAreas);
      const cursor = decodeCursor(actor.organizationId, filters.cursor);
      const at = now();
      return withOrgContext(
        db,
        ctx(actor),
        async (tx): Promise<CursorPage<SafetyHighRiskAreaView>> => {
          const rows = await tx
            .select()
            .from(AREA)
            .where(
              and(
                eq(AREA.organizationId, actor.organizationId),
                // Default: only what is IN FORCE. The editor asks for history explicitly; the pre-visit
                // advisory must never surface a polygon that was retired last winter.
                ...(filters.includeExpired === true
                  ? []
                  : [or(isNull(AREA.effectiveTo), sql`${AREA.effectiveTo} > ${at}`) as never]),
                ...(cursor === null ? [] : [lt(AREA.effectiveFrom, new Date(cursor.a))]),
              ),
            )
            .orderBy(desc(AREA.effectiveFrom))
            .limit(limit + 1);
          return toCursorPage(
            actor.organizationId,
            rows,
            limit,
            (r) => ({ a: isoReq(r.effectiveFrom), id: r.id }),
            (r): SafetyHighRiskAreaView => ({
              id: r.id,
              riskCategory: r.riskCategory as SafetyHighRiskCategory,
              advisoryMessage: r.advisoryMessage,
              polygon: r.polygon as SafetyPolygonRings,
              policyForVisitsToArea: r.policyForVisitsToArea as SafetyHighRiskAreaPolicy,
              effectiveFrom: isoReq(r.effectiveFrom),
              effectiveTo: iso(r.effectiveTo),
              createdByMembershipId: r.createdByMembershipId,
            }),
          );
        },
      );
    },

    async getDashboard(actor, filters) {
      // Decision 3 — the board IS the §4.3 seam.
      const provider = getSafetyDashboardProvider();
      const asOf = (filters.asOf ?? now().toISOString()) as IsoInstant;
      const orgId = actor.organizationId as Parameters<
        typeof provider.clinicianStatusForLocation
      >[0];
      const supervisor = decideSafetySupervisorOrAbove(actor.roles);

      const snapshot: SafetyDashboardSnapshot =
        filters.supervisorMembershipId !== undefined
          ? await provider.clinicianStatusForSupervisor(
              orgId,
              filters.supervisorMembershipId as never,
              asOf,
            )
          : filters.locationId !== undefined
            ? await provider.clinicianStatusForLocation(orgId, filters.locationId as never, asOf)
            : supervisor && actor.membershipId !== null
              ? await provider.clinicianStatusForSupervisor(
                  orgId,
                  actor.membershipId as never,
                  asOf,
                )
              : { clinicians: [], activeSosCount: 0, overdueCount: 0, fetchedAt: asOf };

      // Decision 4 — §6's "clinicians see their own state only". Applied AFTER the seam so the tiles are
      // recomputed over the SAME rows the grid shows: a count that outlived its filter is how a board and
      // its own header start to disagree.
      if (supervisor || actor.membershipId === null) return snapshot;
      const mine = snapshot.clinicians.filter((c) => c.membershipId === actor.membershipId);
      return {
        clinicians: mine,
        activeSosCount: mine.filter((c) => c.activeSosAlert !== null).length,
        overdueCount: mine.filter(
          (c) => c.overdueState === "overdue" || c.overdueState === "escalated",
        ).length,
        fetchedAt: snapshot.fetchedAt,
      };
    },

    async getConsentSurface(actor, purpose) {
      const membershipId = actor.membershipId;
      if (membershipId === null) throw new NotFoundError("membership");
      const at = now();
      return withOrgContext(db, ctx(actor), async (tx): Promise<SafetyConsentSurface> => {
        const rows = await tx
          .select()
          .from(CONSENT)
          .where(
            and(
              eq(CONSENT.organizationId, actor.organizationId),
              // §4.6 — `read_self`. The membership comes from the SESSION, never from a query param, so
              // there is no shape in which one clinician reads another's consent row.
              eq(CONSENT.clinicianMembershipId, membershipId),
              ...(purpose === undefined ? [] : [eq(CONSENT.consentPurpose, purpose)]),
            ),
          )
          .orderBy(desc(CONSENT.grantedAt));
        return {
          asOf: isoReq(at),
          consents: rows.map(
            (r): SafetyConsentView => ({
              purpose: r.consentPurpose as SafetyConsentPurpose,
              status: r.status as SafetyEmergencyContactConsentStatus,
              grantedAt: isoReq(r.grantedAt),
              revokedAt: iso(r.revokedAt),
              expiresAt: iso(r.expiresAt),
              acknowledgmentTextSnapshot: r.acknowledgmentTextSnapshot,
              // The scope detail is application-layer ciphertext and stays closed here (see the DTO's
              // doc-comment): a boolean is the honest projection of "we hold a contact for you".
              contactOnFile:
                r.consentPurpose === "emergency_contact_call" &&
                r.consentScopeDetail !== null &&
                typeof r.consentScopeDetail === "object",
            }),
          ),
        };
      });
    },
  };
}
