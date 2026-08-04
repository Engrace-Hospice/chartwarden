// apps/backend/src/modules/20-field-safety/seams/store-drizzle.ts — M20-T05, the Drizzle-backed
// {@link SafetySeamStore} the seven §4.3 published seams read through.
//
// TENANCY. Every read opens `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER's
// ambient request context. That is the whole tenancy story: the providers never switch tenants — M17
// asking for a visit's badge trio gets M17's caller's org because RLS scoped the statement, not because
// this file compared anything (the `orgId` seam argument is asserted against the same scope, never used
// to select). Called outside a request scope it THROWS rather than reading unscoped, which is the correct
// direction for a surface that publishes where a clinician was and what happened to her.
//
// ── NO CIPHER COLUMN IS SELECTED EXCEPT ONE, AND THAT ONE NEVER LEAVES THE MODULE ────────────────────
//
// `resolution_narrative_cipher`, `acknowledger_dispatch_payload_cipher`, `narrative_cipher`,
// `witnesses_cipher`, `action_plan_cipher` and every `location_description` / `reopen_reason` /
// `concern_note` free-text column are §3.6-denylisted and absent from every query below. The single
// exception is `safety_sos_alert.posted_coordinates_cipher`, selected ONLY for the §8.6 incident
// projection, and it is handed up as ciphertext for the provider to open with the injected tenant-DEK
// decipher and round to three decimals INSIDE M20's boundary. No full-precision coordinate and no DEK
// exists on the consumer side of any seam.
//
// `safety_emergency_contact_consent.consent_scope_detail` IS selected, verbatim and unopened, for the
// M20-F06 terminus path — see ./emergency-contact.ts on why it is never parsed here.
//
// ── FIELD ELIGIBILITY HAS NO COLUMN AND THE QUERY SAYS SO ────────────────────────────────────────────
//
// `coverageSubjects` answers "who could be in the field tonight" with `membership.status = 'active' AND
// default_provider_entity_id IS NOT NULL`. M2 has no field-eligibility flag and M20 may not read M3's
// role assignments across a module boundary; a membership with no ProviderEntity has no coverage
// obligation to be gapped against, and `SafetyCoverageSubjectFacts` requires one. The consequence is
// stated in ./store.ts: it OVER-reports (an office coordinator who carries a PE is reported as an
// uncovered clinician), which is the direction ../lifecycle/coverage-gap declares.
//
// `default_location_ids` is jsonb (M1's `membership`), so the location list is read as a JSON array and
// normalized here rather than joined — a `location`-scoped subscription matches any of them.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  IsoInstant,
  MembershipId,
  SafetyCheckInStatus,
  SafetyIncidentCategory,
  SafetyIncidentSeverity,
  SafetySosLifecycleState,
} from "@wardenx/types";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  SafetyCoverageSubjectFacts,
  SafetySubscriptionFacts,
} from "../lifecycle/coverage-gap";
import type { SafetyPolicyVersionFacts } from "../lifecycle/policy";
import type {
  SafetyClinicianBoardFacts,
  SafetyEmergencyContactFacts,
  SafetyIncidentGeoFacts,
  SafetyIncidentSummaryFacts,
  SafetySeamStore,
  SafetySosAfterHoursSample,
  SafetyVisitScheduleFacts,
} from "./store";

const iso = (d: Date | string): IsoInstant =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant;
const isoN = (d: Date | string | null): IsoInstant | null => (d === null ? null : iso(d));

/** §2.2.3 — the states an incident is NO LONGER open in. `reopened` is deliberately absent: new evidence
 *  about a closed incident re-enters review on the SAME row, and M8 authoring an encounter beside it must
 *  see it. */
const CLOSED_INCIDENT_STATES = ["closed_with_action_plan", "closed_no_action"] as const;

/** §2.2.2 — the lifecycle states an SOS is still LIVE in (the §3.4 `ssa_org_active_idx` predicate). */
const ACTIVE_SOS_STATES = ["resolved", "cancelled_in_window", "incident_opened"] as const;

