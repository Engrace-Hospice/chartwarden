// apps/backend/src/modules/06-admission/physician-authority-db.ts — the production PhysicianAuthorityPort
// (42 CFR 418.25(a) / 418.26(b)). A signer's role keys come from the SAME authority `request.context.roles`
// derives from (the GAP-022 reader: enabled roles on unexpired assignments of an ACTIVE membership); IDG
// physician membership comes from M5's owner-side care-team reader. The candidate list reads M1/M3 identity
// facts (membership / membership_role / role / user — the CROSS_MODULE_SCHEMA_READ_EXEMPT identity tables).
// Each read opens its own `withOrgContext`, so callers resolve facts BEFORE their write transaction.
import { roleConfersKey } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { buildF2fClinicianRoleReader } from "../../bootstrap/f2f-clinician-roles";
import { buildCareTeamPhysicianReader } from "../05-patient/care-team-physician-reader";
import {
  MD_DO_ROLE_KEYS,
  type PhysicianAuthorityPort,
  type PhysicianSignerCandidate,
  heldSignerCapacities,
} from "./physician-authority";

const MB = schema.memberships;
const MR = schema.membershipRoles;
const RO = schema.roles;
const US = schema.users;

/** A read with no acting human (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export function createDbPhysicianAuthority(db: DbClient): PhysicianAuthorityPort {
  const roles = buildF2fClinicianRoleReader(db);
  const careTeam = buildCareTeamPhysicianReader(db);
  return {
    async signerFacts(organizationId, userId, patientId) {
      const [roleKeys, idgPhysicians] = await Promise.all([
        roles.roleKeysForUser(organizationId, userId),
        careTeam.openIdgPhysicianUserIds(organizationId, patientId),
      ]);
      return { roleKeys, idgPhysicianOfPatient: idgPhysicians.includes(userId) };
    },

    async listSignerCandidates(organizationId, patientId) {
      const now = new Date();
      const physicianRoleKeys = [...MD_DO_ROLE_KEYS];
      const [rows, idgPhysicians] = await Promise.all([
        withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
          tx
            .select({
              userId: MB.userId,
              name: US.name,
              roleKey: RO.key,
              roleOrganizationId: RO.organizationId,
              roleCategory: RO.category,
            })
            .from(MB)
            .innerJoin(US, eq(US.id, MB.userId))
            .innerJoin(
              MR,
              and(
                eq(MR.membershipId, MB.id),
                eq(MR.organizationId, organizationId),
                or(isNull(MR.expiresAt), gt(MR.expiresAt, now)),
              ),
            )
            .innerJoin(
              RO,
              and(eq(RO.id, MR.roleId), eq(RO.enabled, true), inArray(RO.key, physicianRoleKeys)),
            )
            .where(and(eq(MB.organizationId, organizationId), eq(MB.status, "active"))),
        ),
        careTeam.openIdgPhysicianUserIds(organizationId, patientId),
      ]);
      const byUser = new Map<string, { name: string | null; roleKeys: Set<string> }>();
      for (const r of rows) {
        if (
          !roleConfersKey({
            organizationId: r.roleOrganizationId,
            key: r.roleKey,
            category: r.roleCategory,
          })
        )
          continue;
        const entry = byUser.get(r.userId) ?? { name: r.name, roleKeys: new Set<string>() };
        entry.roleKeys.add(r.roleKey);
        byUser.set(r.userId, entry);
      }
      const candidates: PhysicianSignerCandidate[] = [];
      for (const [userId, entry] of byUser) {
        const capacities = heldSignerCapacities({
          roleKeys: [...entry.roleKeys],
          idgPhysicianOfPatient: idgPhysicians.includes(userId),
        });
        if (capacities.length > 0) candidates.push({ userId, name: entry.name, capacities });
      }
      return candidates.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    },
  };
}
