// M36 WP 6.7 (ADR-0099) - the composition-root binding of family messaging: the care-team predicate that decides which patients a staff member may act on, and
// the two services over their Drizzle stores. The predicate is the SAME roster + Part 2 rule the care-team channel uses (`part2-channel-gate.ts`), asked
// directly; there is no break-glass door into a family thread.
import { randomBytes } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { HintOutboxPort } from "../message-hint-events";
import { type MessageBodyCipher, createMessageBodyCipher } from "../messaging-write-core";
import { type Part2ChannelGate, createSeamPart2ChannelGate } from "../part2-channel-gate";
import type { AttemptLimiter, FamilyFlagReader } from "./family-common";
import { type FamilyContactService, createFamilyContactService } from "./family-contact-service";
import { type FamilyStaffService, createFamilyStaffService } from "./family-staff-service";
import { createDrizzleFamilyContactStore } from "./family-store-contact";
import { createDrizzleFamilyStaffStore, rowsOf } from "./family-store-staff";

export interface FamilyBindingInput {
  readonly flags?: FamilyFlagReader | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  /** From `familyAccessAvailability`: false => no contact routes, no invitations. */
  readonly accessAvailable?: boolean | undefined;
  readonly pepper?: string | undefined;
  readonly redeemIpLimiter?: AttemptLimiter | undefined;
  readonly verifyIpLimiter?: AttemptLimiter | undefined;
  readonly bearerIpLimiter?: AttemptLimiter | undefined;
  readonly readLimiter?: AttemptLimiter | undefined;
  /** Test seams; the defaults are the live seams. */
  readonly careTeamMembers?:
    | ((orgId: string, patientId: string) => Promise<readonly string[]>)
    | undefined;
  readonly part2Gate?: Part2ChannelGate | undefined;
  readonly cipher?: MessageBodyCipher | undefined;
}

export interface FamilyServices {
  readonly staff: FamilyStaffService;
  readonly contact: FamilyContactService;
}

/**
 * The staff member is on the patient's CURRENT care-team roster, or (after a death) is the counsellor assigned to the patient's open bereavement plan, AND
 * the Part 2 gate admits them. An unavailable seam is a denial.
 */
export function createFamilyPatientAccess(deps: {
  readonly db: DbClient;
  readonly part2Gate: Part2ChannelGate;
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
}): (orgId: string, userId: string, patientId: string) => Promise<boolean> {
  const isAssignedCounsellor = (
    orgId: string,
    userId: string,
    patientId: string,
  ): Promise<boolean> =>
    withOrgContext(deps.db, { organizationId: orgId, userId }, async (tx) => {
      // M16 stores the counsellor as a MEMBERSHIP id; the database function resolves it back to the user (migration 1232).
      const res = await tx.execute(
        sql`SELECT message_family_counsellor(${patientId}, ${userId}) AS "ok"`,
      );
      return rowsOf(res)[0]?.ok === true;
    });

  return async (orgId, userId, patientId) => {
    try {
      const onTeam = (await deps.careTeamMembers(orgId, patientId)).includes(userId);
      if (!onTeam && !(await isAssignedCounsellor(orgId, userId, patientId))) return false;
      const allowed = await deps.part2Gate.allowedUserIds({
        organizationId: orgId,
        patientId,
        userIds: [userId],
      });
      return allowed.has(userId);
    } catch {
      return false; // an unavailable clinical / consent seam is a denial, never a grant
    }
  };
}

export function buildFamilyServices(db: DbClient, input: FamilyBindingInput): FamilyServices {
  const cipher = input.cipher ?? createMessageBodyCipher();
  const canAccessPatient = createFamilyPatientAccess({
    db,
    part2Gate: input.part2Gate ?? createSeamPart2ChannelGate(db),
    careTeamMembers:
      input.careTeamMembers ??
      ((organizationId, patientId) =>
        getSeam("CareTeamProvider").careTeamMembers({ organizationId, patientId })),
  });
  return {
    staff: createFamilyStaffService({
      accessAvailable: input.accessAvailable,
      pepper: input.pepper,
      store: createDrizzleFamilyStaffStore(db),
      outbox: input.outbox,
      flags: input.flags,
      cipher,
      canAccessPatient,
    }),
    contact: createFamilyContactService({
      store: createDrizzleFamilyContactStore(db),
      pepper: input.pepper ?? randomBytes(32).toString("hex"), // contact routes are unmounted without a real pepper
      outbox: input.outbox,
      flags: input.flags,
      cipher,
      redeemIpLimiter: input.redeemIpLimiter,
      verifyIpLimiter: input.verifyIpLimiter,
      bearerIpLimiter: input.bearerIpLimiter,
      readLimiter: input.readLimiter,
    }),
  };
}