/** M1's `membership.default_location_ids` is jsonb; normalize whatever is stored into a string list. */
function locationIdsOf(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Build the Drizzle-backed §4.3 store. Every method opens its own org-context transaction. */
export function buildDrizzleSafetySeamStore(db: DbClient): SafetySeamStore {
  const t = schema;

  const incidentSummarySelect = {
    incidentId: t.safetyIncident.id,
    category: t.safetyIncident.category,
    severity: t.safetyIncident.severity,
    lifecycleState: t.safetyIncident.lifecycleState,
    occurredAt: t.safetyIncident.occurredAt,
    affectedClinicianMembershipId: t.safetyIncident.affectedClinicianMembershipId,
    visitId: t.safetyIncident.visitId,
    linkedSosAlertId: t.safetyIncident.linkedSosAlertId,
    oshaReportable: t.safetyIncident.oshaReportable,
  } as const;

  type IncidentSummaryRow = {
    incidentId: string;
    category: SafetyIncidentCategory;
    severity: SafetyIncidentSeverity;
    lifecycleState: string;
    occurredAt: Date;
    affectedClinicianMembershipId: string;
    visitId: string | null;
    linkedSosAlertId: string | null;
    oshaReportable: boolean;
  };

  const summaryOf = (row: IncidentSummaryRow): SafetyIncidentSummaryFacts => ({
    incidentId: row.incidentId,
    category: row.category,
    severity: row.severity,
    lifecycleState: row.lifecycleState,
    occurredAt: iso(row.occurredAt),
    affectedClinicianMembershipId: row.affectedClinicianMembershipId,
    visitId: row.visitId,
    linkedSosAlertId: row.linkedSosAlertId,
    oshaReportable: row.oshaReportable,
  });

  /** The `safety_check_in_schedule` rows for one PE inside a window — the denominator of both §4.3 rates. */
  const scheduleWindow = (providerEntityId: string, from: Date, to: Date) =>
    and(
      eq(t.safetyCheckInSchedule.providerEntityId, providerEntityId),
      gte(t.safetyCheckInSchedule.expectedAt, from),
      lt(t.safetyCheckInSchedule.expectedAt, to),
    );

  return {
    // ── SafetyPolicyProvider ─────────────────────────────────────────────────────────────────────────
    async policyVersionAt(asOfIso) {
      const asOf = new Date(asOfIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(t.safetyPolicyVersion)
          .where(
            and(
              lte(t.safetyPolicyVersion.effectiveFrom, asOf),
              or(
                isNull(t.safetyPolicyVersion.effectiveTo),
                sql`${t.safetyPolicyVersion.effectiveTo} > ${asOf}`,
              ),
            ),
          )
          .orderBy(desc(t.safetyPolicyVersion.effectiveFrom))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        const facts: SafetyPolicyVersionFacts = {
          versionId: row.id,
          effectiveFrom: iso(row.effectiveFrom),
          effectiveTo: isoN(row.effectiveTo),
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
          oshaReportableAutoFlagCategories: Array.isArray(row.oshaReportableAutoFlagCategories)
            ? (row.oshaReportableAutoFlagCategories as readonly SafetyIncidentCategory[])
            : [],
        };
        return facts;
      });
    },

    // ── SafetyDashboardProvider / SafetySupervisorProvider ───────────────────────────────────────────
    async coverageSubjects() {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            membershipId: t.memberships.id,
            defaultLocationIds: t.memberships.defaultLocationIds,
            providerEntityId: t.memberships.defaultProviderEntityId,
          })
          .from(t.memberships)
          .where(
            and(
              eq(t.memberships.status, "active"),
              isNotNull(t.memberships.defaultProviderEntityId),
            ),
          );
        return rows.map(
          (r): SafetyCoverageSubjectFacts => ({
            membershipId: r.membershipId,
            locationIds: locationIdsOf(r.defaultLocationIds),
            providerEntityId: r.providerEntityId as string,
            isFieldEligible: true,
            // Filled by the provider from `membershipsWithInactiveSubscriptions` — the roster query has
            // no business joining the subscription table for a flag one caller needs.
            hasInactiveSubscriptions: false,
          }),
        );
      });
    },

    async boardFactsForMemberships(membershipIds, asOfIso) {
      if (membershipIds.length === 0) return [];
      const asOf = new Date(asOfIso);
      const ids = [...membershipIds];
      return withOrgContextFromRequest(db, async (tx) => {
        const [names, lastCheckIns, nextObligations, activeSos] = await Promise.all([
          tx
            .select({ membershipId: t.memberships.id, name: t.users.name })
            .from(t.memberships)
            .innerJoin(t.users, eq(t.users.id, t.memberships.userId))
            .where(inArray(t.memberships.id, ids)),
          // The newest LIVE post per clinician. `superseded_at IS NULL` because a correction-of-record
          // replaced the original (§2.2.1) and the board must show the standing attestation.
          tx
            .select({
              membershipId: t.safetyCheckIn.postedByMembershipId,
              postedAt: t.safetyCheckIn.postedAt,
              status: t.safetyCheckIn.status,
            })
            .from(t.safetyCheckIn)
            .where(
              and(
                inArray(t.safetyCheckIn.postedByMembershipId, ids),
                isNull(t.safetyCheckIn.supersededAt),
                lte(t.safetyCheckIn.postedAt, asOf),
              ),
            )
            .orderBy(desc(t.safetyCheckIn.postedAt)),
          // The EARLIEST unfulfilled obligation. `proposed`/`overdue`/`escalated` is the §3.4
          // `scis_overdue_scan_idx` predicate — the same three states the D4 detector walks, so the badge
          // and the escalation ladder can never disagree about which obligation is live.
          tx
            .select({
              membershipId: t.safetyCheckInSchedule.clinicianMembershipId,
              expectedAt: t.safetyCheckInSchedule.expectedAt,
              windowMinutes: t.safetyCheckInSchedule.windowMinutes,
            })
            .from(t.safetyCheckInSchedule)
            .where(
              and(
                inArray(t.safetyCheckInSchedule.clinicianMembershipId, ids),
                inArray(t.safetyCheckInSchedule.state, ["proposed", "overdue", "escalated"]),
              ),
            )
            .orderBy(t.safetyCheckInSchedule.expectedAt),
          tx
            .select({
              membershipId: t.safetySosAlert.postedByMembershipId,
              id: t.safetySosAlert.id,
              postedAt: t.safetySosAlert.postedAt,
              lifecycleState: t.safetySosAlert.lifecycleState,
            })
            .from(t.safetySosAlert)
            .where(
              and(
                inArray(t.safetySosAlert.postedByMembershipId, ids),
                sql`${t.safetySosAlert.lifecycleState} NOT IN ${ACTIVE_SOS_STATES}`,
              ),
            )
            .orderBy(desc(t.safetySosAlert.postedAt)),
        ]);

        const nameOf = new Map(names.map((r) => [r.membershipId, r.name ?? ""]));
        const firstBy = <T extends { membershipId: string }>(rows: readonly T[]) => {
          const out = new Map<string, T>();
          for (const row of rows) if (!out.has(row.membershipId)) out.set(row.membershipId, row);
          return out;
        };
        const lastCheckIn = firstBy(lastCheckIns);
        const nextObligation = firstBy(nextObligations);
        const sos = firstBy(activeSos);

        return ids.map((membershipId): SafetyClinicianBoardFacts => {
          const check = lastCheckIn.get(membershipId);
          const next = nextObligation.get(membershipId);
          const alert = sos.get(membershipId);
          return {
            membershipId,
            displayName: nameOf.get(membershipId) ?? "",
            lastCheckInAt: check === undefined ? null : iso(check.postedAt),
            lastCheckInStatus: check === undefined ? null : (check.status as SafetyCheckInStatus),
            nextExpectedCheckInAt: next === undefined ? null : iso(next.expectedAt),
            nextExpectedWindowMinutes: next?.windowMinutes ?? null,
            activeSosAlert:
              alert === undefined
                ? null
                : {
                    id: alert.id,
                    raisedAt: iso(alert.postedAt),
                    lifecycleState: alert.lifecycleState as SafetySosLifecycleState,
                  },
          };
        });
      });
    },

    // ── SafetyContextReader ─────────────────────────────────────────────────────────────────────────
    async openIncidentForVisit(visitId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select(incidentSummarySelect)
          .from(t.safetyIncident)
          .where(
            and(
              eq(t.safetyIncident.visitId, visitId),
              sql`${t.safetyIncident.lifecycleState} NOT IN ${CLOSED_INCIDENT_STATES}`,
            ),
          )
          .orderBy(desc(t.safetyIncident.occurredAt))
          .limit(1);
        const row = rows[0];
        return row === undefined ? null : summaryOf(row as IncidentSummaryRow);
      });
    },

    async incidentsForClinicianOnDate(clinicianMembershipId, asOfDate) {
      return withOrgContextFromRequest(db, async (tx) => {
        // The date is compared in UTC. §4.3 takes an `IsoDate` with no zone and M20 has no org-timezone
        // column to resolve one from; the caller that knows the org's zone (M8's authoring surface) picks
        // the date, and the boundary error is at most one visit at the edge of a day on a NON-gating
        // context badge. Naming it here beats a silent `AT TIME ZONE` guess.
        const rows = await tx
          .select(incidentSummarySelect)
          .from(t.safetyIncident)
          .where(
            and(
              eq(t.safetyIncident.affectedClinicianMembershipId, clinicianMembershipId),
              sql`${t.safetyIncident.occurredAt}::date = ${asOfDate}::date`,
            ),
          )
          .orderBy(desc(t.safetyIncident.occurredAt));
        return rows.map((r) => summaryOf(r as IncidentSummaryRow));
      });
    },

    // ── SafetyIncidentReader (§8.6) ─────────────────────────────────────────────────────────────────
    async incidentGeoFactsSince(sinceIso) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            incidentId: t.safetyIncident.id,
            category: t.safetyIncident.category,
            severity: t.safetyIncident.severity,
            occurredAt: t.safetyIncident.occurredAt,
            cipher: t.safetySosAlert.postedCoordinatesCipher,
          })
          .from(t.safetyIncident)
          .leftJoin(t.safetySosAlert, eq(t.safetySosAlert.id, t.safetyIncident.linkedSosAlertId))
          .where(gte(t.safetyIncident.occurredAt, new Date(sinceIso)))
          .orderBy(desc(t.safetyIncident.occurredAt));
        return rows.map(
          (r): SafetyIncidentGeoFacts => ({
            incidentId: r.incidentId,
            category: r.category,
            severity: r.severity,
            occurredAt: iso(r.occurredAt),
            linkedSosCoordinatesCipher: r.cipher ?? null,
          }),
        );
      });
    },

    async incidentGeoFactsForClinicianSince(clinicianMembershipId, sinceIso) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            incidentId: t.safetyIncident.id,
            category: t.safetyIncident.category,
            severity: t.safetyIncident.severity,
            occurredAt: t.safetyIncident.occurredAt,
            cipher: t.safetySosAlert.postedCoordinatesCipher,
          })
          .from(t.safetyIncident)
          .leftJoin(t.safetySosAlert, eq(t.safetySosAlert.id, t.safetyIncident.linkedSosAlertId))
          .where(
            and(
              eq(t.safetyIncident.affectedClinicianMembershipId, clinicianMembershipId),
              gte(t.safetyIncident.occurredAt, new Date(sinceIso)),
            ),
          )
          .orderBy(desc(t.safetyIncident.occurredAt));
        return rows.map(
          (r): SafetyIncidentGeoFacts => ({
            incidentId: r.incidentId,
            category: r.category,
            severity: r.severity,
            occurredAt: iso(r.occurredAt),
            linkedSosCoordinatesCipher: r.cipher ?? null,
          }),
        );
      });
    },

    // ── SafetyMetricsProvider ───────────────────────────────────────────────────────────────────────
    async sosCount(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(t.safetySosAlert)
          .where(
            and(
              eq(t.safetySosAlert.providerEntityId, providerEntityId),
              gte(t.safetySosAlert.postedAt, new Date(window.from)),
              lt(t.safetySosAlert.postedAt, new Date(window.to)),
            ),
          );
        return rows[0]?.n ?? 0;
      });
    },

    async incidentCount(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(t.safetyIncident)
          .where(
            and(
              eq(t.safetyIncident.providerEntityId, providerEntityId),
              gte(t.safetyIncident.occurredAt, new Date(window.from)),
              lt(t.safetyIncident.occurredAt, new Date(window.to)),
            ),
          );
        return rows[0]?.n ?? 0;
      });
    },

    async observedVisitCount(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ n: sql<number>`count(distinct ${t.safetyCheckInSchedule.visitId})::int` })
          .from(t.safetyCheckInSchedule)
          .where(
            and(
              scheduleWindow(providerEntityId, new Date(window.from), new Date(window.to)),
              isNotNull(t.safetyCheckInSchedule.visitId),
            ),
          );
        return rows[0]?.n ?? 0;
      });
    },

    async overdueCounts(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            denominator: sql<number>`count(*)::int`,
            numerator: sql<number>`count(*) filter (where ${t.safetyCheckInSchedule.overdueDetectedAt} is not null)::int`,
          })
          .from(t.safetyCheckInSchedule)
          .where(scheduleWindow(providerEntityId, new Date(window.from), new Date(window.to)));
        // `overdue_detected_at` rather than the CURRENT state: an obligation that went overdue and was
        // then answered is back in `recorded`, and counting states would report the late check-in as
        // on-time. The stamp is what §3.3's `m20_scis_overdue_stamped` CHECK guarantees is there.
        return { numerator: rows[0]?.numerator ?? 0, denominator: rows[0]?.denominator ?? 0 };
      });
    },

    async checkInComplianceCounts(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            denominator: sql<number>`count(*)::int`,
            numerator: sql<number>`count(*) filter (where ${t.safetyCheckInSchedule.fulfilledByCheckInId} is not null)::int`,
          })
          .from(t.safetyCheckInSchedule)
          .where(scheduleWindow(providerEntityId, new Date(window.from), new Date(window.to)));
        return { numerator: rows[0]?.numerator ?? 0, denominator: rows[0]?.denominator ?? 0 };
      });
    },

    async sosResponseSeconds(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            seconds: sql<number>`extract(epoch from (${t.safetySosAlert.acknowledgedAt} - ${t.safetySosAlert.postedAt}))::float8`,
          })
          .from(t.safetySosAlert)
          .where(
            and(
              eq(t.safetySosAlert.providerEntityId, providerEntityId),
              gte(t.safetySosAlert.postedAt, new Date(window.from)),
              lt(t.safetySosAlert.postedAt, new Date(window.to)),
              isNotNull(t.safetySosAlert.acknowledgedAt),
            ),
          );
        return rows.map((r) => Number(r.seconds));
      });
    },

    async afterHoursSosSamples(providerEntityId, window) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            postedAt: t.safetySosAlert.postedAt,
            // The window off the version the ALERT pinned, never today's — §2.2.4's whole point.
            afterHoursStartHour: t.safetyPolicyVersion.afterHoursStartHour,
            afterHoursEndHour: t.safetyPolicyVersion.afterHoursEndHour,
          })
          .from(t.safetySosAlert)
          .innerJoin(
            t.safetyPolicyVersion,
            eq(t.safetyPolicyVersion.id, t.safetySosAlert.safetyPolicyVersionId),
          )
          .where(
            and(
              eq(t.safetySosAlert.providerEntityId, providerEntityId),
              gte(t.safetySosAlert.postedAt, new Date(window.from)),
              lt(t.safetySosAlert.postedAt, new Date(window.to)),
            ),
          );
        return rows.map(
          (r): SafetySosAfterHoursSample => ({
            postedAt: iso(r.postedAt),
            afterHoursStartHour: r.afterHoursStartHour,
            afterHoursEndHour: r.afterHoursEndHour,
          }),
        );
      });
    },

    // ── SafetyCheckInProvider ───────────────────────────────────────────────────────────────────────
    async scheduleFactsForVisit(visitId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            kind: t.safetyCheckInSchedule.kind,
            expectedAt: t.safetyCheckInSchedule.expectedAt,
            windowMinutes: t.safetyCheckInSchedule.windowMinutes,
            state: t.safetyCheckInSchedule.state,
          })
          .from(t.safetyCheckInSchedule)
          .where(eq(t.safetyCheckInSchedule.visitId, visitId))
          .orderBy(t.safetyCheckInSchedule.expectedAt);
        return rows.map(
          (r): SafetyVisitScheduleFacts => ({
            kind: r.kind,
            expectedAt: iso(r.expectedAt),
            windowMinutes: r.windowMinutes,
            state: r.state,
          }),
        );
      });
    },

    // ── SafetySupervisorProvider ────────────────────────────────────────────────────────────────────
    async activeSubscriptions() {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(t.safetySupervisorSubscription)
          .where(
            and(
              isNull(t.safetySupervisorSubscription.supersededAt),
              isNull(t.safetySupervisorSubscription.deactivatedAt),
            ),
          );
        return rows.map(
          (r): SafetySubscriptionFacts => ({
            supervisorMembershipId: r.supervisorMembershipId,
            scopeKind: r.scopeKind as SafetySubscriptionFacts["scopeKind"],
            clinicianMembershipId: r.clinicianMembershipId,
            locationId: r.locationId,
            providerEntityId: r.providerEntityId,
            alertKinds: r.alertKinds,
            isVacationForwarding: r.isVacationForwarding,
            vacationForwardToMembershipId: r.vacationForwardToMembershipId,
          }),
        );
      });
    },

    async membershipsWithInactiveSubscriptions() {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .selectDistinct({
            clinicianMembershipId: t.safetySupervisorSubscription.clinicianMembershipId,
          })
          .from(t.safetySupervisorSubscription)
          .where(
            and(
              isNotNull(t.safetySupervisorSubscription.clinicianMembershipId),
              or(
                isNotNull(t.safetySupervisorSubscription.supersededAt),
                isNotNull(t.safetySupervisorSubscription.deactivatedAt),
              ),
            ),
          );
        // Only `explicit` rows carry a clinician id, so this set answers the §7.8 distinction exactly for
        // the clinicians who were ever named directly. A clinician who was only ever covered by a
        // location- or role-scoped row that has since been deactivated reads as `no_subscription` — which
        // is the same fix (add a row) and the safer of the two labels to be wrong in.
        return new Set(
          rows.map((r) => r.clinicianMembershipId).filter((id): id is MembershipId => id !== null),
        );
      });
    },

    async activeMembershipIds(membershipIds) {
      if (membershipIds.length === 0) return new Set<MembershipId>();
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ id: t.memberships.id })
          .from(t.memberships)
          .where(
            and(inArray(t.memberships.id, [...membershipIds]), eq(t.memberships.status, "active")),
          );
        return new Set(rows.map((r) => r.id));
      });
    },

    // ── §4.5 composition + M20-F06 ──────────────────────────────────────────────────────────────────
    async userIdsForMemberships(membershipIds) {
      if (membershipIds.length === 0) return new Map<MembershipId, string>();
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ id: t.memberships.id, userId: t.memberships.userId })
          .from(t.memberships)
          .where(inArray(t.memberships.id, [...membershipIds]));
        return new Map(rows.map((r) => [r.id, r.userId]));
      });
    },

    async emergencyContactConsent(clinicianMembershipId, asOfIso) {
      const asOf = new Date(asOfIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            consentId: t.safetyEmergencyContactConsent.id,
            clinicianMembershipId: t.safetyEmergencyContactConsent.clinicianMembershipId,
            consentPurpose: t.safetyEmergencyContactConsent.consentPurpose,
            grantedAt: t.safetyEmergencyContactConsent.grantedAt,
            expiresAt: t.safetyEmergencyContactConsent.expiresAt,
            consentScopeDetail: t.safetyEmergencyContactConsent.consentScopeDetail,
          })
          .from(t.safetyEmergencyContactConsent)
          .where(
            and(
              eq(t.safetyEmergencyContactConsent.clinicianMembershipId, clinicianMembershipId),
              eq(t.safetyEmergencyContactConsent.consentPurpose, "emergency_contact_call"),
              // §2.2.8 — `granted` only. `expired` is not a revocation and `revoked` is not an expiry,
              // but neither is permission to dial.
              eq(t.safetyEmergencyContactConsent.status, "granted"),
              lte(t.safetyEmergencyContactConsent.grantedAt, asOf),
              or(
                isNull(t.safetyEmergencyContactConsent.expiresAt),
                sql`${t.safetyEmergencyContactConsent.expiresAt} > ${asOf}`,
              ),
            ),
          )
          .orderBy(desc(t.safetyEmergencyContactConsent.grantedAt))
          .limit(1);
        const row = rows[0];
        return row === undefined
          ? null
          : ({
              consentId: row.consentId,
              clinicianMembershipId: row.clinicianMembershipId,
              consentPurpose: "emergency_contact_call",
              grantedAt: iso(row.grantedAt),
              expiresAt: isoN(row.expiresAt),
              consentScopeDetail: row.consentScopeDetail,
            } satisfies SafetyEmergencyContactFacts);
      });
    },
  };
}
