// apps/backend/src/modules/36-messaging/part2-channel-gate.ts — M36 spec §7.13 / GAP-065: the M39 consent gate on
// care_team channel membership and visibility.
//
// "patient has SUD diagnosis + no consent for a member | M39 consent gate excludes that member from
// membership re-sync; audited." A care_team channel is a PHI surface about ONE patient; when that patient
// carries M5's `sud` privacy flag, 42 CFR Part 2 content may only reach staff the patient's Part 2 release
// covers. The per-actor question is M39's `ConsentEvaluator.evaluateForInternalAccess` (the same primitive
// M7/M12/M14/M15 resolve) and it is asked in BOTH places the spec names:
//   · the PUSH half — `syncCareTeamChannel` only adds (and keeps) members the gate admits; and
//   · the PULL half — `canViewChannel` re-asks on every read, so a revocation closes the window at once
//     instead of waiting for the cascade. This is what the `m39.consent.revoked` ACK attests.
//
// M36's `dependsOn` has no M39/M5 edge, so both are read opaquely through the M1 seam registry at CALL time
// (ConsentEvaluator, PatientPrivacyFlagReader) and cast to the minimal structural shapes below. Each
// `evaluateForInternalAccess` call writes M39's own consent_eval_audit row (callerModule `m36`), which is the
// "audited" half of the spec row.
//
// FAIL CLOSED, in the direction that cannot leak: a SUD-flagged patient's member is excluded when M39 throws,
// when the actor has no active membership to name against the release, or when the verdict is malformed. An
// unreadable privacy-flag lookup is NOT read as "not SUD" — it propagates so the caller denies (visibility) or
// retries (sync) rather than guessing.
//
// KNOWN LIMIT (reported on the gap): the flag comes from M5's `patient_privacy_flag_snapshot`, which the M5
// reader reports as empty while the snapshot is marked invalidated. That window is closed by M5's recompute,
// not here.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";

/** The M5 privacy flag that engages the Part 2 gate. */
export const SUD_PRIVACY_FLAG = "sud";
const CONSENT_CALLER_MODULE = "m36";
const CONSENT_CALLER_ROUTE = "care_team channel membership/visibility";

export interface Part2ChannelGate {
  /**
   * Of `userIds`, the ones that may be members of / see the patient's care_team channel. A patient without
   * the SUD flag admits every candidate. May THROW when the privacy flag cannot be read; callers must treat
   * a throw as "do not change anything / deny", never as "admit".
   */
  allowedUserIds(input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly userIds: readonly string[];
    /**
     * Called when M39 could not answer for a user (it threw): that user is withheld, exactly as for a denial, but a
     * caller that can retry (the scheduled-send sweep) uses this to tell an outage from a verdict.
     */
    readonly onUnavailable?: (userId: string) => void;
  }): Promise<ReadonlySet<string>>;
}

/** The ports the gate resolves (injected in tests; the seam registry + DB in production). */
export interface Part2GatePorts {
  /** The patient's ACTIVE privacy flags. Throws when unreadable. */
  privacyFlags(organizationId: string, patientId: string): Promise<readonly string[]>;
  /** userId -> active M2 membership id (the id space a `workforce_member` recipient names). */
  membershipIds(
    organizationId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  evaluateInternalAccess(input: {
    organizationId: string;
    patientId: string;
    membershipId: string;
  }): Promise<{ readonly redactSubstanceUseDisorderFields: boolean }>;
}

export function createPart2ChannelGate(ports: Part2GatePorts): Part2ChannelGate {
  return {
    async allowedUserIds({ organizationId, patientId, userIds, onUnavailable }) {
      if (userIds.length === 0) return new Set();
      const flags = await ports.privacyFlags(organizationId, patientId);
      if (!flags.includes(SUD_PRIVACY_FLAG)) return new Set(userIds);

      const membershipByUser = await ports.membershipIds(organizationId, userIds);
      const verdicts = await Promise.all(
        userIds.map(async (userId): Promise<string | null> => {
          const membershipId = membershipByUser.get(userId);
          if (!membershipId) return null; // cannot be named against a release
          try {
            const verdict = await ports.evaluateInternalAccess({
              organizationId,
              patientId,
              membershipId,
            });
            return verdict?.redactSubstanceUseDisorderFields === false ? userId : null;
          } catch {
            onUnavailable?.(userId);
            return null; // M39 unanswerable => withhold
          }
        }),
      );
      return new Set(verdicts.filter((u): u is string => u !== null));
    },
  };
}

/** Admits every candidate. Slice / unit-test wiring only; production binds {@link createSeamPart2ChannelGate}. */
export const allowAllPart2ChannelGate: Part2ChannelGate = {
  async allowedUserIds({ userIds }) {
    return new Set(userIds);
  },
};

interface ConsentEvaluatorShape {
  evaluateForInternalAccess(args: {
    organizationId: string;
    patientId: string;
    actor: { membershipId: string | null };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ redactSubstanceUseDisorderFields: boolean }>;
}

interface PrivacyFlagReaderShape {
  roomingFactsFor(input: {
    organizationId: string;
    patientIds: readonly string[];
  }): Promise<readonly { patientId: string; privacyFlags: readonly string[] }[]>;
}

/** The production gate: M5 privacy flags + M39 evaluator via the seam registry, memberships from M2's table. */
export function createSeamPart2ChannelGate(db: DbClient): Part2ChannelGate {
  const M = schema.memberships;
  return createPart2ChannelGate({
    async privacyFlags(organizationId, patientId) {
      const reader = getSeam("PatientPrivacyFlagReader") as unknown as PrivacyFlagReaderShape;
      const facts = await reader.roomingFactsFor({ organizationId, patientIds: [patientId] });
      const fact = facts.find((f) => f.patientId === patientId);
      if (!fact) throw new Error(`privacy flags unreadable for patient ${patientId}`);
      return fact.privacyFlags;
    },
    async membershipIds(organizationId, userIds) {
      const rows = await withOrgContext(db, { organizationId, userId: "" }, async (tx) =>
        (tx as unknown as DbClient)
          .select({ id: M.id, userId: M.userId })
          .from(M)
          .where(
            and(
              eq(M.organizationId, organizationId),
              eq(M.status, "active"),
              inArray(M.userId, [...userIds]),
            ),
          ),
      );
      return new Map(rows.map((r) => [r.userId, r.id] as const));
    },
    async evaluateInternalAccess({ organizationId, patientId, membershipId }) {
      const evaluator = getSeam("ConsentEvaluator") as unknown as ConsentEvaluatorShape;
      return evaluator.evaluateForInternalAccess({
        organizationId,
        patientId,
        actor: { membershipId },
        callerModule: CONSENT_CALLER_MODULE,
        callerRoute: CONSENT_CALLER_ROUTE,
      });
    },
  });
}
