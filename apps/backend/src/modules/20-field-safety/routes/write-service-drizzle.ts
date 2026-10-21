// apps/backend/src/modules/20-field-safety/routes/write-service-drizzle.ts — the Drizzle-backed M20 WRITE
// service (§4.1's POST/PATCH/DELETE rows).
//
// Shape of EVERY command: open `withOrgContext` (RLS pins app.org_id) → load the aggregate row → run the
// PURE §2.2 decision (`../lifecycle`) over already-resolved facts → execute the transition's DECLARED side
// effects (`./effects-runner`) and apply the row change under the §2.5 optimistic-concurrency guard →
// emit the §4.10 outbox event on the SAME tx. No business rule lives in SQL, and no event can outlive a
// rolled-back write (§2.4).
//
// ── SEVEN DECISIONS THAT ARE LOAD-BEARING AND EASY TO GET BACKWARDS ─────────────────────────────────
//
//   1. AN INCIDENT CANNOT BE CREATED WITHOUT A BOUND CIPHER, AND THAT IS THE FAIL-CLOSED ANSWER.
//      `safety_incident.narrative_cipher` is NOT NULL and holds the substance of a workers-comp record.
//      With no per-tenant DEK binding (Phase 1 has none for M20) the only alternatives are to refuse or
//      to write cleartext into a column named `_cipher`. The second is strictly worse than the first: the
//      §3.7 eraser would later report the narrative destroyed while the plaintext sat in a backup. So the
//      create refuses with 503 `SAFETY_CIPHER_UNBOUND` and says why. Every OTHER incident route — submit,
//      transition, OSHA sign-off — works without a cipher, because none of them writes prose.
//   2. THE SOS PRESS NEVER REFUSES FOR A CIPHER, A CONSENT OR AN ATTESTATION. M20-F16 / S13: a clinician
//      who declined `sos_coordinates`, or whose org has no DEK bound, or whose device is unattested, still
//      presses the button and still gets the full fan-out. The coordinate is replaced by the
//      ./coordinates.ts sentinel and a WARNING rides the response; §3.3's NOT NULL columns are satisfied
//      without inventing a location. This is the one asymmetry in the module and it is deliberate.
//   3. THE ALERT FAN-OUT HAPPENS AT THE PRESS, INSIDE THE SAME EFFECT LIST (M20-T03's property 1), but
//      the M36 emit itself is BEST-EFFORT and outside the transaction's failure path (effects-runner rule
//      4). §9.7 budgets 300 ms for the raise; waiting on a fan-out would blow it, and a failed SMS gateway
//      must not roll back a call for help.
//   4. `acknowledgersDispatched` IS THREE-VALUED AND THE THIRD VALUE IS `null`. The §4.5 composed resolver
//      answers with a recipient count, `[]` (a real coverage gap), or throws (M20's registry could not be
//      read). `null` is the third case, and the mobile client renders it as the D15 `tel:` direct-dial
//      fallback rather than as "0 recipients" — "nobody is subscribed" and "we could not ask" are
//      different facts and only one of them is the tenant's fault.
//   5. A REJECTED CANCEL IS A 200, NOT A 4xx. §7.4's hostile-actor path: someone else holds the device and
//      taps cancel. Returning an error would tell them their tap did something. The response says
//      `cancel_attempted_but_rejected` and the alert proceeds exactly as if no cancel happened — including
//      the lifecycle state, which does NOT move (M20-T03's property 2: migration 0110's `ssa_sla_scan_idx`
//      does not cover a `cancel_attempted_but_rejected` LIFECYCLE, so parking there would stop the ladder).
//   6. THE POLICY EDIT WRITES A NEW VERSION ROW, NEVER AN UPDATE. §2.2.4's whole design is that every
//      other M20 row PINS the version it was written under, so a 2031 review of a 2026 incident reads the
//      2026 thresholds. An UPDATE would retroactively rewrite what was in force during an incident.
//   7. DEACTIVATING A SUBSCRIPTION SUCCEEDS EVEN WHEN IT CREATES A GAP, AND SAYS SO. Refusing would leave
//      a departed supervisor's row in place, which is the `all_subscriptions_deactivated` failure one step
//      earlier. The gaps ride the response (the only moment they are cheap to fix) AND the §7.8 watchdog's
//      own system-locked critical alert, because a DON who ignored the response still gets woken.
import { type DbClient, schema } from "@chartwarden/db";
import { normalizeE164 } from "@chartwarden/shared/phone";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type IsoInstant,
  NotFoundError,
  SAFETY_INCIDENT_CLOSED_STATES,
  SAFETY_SCHEDULE_ACTIONABLE_STATES,
  type SafetyCoverageGapDto,
  type SafetyPolicyEffectiveDto,
  type SafetyPolygonRings,
  type SafetySosLifecycleState,
  ChartWardenError,
} from "@chartwarden/types";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  buildCheckInOverdueAlert,
  buildIncidentSubmittedAlert,
  buildOshaFiledAlert,
  buildPolicyChangedAlert,
  buildSosAcknowledgedAlert,
  buildSosRaisedAlert,
  buildSosResolvedAlert,
} from "../alerts";
import { detectCoverageGaps } from "../lifecycle/coverage-gap";
import type { SafetySideEffect } from "../lifecycle/effects";
import { requireSafety } from "../lifecycle/errors";
import {
  assertPolicyEditValid,
  mergeEffectivePolicy,
  policyThresholdDiffs,
  safetyPolicyFloorSeed,
} from "../lifecycle/policy";
import {
  type SafetySosAlertFacts,
  acknowledgeSos as acknowledgeSosDecision,
  assertSosVersion,
  beginSosResolution,
  cancelSos as cancelSosDecision,
  openIncidentFromSos,
  raiseSosEffects,
  resolveSos as resolveSosDecision,
} from "../lifecycle/sos-alert";
import { EMERGENCY_CONTACT_DEFAULT_REGION } from "../terminus/contact";
import type { M20WriteActor } from "./actor";
import { providerEntityOf } from "./actor";
import { SAFETY_NO_COORDINATE_SENTINEL, encodeCoordinates } from "./coordinates";
import { type EffectPatch, type SosStateHistoryPort, runEffects } from "./effects-runner";
import type { M20ReadService } from "./read-service";
import { CHECK_IN_AMENDMENT_GRACE_MINUTES } from "./read-service-drizzle";
import type {
  AcknowledgeSosInput,
  AlertPort,
  CoordinateInput,
  CreateHighRiskAreaInput,
  CreateIncidentInput,
  CreateSubscriptionInput,
  GrantConsentInput,
  M20WriteService,
  OshaSignoffInput,
  PatchHighRiskAreaInput,
  PatchIncidentInput,
  PatchPolicyInput,
  RaiseSosInput,
  RecordCheckInInput,
  SafetyCipherPort,
  SubmitIncidentInput,
  TransitionIncidentInput,
  WriteOutboxPort,
} from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

const iso = (d: Date | string): IsoInstant =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant;

/** Decision 1 — refused rather than written as cleartext into a column named `_cipher`. */
function cipherUnbound(what: string): never {
  throw new ChartWardenError(
    "SAFETY_CIPHER_UNBOUND",
    `no per-tenant DEK envelope is bound for M20, so ${what} cannot be stored encrypted; writing it in the clear into a column named _cipher would make the §3.7 erasure a lie`,
    503,
  );
}

/** Deps the composition root binds. */
export interface M20WriteDeps {
  readonly outbox?: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly now?: () => Date;
  readonly cipher?: SafetyCipherPort;
  /**
   * §4.5 — how many recipients the composed resolver produced for this press. `null` when M20's own
   * supervisor registry could not be read (decision 4). Injected rather than called directly so the write
   * service takes no seam dependency and §9.1 can drive both arms.
   */
  readonly recipientCountFor?: (input: {
    readonly organizationId: string;
    readonly clinicianMembershipId: string;
    readonly providerEntityId: string;
    readonly atIso: string;
  }) => Promise<number | null>;
}

