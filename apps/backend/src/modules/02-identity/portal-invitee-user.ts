// apps/backend/src/modules/02-identity/portal-invitee-user.ts — GAP-092. M2's identity primitive for M31's portal
// invitations: find-or-create the `user` an invited caregiver will sign in as, and mark its email verified once the
// emailed single-use token is presented.
//
// `user` is M2's table (M31's `portal_account.user_id` is a real FK to it), so the write lives here and is injected
// into M31 as a locally-declared PORT at the composition root — M31 takes no M2 edge and never touches `user`.
// Mirrors the M34 first-admin precedent: insert-on-conflict-do-nothing keyed on the unique email, then re-select.
// An EXISTING user (a clinician who is also a family caregiver, or a second invitation to the same person) is reused
// as-is — their name and verification state are never overwritten by an invitation.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const USERS = schema.users;

/** An identity write on behalf of an invitation names no acting human (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export interface PortalInviteeUserPort {
  ensureUser(
    organizationId: string,
    input: { readonly email: string; readonly displayName: string },
  ): Promise<{ readonly userId: string }>;
  markEmailVerified(organizationId: string, userId: string): Promise<void>;
}

export function createPortalInviteeUserPort(db: DbClient): PortalInviteeUserPort {
  return {
    async ensureUser(organizationId, input) {
      const email = input.email.trim().toLowerCase();
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        await tx
          .insert(USERS)
          .values({ email, emailVerified: false, name: input.displayName })
          .onConflictDoNothing({ target: USERS.email });
        const [user] = await tx
          .select({ id: USERS.id })
          .from(USERS)
          .where(eq(USERS.email, email))
          .limit(1);
        if (!user) throw new Error("portal invitee user resolution failed");
        return { userId: user.id };
      });
    },

    async markEmailVerified(organizationId, userId) {
      await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        await tx
          .update(USERS)
          .set({ emailVerified: true, updatedAt: new Date() })
          .where(and(eq(USERS.id, userId), eq(USERS.emailVerified, false)));
      });
    },
  };
}