export function buildDrizzleM20WriteService(
  db: DbClient,
  readService: M20ReadService,
  deps: M20WriteDeps = {},
): M20WriteService {
  const CHECK_IN = schema.safetyCheckIn;
  const SCHEDULE = schema.safetyCheckInSchedule;
  const SOS = schema.safetySosAlert;
  const SOS_HISTORY = schema.safetySosAlertStateHistory;
  const ACK = schema.safetyAcknowledgment;
  const INCIDENT = schema.safetyIncident;
  const INCIDENT_HISTORY = schema.safetyIncidentStateHistory;
  const POLICY = schema.safetyPolicy;
  const POLICY_VERSION = schema.safetyPolicyVersion;
  const SUBSCRIPTION = schema.safetySupervisorSubscription;
  const AREA = schema.safetyHighRiskArea;
  const CONSENT = schema.safetyEmergencyContactConsent;
  const MEMBERSHIP = schema.memberships;

  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const alerts = deps.alerts;
  const now = deps.now ?? (() => new Date());

  const ctx = (actor: M20WriteActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  /** The runner's ONE child-row write (see effects-runner's header on why the runner owns it). */
  const stateHistory: SosStateHistoryPort = {
    async insert(tx, row) {
      await (tx as Tx).insert(SOS_HISTORY).values({
        organizationId: row.organizationId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        sosAlertId: row.sosAlertId,
        fromState: row.fromState as never,
        toState: row.toState as never,
        transitionedAt: row.transitionedAt,
        transitionedByMembershipId: row.transitionedByMembershipId,
        reason: row.reason,
      });
    },
  };

  /**
   * §2.2.4 / §3.2 Phase E — the tenant's policy row + its version in force, created from the platform
   * FLOOR on first use.
   *
   * Every PHI row M20 writes carries `safety_policy_version_id NOT NULL`, so a tenant with no policy row
   * yet could not raise an SOS at all. Seeding the floor on first write is what §3.2 Phase E describes,
   * and it is safe precisely because the floor is the STRICTEST configuration — an agency that has never
   * opened the policy editor gets the tightest watch, not the loosest.
   */
  async function ensurePolicyVersion(
    tx: Tx,
    actor: M20WriteActor,
    at: Date,
  ): Promise<{ policyId: string; versionId: string }> {
    const [existing] = await tx
      .select({ id: POLICY.id, currentVersionId: POLICY.currentVersionId })
      .from(POLICY)
      .where(eq(POLICY.organizationId, actor.organizationId))
      .limit(1);

    let policyId = existing?.id;
    if (policyId === undefined) {
      const [created] = await tx
        .insert(POLICY)
        .values({
          organizationId: actor.organizationId,
          createdByMembershipId: actor.membershipId,
        })
        .returning({ id: POLICY.id });
      policyId = (created as { id: string }).id;
    }

    const [version] = await tx
      .select({ id: POLICY_VERSION.id })
      .from(POLICY_VERSION)
      .where(
        and(
          eq(POLICY_VERSION.organizationId, actor.organizationId),
          isNull(POLICY_VERSION.effectiveTo),
        ),
      )
      .orderBy(desc(POLICY_VERSION.effectiveFrom))
      .limit(1);
    if (version) return { policyId, versionId: version.id };

    const floor = safetyPolicyFloorSeed();
    const [seeded] = await tx
      .insert(POLICY_VERSION)
      .values({
        organizationId: actor.organizationId,
        safetyPolicyId: policyId,
        ...floor,
        oshaReportableAutoFlagCategories: floor.oshaReportableAutoFlagCategories as never,
        effectiveFrom: at,
        effectiveTo: null,
        createdByMembershipId: actor.membershipId,
        editReason: null,
      })
      .returning({ id: POLICY_VERSION.id });
    const versionId = (seeded as { id: string }).id;
    await tx
      .update(POLICY)
      .set({ currentVersionId: versionId, updatedAt: at })
      .where(eq(POLICY.id, policyId));
    return { policyId, versionId };
  }

  /** §2.2.8 — is `purpose` an ACTIVE consent for this membership at `at`? */
  async function consentActive(
    tx: Tx,
    actor: M20WriteActor,
    membershipId: string,
    purpose: string,
    at: Date,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ status: CONSENT.status, expiresAt: CONSENT.expiresAt })
      .from(CONSENT)
      .where(
        and(
          eq(CONSENT.organizationId, actor.organizationId),
          eq(CONSENT.clinicianMembershipId, membershipId),
          eq(CONSENT.consentPurpose, purpose),
          eq(CONSENT.status, "granted"),
        ),
      )
      .limit(1);
    if (!row) return false;
    // The tenant's rotation sweep flips `status` on a schedule; between the expiry instant and the next
    // sweep the row LIES. Reading the timestamp rather than trusting the enum closes that window
    // (../lifecycle/location-stream.ts makes the same argument for the stream gate).
    return row.expiresAt === null || row.expiresAt.getTime() > at.getTime();
  }

  /** Encrypt free text under the tenant DEK, or refuse (decision 1). */
  async function seal(actor: M20WriteActor, plaintext: string, what: string): Promise<Buffer> {
    const port = deps.cipher;
    if (port === undefined) cipherUnbound(what);
    return port.encrypt({ organizationId: actor.organizationId, plaintext });
  }

  /**
   * M20-F16 / decision 2 — the coordinate triple for an SOS press.
   *
   * Returns the SENTINEL (never a fabricated location) when the clinician has not consented OR when no
   * DEK is bound. Both produce a coordinate-free alert that still fans out; the WARNING tells the
   * clinician which of the two happened, because "you declined" and "your agency has no key" are
   * different facts about the same missing map pin.
   */
  async function sosCoordinateTriple(
    tx: Tx,
    actor: M20WriteActor,
    input: CoordinateInput | undefined,
    at: Date,
  ): Promise<{
    cipher: Buffer;
    accuracyM: number;
    consentAt: Date;
    warning: { code: string; message: string } | null;
  }> {
    if (input === undefined) {
      return {
        cipher: SAFETY_NO_COORDINATE_SENTINEL,
        accuracyM: 0,
        consentAt: at,
        warning: {
          code: "COORDINATES_ABSENT",
          message:
            "the alert was raised without a location; responders are told there is no position rather than shown a stale one",
        },
      };
    }
    if (!(await consentActive(tx, actor, actor.membershipId, "sos_coordinates", at))) {
      return {
        cipher: SAFETY_NO_COORDINATE_SENTINEL,
        accuracyM: 0,
        consentAt: at,
        warning: {
          code: "COORDINATES_DROPPED_NO_CONSENT",
          message:
            "you have not granted `sos_coordinates` consent, so the location was discarded; the alert still went out (M20-F16)",
        },
      };
    }
    const port = deps.cipher;
    if (port === undefined) {
      return {
        cipher: SAFETY_NO_COORDINATE_SENTINEL,
        accuracyM: 0,
        consentAt: at,
        warning: {
          code: "COORDINATES_DROPPED_NO_CIPHER",
          message:
            "no per-tenant encryption key is bound, so the location was discarded rather than stored in the clear; the alert still went out",
        },
      };
    }
    return {
      cipher: await port.encrypt({
        organizationId: actor.organizationId,
        plaintext: encodeCoordinates(input),
      }),
      accuracyM: input.accuracyM,
      consentAt: at,
      warning: null,
    };
  }

  /** The §4.10 payload base every M20 event carries. */
  const eventBase = (providerEntityId: string, actor: M20WriteActor, at: Date) => ({
    orgId: actor.organizationId,
    providerEntityId,
    occurredAt: iso(at),
  });

  /** Load an SOS row for a transition, or 404. */
  async function loadSos(tx: Tx, actor: M20WriteActor, sosAlertId: string) {
    const [row] = await tx
      .select()
      .from(SOS)
      .where(and(eq(SOS.id, sosAlertId), eq(SOS.organizationId, actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("SOS alert");
    return row;
  }

  const sosFactsOf = (row: {
    lifecycleState: string;
    version: number;
    postedByMembershipId: string;
    postedAt: Date;
    cancelWindowExpiredAt: Date;
    cancelStatus: string;
    lastKnownVisitId: string | null;
    linkedIncidentId: string | null;
  }): SafetySosAlertFacts => ({
    lifecycleState: row.lifecycleState as SafetySosAlertFacts["lifecycleState"],
    version: row.version,
    postedByMembershipId: row.postedByMembershipId as SafetySosAlertFacts["postedByMembershipId"],
    postedAt: iso(row.postedAt),
    cancelWindowExpiredAt: iso(row.cancelWindowExpiredAt),
    cancelStatus: row.cancelStatus as SafetySosAlertFacts["cancelStatus"],
    lastKnownVisitId: row.lastKnownVisitId as SafetySosAlertFacts["lastKnownVisitId"],
    linkedIncidentId: row.linkedIncidentId as SafetySosAlertFacts["linkedIncidentId"],
  });

  /** Apply the accumulated patch + bump `version` under the §2.5 guard (409 `STALE_LIFECYCLE_STATE`). */
  async function applySosPatch(
    tx: Tx,
    sosAlertId: string,
    currentVersion: number,
    patch: EffectPatch,
    at: Date,
  ): Promise<number> {
    const nextVersion = currentVersion + 1;
    const updated = await tx
      .update(SOS)
      .set({
        ...(patch.lifecycleState ? { lifecycleState: patch.lifecycleState as never } : {}),
        ...(patch.cancelStatus ? { cancelStatus: patch.cancelStatus as never } : {}),
        ...(patch.cancelBiometricResult
          ? { cancelBiometricResult: patch.cancelBiometricResult }
          : {}),
        ...(patch.cancelAttemptedAt ? { cancelAttemptedAt: patch.cancelAttemptedAt } : {}),
        ...(patch.acknowledgedAt ? { acknowledgedAt: patch.acknowledgedAt } : {}),
        ...(patch.acknowledgedByMembershipId
          ? { acknowledgedByMembershipId: patch.acknowledgedByMembershipId }
          : {}),
        ...(patch.resolvedAt ? { resolvedAt: patch.resolvedAt } : {}),
        ...(patch.resolvedByMembershipId
          ? { resolvedByMembershipId: patch.resolvedByMembershipId }
          : {}),
        ...(patch.outcome ? { outcome: patch.outcome } : {}),
        ...(patch.linkedIncidentId ? { linkedIncidentId: patch.linkedIncidentId } : {}),
        version: nextVersion,
        updatedAt: at,
      })
      .where(and(eq(SOS.id, sosAlertId), eq(SOS.version, currentVersion)))
      .returning({ version: SOS.version });
    requireSafety(
      updated.length === 1,
      "STALE_LIFECYCLE_STATE",
      "the alert has moved on since you read it; re-read and retry (§2.5)",
    );
    return nextVersion;
  }

  /** §2.2.3 — append the incident's own state-history row. */
  async function insertIncidentHistory(
    tx: Tx,
    row: {
      organizationId: string;
      providerEntityId: string;
      locationId: string | null;
      incidentId: string;
      fromState: string | null;
      toState: string;
      transitionedAt: Date;
      transitionedByMembershipId: string | null;
      reason: string | null;
    },
  ): Promise<void> {
    // §3.3's `m20_sish_no_self` refuses `from = to`; a no-op transition writes no row rather than dying
    // on a constraint (the same rule the SOS terminus loop follows).
    if (row.fromState !== null && row.fromState === row.toState) return;
    await tx.insert(INCIDENT_HISTORY).values({
      organizationId: row.organizationId,
      providerEntityId: row.providerEntityId,
      locationId: row.locationId,
      incidentId: row.incidentId,
      fromState: row.fromState as never,
      toState: row.toState as never,
      transitionedAt: row.transitionedAt,
      transitionedByMembershipId: row.transitionedByMembershipId,
      reason: row.reason,
    });
  }

  /** Load an incident row for a transition, or 404. */
  async function loadIncident(tx: Tx, actor: M20WriteActor, incidentId: string) {
    const [row] = await tx
      .select()
      .from(INCIDENT)
      .where(and(eq(INCIDENT.id, incidentId), eq(INCIDENT.organizationId, actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("safety incident");
    return row;
  }

  /** §2.5 — the incident's own optimistic-concurrency guard. */
  function assertIncidentVersion(current: number, expected: number | undefined): void {
    if (expected === undefined) return;
    requireSafety(
      current === expected,
      "STALE_LIFECYCLE_STATE",
      `the incident has moved on (version ${current}, you sent ${expected})`,
    );
  }

  /**
   * M20-F07 — the polygon validity the CHECK cannot express.
   *
   * §3.3's `m20_shra_polygon_shape` asserts "a non-empty array of rings" and stops, because §2.3's
   * "PostGIS `ST_IsValid`" is unavailable (Phase F struck PostGIS). Ring CLOSURE and the ≥4-point minimum
   * are therefore the app's, and they are checked here rather than in the ray-cast evaluator: an open ring
   * silently changes which side of the boundary a point falls on, and the moment to catch that is when the
   * Compliance Officer draws it — not on the night a clinician is standing in it.
   */
  function assertPolygonValid(polygon: SafetyPolygonRings): void {
    if (polygon.length === 0) {
      throw new ChartWardenError("POLYGON_INVALID", "a high-risk area needs at least one ring", 422);
    }
    polygon.forEach((ring, i) => {
      if (ring.length < 4) {
        throw new ChartWardenError(
          "POLYGON_INVALID",
          `ring ${i} has ${ring.length} points; a closed ring needs at least 4 (the first repeated as the last)`,
          422,
        );
      }
      const first = ring[0] as readonly [number, number];
      const last = ring[ring.length - 1] as readonly [number, number];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        throw new ChartWardenError(
          "POLYGON_INVALID",
          `ring ${i} is not closed; the last point must repeat the first`,
          422,
        );
      }
    });
  }

  /**
   * §3.3's `m20_shra_window` (`effective_to > effective_from`), restated so a retire-before-start is a
   * 422 naming the field rather than a 500 constraint violation (GAP-136, found by the live route suite).
   */
  function assertAreaWindow(effectiveFrom: Date, effectiveTo: Date): void {
    if (effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw new ChartWardenError(
        "AREA_WINDOW_INVALID",
        `effectiveTo must be after the area's effectiveFrom (${effectiveFrom.toISOString()})`,
        422,
      );
    }
  }

  return {
    // ── §4.1 row 1 — record a check-in ──────────────────────────────────────────────────────────────
    async recordCheckIn(actor, input: RecordCheckInInput) {
      const at = now();
      const providerEntityId = providerEntityOf(actor);
      const warnings: { code: string; message: string }[] = [];

      // §2.3 — the concern the supervisor acts on has to actually say something. Checked here so the
      // caller gets a 422 naming the field rather than migration 0110's `m20_sci_concern_note` violation.
      if (input.status !== "ok" && (input.concernNote ?? "").trim().length < 20) {
        throw new ChartWardenError(
          "CONCERN_NOTE_REQUIRED",
          "a check-in that is not `ok` carries a ≥20-character note; your supervisor reads it",
          422,
        );
      }

      const checkIn = await withOrgContext(db, ctx(actor), async (tx) => {
        const { versionId } = await ensurePolicyVersion(tx as Tx, actor, at);

        // D11 — coordinates are OFF by default and consent-gated. Unlike the SOS press, a routine
        // check-in's coordinate columns are NULLABLE, so an absent consent means the triple is simply not
        // written (§3.3's `m20_sci_coordinate_triple` requires all three or none).
        let coordinateCipher: Buffer | null = null;
        let accuracyM: number | null = null;
        let consentAt: Date | null = null;
        if (input.postedCoordinates !== undefined) {
          const consented = await consentActive(
            tx as Tx,
            actor,
            actor.membershipId,
            "sos_coordinates",
            at,
          );
          if (!consented) {
            warnings.push({
              code: "COORDINATES_DROPPED_NO_CONSENT",
              message:
                "you have not granted `sos_coordinates` consent, so the location on this check-in was discarded",
            });
          } else if (deps.cipher === undefined) {
            warnings.push({
              code: "COORDINATES_DROPPED_NO_CIPHER",
              message:
                "no per-tenant encryption key is bound, so the location was discarded rather than stored in the clear",
            });
          } else {
            coordinateCipher = await deps.cipher.encrypt({
              organizationId: actor.organizationId,
              plaintext: encodeCoordinates(input.postedCoordinates),
            });
            accuracyM = input.postedCoordinates.accuracyM;
            consentAt = at;
          }
        }

        // §3.7's retention router — a check-in that BRACKETS an open SOS is `compliance`-class evidence,
        // not a 90-day operational row. Computed at write time because the routine-purge cron reads the
        // column and cannot re-derive the bracket after the alert closes.
        const [openSos] = await tx
          .select({ id: SOS.id })
          .from(SOS)
          .where(
            and(
              eq(SOS.organizationId, actor.organizationId),
              eq(SOS.postedByMembershipId, actor.membershipId),
              sql`${SOS.lifecycleState} NOT IN ('resolved','cancelled_in_window','incident_opened')`,
              gte(SOS.postedAt, new Date(at.getTime() - 12 * 3_600_000)),
            ),
          )
          .limit(1);

        // GAP-030 — a schedule row is the obligation of ONE clinician. Bind it to the poster (and to an
        // actionable state) BEFORE anything is written, with the non-leaking 404: another clinician's
        // schedule id is indistinguishable from one that does not exist.
        if (input.scheduleId !== undefined) {
          const [owned] = await tx
            .select({ id: SCHEDULE.id })
            .from(SCHEDULE)
            .where(
              and(
                eq(SCHEDULE.id, input.scheduleId),
                eq(SCHEDULE.organizationId, actor.organizationId),
                eq(SCHEDULE.clinicianMembershipId, actor.membershipId),
                inArray(SCHEDULE.state, [...SAFETY_SCHEDULE_ACTIONABLE_STATES] as never[]),
              ),
            )
            .limit(1);
          if (!owned) throw new NotFoundError("safety check-in schedule");
        }

        const [created] = await tx
          .insert(CHECK_IN)
          .values({
            organizationId: actor.organizationId,
            providerEntityId,
            locationId: actor.locationIds[0] ?? null,
            scheduleId: input.scheduleId ?? null,
            visitId: input.visitId ?? null,
            postedByMembershipId: actor.membershipId,
            postedAt: at,
            kind: input.kind as never,
            status: input.status as never,
            concernNote: input.concernNote ?? null,
            postedCoordinatesCipher: coordinateCipher,
            postedCoordinatesAccuracyM: accuracyM,
            coordinatesConsentAt: consentAt,
            postedViaDeviceId: input.postedViaDeviceId ?? null,
            safetyPolicyVersionId: versionId,
            isPartOfSosBracket: openSos !== undefined,
          })
          .returning({ id: CHECK_IN.id });
        const id = (created as { id: string }).id;

        // §2.2.1 — the post FULFILS the obligation. `m20_scis_recorded_fulfilled` requires the pointer, so
        // the state and the pointer move in one UPDATE.
        let scheduleClosed = false;
        if (input.scheduleId !== undefined) {
          const closed = await tx
            .update(SCHEDULE)
            .set({ state: "recorded" as never, fulfilledByCheckInId: id, updatedAt: at })
            .where(
              and(
                eq(SCHEDULE.id, input.scheduleId),
                eq(SCHEDULE.organizationId, actor.organizationId),
                eq(SCHEDULE.clinicianMembershipId, actor.membershipId),
                inArray(SCHEDULE.state, [...SAFETY_SCHEDULE_ACTIONABLE_STATES] as never[]),
              ),
            )
            .returning({ id: SCHEDULE.id });
          // Lost a race with the detector or another post: roll the whole post back rather than leave a
          // check-in pointing at a schedule it did not fulfil.
          if (closed.length !== 1) throw new NotFoundError("safety check-in schedule");
          scheduleClosed = true;
        }

        await outbox.publish(tx, {
          eventName: "m20.safety.check_in_recorded",
          organizationId: actor.organizationId,
          aggregateKind: "safety_check_in",
          aggregateId: id,
          payload: {
            ...eventBase(providerEntityId, actor, at),
            checkInId: id,
            scheduleId: input.scheduleId ?? null,
            visitId: input.visitId ?? null,
            clinicianMembershipId: actor.membershipId,
            kind: input.kind,
            status: input.status,
            coordinatesIncluded: coordinateCipher !== null,
            isPartOfSosBracket: openSos !== undefined,
          },
        });

        if (scheduleClosed) {
          // Nothing to alert: §4.10 makes `check_in_recorded` an `info` event with no fan-out — the board
          // updates over M36's socket rooms rather than paging somebody every time a clinician says "I'm
          // OK". The overdue ALERT (if one already fired) is closed by the state flip above.
        }
        return { id, scheduleClosed };
      });

      return {
        checkIn: await readService.getCheckIn(actor, checkIn.id),
        scheduleClosed: checkIn.scheduleClosed,
        warningsSurfaced: warnings,
      };
    },

    // ── §4.1 row 3 — amend within the 5-minute grace ────────────────────────────────────────────────
    async amendCheckIn(actor, checkInId, input) {
      const at = now();
      const correctionId = await withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(CHECK_IN)
          .where(and(eq(CHECK_IN.id, checkInId), eq(CHECK_IN.organizationId, actor.organizationId)))
          .limit(1);
        if (!row) throw new NotFoundError("safety check-in");

        requireSafety(
          row.supersededAt === null,
          "SCHEDULE_FULFILMENT_REQUIRED",
          "this check-in has already been superseded by a correction; amend the correction instead",
        );
        // §4.6's "(within 5-min grace)". After the grace the row is append-only — a clinician's
        // attestation about her own safety must not be editable an hour later, when the supervisor has
        // already acted on it.
        if (at.getTime() - row.postedAt.getTime() > CHECK_IN_AMENDMENT_GRACE_MINUTES * 60_000) {
          throw new ChartWardenError(
            "CHECK_IN_AMENDMENT_WINDOW_CLOSED",
            `the ${CHECK_IN_AMENDMENT_GRACE_MINUTES}-minute amendment grace has closed; post a new check-in instead`,
            422,
          );
        }

        const status = input.status ?? (row.status as string);
        if (status !== "ok" && (input.concernNote ?? row.concernNote ?? "").trim().length < 20) {
          throw new ChartWardenError(
            "CONCERN_NOTE_REQUIRED",
            "a check-in that is not `ok` carries a ≥20-character note",
            422,
          );
        }

        // §2.2.1 — a correction is a NEW ROW that supersedes, never a mutation. The original stays
        // readable because it is what the supervisor may already have acted on.
        const [created] = await tx
          .insert(CHECK_IN)
          .values({
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            scheduleId: null, // `sci_active_uniq` admits one live post per obligation; the original holds it
            visitId: row.visitId,
            postedByMembershipId: actor.membershipId,
            postedAt: at,
            kind: row.kind,
            status: status as never,
            concernNote: input.concernNote ?? row.concernNote,
            postedCoordinatesCipher: row.postedCoordinatesCipher,
            postedCoordinatesAccuracyM: row.postedCoordinatesAccuracyM,
            coordinatesConsentAt: row.coordinatesConsentAt,
            postedViaDeviceId: row.postedViaDeviceId,
            correctsCheckInId: row.id,
            safetyPolicyVersionId: row.safetyPolicyVersionId,
            isPartOfSosBracket: row.isPartOfSosBracket,
          })
          .returning({ id: CHECK_IN.id });
        const id = (created as { id: string }).id;

        // §3.3's `m20_sci_supersession_pair` — both directions move together.
        await tx
          .update(CHECK_IN)
          .set({ supersededAt: at, supersededByCheckInId: id })
          .where(eq(CHECK_IN.id, row.id));

        await outbox.publish(tx, {
          eventName: "m20.safety.check_in_recorded",
          organizationId: actor.organizationId,
          aggregateKind: "safety_check_in",
          aggregateId: id,
          payload: {
            ...eventBase(row.providerEntityId, actor, at),
            checkInId: id,
            scheduleId: null,
            visitId: row.visitId,
            clinicianMembershipId: actor.membershipId,
            kind: row.kind,
            status,
            coordinatesIncluded: row.postedCoordinatesCipher !== null,
            isPartOfSosBracket: row.isPartOfSosBracket,
          },
        });
        return id;
      });
      return readService.getCheckIn(actor, correctionId);
    },

    // ── §4.1 row 5 — the press (decision 2, decision 3) ─────────────────────────────────────────────
    async raiseSos(actor, input: RaiseSosInput) {
      const at = now();
      const providerEntityId = providerEntityOf(actor);
      const warnings: { code: string; message: string }[] = [];

      const created = await withOrgContext(db, ctx(actor), async (tx) => {
        const { versionId } = await ensurePolicyVersion(tx as Tx, actor, at);
        const [version] = await tx
          .select({
            cancelWindowSeconds: POLICY_VERSION.sosCancelWindowSeconds,
          })
          .from(POLICY_VERSION)
          .where(eq(POLICY_VERSION.id, versionId))
          .limit(1);
        const cancelWindowSeconds = version?.cancelWindowSeconds ?? 5;

        // D15 — the ONE dedupe M20-F10 permits, and only on a REPLAY. A second live press is a second
        // call for help and must never collapse into the first (§2.6).
        if (input.offlineSync === true && input.localIdempotencyKey !== undefined) {
          const [replayed] = await tx
            .select({ id: SOS.id, postedAt: SOS.postedAt })
            .from(SOS)
            .where(
              and(
                eq(SOS.organizationId, actor.organizationId),
                eq(SOS.postedByMembershipId, actor.membershipId),
                // The device key is not a column (§3.3 has none), so the replay window is the press
                // instant the device captured: an offline queue replays with its ORIGINAL `capturedAt`,
                // and two rows for one clinician at the same second are the replay, not two presses.
                input.capturedAt === undefined
                  ? sql`false`
                  : eq(SOS.postedAt, new Date(input.capturedAt)),
              ),
            )
            .limit(1);
          if (replayed) {
            warnings.push({
              code: "OFFLINE_PRESS_ALREADY_SYNCED",
              message: "this offline press had already been synced; the original alert stands",
            });
            return { id: replayed.id, postedAt: replayed.postedAt, cancelWindowSeconds };
          }
        }

        const triple = await sosCoordinateTriple(tx as Tx, actor, input.postedCoordinates, at);
        if (triple.warning !== null) warnings.push(triple.warning);

        // D15 — a replayed press keeps its ORIGINAL instant; an online press is stamped by the server.
        // A client that could set `posted_at` on the online path could back-date a press past a gap.
        const postedAt =
          input.offlineSync === true && input.capturedAt !== undefined
            ? new Date(input.capturedAt)
            : at;
        const cancelWindowExpiredAt = new Date(postedAt.getTime() + cancelWindowSeconds * 1000);

        const [row] = await tx
          .insert(SOS)
          .values({
            organizationId: actor.organizationId,
            providerEntityId,
            locationId: actor.locationIds[0] ?? null,
            postedByMembershipId: actor.membershipId,
            postedAt,
            postedViaDeviceId: input.postedViaDeviceId ?? null,
            lastKnownVisitId: input.lastKnownVisitId ?? null,
            postedCoordinatesCipher: triple.cipher,
            postedCoordinatesAccuracyM: triple.accuracyM,
            coordinatesConsentAt: triple.consentAt,
            cancelWindowExpiredAt,
            lifecycleState: (input.offlineSync === true ? "raised" : "cancel_window_open") as never,
            safetyPolicyVersionId: versionId,
          })
          .returning({ id: SOS.id });
        const id = (row as { id: string }).id;

        const effects = raiseSosEffects({
          at: iso(postedAt),
          // §2.2.2 — ADVISORY. An unattested device still records and still fans out; the anomaly event is
          // the forensics trail BEHIND a delivered alert, never a reason it was not delivered.
          deviceAttested: input.postedViaDeviceId !== undefined,
          coordinatesCaptured: triple.warning === null,
          pressesInLastHour: 1,
          ...(input.offlineSync === true ? { offlineSync: true } : {}),
        });

        await runEffects(tx, effects, {
          organizationId: actor.organizationId,
          providerEntityId,
          locationId: actor.locationIds[0] ?? null,
          sosAlertId: id,
          at: postedAt,
          actorMembershipId: actor.membershipId,
          reason: null,
          outbox,
          alerts,
          stateHistory,
          aggregateKind: "safety_sos_alert",
          aggregateId: id,
          payloads: {
            "m20.safety.sos_alert_raised": {
              ...eventBase(providerEntityId, actor, postedAt),
              sosAlertId: id,
              postedByMembershipId: actor.membershipId,
              postedAt: iso(postedAt),
              lastKnownVisitId: input.lastKnownVisitId ?? null,
              deviceAttested: input.postedViaDeviceId !== undefined,
              coordinatesCaptured: triple.warning === null,
            },
            "m20.safety.device_attestation_anomaly": {
              ...eventBase(providerEntityId, actor, postedAt),
              clinicianMembershipId: actor.membershipId,
              deviceId: input.postedViaDeviceId ?? null,
              sosAlertId: id,
              checkInId: null,
              detectedAt: iso(postedAt),
            },
          },
          alertPayloads: {
            "m20.safety.sos_alert_raised": buildSosRaisedAlert({
              orgId: actor.organizationId as never,
              providerEntityId: providerEntityId as never,
              sosAlertId: id as never,
              postedByMembershipId: actor.membershipId as never,
              // §8.2 minimum-necessary. M20 owns no name column and does not join M2's `user` on the
              // press path — §9.7's 300 ms budget is the reason, and the composed resolver's own
              // membership→user lookup is where a recipient's client resolves the display name.
              postedByFirstName: "",
              postedAt: iso(postedAt),
              ...(input.lastKnownVisitId === undefined
                ? {}
                : { lastKnownVisitId: input.lastKnownVisitId as never }),
            }) as unknown as Record<string, unknown>,
          },
        });

        // The lifecycle column already holds the initial state from the INSERT; `raiseSosEffects` declares
        // a history row whose `from` is null, and the runner's `lifecycleState` patch would be a no-op
        // UPDATE. Skipped deliberately — a press is not a transition and has no `version` to bump.
        return { id, postedAt, cancelWindowSeconds };
      });

      const cancelWindowExpiresAt = new Date(
        created.postedAt.getTime() + created.cancelWindowSeconds * 1000,
      );
      const acknowledgersDispatched =
        deps.recipientCountFor === undefined
          ? null
          : await deps
              .recipientCountFor({
                organizationId: actor.organizationId,
                clinicianMembershipId: actor.membershipId,
                providerEntityId,
                atIso: iso(created.postedAt),
              })
              .catch(() => null);

      return {
        id: created.id,
        postedAt: iso(created.postedAt),
        cancelWindowExpiresAt: iso(cancelWindowExpiresAt),
        lifecycleState: (input.offlineSync === true
          ? "raised"
          : "cancel_window_open") as SafetySosLifecycleState,
        acknowledgersDispatched,
        warningsSurfaced: warnings,
      };
    },

    // ── §4.1 row 6 — the D5 cancel (decision 5) ─────────────────────────────────────────────────────
    async cancelSos(actor, sosAlertId, input) {
      const at = now();
      return withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadSos(tx as Tx, actor, sosAlertId);
        const facts = sosFactsOf(row);
        const [version] = await tx
          .select({ requiresBiometric: POLICY_VERSION.sosCancelRequiresBiometric })
          .from(POLICY_VERSION)
          .where(eq(POLICY_VERSION.id, row.safetyPolicyVersionId))
          .limit(1);
        const biometricRequired = version?.requiresBiometric ?? true;

        const decision = cancelSosDecision({
          alert: facts,
          by: actor.membershipId as never,
          at: iso(at),
          biometricRequired,
          // GAP-031 — the verdict is the SERVER's, never the client's. `actor.stepUpRecent` is stamped by
          // the authenticate hook from M2's step-up state (a qualifying webauthn/totp factor inside the
          // freshness window). The body's `biometricVerificationToken` is an unverifiable string and is not
          // consulted: an arbitrary non-empty token used to read as `passed`. Anything the server cannot
          // verify is `failed`, which the machine records as a rejected (not cancelled) attempt.
          biometricResult: actor.stepUpRecent ? "passed" : "failed",
        });

        const effects: readonly SafetySideEffect[] =
          decision.kind === "cancelled" ? decision.transition.effects : decision.effects;

        const patch = await runEffects(tx, effects, {
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          sosAlertId,
          at,
          actorMembershipId: actor.membershipId,
          reason: null,
          outbox,
          alerts,
          stateHistory,
          aggregateKind: "safety_sos_alert",
          aggregateId: sosAlertId,
          payloads: {
            "m20.safety.sos_alert_acknowledged": {
              ...eventBase(row.providerEntityId, actor, at),
              sosAlertId,
              acknowledgedByMembershipId: actor.membershipId,
              acknowledgedAt: iso(at),
              tierAtAcknowledgment: row.lifecycleState,
              slaBreached: false,
            },
            "m20.safety.sos_alert_cancel_attempted_rejected": {
              ...eventBase(row.providerEntityId, actor, at),
              sosAlertId,
              attemptedAt: iso(at),
              biometricResult: "failed",
            },
          },
          alertPayloads: {
            "m20.safety.sos_alert_acknowledged": buildSosAcknowledgedAlert({
              orgId: actor.organizationId as never,
              providerEntityId: row.providerEntityId as never,
              sosAlertId: sosAlertId as never,
              acknowledgedByMembershipId: actor.membershipId as never,
              acknowledgedAt: iso(at),
            }) as unknown as Record<string, unknown>,
          },
        });

        await applySosPatch(tx as Tx, sosAlertId, row.version, patch, at);
        return {
          id: sosAlertId,
          cancelStatus:
            decision.kind === "cancelled"
              ? ("cancelled_in_window" as const)
              : ("cancel_attempted_but_rejected" as const),
          // Decision 5 — a rejected cancel leaves the lifecycle exactly where it was.
          lifecycleState:
            decision.kind === "cancelled"
              ? ("cancelled_in_window" as SafetySosLifecycleState)
              : (row.lifecycleState as SafetySosLifecycleState),
        };
      });
    },

    // ── §4.1 row 7 — a responder answers ────────────────────────────────────────────────────────────
    async acknowledgeSos(actor, sosAlertId, input: AcknowledgeSosInput) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadSos(tx as Tx, actor, sosAlertId);
        if (input.expectedVersion !== undefined) {
          assertSosVersion(row.version, input.expectedVersion);
        }
        const transition = acknowledgeSosDecision({
          alert: sosFactsOf(row),
          by: actor.membershipId as never,
          at: iso(at),
        });

        // §2.2.6 — the row that proves a human answered. Written BEFORE the patch so a constraint failure
        // on the acknowledgment (the ≥20 floor, the one-target rule) rolls the whole transition back
        // rather than leaving an `acknowledged` alert nobody signed.
        await tx.insert(ACK).values({
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          targetKind: "sos_alert" as never,
          sosAlertId,
          acknowledgedByMembershipId: actor.membershipId,
          acknowledgedAt: at,
          actionTaken: input.actionTaken,
          outcome: input.outcome ?? null,
        });

        const slaBreached = row.lifecycleState !== "acknowledging";
        const patch = await runEffects(tx, transition.effects, {
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          sosAlertId,
          at,
          actorMembershipId: actor.membershipId,
          reason: null,
          outbox,
          alerts,
          stateHistory,
          aggregateKind: "safety_sos_alert",
          aggregateId: sosAlertId,
          payloads: {
            "m20.safety.sos_alert_acknowledged": {
              ...eventBase(row.providerEntityId, actor, at),
              sosAlertId,
              acknowledgedByMembershipId: actor.membershipId,
              acknowledgedAt: iso(at),
              tierAtAcknowledgment: row.lifecycleState,
              slaBreached,
            },
          },
          alertPayloads: {
            "m20.safety.sos_alert_acknowledged": buildSosAcknowledgedAlert({
              orgId: actor.organizationId as never,
              providerEntityId: row.providerEntityId as never,
              sosAlertId: sosAlertId as never,
              acknowledgedByMembershipId: actor.membershipId as never,
              acknowledgedAt: iso(at),
            }) as unknown as Record<string, unknown>,
          },
        });
        await applySosPatch(tx as Tx, sosAlertId, row.version, patch, at);
      });
      return readService.getSosAlert(actor, sosAlertId);
    },

    // ── §4.1 row 8 — resolve, or convert into an incident ───────────────────────────────────────────
    async resolveSos(actor, sosAlertId, input) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadSos(tx as Tx, actor, sosAlertId);
        if (input.expectedVersion !== undefined) {
          assertSosVersion(row.version, input.expectedVersion);
        }
        let facts = sosFactsOf(row);
        let version = row.version;

        // §2.2.2 — `resolved` is reachable only from `resolving`. A responder who acknowledged and is now
        // closing the alert in one action passes through the intermediate state rather than being 409'd
        // for a state machine step the UI never surfaced.
        if (facts.lifecycleState === "acknowledged") {
          const begin = beginSosResolution(facts);
          const patch = await runEffects(tx, begin.effects, {
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            sosAlertId,
            at,
            actorMembershipId: actor.membershipId,
            reason: null,
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "safety_sos_alert",
            aggregateId: sosAlertId,
            payloads: {},
          });
          version = await applySosPatch(tx as Tx, sosAlertId, version, patch, at);
          facts = { ...facts, lifecycleState: begin.to, version };
        }

        if (input.openIncidentFromOutcome === true) {
          // §2.2.3 — the incident row is minted FIRST: `m20_ssa_incident_linked` refuses the state
          // without the link, so a machine that moved the alert first would die on a constraint.
          const narrativeCipher = await seal(
            actor,
            input.resolutionNarrative,
            "the incident narrative auto-drafted from this SOS",
          );
          const { versionId } = await ensurePolicyVersion(tx as Tx, actor, at);
          const [incident] = await tx
            .insert(INCIDENT)
            .values({
              organizationId: row.organizationId,
              providerEntityId: row.providerEntityId,
              locationId: row.locationId,
              affectedClinicianMembershipId: row.postedByMembershipId,
              reportedByMembershipId: actor.membershipId,
              category: "other" as never,
              severity: "moderate" as never,
              visitId: row.lastKnownVisitId,
              patientId: row.lastKnownPatientId,
              occurredAt: row.postedAt,
              reportedAt: at,
              narrativeCipher,
              linkedSosAlertId: sosAlertId,
              lifecycleState: "draft" as never,
              safetyPolicyVersionId: versionId,
            })
            .returning({ id: INCIDENT.id });
          const incidentId = (incident as { id: string }).id;
          await insertIncidentHistory(tx as Tx, {
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            incidentId,
            fromState: null,
            toState: "draft",
            transitionedAt: at,
            transitionedByMembershipId: actor.membershipId,
            reason: "auto-drafted from SOS resolution (§7.5)",
          });

          const transition = openIncidentFromSos({
            alert: facts,
            incidentId: incidentId as never,
          });
          const patch = await runEffects(tx, transition.effects, {
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            sosAlertId,
            at,
            actorMembershipId: actor.membershipId,
            reason: null,
            outbox,
            alerts,
            stateHistory,
            aggregateKind: "safety_sos_alert",
            aggregateId: sosAlertId,
            payloads: {
              "m20.safety.incident_reported": {
                ...eventBase(row.providerEntityId, actor, at),
                incidentId,
                affectedClinicianMembershipId: row.postedByMembershipId,
                reportedByMembershipId: actor.membershipId,
                category: "other",
                severity: "moderate",
                occurredAt: iso(row.postedAt),
                linkedSosAlertId: sosAlertId,
              },
            },
          });
          await applySosPatch(tx as Tx, sosAlertId, version, patch, at);
          return;
        }

        const transition = resolveSosDecision({
          alert: facts,
          by: actor.membershipId as never,
          outcome: input.outcome,
          resolutionNarrative: input.resolutionNarrative,
          at: iso(at),
        });

        // The narrative column is nullable (§3.3, so a repaired row stays writable) but the WRITE PATH
        // requires it — an alert that can say it ended but not how is not the workers-comp evidence §1.1
        // exists to produce. With no cipher bound the resolve REFUSES rather than dropping the narrative.
        const narrativeCipher = await seal(
          actor,
          input.resolutionNarrative,
          "the SOS resolution narrative",
        );

        const patch = await runEffects(tx, transition.effects, {
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          sosAlertId,
          at,
          actorMembershipId: actor.membershipId,
          reason: null,
          outbox,
          alerts,
          stateHistory,
          aggregateKind: "safety_sos_alert",
          aggregateId: sosAlertId,
          payloads: {
            "m20.safety.sos_alert_resolved": {
              ...eventBase(row.providerEntityId, actor, at),
              sosAlertId,
              resolvedByMembershipId: actor.membershipId,
              outcome: input.outcome,
              resolvedAt: iso(at),
            },
            "m20.safety.visit_cancellation_requested": {
              ...eventBase(row.providerEntityId, actor, at),
              sosAlertId,
              visitId: row.lastKnownVisitId ?? "",
              requestedAt: iso(at),
            },
          },
          alertPayloads: {
            "m20.safety.sos_alert_resolved": buildSosResolvedAlert({
              orgId: actor.organizationId as never,
              providerEntityId: row.providerEntityId as never,
              sosAlertId: sosAlertId as never,
              resolvedByMembershipId: actor.membershipId as never,
              outcome: input.outcome,
              resolvedAt: iso(at),
            }) as unknown as Record<string, unknown>,
          },
        });

        await tx
          .update(SOS)
          .set({ resolutionNarrativeCipher: narrativeCipher })
          .where(eq(SOS.id, sosAlertId));
        await applySosPatch(tx as Tx, sosAlertId, version, patch, at);
      });
      return readService.getSosAlert(actor, sosAlertId);
    },

    // ── §4.1 row 12 — open an incident (decision 1) ─────────────────────────────────────────────────
    async createIncident(actor, input: CreateIncidentInput) {
      const at = now();
      const providerEntityId = providerEntityOf(actor);
      const narrativeCipher = await seal(actor, input.narrative, "the incident narrative");
      const witnessesCipher =
        input.witnesses === undefined
          ? null
          : await seal(actor, input.witnesses, "the incident witness list");

      const incidentId = await withOrgContext(db, ctx(actor), async (tx) => {
        const { versionId } = await ensurePolicyVersion(tx as Tx, actor, at);
        const occurredAt = new Date(input.occurredAt);
        // §3.3's `m20_si_occurred_before_reported` is the half of §2.2.3's rule a CHECK can express;
        // restating it here turns a driver-level constraint violation into a 422 naming the field.
        if (occurredAt.getTime() > at.getTime()) {
          throw new ChartWardenError(
            "INCIDENT_OCCURRED_IN_FUTURE",
            "an incident cannot have occurred after it was reported",
            422,
          );
        }

        const [created] = await tx
          .insert(INCIDENT)
          .values({
            organizationId: actor.organizationId,
            providerEntityId,
            locationId: actor.locationIds[0] ?? null,
            affectedClinicianMembershipId: input.affectedClinicianMembershipId,
            reportedByMembershipId: actor.membershipId,
            category: input.category as never,
            severity: input.severity as never,
            visitId: input.visitId ?? null,
            patientId: input.patientId ?? null,
            occurredAt,
            reportedAt: at,
            locationDescription: input.locationDescription ?? null,
            narrativeCipher,
            witnessesCipher,
            workersCompClaimInitiated: input.workersCompClaimInitiated ?? false,
            workersCompClaimReference: input.workersCompClaimReference ?? null,
            linkedSosAlertId: input.linkedSosAlertId ?? null,
            lifecycleState: "draft" as never,
            safetyPolicyVersionId: versionId,
          })
          .returning({ id: INCIDENT.id });
        const id = (created as { id: string }).id;

        await insertIncidentHistory(tx as Tx, {
          organizationId: actor.organizationId,
          providerEntityId,
          locationId: actor.locationIds[0] ?? null,
          incidentId: id,
          fromState: null,
          toState: "draft",
          transitionedAt: at,
          transitionedByMembershipId: actor.membershipId,
          reason: null,
        });

        await outbox.publish(tx, {
          eventName: "m20.safety.incident_reported",
          organizationId: actor.organizationId,
          aggregateKind: "safety_incident",
          aggregateId: id,
          payload: {
            ...eventBase(providerEntityId, actor, at),
            incidentId: id,
            affectedClinicianMembershipId: input.affectedClinicianMembershipId,
            reportedByMembershipId: actor.membershipId,
            category: input.category,
            severity: input.severity,
            occurredAt: iso(occurredAt),
            linkedSosAlertId: input.linkedSosAlertId ?? null,
          },
        });

        if (input.workersCompClaimInitiated === true) {
          await outbox.publish(tx, {
            eventName: "m20.safety.workers_comp_claim_initiated",
            organizationId: actor.organizationId,
            aggregateKind: "safety_incident",
            aggregateId: id,
            payload: {
              ...eventBase(providerEntityId, actor, at),
              incidentId: id,
              initiatedByMembershipId: actor.membershipId,
              initiatedAt: iso(at),
            },
          });
        }
        return id;
      });
      return readService.getIncident(actor, incidentId);
    },

    // ── §4.1 row 14 — edit a draft ──────────────────────────────────────────────────────────────────
    async patchIncident(actor, incidentId, input: PatchIncidentInput) {
      const at = now();
      const narrativeCipher =
        input.narrative === undefined
          ? null
          : await seal(actor, input.narrative, "the incident narrative");
      const witnessesCipher =
        input.witnesses === undefined
          ? null
          : await seal(actor, input.witnesses, "the incident witness list");

      await withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadIncident(tx as Tx, actor, incidentId);
        assertIncidentVersion(row.version, input.expectedVersion);

        // §2.2.3 — `submitted` is the immutability entry point. A supervisor edits through the TRANSITION
        // route (`returned_to_clinician`), never by mutating a filed report: the workers-comp timeline an
        // insurer reads must not change under them. `draft` and `returned_to_clinician` are editable;
        // everything else is not.
        const editable =
          row.lifecycleState === "draft" || row.lifecycleState === "returned_to_clinician";
        requireSafety(
          editable,
          "SOS_INVALID_STATE_TRANSITION",
          `an incident in '${row.lifecycleState}' is not editable; return it to the clinician first (§2.2.3)`,
        );

        await tx
          .update(INCIDENT)
          .set({
            ...(input.category ? { category: input.category as never } : {}),
            ...(input.severity ? { severity: input.severity as never } : {}),
            ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
            ...(input.locationDescription !== undefined
              ? { locationDescription: input.locationDescription }
              : {}),
            ...(narrativeCipher !== null ? { narrativeCipher } : {}),
            ...(witnessesCipher !== null ? { witnessesCipher } : {}),
            ...(input.workersCompClaimInitiated !== undefined
              ? { workersCompClaimInitiated: input.workersCompClaimInitiated }
              : {}),
            ...(input.workersCompClaimReference !== undefined
              ? { workersCompClaimReference: input.workersCompClaimReference }
              : {}),
            version: row.version + 1,
            updatedAt: at,
          })
          .where(and(eq(INCIDENT.id, incidentId), eq(INCIDENT.version, row.version)));

        if (input.workersCompClaimInitiated === true && !row.workersCompClaimInitiated) {
          await outbox.publish(tx, {
            eventName: "m20.safety.workers_comp_claim_initiated",
            organizationId: actor.organizationId,
            aggregateKind: "safety_incident",
            aggregateId: incidentId,
            payload: {
              ...eventBase(row.providerEntityId, actor, at),
              incidentId,
              initiatedByMembershipId: actor.membershipId,
              initiatedAt: iso(at),
            },
          });
        }
      });
      return readService.getIncident(actor, incidentId);
    },

    // ── §4.1 row 15 — submit for review (D9's gate) ─────────────────────────────────────────────────
    async submitIncident(actor, incidentId, input: SubmitIncidentInput) {
      const at = now();
      const finalNarrativeCipher =
        input.finalNarrative === undefined
          ? null
          : await seal(actor, input.finalNarrative, "the incident narrative");

      await withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadIncident(tx as Tx, actor, incidentId);
        assertIncidentVersion(row.version, input.expectedVersion);
        requireSafety(
          row.lifecycleState === "draft" || row.lifecycleState === "returned_to_clinician",
          "SOS_INVALID_STATE_TRANSITION",
          `an incident in '${row.lifecycleState}' has already been submitted`,
        );

        // D9 — submitting with `osha_reportable = true` requires the sign-off to ALREADY exist. §3.3's
        // `m20_si_osha_signoff_required` CHECK is the DB's half; this is the half that names the fix
        // rather than raising a constraint violation on a clinician's Submit button.
        if (input.oshaReportable && row.oshaReportableSignedOffAt === null) {
          throw new ChartWardenError(
            "OSHA_SIGNOFF_REQUIRED",
            "an OSHA-reportable incident needs a supervisor's step-up sign-off before it can be submitted (D9); use the osha-signoff route first",
            422,
          );
        }

        await tx
          .update(INCIDENT)
          .set({
            lifecycleState: "submitted" as never,
            submittedAt: at,
            oshaReportable: input.oshaReportable,
            ...(finalNarrativeCipher !== null ? { narrativeCipher: finalNarrativeCipher } : {}),
            version: row.version + 1,
            updatedAt: at,
          })
          .where(and(eq(INCIDENT.id, incidentId), eq(INCIDENT.version, row.version)));

        await insertIncidentHistory(tx as Tx, {
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          incidentId,
          fromState: row.lifecycleState,
          toState: "submitted",
          transitionedAt: at,
          transitionedByMembershipId: actor.membershipId,
          reason: null,
        });

        await outbox.publish(tx, {
          eventName: "m20.safety.incident_submitted",
          organizationId: actor.organizationId,
          aggregateKind: "safety_incident",
          aggregateId: incidentId,
          payload: {
            ...eventBase(row.providerEntityId, actor, at),
            incidentId,
            affectedClinicianMembershipId: row.affectedClinicianMembershipId,
            category: row.category,
            severity: row.severity,
            occurredAt: iso(row.occurredAt),
            oshaReportable: input.oshaReportable,
            linkedSosAlertId: row.linkedSosAlertId,
          },
        });
        // §4.10 — M22 renders the report PDF from the SUBMITTED row. M20 ships no PDF code.
        await outbox.publish(tx, {
          eventName: "m20.safety.incident_report_requested",
          organizationId: actor.organizationId,
          aggregateKind: "safety_incident",
          aggregateId: incidentId,
          payload: {
            ...eventBase(row.providerEntityId, actor, at),
            incidentId,
            // F-099 — the chart target, and legitimately NULL: `safety_incident.patient_id` is nullable
            // because a staff-safety incident (a vehicle accident, a workplace injury) has no patient, and
            // filing that report on someone's chart would be worse than filing it on none.
            patientId: row.patientId ?? null,
            renderTargetKind: "pdf",
          },
        });

        await alerts
          ?.emit({
            organizationId: actor.organizationId,
            kind: "m20.safety.incident_submitted",
            payload: buildIncidentSubmittedAlert({
              orgId: actor.organizationId as never,
              providerEntityId: row.providerEntityId as never,
              incidentId: incidentId as never,
              affectedClinicianMembershipId: row.affectedClinicianMembershipId as never,
              category: row.category as never,
              severityLevel: row.severity as never,
              occurredAt: iso(row.occurredAt),
              oshaReportable: input.oshaReportable,
            }) as unknown as Record<string, unknown>,
          })
          .catch(() => undefined);
      });
      return readService.getIncident(actor, incidentId);
    },

    // ── §4.1 row 16 — the supervisor state machine ─────────────────────────────────────────────────
    async transitionIncident(actor, incidentId, input: TransitionIncidentInput) {
      const at = now();
      const actionPlanCipher =
        input.actionPlan === undefined
          ? null
          : await seal(actor, input.actionPlan, "the incident action plan");

      await withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadIncident(tx as Tx, actor, incidentId);
        assertIncidentVersion(row.version, input.expectedVersion);
        requireSafety(
          row.lifecycleState !== "draft",
          "SOS_INVALID_STATE_TRANSITION",
          "a draft is the clinician's; it enters the review machine by being SUBMITTED",
        );
        // §3.3's `m20_si_action_plan_required` — a close WITH a plan needs the plan.
        if (input.toState === "closed_with_action_plan" && actionPlanCipher === null) {
          throw new ChartWardenError(
            "ACTION_PLAN_REQUIRED",
            "closing with an action plan needs the plan",
            422,
          );
        }

        const closing = (SAFETY_INCIDENT_CLOSED_STATES as readonly string[]).includes(
          input.toState,
        );
        await tx
          .update(INCIDENT)
          .set({
            lifecycleState: input.toState as never,
            reviewedByMembershipId: actor.membershipId,
            reviewedAt: at,
            ...(actionPlanCipher !== null ? { actionPlanCipher } : {}),
            ...(closing ? { closedAt: at } : {}),
            ...(input.toState === "reopened" ? { reopenReason: input.reason, closedAt: null } : {}),
            version: row.version + 1,
            updatedAt: at,
          })
          .where(and(eq(INCIDENT.id, incidentId), eq(INCIDENT.version, row.version)));

        await insertIncidentHistory(tx as Tx, {
          organizationId: row.organizationId,
          providerEntityId: row.providerEntityId,
          locationId: row.locationId,
          incidentId,
          fromState: row.lifecycleState,
          toState: input.toState,
          transitionedAt: at,
          transitionedByMembershipId: actor.membershipId,
          reason: input.reason,
        });

        if (input.toState === "closed_with_action_plan") {
          await outbox.publish(tx, {
            eventName: "m20.safety.incident_closed_with_action",
            organizationId: actor.organizationId,
            aggregateKind: "safety_incident",
            aggregateId: incidentId,
            payload: {
              ...eventBase(row.providerEntityId, actor, at),
              incidentId,
              closedByMembershipId: actor.membershipId,
              closedAt: iso(at),
            },
          });
        }
      });
      return readService.getIncident(actor, incidentId);
    },

    // ── §4.1 row 17 / §7.6 / D9 — the OSHA-equivalent sign-off ──────────────────────────────────────
    async oshaSignoff(actor, incidentId, input: OshaSignoffInput) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) => {
        const row = await loadIncident(tx as Tx, actor, incidentId);
        assertIncidentVersion(row.version, input.expectedVersion);

        // §6's "Override and step-up workflows": the sign-off "cannot be undone without a
        // `safety_incident.transition` to `reopened` … and a second sign-off". So a CLOSED incident is
        // refused here — the reopen is the documented path, and letting a sign-off land on a closed row
        // would file with a state agency against a record whose review had already concluded.
        requireSafety(
          !(SAFETY_INCIDENT_CLOSED_STATES as readonly string[]).includes(row.lifecycleState),
          "SOS_INVALID_STATE_TRANSITION",
          "this incident is closed; reopen it with a reason before re-classifying it (§6)",
        );

        await tx
          .update(INCIDENT)
          .set({
            oshaReportable: input.oshaReportable,
            // §3.3's `m20_si_osha_signoff_pair` — the two move together, in both directions. Clearing the
            // flag clears the pair, so a later read cannot show an unreportable incident carrying a
            // signature that says otherwise.
            oshaReportableSignedOffByMembershipId: input.oshaReportable ? actor.membershipId : null,
            oshaReportableSignedOffAt: input.oshaReportable ? at : null,
            reviewedByMembershipId: actor.membershipId,
            reviewedAt: at,
            version: row.version + 1,
            updatedAt: at,
          })
          .where(and(eq(INCIDENT.id, incidentId), eq(INCIDENT.version, row.version)));

        // The sign-off is not a lifecycle transition (§2.2.3 has no state for it), so no history row is
        // written — `m20_sish_no_self` would refuse `from = to` anyway. The M4 write-audit trigger is what
        // keeps the classification change on the record, which is exactly what §8.8.1 asks of it.

        if (input.oshaReportable) {
          await outbox.publish(tx, {
            eventName: "m20.safety.osha_reportable_incident_filed",
            organizationId: actor.organizationId,
            aggregateKind: "safety_incident",
            aggregateId: incidentId,
            payload: {
              ...eventBase(row.providerEntityId, actor, at),
              incidentId,
              category: row.category,
              severity: row.severity,
              signedOffByMembershipId: actor.membershipId,
              signedOffAt: iso(at),
              stateCode: input.stateCode.toUpperCase(),
              reportingWindowHours: input.reportingWindowHours,
            },
          });
          await alerts
            ?.emit({
              organizationId: actor.organizationId,
              kind: "m20.safety.osha_reportable_incident_filed",
              payload: buildOshaFiledAlert({
                orgId: actor.organizationId as never,
                providerEntityId: row.providerEntityId as never,
                incidentId: incidentId as never,
                category: row.category as never,
                severityLevel: row.severity as never,
                signedOffByMembershipId: actor.membershipId as never,
                stateCode: input.stateCode.toUpperCase(),
                reportingWindowHours: input.reportingWindowHours,
              }) as unknown as Record<string, unknown>,
            })
            .catch(() => undefined);
        }
      });
      return readService.getIncident(actor, incidentId);
    },

    // ── §4.1 row 19 — the policy edit (decision 6) ──────────────────────────────────────────────────
    async patchPolicy(actor, input: PatchPolicyInput) {
      const at = now();
      const providerEntityId = providerEntityOf(actor);
      const { editReason, expectedVersion: _v, ...patch } = input;

      const current = await readService.getPolicy(actor);
      // §2.2.4 / D4 — validated against the MERGED result, because a patch that moves only one rung can
      // still invert a ladder whose other three it never mentions. Throws a 422 naming the knob and its
      // band rather than letting migration 0110's `m20_spv_*` CHECK raise a constraint error.
      assertPolicyEditValid({ current, patch, editReason });
      const diffs = policyThresholdDiffs(current, patch);
      const merged = { ...current, ...patch };

      await withOrgContext(db, ctx(actor), async (tx) => {
        const { policyId } = await ensurePolicyVersion(tx as Tx, actor, at);
        const [locked] = await tx
          .select({ isSystemLocked: POLICY.isSystemLocked })
          .from(POLICY)
          .where(eq(POLICY.id, policyId))
          .limit(1);
        // §3.3 — platform ops froze this tenant's policy (a compliance action). Refusing here rather than
        // at the DB means the DON is told WHY rather than shown a failed write.
        if (locked?.isSystemLocked === true) {
          throw new ChartWardenError(
            "POLICY_SYSTEM_LOCKED",
            "this tenant's safety policy is frozen by platform ops; contact support",
            409,
          );
        }

        // Decision 6 — write a NEW version; never touch the old one. `safety_policy_version` is
        // append-only at the GRANT level (migration 0111: chartwarden_app holds SELECT/INSERT only, so a past
        // cadence cannot be rewritten), which means the old row's `effective_to` cannot be stamped either:
        // the UPDATE that used to close it failed with 42501 and made this route a guaranteed 500 (GAP-136,
        // found by the live route suite). Nothing needs the stamp — every reader (read-service
        // `effectivePolicy`, the seam store's `policyVersionAt`, `ensurePolicyVersion`, the schedule store)
        // resolves the version in force as the LATEST `effective_from` ≤ the instant, so the new row
        // supersedes the old one by its start alone.
        const [created] = await tx
          .insert(POLICY_VERSION)
          .values({
            organizationId: actor.organizationId,
            safetyPolicyId: policyId,
            midVisitCadenceMinutes: merged.midVisitCadenceMinutes,
            midVisitMinVisitDurationMinutes: merged.midVisitMinVisitDurationMinutes,
            preVisitWindowMinutes: merged.preVisitWindowMinutes,
            postVisitWindowMinutes: merged.postVisitWindowMinutes,
            gentleReminderMinutes: merged.gentleReminderMinutes,
            supervisorAlertMinutes: merged.supervisorAlertMinutes,
            escalationMinutes: merged.escalationMinutes,
            sosEquivalentMinutes: merged.sosEquivalentMinutes,
            sosCancelWindowSeconds: merged.sosCancelWindowSeconds,
            sosCancelRequiresBiometric: merged.sosCancelRequiresBiometric,
            sosContinuousLocationEnabled: merged.sosContinuousLocationEnabled,
            sosContinuousLocationSampleSeconds: merged.sosContinuousLocationSampleSeconds,
            sosContinuousLocationMaxDurationHours: merged.sosContinuousLocationMaxDurationHours,
            sosTier1SlaSeconds: merged.sosTier1SlaSeconds,
            sosTier2SlaSeconds: merged.sosTier2SlaSeconds,
            sosTier3SlaSeconds: merged.sosTier3SlaSeconds,
            subscriptionModel: merged.subscriptionModel as never,
            afterHoursStartHour: merged.afterHoursStartHour,
            afterHoursEndHour: merged.afterHoursEndHour,
            oshaReportableAutoFlagCategories: merged.oshaReportableAutoFlagCategories as never,
            effectiveFrom: at,
            effectiveTo: null,
            createdByMembershipId: actor.membershipId,
            editReason,
          })
          .returning({ id: POLICY_VERSION.id });
        const versionId = (created as { id: string }).id;
        await tx
          .update(POLICY)
          .set({ currentVersionId: versionId, updatedAt: at })
          .where(eq(POLICY.id, policyId));

        await outbox.publish(tx, {
          eventName: "m20.safety.policy_changed",
          organizationId: actor.organizationId,
          aggregateKind: "safety_policy",
          aggregateId: policyId,
          payload: {
            ...eventBase(providerEntityId, actor, at),
            newVersionId: versionId,
            changedByMembershipId: actor.membershipId,
            changedAt: iso(at),
            thresholdDiffs: diffs.map((d) => ({ field: d.field, direction: d.direction })),
          },
        });
        await alerts
          ?.emit({
            organizationId: actor.organizationId,
            kind: "m20.safety.policy_changed",
            payload: buildPolicyChangedAlert({
              orgId: actor.organizationId as never,
              providerEntityId: providerEntityId as never,
              newVersionId: versionId as never,
              changedByMembershipId: actor.membershipId as never,
              // §8.2 — the SUMMARY is the knob names and directions, never the free-text edit reason
              // (which is §3.6-denylisted and travels to SMS through no path).
              changeSummary:
                diffs.length === 0
                  ? "policy re-issued with no threshold change"
                  : diffs.map((d) => `${d.field}: ${d.direction}`).join(", "),
            }) as unknown as Record<string, unknown>,
          })
          .catch(() => undefined);
      });

      return readService.getPolicy(actor);
    },

    // ── §4.1 row 21 — add a subscription ────────────────────────────────────────────────────────────
    async createSubscription(actor, input: CreateSubscriptionInput) {
      const at = now();
      // §3.3's `m20_sss_scope_integrity` — a scope kind that does not carry the column it selects on
      // covers NOBODY, and the resolver would return an empty recipient set at 3 a.m. with nothing in the
      // data saying it was misconfigured. Named here so the DON sees which selector is missing.
      const selector =
        input.scopeKind === "explicit"
          ? input.clinicianMembershipId
          : input.scopeKind === "location"
            ? input.locationId
            : input.scopeKind === "provider_entity"
              ? input.providerEntityId
              : "role";
      if (selector === undefined) {
        throw new ChartWardenError(
          "SUBSCRIPTION_SCOPE_INCOMPLETE",
          `a '${input.scopeKind}'-scoped subscription must name the ${input.scopeKind === "explicit" ? "clinician" : input.scopeKind === "location" ? "location" : "provider entity"} it covers`,
          422,
        );
      }
      if (
        (input.isVacationForwarding === true) !==
        (input.vacationForwardToMembershipId !== undefined)
      ) {
        throw new ChartWardenError(
          "SUBSCRIPTION_FORWARD_INCOMPLETE",
          "vacation forwarding names its target, in both directions: a forwarding row with no target drops the page entirely",
          422,
        );
      }

      const subscriptionId = await withOrgContext(db, ctx(actor), async (tx) => {
        const [created] = await tx
          .insert(SUBSCRIPTION)
          .values({
            organizationId: actor.organizationId,
            supervisorMembershipId: input.supervisorMembershipId,
            clinicianMembershipId: input.clinicianMembershipId ?? null,
            locationId: input.locationId ?? null,
            providerEntityId: input.providerEntityId ?? null,
            scopeKind: input.scopeKind,
            alertKinds: [...input.alertKinds],
            isVacationForwarding: input.isVacationForwarding ?? false,
            vacationForwardToMembershipId: input.vacationForwardToMembershipId ?? null,
          })
          .returning({ id: SUBSCRIPTION.id });
        return (created as { id: string }).id;
      });

      const page = await readService.listSubscriptions(actor, { limit: 200 });
      const view = page.data.find((s) => s.id === subscriptionId);
      if (view === undefined) throw new NotFoundError("safety supervisor subscription");
      return view;
    },

    // ── §4.1 row 22 — deactivate (decision 7) ───────────────────────────────────────────────────────
    async deleteSubscription(actor, subscriptionId) {
      const at = now();
      return withOrgContext(db, ctx(actor), async (tx) => {
        const [row] = await tx
          .select()
          .from(SUBSCRIPTION)
          .where(
            and(
              eq(SUBSCRIPTION.id, subscriptionId),
              eq(SUBSCRIPTION.organizationId, actor.organizationId),
              isNull(SUBSCRIPTION.deactivatedAt),
            ),
          )
          .limit(1);
        if (!row) throw new NotFoundError("safety supervisor subscription");

        await tx
          .update(SUBSCRIPTION)
          .set({ deactivatedAt: at, updatedAt: at })
          .where(eq(SUBSCRIPTION.id, subscriptionId));

        // Decision 7 — report what this leaves uncovered, computed over the rows that REMAIN.
        const remaining = await tx
          .select()
          .from(SUBSCRIPTION)
          .where(
            and(
              eq(SUBSCRIPTION.organizationId, actor.organizationId),
              isNull(SUBSCRIPTION.supersededAt),
              isNull(SUBSCRIPTION.deactivatedAt),
            ),
          );
        const subjects = await tx
          .select({
            membershipId: MEMBERSHIP.id,
            defaultLocationIds: MEMBERSHIP.defaultLocationIds,
            providerEntityId: MEMBERSHIP.defaultProviderEntityId,
          })
          .from(MEMBERSHIP)
          .where(
            and(
              eq(MEMBERSHIP.organizationId, actor.organizationId),
              eq(MEMBERSHIP.status, "active"),
              sql`${MEMBERSHIP.defaultProviderEntityId} IS NOT NULL`,
            ),
          );
        const activeSupervisorIds = new Set(
          remaining.map((r) => r.supervisorMembershipId as never as string),
        );
        const gaps: readonly SafetyCoverageGapDto[] = detectCoverageGaps({
          subjects: subjects.map((s) => ({
            membershipId: s.membershipId as never,
            locationIds: Array.isArray(s.defaultLocationIds)
              ? (s.defaultLocationIds as unknown[]).filter(
                  (v): v is string => typeof v === "string",
                )
              : [],
            providerEntityId: s.providerEntityId as string,
            isFieldEligible: true,
            hasInactiveSubscriptions: true,
          })),
          activeSubscriptions: remaining.map((r) => ({
            supervisorMembershipId: r.supervisorMembershipId as never,
            scopeKind: r.scopeKind as never,
            clinicianMembershipId: r.clinicianMembershipId as never,
            locationId: r.locationId,
            providerEntityId: r.providerEntityId,
            alertKinds: r.alertKinds as readonly string[],
            isVacationForwarding: r.isVacationForwarding,
            vacationForwardToMembershipId: r.vacationForwardToMembershipId as never,
          })),
          activeSupervisorMembershipIds: activeSupervisorIds as never,
        });

        for (const gap of gaps) {
          await outbox.publish(tx, {
            eventName: "m20.safety.coverage_gap_detected",
            organizationId: actor.organizationId,
            aggregateKind: "safety_supervisor_subscription",
            aggregateId: subscriptionId,
            payload: {
              ...eventBase((row.providerEntityId ?? providerEntityOf(actor)) as string, actor, at),
              clinicianMembershipId: gap.clinicianMembershipId,
              reason: gap.reason,
              detectedAt: iso(at),
            },
          });
        }

        return { id: subscriptionId, deactivatedAt: iso(at), coverageGapsCreated: gaps };
      });
    },

    // ── §4.1 row 24 — draw an advisory polygon ──────────────────────────────────────────────────────
    async createHighRiskArea(actor, input: CreateHighRiskAreaInput) {
      const at = now();
      assertPolygonValid(input.polygon);
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : at;
      if (input.effectiveTo !== undefined) {
        assertAreaWindow(effectiveFrom, new Date(input.effectiveTo));
      }
      const areaId = await withOrgContext(db, ctx(actor), async (tx) => {
        const [created] = await tx
          .insert(AREA)
          .values({
            organizationId: actor.organizationId,
            riskCategory: input.riskCategory as never,
            advisoryMessage: input.advisoryMessage,
            polygon: input.polygon as never,
            policyForVisitsToArea: input.policyForVisitsToArea ?? "advisory_only",
            effectiveFrom,
            effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
            createdByMembershipId: actor.membershipId,
          })
          .returning({ id: AREA.id });
        return (created as { id: string }).id;
      });
      const page = await readService.listHighRiskAreas(actor, { limit: 200, includeExpired: true });
      const view = page.data.find((a) => a.id === areaId);
      if (view === undefined) throw new NotFoundError("safety high-risk area");
      return view;
    },

    // ── §4.1 row 25 — edit / retire a polygon ───────────────────────────────────────────────────────
    async patchHighRiskArea(actor, areaId, input: PatchHighRiskAreaInput) {
      const at = now();
      if (input.polygon !== undefined) assertPolygonValid(input.polygon);
      await withOrgContext(db, ctx(actor), async (tx) => {
        if (input.effectiveTo !== undefined) {
          const [current] = await tx
            .select({ effectiveFrom: AREA.effectiveFrom })
            .from(AREA)
            .where(and(eq(AREA.id, areaId), eq(AREA.organizationId, actor.organizationId)))
            .limit(1);
          if (!current) throw new NotFoundError("safety high-risk area");
          assertAreaWindow(current.effectiveFrom, new Date(input.effectiveTo));
        }
        const updated = await tx
          .update(AREA)
          .set({
            ...(input.riskCategory ? { riskCategory: input.riskCategory as never } : {}),
            ...(input.advisoryMessage ? { advisoryMessage: input.advisoryMessage } : {}),
            ...(input.polygon ? { polygon: input.polygon as never } : {}),
            ...(input.policyForVisitsToArea
              ? { policyForVisitsToArea: input.policyForVisitsToArea }
              : {}),
            ...(input.effectiveTo !== undefined
              ? { effectiveTo: new Date(input.effectiveTo) }
              : {}),
            updatedAt: at,
          })
          .where(and(eq(AREA.id, areaId), eq(AREA.organizationId, actor.organizationId)))
          .returning({ id: AREA.id });
        if (updated.length !== 1) throw new NotFoundError("safety high-risk area");
      });
      const page = await readService.listHighRiskAreas(actor, { limit: 200, includeExpired: true });
      const view = page.data.find((a) => a.id === areaId);
      if (view === undefined) throw new NotFoundError("safety high-risk area");
      return view;
    },

    // ── §4.1 row 28 — grant one consent purpose ─────────────────────────────────────────────────────
    async grantConsent(actor, input: GrantConsentInput) {
      const at = now();
      // D10 / §3.3's `m20_secc_contact_present` — the purpose that exists to make a phone call must
      // actually carry a number to call. M20-F06: this row IS the emergency-contact record, because M2
      // has no such table.
      if (input.purpose === "emergency_contact_call" && input.contact === undefined) {
        throw new ChartWardenError(
          "EMERGENCY_CONTACT_REQUIRED",
          "granting `emergency_contact_call` needs the contact this platform is to dial (M20-F06)",
          422,
        );
      }
      // The scope detail holds a spouse's phone number and is §3.6-denylisted; §3.3 says it is encrypted
      // at the APPLICATION layer before the write. With no cipher bound, a grant that carries a contact is
      // refused rather than stored in the clear — the consent surface is exactly where a workforce member
      // was promised the number would be protected.
      let scopeDetail: Record<string, unknown> = {};
      if (input.contact !== undefined) {
        // GAP-032: a number that cannot be dialled is refused HERE, at grant time, not discovered at 3 a.m.
        // The sealed copy holds the normalised E.164 so the terminus dial never re-parses free text. The
        // refusal never echoes the number.
        const normalised = normalizeE164(input.contact.phone, EMERGENCY_CONTACT_DEFAULT_REGION);
        if (!normalised.ok) {
          throw new ChartWardenError(
            "EMERGENCY_CONTACT_NUMBER_INVALID",
            "the emergency contact's phone number cannot be dialled; enter a full number with area code (no extension, no emergency or short codes)",
            422,
          );
        }
        const sealed = await seal(
          actor,
          JSON.stringify({ ...input.contact, phone: normalised.e164 }),
          "the emergency contact on this consent",
        );
        scopeDetail = { contact: sealed.toString("base64"), enc: "dek" };
      }

      await withOrgContext(db, ctx(actor), async (tx) => {
        // §2.2.8 / `secc_active_uniq` — one GRANTED row per (org, membership, purpose). Re-granting
        // supersedes by revoking the old row first: the acknowledgment snapshot on each row is what a
        // consent dispute turns on, so the previous text is kept rather than overwritten.
        await tx
          .update(CONSENT)
          .set({ status: "revoked" as never, revokedAt: at, updatedAt: at })
          .where(
            and(
              eq(CONSENT.organizationId, actor.organizationId),
              eq(CONSENT.clinicianMembershipId, actor.membershipId),
              eq(CONSENT.consentPurpose, input.purpose),
              eq(CONSENT.status, "granted"),
            ),
          );
        await tx.insert(CONSENT).values({
          organizationId: actor.organizationId,
          clinicianMembershipId: actor.membershipId,
          consentPurpose: input.purpose,
          consentScopeDetail: scopeDetail,
          status: "granted" as never,
          grantedAt: at,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          acknowledgmentTextSnapshot: input.acknowledgmentTextSnapshot,
        });
      });

      const surface = await readService.getConsentSurface(actor, input.purpose);
      const view = surface.consents.find((c) => c.status === "granted");
      if (view === undefined) throw new NotFoundError("safety consent");
      return view;
    },

    // ── §4.1 row 29 — revoke one purpose ────────────────────────────────────────────────────────────
    async revokeConsent(actor, input) {
      const at = now();
      await withOrgContext(db, ctx(actor), async (tx) => {
        // §2.2.8 — `revoked` is not `expired`, and only this route writes the first. The rotation sweep
        // owns the second; a coercion review reads exactly that difference.
        const updated = await tx
          .update(CONSENT)
          .set({ status: "revoked" as never, revokedAt: at, updatedAt: at })
          .where(
            and(
              eq(CONSENT.organizationId, actor.organizationId),
              eq(CONSENT.clinicianMembershipId, actor.membershipId),
              eq(CONSENT.consentPurpose, input.purpose),
              eq(CONSENT.status, "granted"),
            ),
          )
          .returning({ id: CONSENT.id });
        if (updated.length === 0) throw new NotFoundError("granted safety consent");
      });
      const surface = await readService.getConsentSurface(actor, input.purpose);
      const view = surface.consents[0];
      if (view === undefined) throw new NotFoundError("safety consent");
      return view;
    },
  };
}
